// cloudfunctions/mediaCheckResult/index.js - 接收 mediaCheckAsync 异步检测结果推送
//
// 职责：微信在 mediaCheckAsync 异步检测完成后，通过「消息推送」（wxa_media_check 事件）
// 把结果推送到本云函数（云开发控制台 → 设置 → 其他设置 → 推送模式选云函数 → 添加消息推送，
// 消息类型选 event，事件类型选 wxa_media_check，云函数选本函数）。
// 本函数把结果写入 sec_check_results 集合（_id = trace_id），
// 前端/云函数侧通过 secCheck(action=query, traceId) 轮询读取。
//
// 写入策略（安全优先，fail-closed）：仅当推送成功（errcode===0 且携带有效 result.suggest）
// 时才写入真实判定；推送异常（如下载失败 errcode=-1008、result 缺失、格式异常）视为
// 「检测未完成/不可信」，**不写入任何结果**，交由前端轮询超时后按 fail-closed 拦截——
// 绝不默认 'pass'，否则未真正检测的内容会被当作「合规通过」放行。
//
// 推送事件负载（示例）：
//   {
//     ToUserName, FromUserName, CreateTime, MsgType: 'event', Event: 'wxa_media_check',
//     appid, trace_id,
//     version: 2,
//     errcode: 0,          // 0=有效；-1008=下载错误（媒体链接不可达）
//     result: { suggest: 'pass'|'review'|'risky', label: 100 },
//   注：errcode≠0 或缺失 result 视为检测未完成 → 本函数不写入结果（fail-closed），
//     detail: [ { strategy, errcode, suggest, label, prob } ]
//   }

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const RESULT_COLLECTION = 'sec_check_results';

exports.main = async (event) => {
  const data = (event && typeof event === 'object') ? event : {};

  // 来源校验（防御性，defense-in-depth · M1 修复）：本函数只应接收微信「消息推送」的 wxa_media_check 事件。
  // 微信官方推送负载含 MsgType:'event' 且 Event:'wxa_media_check'（与上方注释示例一致，已被官方文档确认）；
  // 而通过云函数直接调用（wx.cloud.callFunction 或控制台「云端测试」）的 event 不含这些信封字段。
  // 据此区分平台推送与直接调用，阻止攻击者伪造 { trace_id, errcode:0, result:{suggest:'pass'} }
  // 直接写入 sec_check_results、绕过内容安全放行违规图片。
  // 注意：此校验仅为提高伪造门槛，直接调用时伪造信封字段技术上可行，并非密码学强绑定；
  // 微信推送本身的信任边界来自其服务器来源。信封缺失则按非推送事件忽略（fail-closed 友好，不影响正常检测）。
  if (data.MsgType !== 'event' || data.Event !== 'wxa_media_check') {
    // 非检测结果推送（如云开发控制台「云端测试」、恶意直接调用发来的任意事件），直接忽略
    return { errcode: 0, errmsg: 'ignored' };
  }

  const traceId = data.trace_id;
  if (!traceId || typeof traceId !== 'string') {
    // 非检测结果推送（如云开发控制台「云端测试」发来的任意事件），直接忽略
    return { errcode: 0, errmsg: 'ignored' };
  }

  // 安全策略：fail-closed。仅当推送成功（errcode===0 且携带有效 result.suggest）时才写入真实判定；
  // 其余情况（下载失败 errcode=-1008、result 缺失、格式异常等）视为「检测未完成/不可信」，
  // 不写入任何结果，交由前端轮询超时后按 fail-closed 拦截——绝不默认 'pass'，
  // 否则未检内容会被当作「合规通过」绕过防线。
  const okResult = (data.errcode === 0 && data.result && data.result.suggest);
  if (!okResult) {
    console.warn('[mediaCheckResult] 推送结果不可信（errcode=' + (data.errcode != null ? data.errcode : 'n/a') +
      '），不写入结果，交由前端 fail-closed 超时拦截 trace_id=' + traceId);
    return { errcode: 0, errmsg: 'ignored_untrusted' };
  }
  const suggest = String(data.result.suggest).toLowerCase();
  const label = data.result.label != null ? data.result.label : 100;

  try {
    const db = cloud.database();
    // P2-6 修复：先读取 submit 阶段写入的 pending 文档取回 fileID。下方 set 为覆盖写，
    // 若不显式合并，fileID 字段将丢失、云存储文件失去唯一归属线索无法兜底删除。
    let fileID = '';
    try {
      const prev = await db.collection(RESULT_COLLECTION).doc(traceId).get().catch(() => ({ data: null }));
      fileID = (prev && prev.data && typeof prev.data.fileID === 'string') ? prev.data.fileID : '';
    } catch (e) {
      // 读取失败仅告警：fileID 置空则跳过兜底删除（前端 pollSecCheckResult 结束后仍有二层兜底）
      console.warn('[mediaCheckResult] 读取 pending 文档失败，跳过 fileID 合并 trace_id=' + traceId, (e && (e.errMsg || e.message)) || e);
    }
    const writeData = {
      suggest,
      label,
      errcode: data.errcode != null ? data.errcode : 0,
      createdAt: Date.now()
    };
    if (fileID) writeData.fileID = fileID; // 保留 fileID（P2-6），供审计与兜底删除追溯
    await db.collection(RESULT_COLLECTION).doc(traceId).set({ data: writeData });
    console.log('[mediaCheckResult] 已写入结果 trace_id=' + traceId + ' suggest=' + suggest);
    // P2-6 修复：写入成功后兜底删除云存储中转文件。
    // 背景：secCheck submit 成功路径已不在 finally 立即删文件（避免与 mediaCheckAsync
    // 异步下载 media_url 竞态致 -1008 误拦合法图）；此刻检测结果已返回、检测服务器已消费
    // 完该文件，删除时机安全，且保证「用户图片不残留」的隐私目标不变。
    // deleteFile 失败仅告警不阻断（结果已落盘，前端轮询结束后另有二层兜底删除）。
    if (fileID) {
      try {
        await cloud.deleteFile({ fileList: [fileID] });
      } catch (e) {
        console.warn('[mediaCheckResult] 兜底删除云存储文件失败（不阻断）trace_id=' + traceId, (e && (e.errMsg || e.message)) || e);
      }
    }
    return { errcode: 0, errmsg: 'ok' };
  } catch (e) {
    // 集合未创建时报错 → 引导创建（仅服务端日志，不向微信推送方透传细节）
    console.error('[mediaCheckResult] 写入结果失败 trace_id=' + traceId + ':', (e && (e.errMsg || e.message)) || e);
    return { errcode: -1, errmsg: 'write failed' };
  }
};

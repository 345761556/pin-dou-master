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
// 校验链（防御纵深加固，写入前依次通过，任一不过即忽略且不落盘）：
//   L0 信封校验：MsgType==='event' && Event==='wxa_media_check'（区分平台推送与直接调用）；
//   L1 结果可信校验：errcode===0 且携带有效 result.suggest（fail-closed）；
//   L2 pending 存在性校验：sec_check_results 中必须存在 submit 阶段写入的 status==='pending'
//      文档——只为真实提交过的 trace_id 写结果，凭空伪造 trace_id 的调用被忽略；
//      L2+ 极端竞态兜底：submit 拿到 trace_id 后立即写 pending 文档，而微信推送需先下载图片并完成
//      检测（秒级），正常必然晚于 pending set 到达；但理论上推送可能早于 pending set 到达而被 L2
//      拒绝 → 真实结果永久丢失 → 前端 fail-closed 误拦合法图。故对「文档不存在/读取为空」延迟约
//      3 秒重读一次，重试后仍无才判伪造；读到文档但 status 非 pending（已被写过）不重试。
//   L3 appid 匹配校验（best-effort）：pending 文档记录的 appid 与推送负载 appid 均存在时
//      必须一致（任一缺失则跳过本层，不阻断真实推送）；
//   L4 已定结果不可覆盖：文档已有 suggest（最终结果已写）时忽略后续推送（幂等保护），
//      防止伪造调用覆盖真实 risky 判定。
//
// ⚠️ 运维提醒：本函数与 secCheck 云函数的校验链耦合，改动后必须两个云函数同时重新上传部署，
// 否则校验链断裂（最坏全部图片检测 fail-closed 超时拦截）。
//
// ⚠️ 残余风险（架构限制，无法根除）：
// 微信云函数「消息推送」模式不含密码学签名可校验，且推送负载无可绑定提交者的字段——
//   · appid 是小程序公开常量（同一小程序所有用户相同），L3 仅能防「跨小程序/跨环境」误配，
//     对同小程序内的伪造无区分度；
//   · 推送不含提交者 openid（FromUserName 是平台推送服务身份，非提交用户 openid），
//     无法做「推送者=提交者」的归属绑定。
// 因此攻击者对自己的 trace_id 仍可自绕过：伪造 suggest:'pass' 推送可写入本人内容的结果，
// 且因 L4 幂等保护「先到者胜」，若伪造 pass 先于真实 risky 推送到达，真实判定会被拒写——
// 即攻击者可把【本人内容】从 risky 洗成 pass（影响限于自己的内容自己的结果，无法污染
// 他人记录；跨用户污染、覆盖他人判定、越权查询已分别被 L2/L4 与 query 归属绑定阻断）。
// 【未来若接入服务端发布闸门】不得以本集合的 suggest 作为唯一放行依据——须在发布动作侧
// 独立复核（重新调用检测或人工审核），否则自绕过将成为完整绕过。签名验证方案需另行设计。
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
// L2+ 极端竞态兜底的重读延迟（毫秒）。可用环境变量注入以便测试加速；生产默认 500ms（P3-9 由 3000ms 缩短）——
// 该重试窗口远大于 submit 写 pending 文档的毫秒级延迟，足以覆盖「推送早于 pending set」的极端窗口。
// 防御：env 误配（空串/非数字）时 Number() 得 0/NaN，setTimeout(NaN) 退化为 0ms 等价于无延迟，
// 失去竞态兜底窗口。isFinite 校验后回落兜底 3000ms（仅运维误配置，非代码缺陷，但一行兜底成本≈0）。
const PENDING_RETRY_DELAY_MS = (() => {
  if (process.env.MEDIA_CHECK_PENDING_RETRY_DELAY_MS == null) return 500;
  const n = Number(process.env.MEDIA_CHECK_PENDING_RETRY_DELAY_MS);
  return (isFinite(n) && n > 0) ? n : 3000;
})();

exports.main = async (event) => {
  const data = (event && typeof event === 'object') ? event : {};

  // 来源校验（防御性，defense-in-depth · M1 修复 · L0 层）：本函数只应接收微信「消息推送」的
  // wxa_media_check 事件。微信官方推送负载含 MsgType:'event' 且 Event:'wxa_media_check'
  // （与上方注释示例一致，已被官方文档确认）；而通过云函数直接调用（wx.cloud.callFunction
  // 或控制台「云端测试」）的 event 不含这些信封字段。据此区分平台推送与直接调用。
  // 注意：此校验仅为提高伪造门槛，直接调用时伪造信封字段技术上可行，并非密码学强绑定；
  // 真正的写入准入由下方 L2 pending 存在性校验兜底。信封缺失则按非推送事件忽略。
  if (data.MsgType !== 'event' || data.Event !== 'wxa_media_check') {
    // 非检测结果推送（如云开发控制台「云端测试」、恶意直接调用发来的任意事件），直接忽略
    return { errcode: 0, errmsg: 'ignored' };
  }

  // trace_id 大小写兼容：与 secCheck/index.js submit 侧（res.trace_id || res.traceId）对齐——
  // 微信推送负载官方字段是 trace_id（snake_case），但若未来推送管线变更/前端调用方发驼峰 traceId，
  // 只读下划线会导致全部推送被忽略 → 全链路 fail-closed 超时（安全但全断）。一行兜底两种形态。
  const traceId = data.trace_id || data.traceId;
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
    // 【安全加固】失败分支零副作用：不写结果、也【不删除】任何中转文件。
    // 原实现在此 best-effort 读 pending 取 fileID 并 deleteFile，但该分支不经过 L2/L3/L4 校验链、
    // 也无归属锚点（官方推送不含提交者 openid，appid 是同小程序公开常量无区分度）——
    // 攻击者只要知道他人 trace_id（在检 pending 态），伪造 errcode:-1008 推送即可删掉他人
    // 中转文件 → 其真实检测结果推送虽然仍会被 L2 放行（pending 仍在），但文件已删导致
    // mediaCheckAsync 检测端无法下载 → 合法图被 fail-closed 误拦（DoS）。
    // 移除删除后：伪造 -1008 无任何副作用（pending 保留，真实结果推送照常走 okResult 分支
    // 正常写结果并删文件）；真实 -1008（检测永久失败）的孤儿文件由前端 deleteCloudFile
    // 四路径兜底（提交异常/无 trace_id/轮询失败/轮询完成，utils/secCheck.js:344/354/367/373）
    // + 微信 30 分钟内可能重推成功（走 okResult 正常删）双层覆盖，隐私目标不倒退。
    return { errcode: 0, errmsg: 'ignored_untrusted' };
  }
  const suggest = String(data.result.suggest).toLowerCase();
  const label = data.result.label != null ? data.result.label : 100;

  try {
    const db = cloud.database();
    // P2-6 修复：先读取 submit 阶段写入的 pending 文档取回 fileID。下方 set 为覆盖写，
    // 若不显式合并，fileID 字段将丢失、云存储文件失去唯一归属线索无法兜底删除。
    // 安全加固（防御纵深）：本次读取同时作为 L2/L3/L4 三层校验的数据源——
    // 只有真实 submit 过的 pending 文档才允许被推送结果覆盖写。
    let fileID = '';
    let openid = '';
    let prevDoc = null;
    // 单次读取：wx-server-sdk 默认 throwOnNotFound=true（本项目 cloud.init 未设置
    // throwOnNotFound:false），doc().get() 在【文档不存在】时是抛异常而非 resolve
    // {data:null}（官方文档明确「默认情况下,如果获取不到记录,方法会抛出异常」）。
    // 因此必须 catch 并区分：
    //   - 「记录不存在」（errMsg 含 not exist/not found/不存在）→ 返回 null，
    //     由下方 L2+ 竞态兜底重试（推送早于 pending set 的场景必须能触发重读，
    //     否则 3s 兜底是死代码、真实推送被 fail-closed 误拦）；
    //   - 「DB 故障」（其余错误，如集合不存在/权限/网络）→ 原样 rethrow，
    //     由外层 catch fail-closed 忽略且不参与重试（故障期重试无法提升正确性）。
    const readPendingDoc = async () => {
      try {
        const res = await db.collection(RESULT_COLLECTION).doc(traceId).get();
        return (res && res.data && typeof res.data === 'object') ? res.data : null;
      } catch (e) {
        const msg = String((e && (e.errMsg || e.message)) || e || '');
        // 仅当是「文档级」not-found 才返回 null（触发 L2+ 重试）；「集合级」缺失（collection
        // not exists / 集合不存在）属 DB 故障，须排除——否则 sec_check_results 集合缺失时
        // 每次推送会被误判为「记录不存在」→ 空等 3s 重试一次再失败（结果仍 fail-closed，
        // 但与本意「集合缺失不重试」相悖）。真实 SDK 报错：文档级含 'document' + not exist，
        // 集合级含 'collection'/'集合'，故用排除式匹配区分。
        if (/not exist|not found|不存在/i.test(msg) && !/collection|集合/i.test(msg)) return null;
        throw e; // 其余（DB 故障）→ 原样上抛，fail-closed
      }
    };
    try {
      prevDoc = await readPendingDoc();
      if (!prevDoc) {
        // P3-9 修复：重试窗口从 3000ms 缩短至 500ms。原 3s 在高并发推送场景下显著拉长云函数尾延迟，
        // 增加超时/冷启动排队风险；submit 写 pending set 为毫秒级操作，500ms 窗口已足够覆盖该竞态。
        // L2+ 极端竞态兜底（见文件头注释）：对「文档不存在/读取为空」延迟约 500ms 重读一次。
        // 重试窗口远大于 submit 写 pending 的毫秒级延迟；重试后仍无 pending 文档才判定为伪造并忽略。
        // 注意：仅「无文档」重试；读到文档但 status 非 pending（已被写过）不重试，
        // 直接走下方 L2 原逻辑拒绝。
        await new Promise((resolve) => setTimeout(resolve, PENDING_RETRY_DELAY_MS));
        prevDoc = await readPendingDoc();
      }
      fileID = (prevDoc && typeof prevDoc.fileID === 'string') ? prevDoc.fileID : '';
      openid = (prevDoc && typeof prevDoc.openid === 'string') ? prevDoc.openid : '';
    } catch (e) {
      // L2 fail-closed：读取本身抛错（数据库故障等）即无法证明「该 trace_id 来自真实提交」，
      // 一律不写入（宁可使一次真实推送丢失、由前端轮询超时 fail-closed 拦截，也不给伪造开窗）；
      // 该路径不参与上述重试——数据库故障期重试无法提升正确性，只会放大延迟。
      console.warn('[mediaCheckResult] 读取 pending 文档失败，按未验证忽略（fail-closed）trace_id=' + traceId, (e && (e.errMsg || e.message)) || e);
      return { errcode: 0, errmsg: 'ignored_unverified' };
    }

    // L2 pending 存在性校验：只为「submit 阶段真实写入且仍处 pending 态」的 trace_id 写结果。
    // 无文档（凭空伪造 trace_id）或状态非 pending（如已被写过/异常态）→ 记录可疑伪造尝试并忽略。
    // 兼容边界：pending 文档 status 字段是 submit 成功路径必写的（'pending'），真实推送到达时
    // 文档必然处于 pending 态，本层不会误伤合法推送。
    if (!prevDoc || prevDoc.status !== 'pending') {
      console.warn('[mediaCheckResult] 可疑伪造尝试：sec_check_results 中无对应 pending 文档，已忽略（不写入） trace_id=' + traceId);
      return { errcode: 0, errmsg: 'ignored_unverified' };
    }

    // L3 appid 匹配校验（best-effort）：pending 文档记录的 appid 与推送负载 appid 均存在时必须一致；
    // 任一缺失（旧文档无 appid / 推送负载缺 appid 字段）则跳过本层，避免阻断真实推送。
    if (typeof prevDoc.appid === 'string' && prevDoc.appid &&
        typeof data.appid === 'string' && data.appid &&
        prevDoc.appid !== data.appid) {
      console.warn('[mediaCheckResult] 可疑伪造尝试：appid 与提交记录不一致，已忽略（不写入） trace_id=' + traceId);
      return { errcode: 0, errmsg: 'ignored_unverified' };
    }

    // L4 已定结果不可覆盖（幂等保护）：suggest 已存在说明最终结果已写过，后续重复推送
    // （含伪造调用）一律忽略——这是防止伪造 pass 覆盖真实 risky 判定的关键防线。
    if (prevDoc.suggest) {
      console.warn('[mediaCheckResult] 结果已存在，拒绝覆盖（幂等保护） trace_id=' + traceId + ' existing_suggest=' + prevDoc.suggest);
      return { errcode: 0, errmsg: 'ignored_finalized' };
    }

    const writeData = {
      suggest,
      label,
      errcode: data.errcode != null ? data.errcode : 0,
      // 审计字段（外部审查 #4）：原 pending 文档的 status/appid/createdAt 会被 set 覆盖写丢失——
      //   · status 补 'done'：结果文档状态明确（pending → done），审计链可追溯「已出结果」；
      //   · appid 从 pending 文档带出：保留「该次提交所属小程序」归属信息（此前丢失）；
      //   · createdAt 保留原 pending 的提交时间（此前被覆盖为结果时间，丢失提交时刻线索），
      //     结果时间另存 resultAt，二者并存供审计。
      status: 'done',
      createdAt: (prevDoc && typeof prevDoc.createdAt === 'number') ? prevDoc.createdAt : Date.now(),
      resultAt: Date.now()
    };
    if (typeof prevDoc.appid === 'string' && prevDoc.appid) writeData.appid = prevDoc.appid;
    if (fileID) writeData.fileID = fileID; // 保留 fileID（P2-6），供审计与兜底删除追溯
    // 归属绑定：把 pending 文档的 openid 合并进结果，供 secCheck query 分支校验查询者归属
    //（知道 trace_id 的第三方无法读到他人判定结果）。
    if (openid) writeData.openid = openid;
    // L4 原子化（外部审查：结果写入 TOCTOU）：原「读取 prevDoc → 检查 suggest → set 覆盖写」
    // 存在读-改-写窗口——两个并发推送（真实推送 + 伪造/重推）都读到 suggest 不存在 → 都通过
    // L4 → 后 set 者覆盖先写者，「先到者胜」保护不严格成立。改用数据库端条件更新
    // where({_id, suggest: _.exists(false)})：仅当 suggest 字段【不存在】时才更新（server 原子
    // 判-写），并发场景只有一个请求命中 updated=1，其余返回 ignored_finalized——L4 从
    // 「读取时幂等」升级为「写入时原子幂等」。update 为合并写，pending 的 fileID/openid/
    // createdAt 等字段天然保留（writeData 中显式合并的字段值相同，无害）。
    const updRes = await db.collection(RESULT_COLLECTION).where({
      _id: traceId,
      suggest: db.command.exists(false)
    }).update({ data: writeData });
    const updN = (updRes && updRes.updated != null)
      ? updRes.updated
      : ((updRes && updRes.stats && updRes.stats.updated) || 0);
    if (updN !== 1) {
      // 条件未命中：结果已被并发写入（或文档异常态）→ 幂等保护生效，拒绝覆盖。
      // 与「读取时 L4」行为一致（返回 ignored_finalized），仅写入路径原子化。
      console.warn('[mediaCheckResult] 并发/重复推送：结果已存在，条件更新未命中，拒绝覆盖（原子幂等） trace_id=' + traceId);
      return { errcode: 0, errmsg: 'ignored_finalized' };
    }
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

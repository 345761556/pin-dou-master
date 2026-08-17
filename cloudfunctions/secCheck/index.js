// cloudfunctions/secCheck/index.js - 图片内容安全检测云函数
//
// 职责：接收前端上传到云存储的图片 fileID → 换取临时 URL → 调用微信内容安全接口
// security.mediaCheckAsync（异步多媒体检测，/wxa/media_check_async，图片/音频正确接口）
// → 返回 trace_id；检测结果由微信通过「消息推送」（wxa_media_check 事件）推送到
// cloudfunctions/mediaCheckResult 云函数写入 sec_check_results 集合；
// 前端持有 trace_id 轮询本云函数(action=query) 读取结果。
//
// ⚠️ 重要（47001 教训）：微信 /wxa/msg_sec_check 是【文本】检测接口，
// 图片/音频必须用 mediaCheckAsync（异步）。用 msgSecCheck 传图片 media 对象
// 会报 47001 data format error（2026-08-16 多次实测复现）。
//
// 前端约定（utils/secCheck.js）：
//   - submit 入参：{ action:'submit', type:'image', scene:1|2|3|4, fileID }
//   - query  入参：{ action:'query', traceId }
//   - submit 返回：{ errcode:0, trace_id, status:'submitted' } 或 { errcode:非0, errmsg }
//   - query  返回：{ errcode:0, status:'done', suggest } | { errcode:0, status:'pending' }
//   - errmsg 固定为通用令牌，绝不透传底层异常细节，详细错误仅落服务端日志
//
// 安全加固：
//   - fileID 归属校验：仅允许本项目上传路径前缀 sec_check/，杜绝任意 fileID 删除/下载他人文件。
//   - openid 窗口限频：防止刷爆 mediaCheckAsync 免费额度（数据库端原子条件更新优先，
//        内存兜底仅作数据库故障降级，接受其跨实例不精确代价）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// msgSecCheck media.content(base64) 上限 10MB；原始字节按 7MB 守卫（base64 膨胀 4/3 ≈ 9.3MB < 10MB）
const MAX_BYTES = 7 * 1024 * 1024;
// 内容安全场景白名单（mediaCheckAsync v2 scene 枚举，与前端 utils/secCheck.js 保持一致；
// 取值依据微信官方文档：1=资料 2=评论 3=论坛 4=社交日志）：
//   1=资料（头像/昵称等）  2=评论（互动/留言）  3=论坛（用户聚集讨论帖）  4=社交日志（朋友圈式动态）
// 注：scene 3（论坛）当前前端无调用方，但属合法场景，保留以支持未来社区类内容接入；
//   若传入非白名单值（如 99），下方 SCENE_WHITELIST.indexOf 兜底回退为 2（评论）。
const SCENE_WHITELIST = [1, 2, 3, 4];

// 本项目上传路径固定前缀（前端 utils/secCheck.js uploadToCloud 统一放在 sec_check/ 下）。
// fileID 两种格式均指向该存储目录：
//   cloud://<env>.<suffix>/sec_check/xxx.png      → 存储 key = sec_check/xxx.png
//   https://<bucket>.tcb.qcloud.com/<env>/sec_check/xxx.png → 存储 key = sec_check/xxx.png
// 注意：fileID 是「完整资源地址」，/sec_check/ 可能出现在任意位置（如 user/sec_check/x.png）。
// 归属校验必须解析出存储 key 并校验其【精确以 sec_check/ 开头】且不含 '..' 路径遍历段，
// 绝不能用字符串子串包含匹配（含该子串即放过，可绕过归属边界）。
const SEC_CHECK_KEY_PREFIX = 'sec_check/';

/**
 * 从 fileID 解析出云存储 key（env 根目录下的相对路径）。
 * @param {string} fileID
 * @returns {string|null} 存储 key；无法解析返回 null（调用方应拒绝）。
 */
function getStorageKey(fileID) {
  if (typeof fileID !== 'string' || fileID.length === 0) return null;
  if (fileID.startsWith('cloud://')) {
    // cloud://<env>.<suffix>/<key> —— 取第一个 '/' 之后的部分作为 key
    const rest = fileID.slice('cloud://'.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? null : rest.slice(slash + 1);
  }
  if (fileID.startsWith('https://')) {
    // https://<bucket>.tcb.qcloud.com/<env>/<key> —— 路径首段为 <env>，去掉后剩余即 key
    try {
      const seg = new URL(fileID).pathname.split('/').filter(Boolean);
      seg.shift(); // 丢弃 env 段
      return seg.join('/');
    } catch (e) {
      return null;
    }
  }
  return null; // 未知格式拒绝
}

/**
 * 归属校验：文件是否在本函数授权管理的 sec_check/ 目录内。
 * @param {string} fileID
 * @returns {boolean}
 */
function isOwnedSecCheckFile(fileID) {
  const key = getStorageKey(fileID);
  if (!key) return false;
  if (!key.startsWith(SEC_CHECK_KEY_PREFIX)) return false; // 精确前缀，非子串
  // 防路径遍历：存储 key 不得含 '..' 段
  if (key.split('/').some((seg) => seg === '..')) return false;
  return true;
}

// 限频参数（防刷爆 msgSecCheck 免费额度）：每 openid 每窗口上限（可调）
const RATE_LIMIT_WINDOW_MS = 3600 * 1000; // 1 小时窗口
const RATE_LIMIT_MAX = 100;               // 每 openid 每窗口最大调用次数
const RATE_LIMIT_COLLECTION = 'sec_check_rate';

// 内存兜底：仅作为「数据库整体不可用（未建集合/权限/网络）」时的降级层，
// 单实例内 JS 单线程天然原子，但跨实例无一致性——此不精确代价被接受（见 S3 修复结论）。
const _memRateStore = new Map();
let _rateDegradeLogged = false; // B21：限频降级告警去重，每个实例冷启动只打印一次完整错误（避免持续故障期日志风暴）
let _rateWasDegraded = false;   // n4：记录是否曾降级为内存兜底；DB 恢复时据此外部打印「降级已解除」事件（消除恢复后无感知盲区）

/**
 * 按 openid 的窗口限频检查（数据库优先·原子更新；内存仅作数据库故障降级）。
 * @param {string} openid - 当前用户 openid（来自云调用上下文）
 * @returns {Promise<{allowed: boolean, source?: string, reason?: string}>}
 *          allowed=false 表示已超限，调用方应直接 return 限频错误（不消耗额度、不删文件）。
 *
 * 原子性（修复 S3 的 TOCTOU 读-改-写非原子序列）：
 *   旧实现 where({openid}).get() → 本地算 newCount = existing.count+1 → doc(openid).set() 是
 *   典型读-改-写，云函数多实例并发时多个请求同时读到旧 count 并各自写回，窗口内实际调用次数
 *   可远超 RATE_LIMIT_MAX，msgSecCheck 免费额度可被刷爆。
 *   新实现改为数据库端「条件更新」让 server 完成读-判-写：
 *     - 窗口内累加：where({_id, windowStart, count: _.lt(MAX)}).update({count: _.inc(1)})
 *       仅当「处于当前窗口 且 当前计数<上限」时被 server 原子自增，返回 updated===1 即放行；
 *       并发请求只有满足条件者被原子自增，其余因 count 已被 +1 不再满足 _.lt(MAX) → updated===0
 *       → 判定为超限，从根上杜绝并发突破上限。
 *     - 窗口重置：where({_id, windowStart: _.neq(当前窗口)}).update({windowStart, count:1})
 *       条件更新确保同一时刻仅一个并发请求成功重置；抢占失败者重试窗口内累加以正确纳入计数，
 *       避免重置竞态导致的误拦截。
 *   内存兜底仅作为数据库故障降级（见 memoryRateLimit）。
 */
async function checkRateLimit(openid) {
  const now = Date.now();
  try {
    const db = cloud.database();
    const _ = db.command;
    const coll = db.collection(RATE_LIMIT_COLLECTION);

    const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;

    // 1) 窗口内原子累加：满足条件者由数据库端原子自增，返回 updated===1 即放行（S3 修复核心）。
    const incRes = await coll.where({
      _id: openid,
      windowStart: windowStart,
      count: _.lt(RATE_LIMIT_MAX)
    }).update({ data: { count: _.inc(1), _updatedAt: now } });

    // n4 修复：能成功取到 incRes 即证明数据库已可达（若 DB 不可用，上方 await 会抛错进入 catch 降级）。
    // 若此前曾降级为内存兜底，本次成功说明已恢复，打印一次「降级已解除」并复位 _rateDegradeLogged，
    // 使下次再降级能重新告警（消除「恢复后无感知、降级告警只响一次」的盲区）。正常无降级时 _rateWasDegraded 恒为 false，无额外日志。
    if (_rateWasDegraded) {
      _rateWasDegraded = false;
      _rateDegradeLogged = false;
      console.warn('[secCheck] 限频数据库已恢复，降级已解除，恢复正常 DB 限频（内存兜底不再生效）');
    }

    if (incRes.updated === 1) {
      return { allowed: true, source: 'db' };
    }

    // 2) updated===0：文档不存在 / 窗口已过期 / 已达上限。读取以区分。
    const doc = await coll.doc(openid).get().catch(() => ({ data: null }));
    const d = doc && doc.data;
    if (!d) {
      // 清理遗留非规范文档（灰度期间 add() 自动 _id 格式）：best-effort，不影响主流程。
      // 规范文档以 openid 为 _id，全程用 doc(openid) 读取/写入，结构上已无解双文档竞态（L1 修复）。
      // m6 修复：原实现每次请求都执行一次清理查询（约 20-50ms 额外延迟）；灰度迁移已结束、孤立文档
      // 正常情况下不存在，故改为仅在「文档不存在（首次访问）」时清理——绝大多数请求（窗口内累加命中
      // 即返回的常驻用户）不再付出该查询代价，同时保留对罕见孤立文档的安全网（首次访问即顺带清理）。
      try {
        const orphanRes = await coll.where({ openid, _id: _.neq(openid) }).get();
        for (const d of (orphanRes.data || [])) {
          try { await coll.doc(d._id).remove(); } catch (e) { /* 孤立文档删除失败忽略 */ }
        }
      } catch (e) { /* 忽略 */ }

      // 首次访问（文档尚不存在）：原子创建（doc(openid).set 在云开发侧「不存在则创建」），
      // 作为当前窗口第 1 次计数。
      // 并发首访竞态（对抗式审查 M5）：两个请求同时读到 updated===0 且 doc 不存在时，会各自
      // set count=1，最后写入者覆盖，计数收敛为 1 而非 2，二者均放行——窗口起始时刻存在极小限频
      // 绕过窗口。影响边界：仅「同 openid 在窗口起始的并发首访」会多放行少量（至多=真正并发数）；
      // RATE_LIMIT_MAX=100 下溢出可忽略；若将 MAX 调至个位数（强反滥用场景），需在调用方叠加额外
      // 限速，或改用 coll.add({_id:openid}) 条件创建（_id 冲突则重试窗口内原子自增）消除此窗口。
      // 当前按 S3 决策保持 set 创建（可接受），仅作文档化说明。
      await coll.doc(openid).set({
        data: { _id: openid, openid, windowStart: windowStart, count: 1, _updatedAt: now }
      });
      return { allowed: true, source: 'db' };
    }
    if (d.windowStart !== windowStart) {
      // 窗口过期：原子重置为新窗口（count=1）。条件更新确保同一时刻仅一个并发请求成功重置，
      // 其余因文档已是新窗口而不再满足 _.neq(当前窗口) → updated===0 → 走下方重试窗口内累加，
      // 既无重置竞态误拦截，也避免重置把已累加计数回退（防边界超额放行）。
      const resetRes = await coll.where({
        _id: openid,
        windowStart: _.neq(windowStart)
      }).update({ data: { windowStart: windowStart, count: 1, _updatedAt: now } });
      if (resetRes.updated === 1) {
        return { allowed: true, source: 'db' };
      }
      // 重置被抢占（文档已是新窗口）：重试窗口内累加以正确纳入计数，否则视为已达上限。
      const retryRes = await coll.where({
        _id: openid,
        windowStart: windowStart,
        count: _.lt(RATE_LIMIT_MAX)
      }).update({ data: { count: _.inc(1), _updatedAt: now } });
      return retryRes.updated === 1
        ? { allowed: true, source: 'db' }
        : { allowed: false, reason: 'rate', source: 'db' };
    }

    // 3) 同窗口：已达上限则拒绝；否则重试窗口内原子累加（覆盖 attempt1 时的瞬时边界）。
    if (d.count >= RATE_LIMIT_MAX) {
      return { allowed: false, reason: 'rate', source: 'db' };
    }
    const retryRes = await coll.where({
      _id: openid,
      windowStart: windowStart,
      count: _.lt(RATE_LIMIT_MAX)
    }).update({ data: { count: _.inc(1), _updatedAt: now } });
    return retryRes.updated === 1
      ? { allowed: true, source: 'db' }
      : { allowed: false, reason: 'rate', source: 'db' };
  } catch (e) {
    // 数据库不可用（未建集合/权限/网络等）：降级内存兜底（仅当前实例，跨实例不精确，代价接受）。
    // B21 修复：补充降级告警。若 sec_check_rate 集合被误删/权限丢失，原本完全静默，
    // 运维侧无法察觉限频已退化为单实例内存、存在被多实例/多设备打爆 mediaCheckAsync 免费额度风险。
    // 仅在每个实例冷启动首次降级时打印完整错误（避免持续故障期日志风暴），
    // 符合「详细错误仅落服务端日志」约定（line 18）。
    if (!_rateDegradeLogged) {
      _rateDegradeLogged = true;
      _rateWasDegraded = true;
      console.error('[secCheck] 限频数据库不可用，已降级为单实例内存兜底（跨实例不精确，存在被打爆 mediaCheckAsync 免费额度风险，请检查 sec_check_rate 集合是否存在/权限是否正确）:', (e && (e.errMsg || e.message)) || e);
    }
    return memoryRateLimit(openid, now);
  }
}

/**
 * 内存兜底限频（仅数据库整体不可用时使用）。
 * 单实例内 JS 单线程天然原子；跨实例无共享，统计不精确——S3 修复结论明确接受此代价（仅降级层）。
 * 窗口语义差异（维护者注意）：本函数使用「以首次请求为锚点的滑动窗口」(windowStart=now)，
 * 而主路径 checkRateLimit 使用「对齐整点的固定窗口」(windowStart=floor(now/1h)*1h)。
 * 两者仅在 DB 不可用时切换，降级期间窗口边界附近配额可能有少量多算/少算，属可接受精度损失。
 * @param {string} openid
 * @param {number} now
 */
function memoryRateLimit(openid, now) {
  // 超过阈值时清理已过期窗口，避免长驻实例内存缓慢增长（L4 修复：阈值从 2000 降到 500）。
  // 原 2000 阈值在「2000+ 个 openid 都在窗口内」时清理无效（只删过期项，不过期则全保留），
  // 内存会持续增长。降到 500 后，即使所有条目都未过期，也至少保留最近 500 个，防止无限增长。
  if (_memRateStore.size > 500) {
    // 不能依赖「插入顺序 == windowStart 顺序」做早停：L225 对已有 key 执行 set() 时只更新
    // windowStart 为 now、但保留原插入位置，会导致靠前的条目拥有更新的 windowStart、靠后的条目
    // 反而可能是过期旧窗口。若此处用 else break 早停，会漏删靠后的过期条目，并在下方 500→300
    // 强制裁剪时误删靠前活跃条目（削弱限频精度）。故改为全量扫描，精确删除所有已过期窗口。
    for (const [k, v] of _memRateStore.entries()) {
      if ((now - v.windowStart) > RATE_LIMIT_WINDOW_MS) _memRateStore.delete(k);
    }
    // 若清理后仍超限（极端情况：500+ 个 openid 都在同一窗口），强制保留最近 300 个
    if (_memRateStore.size > 500) {
      let removed = 0;
      for (const [k] of _memRateStore.entries()) {
        if (removed++ >= 200) break;
        _memRateStore.delete(k);
      }
    }
  }
  const rec = _memRateStore.get(openid);
  if (!rec || (now - rec.windowStart) > RATE_LIMIT_WINDOW_MS) {
    _memRateStore.set(openid, { windowStart: now, count: 1 });
    return { allowed: true, source: 'memory' };
  }
  const newCount = (rec.count || 0) + 1;
  if (newCount > RATE_LIMIT_MAX) {
    return { allowed: false, reason: 'rate', source: 'memory' };
  }
  _memRateStore.set(openid, { windowStart: rec.windowStart, count: newCount });
  return { allowed: true, source: 'memory' };
}

exports.main = async (event) => {
  // 参数防御：云函数运行时 event 已为解析后的对象；若非对象（异常字符串/undefined）则按空对象处理，
  // 后续 fileID 校验会自然返回 invalid fileID。本函数不解析字符串入参（保持简单与健壮）。
  const data = (event && typeof event === 'object') ? event : {};
  const action = data.action || 'submit';

  // action=query：按 trace_id 查询检测结果（前端轮询用，见 utils/secCheck.js）
  if (action === 'query') {
    const traceId = data.traceId;
    if (!traceId || typeof traceId !== 'string') {
      return { errcode: -9, errmsg: 'invalid traceId' };
    }
    try {
      const db = cloud.database();
      const res = await db.collection('sec_check_results').doc(traceId).get().catch(() => ({ data: null }));
      const doc = res && res.data;
      if (doc && doc.suggest) {
        return { errcode: 0, errmsg: 'ok', status: 'done', suggest: String(doc.suggest).toLowerCase() };
      }
      return { errcode: 0, errmsg: 'ok', status: 'pending' };
    } catch (e) {
      console.error('[secCheck] query result failed:', (e && (e.errMsg || e.message)) || e);
      return { errcode: -10, errmsg: 'query failed' };
    }
  }

  const fileID = data.fileID;
  const sceneNum = SCENE_WHITELIST.indexOf(Number(data.scene)) !== -1 ? Number(data.scene) : 2;

  if (!fileID || typeof fileID !== 'string') {
    return { errcode: -1, errmsg: 'invalid fileID' };
  }

  // 10a. 归属校验：仅允许本项目上传路径前缀（前端 uploadToCloud 统一放在 sec_check/ 下）。
  // 解析 fileID 得到存储 key，校验其精确以 sec_check/ 开头且不含 '..' 路径遍历；
  // 不使用子串 includes（如 user/sec_check/x.png 会误过），避免 finally 内 deleteFile
  // 删除非本目录文件（任意文件删除漏洞 / 授权边界绕过）。
  if (!isOwnedSecCheckFile(fileID)) {
    return { errcode: -5, errmsg: 'invalid fileID path' };
  }

  // 当前用户 openid（mediaCheckAsync 必填，云调用自动注入上下文）
  // ⚠️ 开发者工具模拟器下 OPENID 可能为空（未登录/环境未关联）——mediaCheckAsync 要求 openid 必填，
  // 空 openid 会导致接口失败。显式判空以区分「环境问题」与「参数问题」。
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    console.error('[secCheck] OPENID 为空（开发者工具模拟器未登录/环境未关联？），mediaCheckAsync 要求 openid 必填');
    return { errcode: -7, errmsg: 'missing openid' };
  }

  // 10b. 限频检查（必须在任何外部调用之前：超限不消耗额度）
  const rate = await checkRateLimit(OPENID);
  if (!rate.allowed) {
    return { errcode: -6, errmsg: 'rate limited' };
  }

  try {
    // 1) 换取临时访问 URL（mediaCheckAsync 要求 media_url 是检测服务器可下载的公网 URL）
    const urlRes = await cloud.getTempFileURL({ fileList: [fileID] });
    const tmp = (urlRes && urlRes.fileList && urlRes.fileList[0]) || null;
    const tempURL = tmp && tmp.tempFileURL;
    if (!tempURL) {
      return { errcode: -8, errmsg: 'temp url unavailable' };
    }

    // 2) 调用微信内容安全检测（mediaCheckAsync 异步提交，media_type 2=图片）
    //    ⚠️ 注意：msgSecCheck 是「文本」检测接口（wx-server-sdk 映射 /wxa/msg_sec_check），
    //    图片/音频的正确接口是 mediaCheckAsync（/wxa/media_check_async，异步）——
    //    用 msgSecCheck 传图片 media 对象会报 47001 data format error（实测多次复现）。
    //    mediaCheckAsync 提交后立即返回 trace_id，检测结果通过消息推送
    //    （wxa_media_check 事件 → mediaCheckResult 云函数写入 sec_check_results 集合），
    //    前端持有 trace_id 轮询 secCheck(action=query) 获取结果。

    // 兼容旧版 wx-server-sdk / 基础库：mediaCheckAsync 需要 wx-server-sdk ≥ 1.8.0 且基础库 ≥ 2.14.0，
    // 旧版下 cloud.openapi.security.mediaCheckAsync 可能根本不存在，直接调用会抛 TypeError，
    // 被下方 catch 收敛为模糊的 sec_check_internal_error（错误根源彻底丢失，排查困难）。
    // 显式 typeof 判型，缺失时返回明确的「SDK 版本不支持」错误，便于快速定位（升级 wx-server-sdk 即可）。
    if (typeof cloud.openapi.security.mediaCheckAsync !== 'function') {
      console.error('[secCheck] cloud.openapi.security.mediaCheckAsync 不存在（wx-server-sdk 版本过低？需 ≥ 1.8.0，基础库 ≥ 2.14.0），请升级 wx-server-sdk 后重新部署');
      return { errcode: -12, errmsg: 'sdk_unsupported_mediaCheckAsync' };
    }

    console.log('[secCheck] mediaCheckAsync 提交:', JSON.stringify({
      version: 2, scene: sceneNum, openid: OPENID, mediaType: 2, urlPrefix: tempURL.slice(0, 60)
    }));
    const res = await cloud.openapi.security.mediaCheckAsync({
      media_url: tempURL,
      media_type: 2,
      version: 2,
      openid: OPENID,
      scene: sceneNum
    });

    // ⚠️ wx-server-sdk 返回字段是驼峰 traceId（社区案例均为 result.traceId），
    // 与官方文档的下划线 trace_id 不一致；兼容两种写法避免 no trace_id（实测复现）。
    const traceId = res && (res.trace_id || res.traceId);
    if (!traceId) {
      // 记录完整响应便于排查（不含用户敏感信息，仅字段结构）
      console.error('[secCheck] mediaCheckAsync 未返回 trace_id，完整响应:', JSON.stringify(res));
      return { errcode: -11, errmsg: 'no trace_id' };
    }
    // 3) 返回 trace_id（异步检测已受理，结果由推送回写 sec_check_results）
    return { errcode: 0, errmsg: 'ok', trace_id: traceId, status: 'submitted' };
  } catch (e) {
    // 4) 其余错误（网络/频率限制/云调用权限等）：统一收敛为固定 errcode + 通用 errmsg，
    //    绝不把底层异常消息透传客户端（M6 安全修复）。详细错误仅写服务端日志。
    const detail = (e && (e.errMsg || e.message || String(e))) || 'unknown';
    console.error('[secCheck] 内部错误（不回传客户端）:', detail, e && e.stack ? e.stack : '');
    return {
      errcode: (e && e.errCode != null) ? e.errCode : -4,
      errmsg: 'sec_check_internal_error'
    };
  } finally {
    // 5) 清理云存储文件：无论提交是否成功，本文件都曾被上传到 sec_check/ 存储，
    //    统一删除以避免用户图片残留（隐私 + 配额）；此为有意的隐私设计（测试已断言）。
    //    注意：错误路径（如临时 URL 不可用 -8 / SDK 不支持 -12）下检测服务器未必下载过该文件，
    //    但前端 checkImageByPath 在 errcode≠0 时会引导用户「重新选图重传」，本地原图不丢失，故无数据损失。
    try {
      await cloud.deleteFile({ fileList: [fileID] });
    } catch (e) {
      // 删除失败忽略（前端有兜底清理 deleteCloudFile）
    }
  }
};

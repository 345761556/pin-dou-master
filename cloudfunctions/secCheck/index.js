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
//   - 检测结果归属绑定：submit 成功路径向 pending 文档写入 openid + appid，
//        mediaCheckResult 回调侧据此做「pending 存在性 / appid 匹配 / 已定结果不可覆盖」
//        三层校验（防伪造写入与覆盖真实判定）；本函数 query 分支校验归属，
//        知道他人 trace_id 的越权查询只返回 pending（防越权读取判定结果）。
//
// ⚠️ 运维提醒：本函数与 mediaCheckResult 云函数的校验链耦合，改动后必须两个云函数同时重新上传部署，
// 否则校验链断裂（最坏全部图片检测 fail-closed 超时拦截）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * wx-server-sdk update() 返回的「更新条数」双形态兼容读取。
 * 背景（对抗式审查 #30 发现，严重）：微信官方文档（developers.weixin.qq.com）明确
 * Collection.update() / Document.update() 返回结构为 { stats: { updated: number } }，
 * 支持端含云函数（wx-server-sdk）；但社区长期存在「update 返回更新条数位置有歧义」的讨论
 * （部分历史版本/示例以扁平 { updated: N } 呈现）。此前代码直接读 res.updated，
 * 在真实 SDK 返回 { stats: { updated } } 时恒为 undefined → 限频原子自增主路径永不命中，
 * 实际退化为「每用户每窗口仅首次（文档不存在 set 创建）放行、之后一律误判 -6 操作频繁」。
 * 本函数双形态读取（优先扁平、兜底 stats），两种结构都正确返回条数；均缺失按 0 处理。
 * @param {Object} r - update() 的 resolve 结果
 * @returns {number} 成功更新的记录数
 */
function updatedCount(r) {
  if (r && r.updated != null) return r.updated;
  if (r && r.stats && r.stats.updated != null) return r.stats.updated;
  return 0;
}

/**
 * 读取限频文档（openid 为 _id），并区分「文档不存在」与「DB 故障」：
 *   - 文档不存在（throwOnNotFound 抛错且 errMsg 为文档级 not exist/not found/不存在）→ 返回 null，
 *     由调用方走「首次访问创建」逻辑（真实首次访问路径）；
 *   - 其余异常（权限抖动/网络错/DB 故障/集合缺失）→ 原样 rethrow，
 *     由调用方外层 catch 降级内存兜底——【绝不当作「文档不存在」走 set 创建】。
 * 背景（中危 #1）：原实现 .catch(() => ({data:null})) 把一切异常当「文档不存在」→ 后续
 * doc(openid).set() 整文档覆盖写会在 DB 抖动期间把本窗口已累加的 count 清零重置（配额被放宽），
 * 且无降级告警（问题被静默掩盖）。分流后：真故障走降级（有告警、单实例内存、不触碰 DB 计数），
 * 文档不存在才走 set 创建，消除「误判首访 → 覆盖清零」的非并发放大路径。
 * @param {object} coll - 限频集合引用
 * @param {string} openid
 * @returns {Promise<object|null>} 文档 data 或 null（文档不存在）
 */
async function readRateDoc(coll, openid) {
  try {
    const res = await coll.doc(openid).get();
    return (res && res.data && typeof res.data === 'object') ? res.data : null;
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e || '');
    if (/not exist|not found|不存在/i.test(msg) && !/collection|集合/i.test(msg)) return null;
    throw e;
  }
}

// 上传原图文件大小守卫：本项目内容安全走 mediaCheckAsync（异步接口，传 media_url 公网地址，
// 非 msgSecCheck 的 base64 content），媒体文件建议 ≤10MB，此处以 7MB 守卫预留余量。
// ⚠️ 服务端体积复检调查结论（已核实，不实施）：wx-server-sdk 的 cloud.getTempFileURL 返回的
// fileList 项仅含 fileID / tempFileURL / status / errMsg 四字段（官方文档确认，无 size/fileSize），
// 服务端无法低成本获取文件大小，故不做服务端复检。体积防线依赖三重兜底：
//   ① 前端 compressImageIfNeeded(≤800px) 压缩 + getFileSize 7MB 守卫（utils/secCheck.js，唯一硬校验）；
//   ② mediaCheckAsync 接口侧 10MB 媒体上限（超限接口报错 → 全链路 fail-closed）；
//   ③ 每 openid 100/h 限频（下方 checkRateLimit）。
// 历史注释曾误写 msgSecCheck/base64（复制粘贴残留，已移除）。
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
// 未做 openid 子路径绑定（sec_check/<openid>/xxx）的理由：前端拿不到 openid，需额外云调用往返；
// 且文件名由前端 uploadToCloud 生成为「时间戳 + 8 位随机串」（utils/secCheck.js），随机不可猜测，
// 枚举他人 fileID 的成本足够高。
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

// P2-6 修复：query（轮询）分支独立限频参数。前端每秒轮询一次、最长 20 次，单次检测的合法
// 轮询消耗远高于 submit，故上限放宽到 600/h；但必须独立于 submit 配额——原实现 query 分支
// 在 OPENID 校验与限频之前直接 return，可被匿名/恶意刷调用量（免费读额度被打爆）。
// 独立字段 qWindowStart/qCount 与 submit 的 windowStart/count 互不占用、互不重置。
const QUERY_RATE_LIMIT_MAX = 600;

// 内存兜底：仅作为「数据库整体不可用（未建集合/权限/网络）」时的降级层，
// 单实例内 JS 单线程天然原子，但跨实例无一致性——此不精确代价被接受（见 S3 修复结论）。
const _memRateStore = new Map();
// P2-6 修复：query 分支独立的内存兜底存储与降级告警去重标记（与 submit 限频互不干扰）
const _memQueryRateStore = new Map();
let _rateDegradeLogged = false; // B21：限频降级告警去重，每个实例冷启动只打印一次完整错误（避免持续故障期日志风暴）
let _rateWasDegraded = false;   // n4：记录是否曾降级为内存兜底；DB 恢复时据此外部打印「降级已解除」事件（消除恢复后无感知盲区）
let _queryRateDegradeLogged = false; // P2-6：query 限频降级告警去重（同 B21 口径）

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
  if (!openid) return { allowed: false, reason: 'missing openid', source: 'db' };
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

    if (updatedCount(incRes) === 1) {
      return { allowed: true, source: 'db' };
    }

    // 2) updated===0：文档不存在 / 窗口已过期 / 已达上限。读取以区分。
    //    读取用 readRateDoc 分流：真「文档不存在」→ null 走下方首次创建；
    //    DB 故障/权限抖动 → rethrow 走外层 catch 降级内存兜底（绝不误当首访 set 覆盖清零配额）。
    const doc = await readRateDoc(coll, openid);
    const d = doc;
    if (!d) {
      // 清理遗留非规范文档（灰度期间 add() 自动 _id 格式）：best-effort，不影响主流程。
      // 规范文档以 openid 为 _id，全程用 doc(openid) 读取/写入，结构上已无解双文档竞态（L1 修复）。
      // m6 修复：原实现每次请求都执行一次清理查询（约 20-50ms 额外延迟）；灰度迁移已结束、孤立文档
      // 正常情况下不存在，故改为仅在「文档不存在（首次访问）」时清理——绝大多数请求（窗口内累加命中
      // 即返回的常驻用户）不再付出该查询代价，同时保留对罕见孤立文档的安全网（首次访问即顺带清理）。
      try {
        const orphanRes = await coll.where({ openid, _id: _.neq(openid) }).get();
        for (const d of (orphanRes.data || [])) {
          try { await coll.doc(d._id).remove(); }
          catch (e) {
            // P3-11 修复：原 catch 完全静默吞错，若 TCB 对该集合删除权限持续异常，孤立文档无限堆积且零告警。
            // 改为至少 warn 一次（带 openid 前缀 + 错误信息），便于排查权限问题。
            // 注意：仅首次访问（文档不存在）时才触发清理，绝大多数请求不进入此路径，不会产生日志风暴。
            console.warn('[secCheck] 孤立文档删除失败（检查 sec_check_rate 集合删除权限）openid=' + openid + ' _id=' + d._id + ': ' + (e && (e.errMsg || e.message) || e));
          }
        }
      } catch (e) { console.warn('[secCheck] 孤立文档清理查询失败:', (e && (e.errMsg || e.message)) || e); }

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
      if (updatedCount(resetRes) === 1) {
        return { allowed: true, source: 'db' };
      }
      // 重置被抢占（并发请求已抢先完成重置）：此处刻意不加 return，
      // 控制流落入下方 3) 的条件原子累加重新计数。勿在此补 return，
      // 否则被抢占路径会漏计一次（与 checkQueryRateLimit 同款防竞态设计）。
      const retryRes = await coll.where({
        _id: openid,
        windowStart: windowStart,
        count: _.lt(RATE_LIMIT_MAX)
      }).update({ data: { count: _.inc(1), _updatedAt: now } });
      return updatedCount(retryRes) === 1
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
    return updatedCount(retryRes) === 1
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
 * P2-6 修复：query（轮询）分支独立限频检查。
 * 复用 checkRateLimit 的「数据库端原子条件更新」模式（S3 修复同款，杜绝 TOCTOU 并发突破），
 * 但在同一文档（_id=openid）上使用独立字段 qWindowStart/qCount，上限 600/h：
 *   - 独立于 submit 的 count/windowStart，query 轮询不占用、也不会重置 submit 的 100/h 额度；
 *   - 数据库不可用时降级为独立内存 Map（memoryQueryRateLimit，同 memoryRateLimit 口径）。
 * ⚠️ 已知边界（可接受）：文档不存在时的 doc(openid).set 创建在真实 TCB 侧为整文档覆盖写，
 * 与「并发首访的 submit 创建」竞态时可能覆盖掉 submit 的 count/windowStart（submit 配额被
 * 重置一次）。该竞态要求「同一 openid 的首次 submit 与首次 query 几乎同时且文档尚不存在」，
 * 概率极低且后果仅是配额略微放宽（无安全风险），与 checkRateLimit 首访 set 的既有决策一致。
 * @param {string} openid - 当前用户 openid（来自云调用上下文）
 * @returns {Promise<{allowed: boolean, source?: string, reason?: string}>}
 */
async function checkQueryRateLimit(openid) {
  if (!openid) return { allowed: false, reason: 'missing openid', source: 'db' };
  const now = Date.now();
  try {
    const db = cloud.database();
    const _ = db.command;
    const coll = db.collection(RATE_LIMIT_COLLECTION);
    const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;

    // 1) 窗口内原子累加（独立字段 qCount/qWindowStart）：updated===1 即放行
    const incRes = await coll.where({
      _id: openid,
      qWindowStart: windowStart,
      qCount: _.lt(QUERY_RATE_LIMIT_MAX)
    }).update({ data: { qCount: _.inc(1), _updatedAt: now } });
    if (updatedCount(incRes) === 1) {
      return { allowed: true, source: 'db' };
    }

    // 2) updated===0：文档不存在 / q 窗口已过期 / q 已达上限。读取以区分。
    //    与 checkRateLimit 同款 readRateDoc 分流：真「文档不存在」→ null 走首次创建；
    //    DB 故障/权限抖动 → rethrow 走外层 catch 降级（不误当首访 set 覆盖 submit 计数）。
    const doc = await readRateDoc(coll, openid);
    const d = doc;
    if (!d) {
      // 首次访问：原子创建（仅写 query 字段，不触碰 submit 字段）。
      // ⚠️ 已知边界（并发首访）：TCB 的 doc().set 为整文档覆盖写，与「并发首访的 submit 创建」
      // 竞态时可能覆盖掉 submit 的 count/windowStart（submit 配额被重置一次）；该竞态要求
      // 「同一 openid 的首次 submit 与首次 query 几乎同时且文档尚不存在」，概率极低且后果
      // 仅是配额略微放宽（无安全风险），与 checkRateLimit 首访 set 的既有决策一致（文档化可接受）。
      await coll.doc(openid).set({
        data: { _id: openid, openid, qWindowStart: windowStart, qCount: 1, _updatedAt: now }
      });
      return { allowed: true, source: 'db' };
    }
    if (d.qWindowStart !== windowStart) {
      // q 窗口过期（含文档由 submit 创建、q 字段尚为 undefined 的情形）：原子重置
      const resetRes = await coll.where({
        _id: openid,
        qWindowStart: _.neq(windowStart)
      }).update({ data: { qWindowStart: windowStart, qCount: 1, _updatedAt: now } });
      if (updatedCount(resetRes) === 1) {
        return { allowed: true, source: 'db' };
      }
      // 重置被抢占（并发请求已抢先完成重置）：此处刻意不加 return，
      // 控制流落入下方 3) 的条件原子累加重新计数。⚠️ 勿在此补 return，
      // 否则被抢占路径会漏计一次（与 checkRateLimit 同款防竞态设计）。
    }

    // 3) 同窗口 / 重置被抢占：重试原子累加（覆盖瞬时边界），仍不满足则超限
    const retryRes = await coll.where({
      _id: openid,
      qWindowStart: windowStart,
      qCount: _.lt(QUERY_RATE_LIMIT_MAX)
    }).update({ data: { qCount: _.inc(1), _updatedAt: now } });
    return updatedCount(retryRes) === 1
      ? { allowed: true, source: 'db' }
      : { allowed: false, reason: 'rate', source: 'db' };
  } catch (e) {
    // 数据库不可用：降级独立内存兜底（同 B21 口径，每实例冷启动仅告警一次）
    if (!_queryRateDegradeLogged) {
      _queryRateDegradeLogged = true;
      console.error('[secCheck] query 限频数据库不可用，已降级为单实例内存兜底（跨实例不精确，请检查 sec_check_rate 集合是否存在/权限是否正确）:', (e && (e.errMsg || e.message)) || e);
    }
    return memoryQueryRateLimit(openid, now);
  }
}

/**
 * P2-6 修复：query 分支的内存兜底限频（仅数据库整体不可用时使用）。
 * 语义与 memoryRateLimit 一致（首请求锚点滑动窗口、单实例内原子、跨实例不精确可接受），
 * 使用独立 Map，与 submit 限频互不干扰。
 * @param {string} openid
 * @param {number} now
 */
function memoryQueryRateLimit(openid, now) {
  // 大小防护（交叉审查 #9 修复）：P2-6 新增本函数时漏抄了 memoryRateLimit 的 L4 三段式清理，
  // DB 长时间不可用 + 长驻实例涌入大量独立 openid 时，本 Map 无限增长最终可致云函数 OOM。
  // 语义与 memoryRateLimit 完全一致（阈值 500 → 全量清扫过期窗口 → 仍超限则强制裁剪至 300）。
  // 注意：不能依赖插入顺序 == windowStart 顺序做早停：L2 对已有 key 执行 set() 时只更新
  // windowStart 为 now、但保留原插入位置，会导致靠前的条目拥有更新的 windowStart、靠后的条目
  // 反而可能是过期旧窗口。若此处用 else break 早停，会漏删靠后的过期条目，并在下方 500→300
  // 强制裁剪时误删靠前活跃条目（削弱限频精度）。故改为全量扫描，精确删除所有已过期窗口。
  if (_memQueryRateStore.size > 500) {
    for (const [k, v] of _memQueryRateStore.entries()) {
      if ((now - v.windowStart) > RATE_LIMIT_WINDOW_MS) _memQueryRateStore.delete(k);
    }
    if (_memQueryRateStore.size > 500) {
      let removed = 0;
      for (const [k] of _memQueryRateStore.entries()) {
        if (removed++ >= 200) break;
        _memQueryRateStore.delete(k);
      }
    }
  }
  const rec = _memQueryRateStore.get(openid);
  if (!rec || (now - rec.windowStart) > RATE_LIMIT_WINDOW_MS) {
    _memQueryRateStore.set(openid, { windowStart: now, count: 1 });
    return { allowed: true, source: 'memory' };
  }
  const newCount = (rec.count || 0) + 1;
  if (newCount > QUERY_RATE_LIMIT_MAX) {
    return { allowed: false, reason: 'rate', source: 'memory' };
  }
  _memQueryRateStore.set(openid, { windowStart: rec.windowStart, count: newCount });
  return { allowed: true, source: 'memory' };
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
    // P2-6 修复：OPENID 判空与 submit 同口径（-7）——原实现 query 分支在校验之前直接 return，
    // 匿名调用（模拟器未登录/伪造请求）可无限刷读数据库调用量
    const queryCtx = cloud.getWXContext();
    if (!queryCtx || !queryCtx.OPENID) {
      console.error('[secCheck] query OPENID 为空（开发者工具模拟器未登录/环境未关联？），拒绝服务');
      return { errcode: -7, errmsg: 'missing openid' };
    }
    // P2-6 修复：query 独立限频（600/h，独立字段 qCount，不占用 submit 的 100/h 额度）。
    // 超限返回 -6：前端 pollSecCheckResult 对非 0 errcode 仅继续轮询直至超时 fail-closed，
    // 属可自愈的瞬时限流，无需前端特殊处理。
    const queryRate = await checkQueryRateLimit(queryCtx.OPENID);
    if (!queryRate.allowed) {
      return { errcode: -6, errmsg: 'rate limited' };
    }
    try {
      const db = cloud.database();
      // P3-10 修复：原 .catch(() => ({data:null})) 把集合不存在/权限错误/网络故障等所有异常
      // 统一降级为 data:null → 返回 pending，完全掩盖 DB 侧故障，运维不可见。改为不吞异常，
      // 让外层 catch 返回 errcode -10（fail-closed，前端轮询收到 -10 后 fail-closed 拦截，
      // 与 L2 readPendingDoc 同口径）。文档不存在时 doc().get() 抛 errcode 2 的 not_found 错误，
      // 外层 catch 收敛为 -10 → 前端轮询超时 fail-closed，与"未出结果"语义一致。
      const res = await db.collection('sec_check_results').doc(traceId).get();
      const doc = res && res.data;
      if (doc && doc.suggest) {
        // 归属绑定：结果仅对提交者可见。知道他人 trace_id 的越权查询返回 pending
        //（而非泄露判定），与「未出结果」不可区分，不给攻击者任何探测信号。
        // 向后兼容：旧文档无 openid 字段时放行（doc.openid 为 undefined 时条件不成立）。
        if (doc.openid && doc.openid !== queryCtx.OPENID) {
          console.warn('[secCheck] query 归属不匹配，拒绝返回结果 traceId=' + traceId);
          return { errcode: 0, errmsg: 'ok', status: 'pending' };
        }
        return { errcode: 0, errmsg: 'ok', status: 'done', suggest: String(doc.suggest).toLowerCase() };
      }
      return { errcode: 0, errmsg: 'ok', status: 'pending' };
    } catch (e) {
      console.error('[secCheck] query result failed:', (e && (e.errMsg || e.message)) || e);
      return { errcode: -10, errmsg: 'query failed' };
    }
  }

  // action=text：文本内容安全检测（P1-1 修复：昵称等 UGC 文本接入 msgSecCheck v2 同步接口）
  if (action === 'text') {
    const content = data.content;
    // 参数校验：非空字符串；长度 ≤50（昵称输入上限口径，按「码点」计数——含 emoji/生僻字的
    // 文本一个字符占 2 个 UTF-16 code unit，content.length 会把「30 个 emoji」误判为 60 超长，
    // 与前端 checkText 的 [...content].length 口径保持一致），超长拒绝（不静默截断，
    // 让调用方明确感知参数问题），与图片链路的非法入参错误码风格一致
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return { errcode: -1, errmsg: 'invalid content' };
    }
    if ([...content].length > 50) {
      return { errcode: -2, errmsg: 'content too long' };
    }
    // OPENID 判空：msgSecCheck v2 要求 openid 必填（与 submit 口径一致）
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) {
      console.error('[secCheck] text OPENID 为空（开发者工具模拟器未登录/环境未关联？）');
      return { errcode: -7, errmsg: 'missing openid' };
    }
    // 过 submit 同款限频：文本检测同样消耗 msgSecCheck 免费额度，与图片共享 100/h 合理
    const rate = await checkRateLimit(OPENID);
    if (!rate.allowed) {
      return { errcode: -6, errmsg: 'rate limited' };
    }
    try {
      // 旧版 wx-server-sdk 可能无 msgSecCheck 方法：typeof 判型给出明确错误码
      // （仿 mediaCheckAsync 的 -12 分支，避免抛 TypeError 被 catch 吞成模糊 internal_error）
      if (typeof cloud.openapi.security.msgSecCheck !== 'function') {
        console.error('[secCheck] cloud.openapi.security.msgSecCheck 不存在（wx-server-sdk 版本过低？需 ≥ 1.8.0），请升级 wx-server-sdk 后重新部署');
        return { errcode: -12, errmsg: 'sdk_unsupported_msgSecCheck' };
      }
      // R1 修复：msgSecCheck v2 的 scene 为必填参数（1资料/2评论/3论坛/4社交日志），
      // 缺失会报参数错误被收敛为 -4 → 前端 fail-closed → 正式版昵称完全无法保存。
      // 昵称编辑属「资料」场景，固定 scene=1。
      const res = await cloud.openapi.security.msgSecCheck({
        version: 2,
        scene: 1,
        openid: OPENID,
        content: content
      });
      // msgSecCheck v2 同步返回 result.suggest（pass/review/risky）
      const suggest = res && res.result && res.result.suggest ? String(res.result.suggest).toLowerCase() : '';
      if (!suggest) {
        console.error('[secCheck] msgSecCheck 未返回 suggest，完整响应:', JSON.stringify(res));
        return { errcode: -11, errmsg: 'no suggest' };
      }
      return { errcode: 0, errmsg: 'ok', suggest };
    } catch (e) {
      // 异常收敛为固定 errmsg，绝不透传底层异常细节（M6 口径）；详细错误仅落服务端日志
      const detail = (e && (e.errMsg || e.message || String(e))) || 'unknown';
      console.error('[secCheck] 文本检测内部错误（不回传客户端）:', detail, e && e.stack ? e.stack : '');
      return {
        errcode: (e && e.errCode != null) ? e.errCode : -4,
        errmsg: 'sec_check_internal_error'
      };
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
  // APPID 一并取出：写入 pending 文档供 mediaCheckResult 回调侧做 L3 appid 匹配校验（best-effort）。
  const { OPENID, APPID } = cloud.getWXContext();
  if (!OPENID) {
    console.error('[secCheck] OPENID 为空（开发者工具模拟器未登录/环境未关联？），mediaCheckAsync 要求 openid 必填');
    return { errcode: -7, errmsg: 'missing openid' };
  }

  // 10b. 限频检查（必须在任何外部调用之前：超限不消耗额度）
  const rate = await checkRateLimit(OPENID);
  if (!rate.allowed) {
    return { errcode: -6, errmsg: 'rate limited' };
  }

  // P2-6 修复：submit 成功标记。成功路径不在 finally 立即删文件——mediaCheckAsync 是异步接口，
  // 检测服务器在提交后数秒才下载 media_url，原「finally 立即 deleteFile」与之竞态会导致
  // 下载失败（-1008）→ 合法图被误拦。成功路径的文件由 mediaCheckResult 写入最终结果后
  // 兜底删除 + 前端轮询结束后兜底删除（用户图片不残留的隐私目标不变）。
  let submitSucceeded = false;
  try {
    // 1) 换取临时访问 URL（mediaCheckAsync 要求 media_url 是检测服务器可下载的公网 URL）。
    //    ⚠️ 校验 fileList 项的 status（外部审查 #5）：getTempFileURL 返回 { status, tempFileURL, errMsg }，
    //    status!==0 表示换 URL 失败（文件不存在/权限），此时 tempFileURL 可能为空或带残留值——仅判
    //    tempFileURL 空串会漏掉「status 非 0 但带残留 URL」的异常响应，把不可下载的 URL 交给
    //    检测服务器 → 必然 -1008 下载失败（白白消耗一次检测配额且用户看到无谓失败）。
    const urlRes = await cloud.getTempFileURL({ fileList: [fileID] });
    const tmp = (urlRes && urlRes.fileList && urlRes.fileList[0]) || null;
    const tempURL = tmp && tmp.tempFileURL;
    if (!tmp || tmp.status !== 0 || !tempURL) {
      console.warn('[secCheck] getTempFileURL 返回异常（status=' + (tmp && tmp.status) + '），拒绝提交 fileID=' + fileID);
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

    // 云日志脱敏（与 app.js traceUser:false 的最小化立场一致）：openid 虽仅开发者可见，
    // 但属可识别用户身份信息——日志只打首 4 + 尾 4 打码形式，保留排查所需的可关联性；
    // tempURL 为短期有效的临时下载地址、不含身份语义，保留前 60 字符用于定位上传对象。
    const maskedOpenid = (typeof OPENID === 'string' && OPENID.length > 8)
      ? OPENID.slice(0, 4) + '****' + OPENID.slice(-4) : '***';
    console.log('[secCheck] mediaCheckAsync 提交:', JSON.stringify({
      version: 2, scene: sceneNum, openid: maskedOpenid, mediaType: 2, urlPrefix: tempURL.slice(0, 60)
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

    // P2-6 修复：submit 成功后向 sec_check_results 写入 pending 文档并保留 fileID。
    // mediaCheckResult 稍后写最终结果时据此取回 fileID 做兜底删除（set 覆盖写会丢字段，
    // 必须在此先落盘 fileID）。
    // 安全加固：pending 文档额外写入 openid + appid，作为 mediaCheckResult 回调侧
    // 「L2 pending 存在性 / L3 appid 匹配」校验与 query 归属绑定的信任锚点——
    // 只有真实提交过的 trace_id 才存在 pending 文档，伪造推送因此无法凭空写入结果；
    // openid 供 query 分支校验「结果仅对提交者可见」，appid 供回调侧 best-effort 比对。
    // 【安全加固】pending 写入失败 → 阻断本次提交（fail-closed）：mediaCheckResult 的
    // L2 要求「必须存在 pending 文档」才写结果，若此处仅 warn 仍返回成功，则 DB 瞬断窗口期
    // 提交的图片「表面受理、实际结果推送必被 L2 拒绝」→ 前端轮询超时 fail-closed 误拦，
    // 用户看到的是无提示的检测失败。阻断返回错误码让前端明确提示重试（重试时 DB 若已恢复
    // 则正常走通）；已受理的 mediaCheckAsync 检测推送到达 mediaCheckResult 时 L2 无 pending
    // 会忽略（无害，且本函数 finally 已删除中转文件，无残留）。
    try {
      await cloud.database().collection('sec_check_results').doc(traceId).set({
        data: {
          status: 'pending',
          fileID: fileID,
          openid: OPENID,
          appid: APPID || '',
          createdAt: Date.now()
        }
      });
    } catch (e) {
      console.error('[secCheck] 写入 pending 文档失败，阻断本次提交（fail-closed，避免「表面受理实际必被误拦」）trace_id=' + traceId + ':', (e && (e.errMsg || e.message)) || e);
      return { errcode: -14, errmsg: 'pending write failed' };
    }
    // 3) 返回 trace_id（异步检测已受理，结果由推送回写 sec_check_results）
    submitSucceeded = true;
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
    // 5) 清理云存储文件（P2-6 修复：删除时机后移）：
    //    - 失败路径（errcode≠0 / 抛异常 / 无 trace_id 等）：检测服务器不会消费该文件，
    //      仍立即删除（隐私 + 配额清理不变；前端 checkImageByPath 会引导用户重选图重传，无数据损失）。
    //    - 成功路径：不在 finally 立即删除（与 mediaCheckAsync 异步下载 media_url 竞态，
    //      立即删会致 -1008 误拦合法图）。文件由 mediaCheckResult 写入最终结果后兜底删除，
    //      前端 pollSecCheckResult 结束后另有 deleteCloudFile 二层兜底。
    //    注意：错误路径（如临时 URL 不可用 -8 / SDK 不支持 -12）下检测服务器未必下载过该文件，
    //    但前端在 errcode≠0 时会引导用户「重新选图重传」，本地原图不丢失，故无数据损失。
    if (!submitSucceeded) {
      try {
        await cloud.deleteFile({ fileList: [fileID] });
      } catch (e) {
        // 删除失败忽略（前端有兜底清理 deleteCloudFile）
      }
    }
  }
};

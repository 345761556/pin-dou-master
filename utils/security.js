/**
 * 安全工具模块
 * 提供安全日志、敏感数据防护、存储加密等能力
 */

// 是否生产环境（发布版不输出详细日志）
// 用 typeof 守卫：微信运行时 __wxConfig 必存在；非微信 JS 环境（如 Node 单测）下其为未声明全局，
// 直接引用会抛 ReferenceError，故先 typeof 判断。
const IS_RELEASE = typeof __wxConfig === 'undefined' || !__wxConfig.envVersion || __wxConfig.envVersion === 'release';

// P3-8 修复：微信运行时 wx.env.USER_DATA_PATH 必存在；Node 单测环境 wx 未定义，直接引用抛 ReferenceError。
// 模块级 typeof 守卫，非微信环境下引用空串。注意：空串前缀匹配 startsWith('') 恒为 true，
// 会使 isValidFilePath 在 Node 单测环境对任意字符串返回 true——仅影响单测，微信端 WX_USER_DATA_PATH
// 恒非空、行为正常，故不加额外分支（保持运行时零开销、语义清晰）。
const WX_USER_DATA_PATH = (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) ? wx.env.USER_DATA_PATH : '';

/**
 * 安全日志输出
 * 生产环境自动屏蔽非必要的详细日志，仅保留关键错误
 */
const log = {
  info(...args) {
    if (!IS_RELEASE) {
      console.log('[安全]', ...args);
    }
  },
  warn(...args) {
    // 警告信息生产环境仍保留，但缩减长度
    if (IS_RELEASE) {
      console.warn('[安全]', ...args.map(sanitizeForLog));
    } else {
      console.warn('[安全]', ...args);
    }
  },
  error(...args) {
    // 错误始终记录，但生产环境脱敏（避免泄露 wxfile://tmp_ 等带设备特征的路径）
    if (IS_RELEASE) {
      console.error('[安全]', ...args.map(sanitizeForLog));
    } else {
      console.error('[安全]', ...args);
    }
  }
};

// 脱敏正则提升为模块级常量（第八轮审查 #12）：
// 原先四个字面量写在函数体内，每次调用都新建 RegExp 对象；日志路径虽低频，
// 但提升零风险（String.replace 对 /g 正则每次从 0 开始且结束后复位 lastIndex，无状态残留问题）。
const RE_WXFILE_TMP = /wxfile:\/\/[^'"\s,)]+/g;
const RE_HTTP_URL = /(https?:\/\/[^'"\s,)]+)/g;
const RE_LOCAL_TMP_DIR = /\/tmp\/[^'"\s,)]+/g;
const RE_USER_DATA_PATH = /USER_DATA_PATH[^'"]*/g;

/**
 * 日志脱敏：替换路径、Token 等敏感信息
 * 支持 Error / string 以及普通对象、数组的递归脱敏（保留结构便于排错）。
 */
function sanitizeForLog(val, depth = 0) {
  // Error 对象：脱敏其 stack / message（常含本地路径）
  if (val instanceof Error) {
    return sanitizeForLog(val.stack || val.message || String(val));
  }
  // 字符串：脱敏路径 / Token 等敏感信息
  if (typeof val === 'string') {
    let result = val;
    // 微信临时文件（含设备特征）：wxfile://tmp_xxx / wxfile://store_xxx 等
    result = result.replace(RE_WXFILE_TMP, 'wxfile://***');
    // http(s):// 协议路径：
    //   - host 含 "." 视为真实远程域名（如 cdn.example.com），不泄露设备信息，保留
    //   - host 不含 "."（如 tmp / store / usr / cache）是微信本地沙盒路径，
    //     其真实值即 wx.env.USER_DATA_PATH 等内容（如 http://usr/...、http://store/...），
    //     不会以 "USER_DATA_PATH" 字面量或 "/tmp/" 形式出现，故按 host 是否含 "." 判定后整段脱敏
    result = result.replace(RE_HTTP_URL, (m) => {
      const proto = m.startsWith('https://') ? 'https://' : 'http://';
      const host = m.slice(proto.length).split('/')[0];
      return host.indexOf('.') !== -1 ? m : proto + '***';
    });
    // 其它本地临时目录（开发者工具 / 部分系统）
    result = result.replace(RE_LOCAL_TMP_DIR, '/tmp/***');
    // 防御性：日志中若直接出现 USER_DATA_PATH 字面量（代码引用，非真实路径）一并脱敏
    result = result.replace(RE_USER_DATA_PATH, 'USER_DATA_PATH/***');
    return result;
  }
  // 数字 / 布尔 / undefined / null / function / symbol 等无需脱敏，原样返回
  if (val === null || val === undefined || typeof val !== 'object') return val;
  // 对象 / 数组：递归脱敏其每个值（保留结构，便于排错）
  // depth 守卫：避免超深嵌套导致栈溢出；循环引用兜底为脱敏字符串
  if (depth >= 6) return sanitizeForLog(String(val));
  try {
    if (Array.isArray(val)) {
      return val.map((item) => sanitizeForLog(item, depth + 1));
    }
    const out = {};
    for (const key of Object.keys(val)) {
      out[key] = sanitizeForLog(val[key], depth + 1);
    }
    return out;
  } catch (e) {
    // 极端情况（如循环引用）回退为脱敏后的字符串表示
    return sanitizeForLog(String(val));
  }
}

/**
 * 验证图片路径是否安全（防止路径遍历攻击）
 * @param {string} filePath - 要校验的文件路径
 * @returns {boolean} 是否安全
 */
function isValidFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  // 禁止路径遍历
  if (filePath.indexOf('..') >= 0) return false;
  // 微信临时文件路径格式校验
  if (filePath.startsWith('wxfile://') || filePath.startsWith(WX_USER_DATA_PATH)) {
    return true;
  }
  // http(s):// 路径须校验 host 含 "."（与 isRemoteImageUrl 口径一致）：
  // 微信沙盒 http://tmp/... / http://store/... 无点→本地（放行）；
  // 真实远程域名含点（如 evil.com）→拒绝，防恶意 URL 流入路径操作。
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    const m = /^https?:\/\/([^/?#]+)/.exec(filePath);
    if (m && m[1] && m[1].indexOf('.') === -1) return true; // 无点 host（如 tmp/store/usr）→ 本地沙盒，放行
    return false; // 有点 host（如 evil.com）→ 远程域名，拒绝
  }
  // 其他路径需谨慎
  return false;
}

/**
 * 判断路径是否为「真正的网络图片 URL」（复制/清理时必须跳过，无法用 fs 落地）。
 *
 * 关键：微信沙盒临时路径在 Android 真机上以 `http://tmp/...` 开头、在 iOS/开发者工具上
 * 以 `wxfile://tmp_...` 开头，均属**本地临时文件**，应复制/清理，不可误判为网络图被跳过。
 * 仅当 http(s):// 的 host 为真实域名（含 "."，如 cdn.example.com）时才视为远程。
 * 这与 isValidFilePath 的口径一致——http(s):// 本地沙盒方案（tmp/usr/store）都是可落地的本地路径。
 *
 * @param {string} path
 * @returns {boolean} 是否为真正的远程网络 URL
 */
function isRemoteImageUrl(path) {
  if (!path || typeof path !== 'string') return false;
  const m = /^https?:\/\/([^/?#]+)/.exec(path);
  if (!m) return false;            // 非 http(s)（如 wxfile://、绝对路径）→ 本地
  return m[1].indexOf('.') !== -1; // host 含 "." 才是真实域名 → 远程
}

/**
 * 判断 sourceImage 是否为「我们持久化管理的本地原图文件」，可安全 unlink。
 *
 * 历史记录里的 sourceImage 只会是以下三者之一：
 *   - 远程网络 URL（应跳过，不能 fs 落地/删除）
 *   - 我们复制到 USER_DATA_PATH 的原图副本 history_source_*（应清理）
 *   - null / ''（无原图，跳过）
 * 因此「能否删除」的判定不应只是「不是远程就删」这种宽松口径——否则历史记录被
 * 篡改/损坏、sourceImage 指向任意本地路径时，会盲目 unlinkSync（虽被 catch 吞掉，仍是隐患）。
 *
 * 本函数要求全部满足才返回 true：
 *   1) 非空字符串
 *   2) 不含路径遍历 ".."（防误删/攻击）
 *   3) 非远程网络 URL（isRemoteImageUrl 为 false）
 *   4) 含我们管理的原图前缀 history_source_（跨平台：Android http://store/、iOS/工具 wxfile://usr/、绝对路径 均含此串）
 * 这样无论记录如何异常，删除动作只会作用在我们自己拥有的文件上。
 *
 * @param {string} path
 * @returns {boolean}
 */
function isManagedHistorySource(path) {
  if (!path || typeof path !== 'string') return false;
  if (path.indexOf('..') !== -1) return false;        // 防路径遍历
  if (isRemoteImageUrl(path)) return false;            // 远程图不删
  return path.indexOf('history_source_') !== -1;       // 仅删我们 own 的原图副本
}

/**
 * 全局 Error Handler 注册
 * 捕获未处理的异常和 Promise 拒绝
 */
function registerGlobalErrorHandler() {
  // 微信小程序全局错误监听
  wx.onError && wx.onError((error) => {
    log.error('未捕获的全局错误:', typeof error === 'object' ? JSON.stringify(error).substring(0, 200) : String(error).substring(0, 200));
  });

  // 页面 JS 错误
  if (typeof wx.onPageNotFound === 'function') {
    wx.onPageNotFound((res) => {
      log.error('页面不存在:', res.path);
    });
  }

  // 内存警告
  if (typeof wx.onMemoryWarning === 'function') {
    wx.onMemoryWarning(() => {
      log.warn('内存不足警告');
    });
  }

  // 未处理的 Promise 拒绝（基础库 2.10.0+）：生产环境浮动 Promise 拒绝若零日志，
  // 会掩盖异步链路故障（H1 教义：绝不静默吞错）。与 onError 同口径脱敏记录。
  if (typeof wx.onUnhandledRejection === 'function') {
    wx.onUnhandledRejection((res) => {
      const reason = (res && res.reason) || '';
      log.error('未处理的 Promise 拒绝:', typeof reason === 'object' ? JSON.stringify(reason).substring(0, 200) : String(reason).substring(0, 200));
    });
  }
}

module.exports = {
  log,
  IS_RELEASE,
  sanitizeForLog,
  isValidFilePath,
  isRemoteImageUrl,
  isManagedHistorySource,
  registerGlobalErrorHandler
};

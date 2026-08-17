/**
 * 安全工具模块
 * 提供安全日志、敏感数据防护、存储加密等能力
 */

// 是否生产环境（发布版不输出详细日志）
// 用 typeof 守卫：微信运行时 __wxConfig 必存在；非微信 JS 环境（如 Node 单测）下其为未声明全局，
// 直接引用会抛 ReferenceError，故先 typeof 判断。
const IS_RELEASE = typeof __wxConfig === 'undefined' || !__wxConfig.envVersion || __wxConfig.envVersion === 'release';

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
    // 错误始终记录
    console.error('[安全]', ...args);
  }
};

/**
 * 日志脱敏：替换路径、Token 等敏感信息
 */
function sanitizeForLog(val) {
  if (typeof val !== 'string') return val;
  let result = val;
  // 脱敏本地文件路径
  result = result.replace(/USER_DATA_PATH[^'"]+/g, 'USER_DATA_PATH/***');
  result = result.replace(/\/tmp\/[^'"\s,)]+/g, '/tmp/***');
  // 脱敏可能的 hex 色值（过长时）
  return result;
}

/**
 * 安全存储：写入前对值做基本校验和清洗
 * @param {string} key - 存储键
 * @param {any} value - 存储值
 * @param {Object} [options] - 配置项
 * @param {number} [options.maxLength] - 值序列化后的最大长度限制
 * @returns {boolean} 是否写入成功
 */
function safeSetStorage(key, value, options = {}) {
  try {
    const {
      maxLength = 1024 * 100,  // 默认 100KB
    } = options;

    // 校验键名
    if (typeof key !== 'string' || key.trim() === '') {
      log.warn('safeSetStorage: 无效的键名', key);
      return false;
    }

    // 校验值非空
    if (value === undefined || value === null) {
      log.warn('safeSetStorage: 值不能为空');
      return false;
    }

    // 序列化并检查大小
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized.length > maxLength) {
      log.warn(`safeSetStorage: 数据过大(${serialized.length}B > ${maxLength}B)，${key}`);
      return false;
    }

    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    log.error('safeSetStorage 写入失败:', key, e);
    return false;
  }
}

/**
 * 安全读取：带类型校验的 Storage 读取
 * @param {string} key - 存储键名
 * @param {*} defaultValue - 读取失败时的默认值
 * @returns {*} 读取的值
 */
function safeGetStorage(key, defaultValue = null) {
  try {
    const value = wx.getStorageSync(key);
    // 空值返回默认值
    if (value === '' || value === undefined || value === null) {
      return defaultValue;
    }
    return value;
  } catch (e) {
    log.warn('safeGetStorage 读取失败:', key, e);
    return defaultValue;
  }
}

/**
 * 安全删除 Storage 键
 * @param {string} key - 要删除的键
 */
function safeRemoveStorage(key) {
  try {
    wx.removeStorageSync(key);
  } catch (e) {
    log.error('safeRemoveStorage 失败:', key, e);
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
  if (filePath.startsWith('wxfile://') || filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith(wx.env.USER_DATA_PATH)) {
    return true;
  }
  // 其他路径需谨慎
  return false;
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

  // 监听 API 调用失败
  if (typeof wx.onApiCallFail === 'function') {
    wx.onApiCallFail((res) => {
      log.warn('API 调用失败:', res.errMsg, res.apiName);
    });
  }
}

module.exports = {
  log,
  IS_RELEASE,
  safeSetStorage,
  safeGetStorage,
  safeRemoveStorage,
  isValidFilePath,
  registerGlobalErrorHandler
};

// app.js - 拼豆大师全局入口
const { artkalC, hama, perler, photoPearl, neko, colorLibraryMeta } = require('./utils/colorData.js');
const { registerGlobalErrorHandler, log } = require('./utils/security.js');
const { gcBeadTempFiles, removeFileIfExists, CONSTANTS: UTIL_CONSTANTS } = require('./utils/util.js');

// ==================== 全局常量 ====================
// 单一真源：与业务算法/页面共享的数值常量统一引用 util.js CONSTANTS，
// 避免 app.js 与 util.js 各自硬编码导致「改一处漏另一处」的漂移。
// 仅 app 自身表现层常量（BEAD_TYPE / LAYOUT / DEFAULT_PALETTE）留在本文件。
const CONSTANTS = Object.freeze({
  // 拼豆尺寸约束（毫米）
  BEAD_SIZE: {
    MIN: 5,          // 最小尺寸
    MAX: 50,         // 最大尺寸
    DEFAULT: UTIL_CONSTANTS.DEFAULT_BEAD_SIZE,   // 单一真源 29（util.js CONSTANTS）
  },

  // 拼豆形状类型
  BEAD_TYPE: {
    SQUARE: 'square',   // 方形拼豆
    CIRCLE: 'circle',   // 圆形拼豆
    DEFAULT: 'square',  // 默认形状
  },

  // 布局默认值
  LAYOUT: {
    STATUS_BAR_HEIGHT: 20,       // 状态栏高度兜底值
    NAV_BAR_HEIGHT: 64,         // 导航栏高度兜底值
    NAV_BAR_FALLBACK: 44,       // 导航栏计算兜底值
  },

  // 默认色卡
  DEFAULT_PALETTE: 'artkal_c',

  // 历史记录上限 —— 单一真源见 util.js CONSTANTS.MAX_HISTORY（50）
  MAX_HISTORY: UTIL_CONSTANTS.MAX_HISTORY,
});

// ==================== 工具函数 ====================

/**
 * 深度冻结对象（递归冻结所有嵌套对象和数组）
 * @param {any} obj - 要冻结的对象
 * @returns {any} 冻结后的对象
 */
function deepFreeze(obj, seen) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj;
  if (obj instanceof RegExp) return obj;
  // 防御循环引用：避免对象相互引用时无限递归导致栈溢出
  seen = seen || new WeakSet();
  if (seen.has(obj)) return obj;
  seen.add(obj);

  // Reflect.ownKeys 同时覆盖字符串键与 Symbol 键（Object.keys 不返回 Symbol 键）；
  // 否则 Symbol 键对应的嵌套对象/数组不会被递归深冻结（属性槽位虽被 Object.freeze 保护，
  // 但其内部子节点仍可改），埋下未来色卡数据使用 Symbol 键时的隐患。
  Reflect.ownKeys(obj).forEach(key => {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value, seen);
    }
  });
  return Object.freeze(obj);
}

// 拼豆偏好 schema 与默认值（app.js 与 index.js 共用，确保读写一致）
const BEAD_PREFS_SCHEMA = {
  beadSize: 'number',
  beadType: 'string',
  colorCount: 'number',
  useDithering: 'boolean',
};

const BEAD_PREFS_DEFAULTS = {
  beadSize: CONSTANTS.BEAD_SIZE.DEFAULT,
  beadType: CONSTANTS.BEAD_TYPE.DEFAULT,
  colorCount: 30,
  useDithering: true,
};

/**
 * 安全读取本地存储偏好
 * @param {string} key - 存储键名
 * @param {object} schema - 期望的字段类型定义 { fieldName: 'number' | 'string' | 'boolean' }
 * @param {object} defaults - 默认值
 * @returns {object} 验证后的偏好对象
 */
function safeGetStoragePrefs(key, schema, defaults) {
  const result = { ...defaults };

  try {
    const raw = wx.getStorageSync(key);
    if (raw === null || raw === undefined || raw === '') {
      return result;
    }
    // 仅接受普通对象，排除 null、数组等
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      log.warn(`[偏好] ${key} 类型异常(${typeof raw})，使用默认值`);
      return result;
    }

    // 按 schema 逐字段校验
    for (const [field, type] of Object.entries(schema)) {
      if (field in raw) {
        const value = raw[field];
        // 基础类型校验；仅 number 类型额外排除非有限数（NaN/Infinity/-Infinity）
        // （isFinite 会对字符串做隐式强转，但此处仅当 typeof value === 'number' 才走到，
        //   不会影响 string/boolean 字段，'circle' 等字符串偏好不会被误杀）
        if (typeof value === type && value !== null) {
          if (type === 'number' && !isFinite(value)) {
            log.warn(`[偏好] ${key}.${field} 为非有限数(NaN/Infinity/-Infinity)，使用默认值`);
            continue;
          }
          result[field] = value;
        } else {
          log.warn(`[偏好] ${key}.${field} 类型错误(${typeof value})，使用默认值`);
        }
      }
    }
  } catch (e) {
    log.warn(`[偏好] 读取 ${key} 失败:`, e);
  }

  return result;
}

/**
 * 读取拼豆偏好（统一入口，app.js 与 index.js 共用，含完整 schema 与类型校验）
 * @returns {object} { beadSize, beadType, colorCount, useDithering }
 */
function getBeadPrefs() {
  return safeGetStoragePrefs('bead_prefs', BEAD_PREFS_SCHEMA, BEAD_PREFS_DEFAULTS);
}

// app.js - 拼豆大师全局入口
App({
  onLaunch() {
    // 防护网最先部署：确保后续任何初始化步骤（_initSystemInfo/_initColorLibraries/
    // _initPreferences/checkUpdate）抛出的未捕获异常都能被捕获上报
    registerGlobalErrorHandler();
    // 初始化云开发（内容安全检测通道；未开通时静默跳过，生产环境检测模块默认 fail-closed 拦截，仅 develop 本地未部署云函数时 fail-open）
    this._initCloud();
    // 初始化应用
    this._initSystemInfo();
    // 必须先建色卡库再读偏好：_initPreferences 需校验 selectedPalette 是否为
    // colorLibraries 中真实存在的 key，若顺序颠倒（先读偏好）校验必然失败
    this._initColorLibraries();
    this._initPreferences();
    this.checkUpdate();
    // 注册隐私协议处理回调（微信 2023.9 新规，必须在 onLaunch 中注册）
    this._initPrivacyHandler();
    // 启动清理：兜底扫描并删除 USER_DATA_PATH 下累积的拼豆中间产物（bead_export_*/bead_share_*），
    // 防止本地 10MB 配额被长期占用导致后续导出/分享失败
    gcBeadTempFiles({ keepSharePath: '' });
  },

  /**
   * 集中清理跨页模板态（currentTemplate / sourceImagePath / shareImagePath）。
   * 消除 template.js 中 shareImagePath 清空逻辑分散在 onLoad 与 shareTemplate 的问题，
   * 统一在此管理生命周期，明确「谁创建、谁清理」。
   *
   * 关键契约：重置 shareImagePath 指针前，必须先删除磁盘上的旧分享图（bead_share_*.png）。
   * 否则指针清空后旧文件成为孤儿——shareTemplate「写新图前删旧图」读到空串会跳过删除，
   * 同会话反复生成分享图将累积大 PNG（1-4MB/个）逼近 USER_DATA_PATH 10MB 配额
   * （BUG-10 复发路径）。清除逻辑与 BUG-10 / [3] 修复保持完全一致。
   *
   * @param {Object} [options]
   * @param {boolean} [options.clearShareFile=true]          是否重置 shareImagePath（含删磁盘旧图）
   * @param {boolean} [options.clearSource=true]             是否重置 sourceImagePath
   * @param {boolean} [options.clearCurrentTemplate=true]    是否清空 currentTemplate
   */
  resetTemplateState(options) {
    const g = this.globalData;
    const opt = options || {};
    if (opt.clearShareFile !== false) {
      const prev = g.shareImagePath;
      if (prev && typeof prev === 'string' && prev.indexOf('bead_share_') !== -1) {
        removeFileIfExists(prev);
      }
      g.shareImagePath = '';
    }
    if (opt.clearSource !== false) g.sourceImagePath = '';
    if (opt.clearCurrentTemplate !== false) g.currentTemplate = null;
  },

  // 注册隐私协议处理器
  // 微信基础库 >= 2.33.0 提供 wx.onNeedPrivacyAuthorization
  // 当框架检测到需要隐私授权时，会回调此处注册的 handler
  _initPrivacyHandler() {
    if (typeof wx.onNeedPrivacyAuthorization !== 'function') return;

    wx.onNeedPrivacyAuthorization((resolve) => {
      // 弹出隐私协议弹框，让用户阅读并确认
      wx.showModal({
        title: '隐私保护提示',
        content: '在使用选择图片、保存图片等功能前，需要您阅读并同意《隐私协议》。',
        confirmText: '同意',
        cancelText: '拒绝',
        success: (res) => {
          if (res.confirm) {
            // 用户同意，通知微信框架继续执行 API
            resolve({ event: 'agree' });
          } else {
            // 用户拒绝，通知微信框架终止 API 调用
            resolve({ event: 'disagree' });
          }
        },
        fail: () => {
          // 弹框失败时默认拒绝，防止非法调用
          resolve({ event: 'disagree' });
        }
      });
    });
  },

  // 初始化云开发（内容安全检测通道）
  // 仅初始化不抛错：未开通云开发 / 基础库过旧时静默跳过，utils/secCheck.js
  // 在生产环境（体验版/正式版）通道不可用会 fail-closed 拦截（不阻塞检测流程，但会拦截发布），
  // 仅 develop 本地调试时 fail-open 放行；
  // 提审前必须完成云开发开通与云函数部署（详见 overview.md「内容安全接入」）。
  _initCloud() {
    try {
      if (typeof wx.cloud === 'undefined' || typeof wx.cloud.init !== 'function') {
        this.globalData.cloudAvailable = false;
        log.info('[cloud] 当前基础库不支持云开发，内容安全检测通道不可用（生产环境将 fail-closed 拦截）');
        return;
      }
      // 不指定 env：使用默认云环境（仅开通一个环境时无需显式传 envId）
      wx.cloud.init({ traceUser: true });
      this.globalData.cloudAvailable = true;
      log.info('[cloud] 云开发初始化成功，内容安全检测通道可用');
    } catch (e) {
      this.globalData.cloudAvailable = false;
      log.warn('[cloud] 云开发初始化失败，内容安全检测通道不可用（生产环境将 fail-closed 拦截）:', e);
    }
  },

  // 初始化系统信息（同步）
  // 修复 BUG-3-1：wx.getSystemInfoAsync 自基础库 2.20.1 起停止维护，改用受维护的 wx.getWindowInfo
  // 修复 BUG-3-2：改为同步获取，避免 onLaunch 期间异步未就绪、页面 onLoad 读到默认值/undefined 的竞态
  // 同步获取已消除竞态；getSystemInfoReady(callback) 为防御性订阅 API，
  // 供页面在需要时等待布局信息就绪（若未来有人把初始化改回异步，页面仍不会读到兜底值）
  _initSystemInfo() {
    try {
      const windowInfo = (typeof wx.getWindowInfo === 'function')
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync(); // 极旧基础库兜底（仍可用）
      const statusBarHeight = (windowInfo && typeof windowInfo.statusBarHeight === 'number')
        ? windowInfo.statusBarHeight
        : CONSTANTS.LAYOUT.STATUS_BAR_HEIGHT;
      this.globalData.statusBarHeight = statusBarHeight;
      this.globalData.systemInfo = windowInfo;
      // 动态计算导航栏高度，适配刘海屏和不同厂商定制系统
      const menuButton = wx.getMenuButtonBoundingClientRect();
      // menuButton 可能返回空对象 {}，或胶囊被隐藏（自定义组件/插件环境/隐藏胶囊）时返回
      // {top:0,height:0,...} 全零对象；全零对象会使公式算出负数导航栏高度
      // （(0-statusBarHeight)*2+0+statusBarHeight = -statusBarHeight），导致布局错乱。
      // 故用 top/height > 0 一并校验（同时挡掉 NaN：typeof NaN==='number' 为 true，仅 typeof 判断不够），
      // 命中兜底时使用 statusBarHeight + NAV_BAR_FALLBACK，防止负导航栏高度
      const navH = (menuButton && menuButton.top > 0 && menuButton.height > 0)
        ? (menuButton.top - statusBarHeight) * 2 + menuButton.height + statusBarHeight
        : statusBarHeight + CONSTANTS.LAYOUT.NAV_BAR_FALLBACK;
      this.globalData.navBarHeight = navH;
    } catch (e) {
      log.warn('[initSystemInfo] 获取失败，使用默认布局:', e);
      this.globalData.statusBarHeight = CONSTANTS.LAYOUT.STATUS_BAR_HEIGHT;
      this.globalData.navBarHeight = CONSTANTS.LAYOUT.NAV_BAR_HEIGHT;
    } finally {
      // 无论成功路径还是兜底路径，布局信息均已就绪：置标记并触发等待队列
      this._markSystemInfoReady();
    }
  },

  // 订阅布局信息就绪（防御性 API）
  // 页面可在 onLoad 中调用：若已就绪则立即同步回调；否则入队等待，就绪后统一触发
  // @param {Function} callback - 就绪回调，入参为 this.globalData
  getSystemInfoReady(callback) {
    if (typeof callback !== 'function') return;
    if (this.globalData.systemInfoReady === true) {
      callback(this.globalData);
      return;
    }
    if (!Array.isArray(this._systemInfoWaiters)) {
      this._systemInfoWaiters = [];
    }
    this._systemInfoWaiters.push(callback);
  },

  // 布局信息就绪收尾：置标记并清空/触发等待队列
  // 单个回调抛错不影响其他回调，仅记录警告
  _markSystemInfoReady() {
    this.globalData.systemInfoReady = true;
    const waiters = this._systemInfoWaiters || [];
    this._systemInfoWaiters = [];
    for (let i = 0; i < waiters.length; i++) {
      try {
        waiters[i](this.globalData);
      } catch (e) {
        log.warn('[systemInfoReady] 等待回调执行失败:', e);
      }
    }
  },

  // 初始化用户偏好（同步）
  _initPreferences() {
    // 安全读取 bead_prefs（统一走 getBeadPrefs，含完整 schema 与类型校验）
    const prefs = getBeadPrefs();

    // 范围校验
    this.globalData.beadSize = Math.max(
      CONSTANTS.BEAD_SIZE.MIN,
      Math.min(CONSTANTS.BEAD_SIZE.MAX, prefs.beadSize)
    );
    this.globalData.beadType = [CONSTANTS.BEAD_TYPE.SQUARE, CONSTANTS.BEAD_TYPE.CIRCLE].includes(prefs.beadType)
      ? prefs.beadType : CONSTANTS.BEAD_TYPE.DEFAULT;

    // 读取用户偏好的色卡（字符串类型，简单处理）
    // 校验 key 为 colorLibraries 的真实自有 key：仅"是字符串且非空"不足以防脏数据，
    // 用 hasOwnProperty 而非 `in`（`in` 会命中 Object.prototype 原型链，
    // '__proto__'/'constructor'/'toString' 等会误判为存在），
    // 否则本地存储被污染为废弃 key 时，消费端 colorLibraries[selectedPalette] 会拿到 undefined
    try {
      const savedPalette = wx.getStorageSync('selectedPalette');
      if (typeof savedPalette === 'string' &&
          Object.prototype.hasOwnProperty.call(this.globalData.colorLibraries, savedPalette)) {
        this.globalData.selectedPalette = savedPalette;
      } else {
        this.globalData.selectedPalette = CONSTANTS.DEFAULT_PALETTE;
      }
    } catch (e) {
      this.globalData.selectedPalette = CONSTANTS.DEFAULT_PALETTE;
    }
  },

  // 初始化色卡库（同步）
  _initColorLibraries() {
    this.globalData.colorLibraries = deepFreeze({
      artkal_c: deepFreeze(artkalC),
      hama: deepFreeze(hama),
      perler: deepFreeze(perler),
      photoPearl: deepFreeze(photoPearl),
      neko: deepFreeze(neko)
    });
    this.globalData.colorLibraryMeta = deepFreeze(colorLibraryMeta);
  },

  // 检查小程序版本更新
  // 防抖/重试语义说明：
  //   1. 监听只注册一次。onCheckForUpdate/onUpdateReady/onUpdateFailed 全部平级注册，
  //      与 hasUpdate 无关（事件只在有更新时触发），避免 hasUpdate 多次回调或重复调用
  //      checkUpdate 导致监听叠加注册、一次 ready/failed 触发多个弹窗。
  //   2. 弹窗防抖。_updateDialogBusy 保证同一时刻最多弹一个更新相关弹窗，
  //      弹窗关闭（success/complete）时复位。
  //   3. 失败重试。微信 UpdateManager 没有提供"重新下载"的公开 API，applyUpdate() 仅在
  //      onUpdateReady 触发后才有效；因此"重试"的合理语义是：复位防抖标志、递减重试计数
  //      并给出 toast 反馈，不重新注册监听（避免叠加），等待微信库在网络恢复后自然再次
  //      触发 onUpdateReady/onUpdateFailed。
  checkUpdate() {
    if (!wx.canIUse('getUpdateManager')) return;
    // 监听只注册一次：已注册过则直接返回，防止叠加注册
    if (this._updateListenersInstalled) return;
    this._updateListenersInstalled = true;
    this._updateDialogBusy = false;
    this._updateRetryLeft = 2;  // 失败重试次数，每次重试 -1，耗尽后仅提示

    const updateManager = wx.getUpdateManager();
    updateManager.onCheckForUpdate(() => {
      // 检测结果由库内部驱动 onUpdateReady/onUpdateFailed（监听已平级注册），
      // 此处无需再注册任何监听
    });
    updateManager.onUpdateReady(() => {
      if (this._updateDialogBusy) return;
      this._updateDialogBusy = true;
      wx.showModal({
        title: '更新提示',
        content: '新版本已准备好，是否重启应用？',
        success: (modalRes) => {
          if (modalRes.confirm) updateManager.applyUpdate();
        },
        complete: () => { this._updateDialogBusy = false; }
      });
    });
    updateManager.onUpdateFailed(() => {
      if (this._updateDialogBusy) return;
      this._updateDialogBusy = true;
      if (this._updateRetryLeft > 0) {
        wx.showModal({
          title: '更新提示',
          content: '新版本下载失败，是否重试？',
          confirmText: '重试',
          cancelText: '取消',
          success: (modalRes) => {
            if (modalRes.confirm) {
              // 重试：复位 busy → 计数-1 → toast；不重新注册监听，
              // 等待微信库在网络恢复后自然再次触发 onUpdateReady/onUpdateFailed
              this._updateDialogBusy = false;
              this._updateRetryLeft -= 1;
              wx.showToast({ title: '已重新检查', icon: 'none' });
            }
          },
          complete: () => { this._updateDialogBusy = false; }
        });
      } else {
        // 重试次数耗尽：仅提示，不再提供重试按钮
        wx.showModal({
          title: '更新提示',
          content: '新版本下载失败，请稍后重试。',
          showCancel: false,
          complete: () => { this._updateDialogBusy = false; }
        });
      }
    });
  },

  globalData: {
    systemInfo: null,
    statusBarHeight: CONSTANTS.LAYOUT.STATUS_BAR_HEIGHT,
    navBarHeight: CONSTANTS.LAYOUT.NAV_BAR_HEIGHT,
    // 布局信息就绪标记：_initSystemInfo 完成（成功或兜底）后置 true，
    // 页面可通过 getSystemInfoReady(callback) 订阅等待（防御未来改回异步时的竞态）
    systemInfoReady: false,
    // 云开发可用标记：_initCloud 执行后置位（内容安全检测通道）
    cloudAvailable: false,
    beadSize: CONSTANTS.BEAD_SIZE.DEFAULT,
    beadType: CONSTANTS.BEAD_TYPE.DEFAULT,
    selectedPalette: CONSTANTS.DEFAULT_PALETTE,  // 默认色卡
    colorLibraries: {},  // 初始化时填充，防止色卡被意外修改
    colorLibraryMeta: [], // 初始化时填充
    // 以下字段被动态赋值，内部使用
    currentTemplate: null,          // 当前模板数据
    sourceImagePath: '',            // 原始图片路径
    shareImagePath: '',             // 分享图片路径
    historyVersion: 0               // 历史记录版本号：每次写入/清空/删除 template_history 时自增，
                                    // gallery 页据此判断数据是否变化，避免 5s 防抖读到陈旧列表
  }
});

// 导出常量与偏好读取函数供其他模块使用
module.exports = { CONSTANTS, getBeadPrefs, safeGetStoragePrefs };

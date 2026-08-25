// utils/colorLibrary.js - 色卡公共操作模块
// 修复 BUG-3-3：不在模块顶层调用 getApp()，避免本模块在 App() 构造期间被间接 require 时
// getApp() 返回 undefined 而崩溃。改为在每个方法内部按需获取当前 app 实例。
// 统一脱敏日志
const { log } = require('./security');
const { COLOR_LIBRARY_KEYS } = require('./colorData');
function getAppInstance() {
  return getApp();
}
// 判空取 globalData：getApp() 在 App() 构造期间被间接调用时返回 undefined（文件头注释已在案），
// 且理论上 globalData 也可能未初始化（异常时序）。统一兜底，避免 `.globalData` 直接 TypeError。
function getGlobalData() {
  const app = getAppInstance();
  return (app && app.globalData) || {};
}

module.exports = {
  /** 获取所有色卡元信息列表 */
  getPaletteList() {
    return getGlobalData().colorLibraryMeta || [];
  },

  /** 获取当前选中的色卡 key */
  getCurrentPaletteKey() {
    return getGlobalData().selectedPalette || 'artkal_c';
  },

  /** 根据当前 key 获取对应的色卡颜色数组 */
  getCurrentColors() {
    // P1-1 修复：原 this.getCurrentPaletteKey() 依赖方法作为模块对象属性调用时 this 绑定，
    // 一旦作为回调传递（map/then/组件 props）this 丢失会 TypeError 白屏（测试注释已记该雷区）。
    // 改为直接读取 globalData.selectedPalette（与 getCurrentPaletteKey() 方法体同逻辑），零行为变更。
    const key = getGlobalData().selectedPalette || 'artkal_c';
    const libs = getGlobalData().colorLibraries || {};
    // 与 P2-1 getColorsByKey 同口径：返回 .slice() 浅拷贝隔离全局引用；
    // selectedPalette 经 app.js _initPreferences 白名单校验，libs[key] 恒为真值，? .slice() : [] 语义清晰。
    return libs[key] ? libs[key].slice() : [];
  },

  /** 根据指定 key 获取色卡颜色数组（用于历史记录按"记录当时的色卡"还原，避免切色卡后旧记录白色兜底错位） */
  getColorsByKey(paletteKey) {
    const validKeys = COLOR_LIBRARY_KEYS;
    if (!paletteKey || !validKeys.includes(paletteKey)) {
      log.warn('[colorLibrary] 非法色卡 key:', paletteKey);
      return [];
    }
    const libs = getGlobalData().colorLibraries || {};
    // P2-1 修复：原返回 libs[paletteKey] 原始引用，且 || [] 对白名单校验后恒不可达（死代码，见 P3-1）。
    // 返回 .slice() 浅拷贝隔离全局色卡引用，防止未来调用方直接 mutate 返回数组污染所有页面。
    // 合法 key 经白名单校验后 libs[paletteKey] 恒为真值，显式 ? .slice() : [] 语义清晰。
    return libs[paletteKey] ? libs[paletteKey].slice() : [];
  },

  /** 获取色卡显示名称（带"系列"后缀） */
  getPaletteName(paletteKey) {
    const meta = (getGlobalData().colorLibraryMeta || []).find(p => p.key === paletteKey);
    return meta ? meta.name + ' 系列' : (paletteKey || '') + ' 系列';
  },

  /** 切换色卡：更新全局状态和本地存储，返回新色卡颜色数组 */
  switchPalette(paletteKey) {
    // 安全加固：校验色卡 key 是否在白名单中，防止被意外注入非法值
    const validKeys = COLOR_LIBRARY_KEYS;
    if (!validKeys.includes(paletteKey)) {
      log.warn('[colorLibrary] 非法色卡 key:', paletteKey);
      return [];
    }
    const gd = getGlobalData();
    // P2-2 修复：先保存切换前值，存储失败时回退内存保持一致（否则 UI 已切换但 storage 未变，
    // 冷启动读旧 key 回跳，用户体验"选了又被切回去"）。
    const prevPalette = gd.selectedPalette;
    gd.selectedPalette = paletteKey;
    try {
      wx.setStorageSync('selectedPalette', paletteKey);
    } catch (e) {
      // 存储配额满等持久化失败：内存回退到切换前值与 storage 对齐，返回 [] 阻止调用方 setData 切换 UI，
      // 避免"UI 已切但冷启动回跳"的不一致体验。
      gd.selectedPalette = prevPalette;
      log.warn('[colorLibrary] 持久化选中色卡失败，已回退内存:', e);
      return [];
    }
    const libs = gd.colorLibraries || {};
    return libs[paletteKey] ? libs[paletteKey].slice() : [];
  },

  /** 获取指定色卡的颜色数量（用于页面 slider 上限钳制，避免 UI 显示超出实际色卡容量的值） */
  getPaletteColorCount(paletteKey) {
    // P1-1 修复：同款 this 作用域缺陷（方法体作为回调传递时 this 丢失白屏），
    // 直接读取 globalData.selectedPalette 与 getCurrentPaletteKey() 方法体同逻辑。
    const key = paletteKey || (getGlobalData().selectedPalette || 'artkal_c');
    const libs = getGlobalData().colorLibraries || {};
    const arr = libs[key] || libs.artkal_c || [];
    return Array.isArray(arr) ? arr.length : 0;
  }
};

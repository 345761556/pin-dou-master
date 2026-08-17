// utils/colorLibrary.js - 色卡公共操作模块
// 修复 BUG-3-3：不在模块顶层调用 getApp()，避免本模块在 App() 构造期间被间接 require 时
// getApp() 返回 undefined 而崩溃。改为在每个方法内部按需获取当前 app 实例。
// 统一脱敏日志
const { log } = require('./security');
const { COLOR_LIBRARY_KEYS } = require('./colorData');
function getAppInstance() {
  return getApp();
}

module.exports = {
  /** 获取所有色卡元信息列表 */
  getPaletteList() {
    return getAppInstance().globalData.colorLibraryMeta || [];
  },

  /** 获取当前选中的色卡 key */
  getCurrentPaletteKey() {
    return getAppInstance().globalData.selectedPalette || 'artkal_c';
  },

  /** 根据当前 key 获取对应的色卡颜色数组 */
  getCurrentColors() {
    const key = this.getCurrentPaletteKey();
    const libs = getAppInstance().globalData.colorLibraries || {};
    return libs[key] || libs.artkal_c || [];
  },

  /** 根据指定 key 获取色卡颜色数组（用于历史记录按"记录当时的色卡"还原，避免切色卡后旧记录白色兜底错位） */
  getColorsByKey(paletteKey) {
    const validKeys = COLOR_LIBRARY_KEYS;
    if (!paletteKey || !validKeys.includes(paletteKey)) {
      log.warn('[colorLibrary] 非法色卡 key:', paletteKey);
      return [];
    }
    const libs = getAppInstance().globalData.colorLibraries || {};
    return libs[paletteKey] || [];
  },

  /** 获取色卡显示名称（带"系列"后缀） */
  getPaletteName(paletteKey) {
    const meta = (getAppInstance().globalData.colorLibraryMeta || []).find(p => p.key === paletteKey);
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
    getAppInstance().globalData.selectedPalette = paletteKey;
    try {
      wx.setStorageSync('selectedPalette', paletteKey);
    } catch (e) {
      // 内存 globalData 已切换，本地持久化失败可容忍（下次启动回落默认色卡），仅记录日志
      log.warn('[colorLibrary] 持久化选中色卡失败:', e);
    }
    const libs = getAppInstance().globalData.colorLibraries || {};
    return libs[paletteKey] || [];
  },

  /** 获取指定色卡的颜色数量（用于页面 slider 上限钳制，避免 UI 显示超出实际色卡容量的值） */
  getPaletteColorCount(paletteKey) {
    const key = paletteKey || this.getCurrentPaletteKey();
    const libs = getAppInstance().globalData.colorLibraries || {};
    const arr = libs[key] || libs.artkal_c || [];
    return Array.isArray(arr) ? arr.length : 0;
  }
};

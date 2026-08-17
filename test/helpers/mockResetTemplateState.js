// test/helpers/mockResetTemplateState.js
// 复刻 app.js App.resetTemplateState 行为，供模板页单元测试注入 app mock。
// ⚠️ 必须与 app.js 中 resetTemplateState 实现保持同步（清除契约：删 bead_share_ 旧图 + 重置指针）。
const { removeFileIfExists } = require('../../utils/util');

/**
 * 给测试用 app mock 附加 resetTemplateState 方法（行为同 app.js）。
 * @param {Object} appObj 含 globalData 的 app mock（即 getApp() 返回值）
 * @returns {Object} 同一个 appObj
 */
function attachResetTemplateState(appObj) {
  appObj.resetTemplateState = function (options) {
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
  };
  return appObj;
}

module.exports = { attachResetTemplateState };

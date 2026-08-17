// 回归测试：saveTemplate / shareTemplate 重复点击守卫（修复 L3）
// 原 bug：两者无并发守卫，快速双击会并发两次「生成导出图 → 写相册/写分享图」，
// 产生重复保存；shareTemplate 并发竞态下先创建的分享图可能成为孤儿。
// 修复：进入即用 this._saveBusy / this._shareBusy 置位，finally 清理，重复点击直接忽略。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

// ---- 微信运行时全局 mock ----
let warnCalls = [];
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  showLoading() {}, hideLoading() {}, showToast() {}, showModal() {},
  showShareMenu() {}, getFileSystemManager: () => ({ saveFile: (o) => o.success && o.success(), copyFileSync() {} })
};
global.App = () => {};
const appSingleton = { globalData: {} };
global.getApp = () => appSingleton;
attachResetTemplateState(appSingleton);

let captured = null;
global.Page = (o) => { captured = o; };

const FAKE_IDS = {
  '../../utils/beadEngine': { renderBeads: () => ({}) },
  '../../utils/security': {
    log: { info() {}, warn(m) { warnCalls.push(m); }, error() {} },
    isValidFilePath: () => true
  }
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (FAKE_IDS[id]) return FAKE_IDS[id];
  return origRequire.apply(this, arguments);
};

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  require(path.join(root, 'pages/template/template.js'));
  const tpl = captured;
  tpl.setData = function (obj) { Object.assign(this.data, obj); };
  // 让导出图生成步骤「挂起」（永不 resolve），使第一次调用保持在忙碌态，
  // 从而验证第二次点击在 busy 期间被忽略。
  let genCalls = 0;
  tpl._generateExportImage = () => { genCalls++; return new Promise(() => {}); };
  tpl._templateData = { cols: 10, rows: 10 };

  console.log('L3 重复点击守卫:');

  // ---- saveTemplate ----
  warnCalls = [];
  tpl._saveBusy = false;
  const p1 = tpl.saveTemplate();           // 第一次：进入并挂起在 _generateExportImage
  ok('saveTemplate 首次调用置位 _saveBusy', tpl._saveBusy === true);
  const p2 = tpl.saveTemplate();           // 第二次（忙碌中）：应被忽略
  ok('saveTemplate 重复点击被忽略（_generateExportImage 仅调用 1 次）', genCalls === 1);
  ok('saveTemplate 重复点击记录 warn 日志', warnCalls.some((m) => /saveTemplate.*重复点击/.test(m)));
  ok('saveTemplate 第二次调用未再次置位（仍为首次的忙碌态）', tpl._saveBusy === true);

  // ---- shareTemplate ----
  warnCalls = [];
  tpl._saveBusy = false; tpl._shareBusy = false;   // 隔离测试分享按钮自身重复点击守卫：确保保存不处于忙碌态
  const s1 = tpl.shareTemplate();
  ok('shareTemplate 首次调用置位 _shareBusy', tpl._shareBusy === true);
  const s2 = tpl.shareTemplate();
  ok('shareTemplate 重复点击记录 warn 日志', warnCalls.some((m) => /shareTemplate.*重复点击/.test(m)));

  // 收尾：让挂起的首次调用自然结束（避免进程悬挂），不阻塞结果判定
  p1.catch(() => {}); s1.catch(() => {});
  p2.catch(() => {}); s2.catch(() => {});

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

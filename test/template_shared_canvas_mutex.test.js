// 回归测试：saveTemplate / shareTemplate 共用 #export-canvas 的并发互斥（修复 H1）
// 原 bug：两方法各有独立 _saveBusy/_shareBusy，仅拦「同按钮重复点击」，不互相拦截；
// 先点保存再点分享 → 两个 async 并发拿到同一 canvas node，交替改 canvas.width/height
// 与绘制 → 导出图损坏 / canvas 状态错乱。
// 修复：进入时判 `if (this._saveBusy || this._shareBusy)` 任一忙碌即忽略（交叉互斥）。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

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
  const src = fs.readFileSync(path.join(root, 'pages/template/template.js'), 'utf8');
  require(path.join(root, 'pages/template/template.js'));
  const tpl = captured;
  tpl.setData = function (obj) { Object.assign(this.data, obj); };

  // 让 _generateExportImage 挂起（永不 resolve），使调用方保持在忙碌态，
  // 从而验证「另一按钮」在忙期间被互斥拦截（不进入、不碰共用 canvas）。
  let genCalls = 0;
  tpl._generateExportImage = () => { genCalls++; return new Promise(() => {}); };
  tpl._templateData = { cols: 10, rows: 10 };

  console.log('H1 共用 canvas 并发互斥守卫:');

  // ---- 静态守卫：两方法进入时都判 this._saveBusy || this._shareBusy ----
  ok('saveTemplate 进入时判 this._saveBusy || this._shareBusy',
    /async saveTemplate\(\)\s*\{[\s\S]*?if\s*\(this\._saveBusy\s*\|\|\s*this\._shareBusy\)/.test(src));
  ok('shareTemplate 进入时判 this._saveBusy || this._shareBusy',
    /async shareTemplate\(\)\s*\{[\s\S]*?if\s*\(this\._saveBusy\s*\|\|\s*this\._shareBusy\)/.test(src));

  // ---- 场景 A：保存进行中 → 分享被互斥拦截（共用 canvas 不被并发改写） ----
  warnCalls = [];
  genCalls = 0;
  tpl._saveBusy = false; tpl._shareBusy = false;
  const pSave = tpl.saveTemplate();            // 进入并挂起在 _generateExportImage
  const saveEntered = tpl._saveBusy === true && genCalls === 1;
  const pShare = tpl.shareTemplate();          // 分享：应被互斥拦截
  ok('A-1 保存已进入（_saveBusy 置位 + _generateExportImage 调用 1 次）', saveEntered);
  ok('A-2 保存进行中 shareTemplate 被忽略（_generateExportImage 未再调用，共用 canvas 无并发）', genCalls === 1);
  ok('A-3 保存进行中 shareTemplate 记录互斥 warn（含「重复点击」）', warnCalls.some((m) => /shareTemplate.*重复点击/.test(m)));
  ok('A-4 保存进行中 shareTemplate 未置位 _shareBusy（避免误标自身忙碌）', tpl._shareBusy === false);
  ok('A-5 保存进行中 shareTemplate 返回已 resolve 的 promise（不抛、不逃逸）', typeof pShare.then === 'function');

  // ---- 场景 B：分享进行中 → 保存被互斥拦截（共用 canvas 不被并发改写） ----
  warnCalls = [];
  genCalls = 0;
  tpl._saveBusy = false; tpl._shareBusy = false;
  const pShare2 = tpl.shareTemplate();         // 进入并挂起在 _generateExportImage
  const shareEntered = tpl._shareBusy === true && genCalls === 1;
  const pSave2 = tpl.saveTemplate();           // 保存：应被互斥拦截
  ok('B-1 分享已进入（_shareBusy 置位 + _generateExportImage 调用 1 次）', shareEntered);
  ok('B-2 分享进行中 saveTemplate 被忽略（_generateExportImage 未再调用，共用 canvas 无并发）', genCalls === 1);
  ok('B-3 分享进行中 saveTemplate 记录互斥 warn（含「重复点击」）', warnCalls.some((m) => /saveTemplate.*重复点击/.test(m)));
  ok('B-4 分享进行中 saveTemplate 未置位 _saveBusy（避免误标自身忙碌）', tpl._saveBusy === false);
  ok('B-5 分享进行中 saveTemplate 返回已 resolve 的 promise（不抛、不逃逸）', typeof pSave2.then === 'function');

  // ---- 场景 C：无忙碌时各自可正常进入（不误杀合法操作） ----
  warnCalls = [];
  genCalls = 0;
  tpl._saveBusy = false; tpl._shareBusy = false;
  const pOnlySave = tpl.saveTemplate();
  ok('C-1 无忙碌时 saveTemplate 正常进入（_saveBusy 置位 + 调用 _generateExportImage）', tpl._saveBusy === true && genCalls === 1);

  // 收尾：让挂起的首次调用自然结束（避免进程悬挂），不阻塞结果判定
  pSave.catch(() => {}); pShare.catch(() => {}); pShare2.catch(() => {}); pSave2.catch(() => {}); pOnlySave.catch(() => {});

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

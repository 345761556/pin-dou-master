// 回归测试：route 竞态守卫（routeDone webviewId not found）
// 场景 1：template.js onLoad 无效数据分支的 navigateBack 定时器须跟踪 + onUnload 清理
//   （否则用户 1.5s 内手动返回后，定时器对已死页面再发 navigateBack → 路由竞态报错）
// 场景 2：gallery.js viewTemplate 须防快速连点（两次 navigateTo 竞态 → 第二次路由找不到 webview）
const fs = require('fs');
const path = require('path');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(msg, cond) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

// ================= 静态断言 =================
console.log('静态校验（template.js 无效数据定时器跟踪）:');
const tplSrc = fs.readFileSync(path.join(root, 'pages/template/template.js'), 'utf-8');
ok('onLoad 无效分支定时器已跟踪（this._invalidDataTimer = setTimeout）',
   /this\._invalidDataTimer\s*=\s*setTimeout/.test(tplSrc));
ok('定时器回调内先置空引用再 navigateBack',
   /_invalidDataTimer\s*=\s*null;\s*\n?\s*wx\.navigateBack/.test(tplSrc));
ok('onUnload 清理 _invalidDataTimer（clearTimeout）',
   /onUnload[\s\S]{0,600}clearTimeout\(this\._invalidDataTimer\)/.test(tplSrc));
ok('onUnload 清理后置空（this._invalidDataTimer = null）',
   /clearTimeout\(this\._invalidDataTimer\);\s*\n?\s*this\._invalidDataTimer\s*=\s*null/.test(tplSrc));
ok('无残留裸 setTimeout(...navigateBack...)（未跟踪）',
   !/[^.]setTimeout\(\(\)\s*=>\s*wx\.navigateBack/.test(tplSrc));

console.log('静态校验（gallery.js viewTemplate 连点守卫）:');
const galSrc = fs.readFileSync(path.join(root, 'pages/gallery/gallery.js'), 'utf-8');
ok('viewTemplate 入口含 _viewNavBusy 守卫',
   /viewTemplate\(e\)\s*\{[\s\S]{0,200}if\s*\(this\._viewNavBusy\)\s*return/.test(galSrc));
ok('navigateTo 前置位 _viewNavBusy = true',
   /this\._viewNavBusy\s*=\s*true;\s*\n?\s*wx\.navigateTo/.test(galSrc));
ok('catch 分支复位 _viewNavBusy = false（解码失败允许重试）',
   /catch\s*\(e\)\s*\{\s*\n?\s*this\._viewNavBusy\s*=\s*false/.test(galSrc));
ok('onShow 复位 _viewNavBusy = false（返回本页允许再次点击）',
   /onShow\(\)\s*\{[\s\S]{0,800}this\._viewNavBusy\s*=\s*false/.test(galSrc));

// ================= 运行时断言 =================
console.log('运行时校验（template 无效数据 → 手动返回 → 定时器不再触发 navigateBack）:');

// mock 定时器：记录 id 与回调
const pendingTimers = new Map();
let nextTimerId = 1;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = (cb, ms) => { const id = nextTimerId++; pendingTimers.set(id, { cb, ms }); return id; };
global.clearTimeout = (id) => { pendingTimers.delete(id); };

let navigateBackCalls = 0;
const appSingleton = { globalData: { currentTemplate: null } }; // 无效数据分支
global.getApp = () => appSingleton;
global.App = () => {};
attachResetTemplateState(appSingleton);
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  showShareMenu() {},
  showToast() {},
  showLoading() {},        // B30: onUnload 兜底清理 loading 遮罩所用（建模真实 wx API）
  hideLoading() {},        // B30: onUnload 兜底清理 loading 遮罩所用
  setNavigationBarTitle() {},
  navigateBack() { navigateBackCalls++; },
  getFileSystemManager: () => ({ saveFile: (o) => o.success && o.success(), copyFileSync() {} }),
  createSelectorQuery() { return { select() { return { fields() { return { exec() {} }; } }; } }; }
};
let captured = null;
global.Page = (o) => { captured = o; };

// 模板页依赖重，整体桩掉 beadEngine/security 避免副作用
const beadPath = path.join(root, 'utils/beadEngine.js');
const secPath = path.join(root, 'utils/security.js');
require.cache[beadPath] = { id: beadPath, filename: beadPath, loaded: true, exports: {
  rleDecode: () => [], calcLabelSpace: () => 0, renderTemplate: () => ({}) } };
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  log: { warn() {}, info() {}, error() {} }, removeFileIfExists: () => {}, clampDisplayNumber: (n) => n,
  isManagedHistorySource: () => true } };

delete require.cache[path.join(root, 'pages/template/template.js')];
require(path.join(root, 'pages/template/template.js'));
const tpl = captured;
tpl.setData = function (obj) { Object.assign(this.data, obj); };
tpl.data = {};

// onLoad 触发无效数据分支 → 应挂起 1 个 1500ms 定时器
tpl.onLoad({});
ok('onLoad 无效数据后挂起 1 个定时器', pendingTimers.size === 1);
const timerEntry = [...pendingTimers.values()][0] || {};
ok('定时器时长为 1500ms', timerEntry.ms === 1500);

// 用户在 1.5s 内手动返回 → onUnload 清理定时器
tpl.onUnload();
ok('onUnload 后定时器已清理（pending 为 0）', pendingTimers.size === 0);

// 模拟原竞态：若定时器残留并触发，navigateBack 会被再次调用；
// 这里 pending 已空、无回调可触发，直接断言 navigateBack 从未被调用
ok('navigateBack 未被重复调用（竞态已杜绝）', navigateBackCalls === 0);

// 恢复定时器
global.setTimeout = realSetTimeout;
global.clearTimeout = realClearTimeout;

// ================= 汇总 =================
console.log(`\nroute_race_guard.test.js: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

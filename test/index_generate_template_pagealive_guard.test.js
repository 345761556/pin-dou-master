// test/index_generate_template_pagealive_guard.test.js
// 回归测试：[审计 #5] generateTemplate 的 exec 异步回调（含 img.src 赋值、canvas 检查）
//           缺少 _pageAlive 守护，可能在页面已卸载/隐藏后才执行 → 对已销毁页面 setData / 误跳转。
// 修复：exec 回调入口加 _pageAlive 守护；内层 img.onload / img.onerror 守卫在提前返回时
//       一并复位 generating（避免 tab 切回后重新触发被 generating 守卫误拦）。
// 运行：node test/index_generate_template_pagealive_guard.test.js
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：exec 回调入口存在 _pageAlive 守护，且三处守卫均复位 generating ----
const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
const idx = idxSrc.indexOf('.exec((res) => {');
ok('exec 回调入口存在 _pageAlive === false 守护', idx !== -1 && /if \(this\._pageAlive === false\)/.test(idxSrc.slice(idx, idx + 700)));
const guardCount = (idxSrc.match(/if \(this\._pageAlive === false\)/g) || []).length;
ok('三处 _pageAlive 守卫齐全（exec 入口 + img.onload + img.onerror）', guardCount >= 3);

// ---- 2) 功能驱动：generateTemplate 已发起，但 exec 回调在 onUnload 之后才执行（竞态复现）----
const fakeApp = { globalData: {} };
global.getApp = () => fakeApp;
global.App = () => {};                 // app.js 顶层注册 App({})，测试环境需占位
global.getCurrentPages = () => [];

let hideLoadingCalled = false;
let navigateToCalled = false;
let redirectToCalled = false;
let toastCalled = false;
let setDataCalls = [];

const fakeWx = {
  showShareMenu: () => {},
  getStorageSync: () => undefined,
  setStorageSync: () => {},
  showLoading: () => {},
  hideLoading: () => { hideLoadingCalled = true; },
  showToast: () => { toastCalled = true; },
  navigateTo: () => { navigateToCalled = true; },
  redirectTo: () => { redirectToCalled = true; },
  // exec 延后到下一个 tick 才执行，以便测试在调用 generateTemplate 后、回调前模拟 onUnload
  createSelectorQuery: () => {
    let stored = null;
    return {
      in() { return this; },
      select() { return this; },
      fields() { return this; },
      exec(cb) { stored = cb; setImmediate(() => stored && stored([{ node: {} }])); }
    };
  },
  getFileSystemManager: () => ({ copyFileSync() {}, accessSync() {} })
};
global.wx = fakeWx;

let pageObj = null;
global.Page = (o) => { pageObj = o; };
delete require.cache[path.join(__dirname, '..', 'pages', 'index', 'index.js')];
require(path.join(__dirname, '..', 'pages', 'index', 'index.js'));

const ctx = Object.assign({}, pageObj, {
  data: {
    generating: false,
    imagePath: 'wxfile://tmp_test.png',
    beadSize: 5, templateCols: 30, colorCount: 24,
    useDithering: false, beadType: 'normal', fillBackgroundWhite: false
  },
  setData: (d) => { setDataCalls.push(d); Object.assign(ctx.data, d); }
});

ctx.onLoad({});             // 置 _pageAlive = true
ctx.generateTemplate();     // 发起生成（exec 被延后）
ctx.onUnload();             // 模拟用户在图片异步加载期间离开 → _pageAlive = false

setTimeout(() => {
  // 此刻被延后的 exec 回调已执行，且 _pageAlive 已被置 false
  ok('页面已卸载时 exec 回调清理全局遮罩（hideLoading）', hideLoadingCalled);
  ok('页面已卸载时未触发误跳转 navigateTo', !navigateToCalled);
  ok('页面已卸载时未触发误跳转 redirectTo', !redirectToCalled);
  ok('页面已卸载时未对已死页面 setData（无 generating 写回，遵守存活守护契约）', !setDataCalls.some(o => o.generating === false));
  ok('页面已卸载时未走未守护的 canvas 检查分支（无 Canvas 初始化失败 toast）', !toastCalled);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}, 50);

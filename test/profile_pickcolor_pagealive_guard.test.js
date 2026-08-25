// test/profile_pickcolor_pagealive_guard.test.js
// 回归测试：[4] profile.pickColorAtPoint 缺少页面存活守护
// 问题：取色是用户点击触发的异步操作（query.exec → ctx.drawImage → img.onload → getImageData → setData）。
//       若用户在取色动画期间快速切走 profile（tab 页 onHide），img.onload 回调仍会在已隐藏页面上
//       this.setData，触发「页面已卸载 setData」告警。
// 修复：onShow 置 this._pageAlive=true、onHide 置 false；query.exec 回调入口与 img.onload 入口均
//       加 this._pageAlive===false 提前 return，避免在隐藏页 setData（与 index.generateTemplate #5 对齐）。
// 运行：node test/profile_pickcolor_pagealive_guard.test.js,
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

// scoped require 拦截：仅 profile.js 引用的 util / secCheck 替换为轻量桩（与 profile_sec_check_compress 同款，确保可加载）,
const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p, max) => ({ tempFilePath: p, width: 100, height: 100 }),
  getImageInfoWithTimeout: (src) => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: () => {},
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 }
};
const fakeSecCheck = {
  checkImageByPath: async () => ({ pass: true, suggest: 'pass', skipped: false }),
  blockMessage: (r, def) => def
};
// 取色匹配路径用到的色彩库/豆引擎：用受控桩替换，避免依赖真实色卡数据是否加载,
const fakeColorLib = {
  getCurrentColors: () => ([{ id: 'C01', name: '白', hex: '#FFFFFF', r: 255, g: 255, b: 255 }])
};
const fakeBeadEngine = {
  initPalette: (colors) => colors,
  matchToPalette: (r, g, b) => ({ hex: '#0A141E', name: '测试色', id: 'T1', r, g, b }),
  calcDeltaE: () => 1.0,
  renderTemplate: () => {}
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.indexOf('utils/util') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeSecCheck;
  if (id.indexOf('utils/colorLibrary') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeColorLib;
  if (id.indexOf('utils/beadEngine') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeBeadEngine;
  return origRequire.apply(this, arguments);
};

// ---- mock 微信环境 ----,
let execCb = null;          // query.exec 回调,
let imgOnload = null;       // imgEl.onload,
let toastTitles = [];       // 捕获 showToast 文案，用于验证超时看门狗,
const fakeCtx = {
  fillStyle: '', fillRect() {}, drawImage() {},
  getImageData: (x, y, w, h) => ({ data: [10, 20, 30, 255] })
};
const fakeCanvas = {
  width: 0, height: 0,
  getContext: () => fakeCtx,
  createImage: () => {
    const img = {};
    Object.defineProperty(img, 'onload', { set: (fn) => { imgOnload = fn; }, get: () => imgOnload });
    Object.defineProperty(img, 'onerror', { set: () => {}, get: () => null });
    Object.defineProperty(img, 'src', { set: () => {}, get: () => '' });
    return img;
  }
};
global.getApp = () => ({ globalData: {} });
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  createSelectorQuery: () => ({
    select: () => ({ boundingClientRect: () => ({}), fields: () => ({}) }),
    exec: (cb) => { execCb = cb; }
  }),
  showToast: (o) => { toastTitles.push(o && o.title); }, showModal: () => {},
  getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {} })
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };
require('../pages/profile/profile.js');

function makeCtx(init) {
  const ctx = Object.assign({}, pageObj, {
    data: Object.assign({ pickerImagePath: 'wxfile://tmp/pick.png', pickerImageInfo: { width: 100, height: 100 }, pickerHistory: [] }, init || {}),
    setData: (d) => Object.assign(ctx.data, d)
  });
  return ctx;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 静态断言 ----,
const profSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'), 'utf8');
ok('onShow 中置 this._pageAlive = true', /onShow\(\)\s*\{[^}]*this\._pageAlive\s*=\s*true/.test(profSrc));
ok('onHide 中置 this._pageAlive = false', /onHide\(\)\s*\{[^}]*this\._pageAlive\s*=\s*false/.test(profSrc));
ok('pickColorAtPoint 的 query.exec 回调入口有 _pageAlive 守护',
  /query\.exec\(\(res\)\s*=>\s*\{[\s\S]*?if \(this\._pageAlive === false\) return;/.test(profSrc));
ok('pickColorAtPoint 的 img.onload 入口有 _pageAlive 守护',
  /imgEl\.onload\s*=\s*\(\)\s*=>\s*\{[\s\S]*?if \(this\._pageAlive === false\) return;/.test(profSrc));
ok('[Low-3] pickColorAtPoint 不直接 mutate this.data：先用 .slice() 拷贝再 setData',
  /\(\s*this\.data\.pickerHistory\s*\|\|\s*\[\]\s*\)\.slice\(\)/.test(profSrc));
ok('[Medium-Low-1] pickColorAtPoint 带超时看门狗（pickerSettled 守卫 + 1.5s setTimeout 退回提示），与 index._measureTransparency 同源',
  /let pickerSettled = false;/.test(profSrc) &&
  /const pickerTimer = setTimeout\(\(\) => \{[\s\S]*?pickerSettled = true;[\s\S]*?取色超时，请重试/.test(profSrc));
ok('[Medium-Low-1] img.onload / img.onerror 均先置 pickerSettled 并 clearTimeout(pickerTimer)，防超时与真实回调重复触发',
  /imgEl\.onload\s*=\s*\(\)\s*=>\s*\{[\s\S]*?pickerSettled = true;[\s\S]*?clearTimeout\(pickerTimer\)/.test(profSrc) &&
  /imgEl\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]*?pickerSettled = true;[\s\S]*?clearTimeout\(pickerTimer\)/.test(profSrc));

(async () => {
  // 场景 A：页面已隐藏（onHide 置 _pageAlive=false）→ exec 回调提前 return，不注册 onload、不 setData
  {
    execCb = null; imgOnload = null;
    const ctx = makeCtx();
    ctx._pageAlive = false;   // 模拟用户已切走 tab
    ctx.pickColorAtPoint(50, 50);
    // pickColorAtPoint 内部触发 query.exec(cb)，我们的 mock 把 cb 存到 execCb
    execCb([{
      width: 100, height: 100, left: 0, top: 0
    }, { node: fakeCanvas }]);
    ok('场景A：隐藏页时 query.exec 回调提前 return（未注册 img.onload）', imgOnload === null);
    ok('场景A：隐藏页时未触发 setData（pickedColor 未设置）', ctx.data.pickedColor === undefined);
  }

  // 场景 B：页面存活 → 正常取色并 setData
  {
    execCb = null; imgOnload = null;
    const ctx = makeCtx();
    ctx._pageAlive = true;    // 模拟页面在前台
    ctx.pickColorAtPoint(50, 50);
    execCb([{
      width: 100, height: 100, left: 0, top: 0
    }, { node: fakeCanvas }]);
    // 手动触发 img.onload（模拟图片加载完成）
    if (typeof imgOnload === 'function') imgOnload();
    ok('场景B：存活页时注册了 img.onload 并触发取色', typeof imgOnload === 'function');
    ok('场景B：存活页时成功 setData pickedColor', ctx.data.pickedColor && ctx.data.pickedColor.originalHex === '#0A141E');
  }

  // 场景 C：[Low-3] 反模式回归：取色不得原地 mutate this.data.pickerHistory
  {
    execCb = null; imgOnload = null;
    const originalRef = [];                 // 模拟页面 data 中初始的 pickerHistory 数组
    const ctx = makeCtx({ pickerHistory: originalRef });
    ctx._pageAlive = true;
    ctx.pickColorAtPoint(50, 50);
    execCb([{
      width: 100, height: 100, left: 0, top: 0
    }, { node: fakeCanvas }]);
    if (typeof imgOnload === 'function') imgOnload();
    // 修复后：history = originalRef.slice()（新数组）再 unshift + setData，
    // 故 this.data.pickerHistory 是「新引用」，原数组 originalRef 不应被改动。
    ok('场景C：this.data.pickerHistory 为拷贝后的新数组（引用已替换）', ctx.data.pickerHistory !== originalRef);
    ok('场景C：原数组未被原地 mutate（仍为 0 条）', originalRef.length === 0);
    ok('场景C：新历史首条已写入（长度 1）', ctx.data.pickerHistory.length === 1);
  }

  // 场景 D：[Medium-Low-1] 超时看门狗。页面存活、图片选好，但 onload/onerror 都永不触发
  // （WeChat 偶发 canvas 节点销毁 / 图片解码卡死）→ 1.5s 超时兜底应弹「取色超时」提示，不永久挂起。
  {
    toastTitles = [];
    execCb = null; imgOnload = null;
    const ctx = makeCtx();
    ctx._pageAlive = true;
    ctx.pickColorAtPoint(50, 50);
    execCb([{
      width: 100, height: 100, left: 0, top: 0
    }, { node: fakeCanvas }]);
    // 关键：绝不调用 imgOnload / 不触发 onerror（模拟回调永不触发）
    ok('场景D：超时前未静默 setData pickedColor（无响应但不崩溃）', ctx.data.pickedColor === undefined);
    await new Promise((r) => setTimeout(r, 1700));
    ok('场景D：1.5s 看门狗触发「取色超时」提示（未永久挂起选图链）', toastTitles.indexOf('取色超时，请重试') !== -1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();


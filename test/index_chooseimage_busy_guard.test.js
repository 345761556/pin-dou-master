// test/index_chooseimage_busy_guard.test.js
// 安全审计 S4（客户端限频缺失）：index.chooseImage 此前无忙碌守卫，连点「选择图片」
// 会并发触发多条「校验 + 压缩 + secCheck + 透明统计 + setData」异步链，重复消耗
// mediaCheckAsync 检测配额（后端 100 次/h 限频虽兜底，并发链仍会重复计数）并产生
// 对页面状态的并发写。现加 _pickerBusy 互斥守卫（与 profile.uploadPickerImage
// _pickerBusy、template.js _saveBusy 同款机制），finally 保证任何路径复位。
// 采用 scoped require 拦截（同 profile_robustness 风格）。
const path = require('path');
const Module = require('module');
const fs = require('fs');

const INDEX_MARK = 'pages/index/index.js';

let secCheckCalls = [];
let toasts = [];
const fakeUtil = {
  getBeadSizePresets: () => [],
  formatNumber: (n) => String(n),
  formatMm: (n) => n + ' mm',
  compressImageIfNeeded: async (p) => ({ tempFilePath: p, width: 100, height: 100 }),
  clampTemplateSize: (c, r) => ({ cols: c, rows: r }),
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: () => {},
  debounce: (fn) => Object.assign(fn, { cancel: () => {} }),
  CONSTANTS: {
    DEFAULT_IMAGE_SIZE: 800,
    MAX_COLS: 120,
    MIN_COLS: 20,
    DEFAULT_COLS: 50,
    MAX_ROWS: 120,
    MAX_PIXELS: 8000
  },
  MAX_HISTORY: 50,
  MAX_PIXELS: 8000,
  MAX_ROWS: 120,
  // F3：index.js 已统一从 utils/util 解构 safeShowLoading/safeHideLoading，桩必须提供
  safeShowLoading: () => {},
  safeHideLoading: () => {}
};
const fakeSecCheck = {
  checkImageByPath: async (p, opts) => {
    secCheckCalls.push({ path: p, opts });
    return { pass: true, suggest: 'pass', skipped: false };
  },
  blockMessage: (r, def) => def
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const fname = this.filename ? this.filename.replace(/\\/g, '/') : '';
  if (fname.indexOf(INDEX_MARK) === -1) return origRequire.apply(this, arguments);
  if (id.indexOf('utils/util') !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1) return fakeSecCheck;
  if (id.indexOf('utils/beadEngine') !== -1) return { TRANSPARENCY_ALPHA: 128 };
  if (id.indexOf('utils/colorLibrary') !== -1) return {};
  if (id.indexOf('utils/security') !== -1) return { log: { info() {}, error() {}, warn() {} }, isRemoteImageUrl: () => false, isManagedHistorySource: () => false };
  if (id.indexOf('app.js') !== -1 || id.indexOf('app') !== -1) return { getBeadPrefs: () => ({}), CONSTANTS: { BEAD_SIZE: { MIN: 5, MAX: 50 } } };
  return origRequire.apply(this, arguments);
};

global.getApp = () => ({ globalData: {} });
let chooseMediaSuccessCb = null;
let chooseMediaCalls = 0;
global.wx = {
  chooseMedia: (opts) => { chooseMediaCalls++; chooseMediaSuccessCb = opts.success; },
  showToast: (o) => { toasts.push(o && o.title); },
  showLoading: () => {},
  hideLoading: () => {},
  createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({}), fields: () => ({}) }), exec: () => {} })
};
global.Page = (o) => { pageObj = o; };
let pageObj = null;
require(path.join(__dirname, '..', 'pages', 'index', 'index.js'));

function makeCtx() {
  const ctx = Object.assign({}, pageObj, {
    data: {},
    setData(d) { Object.assign(ctx.data, d); },
    // 轻量化：透明统计与预估更新在连点守卫测试中不是被测对象
    _measuring: false,
    _measureTransparency: async () => 0,
    updateEstimate() {},
    debouncedOnColsChange: { cancel: () => {} }
  });
  return ctx;
}
function reset() {
  secCheckCalls = []; toasts = []; chooseMediaCalls = 0; chooseMediaSuccessCb = null;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ============ 静态断言：源码守卫结构 ============
const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
ok('静态: chooseImage 函数入口含 _pickerBusy 前置守卫（防连点）',
  /async chooseImage\(\)[\s\S]*?if\s*\(this\._pickerBusy\)\s*return;[\s\S]*?this\._pickerBusy\s*=\s*true;/.test(src));
ok('静态: chooseImage finally 块调用 releaseBusy 复位 _pickerBusy',
  /finally\s*\{\s*releaseBusy\(\)/.test(src));

(async () => {
  // ============ 行为断言：连点并发守卫 ============
  reset();
  const ctx = makeCtx();
  ctx.chooseImage(); // 第一次触发，捕获 chooseMedia success
  const s1 = chooseMediaSuccessCb;
  ctx.chooseImage(); // 连点第二次，入口 _pickerBusy 守卫直接 return，不触发 chooseMedia
  const s2 = chooseMediaSuccessCb; // 第二次被拦截，s2 与 s1 是同一个回调
  ok('A. 第一次触发 chooseMedia，第二次被入口守卫拦截（chooseMediaCalls === 1）', chooseMediaCalls === 1);
  ok('A. 第二次调用 chooseImage 被入口守卫拦截，未设置新 success 回调（s2 === s1）', s2 === s1);

  const p1 = s1({ tempFiles: [{ tempFilePath: 'wxfile://tmp/img_A.png', size: 100, fileType: 'image' }] });
  // 第二次调用被入口守卫拦截，s2 === s1，无需再次调用；等待第一条链完成
  await p1;

  ok('A. 入口守卫有效：仅首次图片 A 进入 secCheck 链路（secCheck 调用 1 次）', secCheckCalls.length === 1);
  ok('A. 仅首次图片 A 进入检测链路', secCheckCalls[0] && secCheckCalls[0].path.indexOf('img_A') !== -1);
  ok('A. 守卫正确复位：完成后 _pickerBusy 恢复 false', ctx._pickerBusy === false);

  // ============ 行为断言：复位后可再次选择（不卡死） ============
  reset();
  const ctx2 = makeCtx();
  ctx2.chooseImage();
  const s3 = chooseMediaSuccessCb;
  await s3({ tempFiles: [{ tempFilePath: 'wxfile://tmp/img_C.png', size: 100, fileType: 'image' }] });
  ok('B. 处理完成后再次选择可正常进入（secCheck 调用 1 次）', secCheckCalls.length === 1);
  ok('B. 状态复位，_pickerBusy === false', ctx2._pickerBusy === false);

  console.log('---');
  console.log('PASS=' + passed + ' FAIL=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();

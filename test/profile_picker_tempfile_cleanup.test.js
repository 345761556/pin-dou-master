// test/profile_picker_tempfile_cleanup.test.js
// 修复 ③ 回归：uploadPickerImage 取色上传全链路清理孤儿临时文件。
// 旧实现：chooseMedia 原始图 tempFilePath 任何分支都不清理；压缩件 checkPath 成功态保留展示，
//         但 hideColorPicker / 换图时不清理 → 每次查询遗留孤儿文件、长期占用小程序存储配额。
// 修复：
//   - 成功路径：清理上一张展示图 prevPath + 原始 chooseMedia 临时文件 tempFilePath；
//   - 拦截分支 / 读取失败分支：补清理原始 tempFilePath；
//   - hideColorPicker：关闭弹窗时清理展示用取色图（checkPath 临时文件）。
//
// 采用 scoped require 拦截（同 profile_sec_check_compress 风格）。
// 运行：node test/profile_picker_tempfile_cleanup.test.js
const path = require('path');
const Module = require('module');
const PROFILE_MARK = 'pages/profile/profile.js';
let compressCalls = [];
let secCheckCalls = [];
let removeCalls = [];
let toasts = [];
let secCheckShouldPass = true;
const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p) => ({ tempFilePath: 'compressed://' + p, width: 100, height: 100 }),
  getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: (p) => { removeCalls.push(p); },
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 },
  safeShowLoading: () => {},
  safeHideLoading: () => {}
};
const fakeSecCheck = {
  checkImageByPath: async (p, opts) => secCheckShouldPass
    ? { pass: true, suggest: 'pass', skipped: false }
    : { pass: false, suggest: 'risky', skipped: false },
  blockMessage: (r, def) => def,
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.indexOf('utils/util') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeSecCheck;
  return origRequire.apply(this, arguments);
};
global.getApp = () => ({ globalData: {} });
let chooseMediaSuccessCb = null;
let chooseMediaDone = null;
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {} }),
  getImageInfo: (opts) => { if (opts.success) opts.success({ width: 100, height: 100 }); },
  showToast: (o) => { toasts.push(o && o.title); },
  chooseMedia: (opts) => { if (chooseMediaSuccessCb) chooseMediaDone = chooseMediaSuccessCb(opts); }
};
global.Page = (o) => { pageObj = o; };
let pageObj = null;
require(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'));
function makeCtx(init) {
  const ctx = Object.assign({}, pageObj, {
    data: Object.assign({ editAvatarUrl: '', pickerImagePath: '' }, init || {}),
    setData: (d) => Object.assign(ctx.data, d)
  });
  return ctx;
}
function reset() {
  compressCalls = []; secCheckCalls = []; removeCalls = []; toasts = [];
  secCheckShouldPass = true; chooseMediaSuccessCb = null; chooseMediaDone = null;
}
let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}
(async () => {
  // (a) 成功上传后：原始 chooseMedia 临时文件 tempFilePath 被清理；展示图 checkPath 保留
  reset();
  const a = makeCtx();
  chooseMediaSuccessCb = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker1.png' }] });
  await a.uploadPickerImage();
  await chooseMediaDone;
  ok('③(a) 成功上传后：原始 chooseMedia 临时文件 tempFilePath 被清理',
    removeCalls.indexOf('wxfile://tmp/picker1.png') !== -1);
  ok('③(a) 成功上传后：压缩件 checkPath 保留用于展示（未清理）',
    a.data.pickerImagePath === 'compressed://wxfile://tmp/picker1.png' &&
    removeCalls.indexOf('compressed://wxfile://tmp/picker1.png') === -1);
  // (b) 调用 hideColorPicker 后：展示用取色图（pickerImagePath 对应文件）被清理
  reset();
  const b = makeCtx();
  chooseMediaSuccessCb = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker2.png' }] });
  await b.uploadPickerImage();
  await chooseMediaDone;
  const shownPath = b.data.pickerImagePath; // 'compressed://wxfile://tmp/picker2.png'
  ok('③(b) 上传完成：展示图已设置', shownPath === 'compressed://wxfile://tmp/picker2.png');
  removeCalls = []; // 隔离 hideColorPicker 的清理观测
  b.hideColorPicker();
  ok('③(b) hideColorPicker：清理展示用取色图（pickerImagePath 对应文件）',
    removeCalls.indexOf(shownPath) !== -1);
  ok('③(b) hideColorPicker：pickerImagePath 已清空', b.data.pickerImagePath === '');
  // (c) 连续上传两张图：第二张上传时清理第一张已展示的 checkPath（换图孤儿清理）
  reset();
  const c = makeCtx();
  chooseMediaSuccessCb = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker3.png' }] });
  await c.uploadPickerImage();
  await chooseMediaDone;
  const firstCheck = c.data.pickerImagePath; // 'compressed://wxfile://tmp/picker3.png'
  ok('③(c) 第一张上传：checkPath 已记录为展示图', firstCheck === 'compressed://wxfile://tmp/picker3.png');
  chooseMediaSuccessCb = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker4.png' }] });
  removeCalls = []; // 隔离第二张上传的清理观测
  await c.uploadPickerImage();
  await chooseMediaDone;
  ok('③(c) 第二张上传：清理第一张已展示的 checkPath（换图孤儿不累积）',
    removeCalls.indexOf(firstCheck) !== -1);
  ok('③(c) 第二张上传：新展示图 checkPath 已更新', c.data.pickerImagePath === 'compressed://wxfile://tmp/picker4.png');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

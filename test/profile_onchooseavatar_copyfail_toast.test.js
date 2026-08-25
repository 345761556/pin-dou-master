// test/profile_onchooseavatar_copyfail_toast.test.js
// 修复 ② 回归：onChooseAvatar 的 copyFileSync（持久化头像到 USER_DATA_PATH/avatar.png）失败时，
// 旧实现仅把 editAvatarUrl 回退为 volatile 的 tempPath，既不清理压缩件 checkPath，也无任何提示，
// 造成「静默成功」假象（用户以为保存成功，重启后头像失效）。
// 修复：catch 分支在回退 tempPath 后，清理压缩件 checkPath（非活动头像，避免孤儿累积），
//       并弹出『头像保存失败，请重试』toast。
//
// 采用 scoped require 拦截（同 profile_onchooseavatar_tempfile_cleanup 风格）。
// 运行：node test/profile_onchooseavatar_copyfail_toast.test.js
const path = require('path');
const Module = require('module');
const PROFILE_MARK = 'pages/profile/profile.js';
let compressCalls = [];
let removeCalls = [];
let copyCalls = [];
let toasts = [];
let secCheckShouldPass = true;
let copyShouldFail = false;
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
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getFileSystemManager: () => ({
    copyFileSync: (src, dest) => { if (copyShouldFail) throw new Error('quota'); copyCalls.push({ src, dest }); },
    accessSync: () => {}
  }),
  getImageInfo: (opts) => { if (opts.success) opts.success({ width: 100, height: 100 }); },
  showToast: (o) => { toasts.push(o && o.title); }
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
  compressCalls = []; removeCalls = []; copyCalls = []; toasts = [];
  secCheckShouldPass = true; copyShouldFail = false;
}
let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}
(async () => {
  // 修复 ②：copyFileSync 失败 → editAvatarUrl 仍为 tempPath（活动头像）、checkPath 被清理、有 toast『头像保存失败』
  reset();
  copyShouldFail = true;
  const d = makeCtx();
  await d.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_D.png' } });
  ok('② 复制失败：editAvatarUrl 回退为 tempPath（仍作为活动头像，本次会话可用）',
    d.data.editAvatarUrl === 'wxfile://tmp/avatar_D.png');
  ok('② 复制失败：压缩件 checkPath 被清理（避免孤儿临时文件累积）',
    removeCalls.indexOf('compressed://wxfile://tmp/avatar_D.png') !== -1);
  ok('② 复制失败：tempPath（活动头像）不被清理',
    removeCalls.indexOf('wxfile://tmp/avatar_D.png') === -1);
  ok('② 复制失败：弹出『头像保存失败，请重试』提示（消除静默成功假象）',
    toasts.some((t) => t && t.indexOf('头像保存失败') !== -1));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

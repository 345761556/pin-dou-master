// test/profile_robustness.test.js
// 通篇体检（2026-08-16）健壮性回归：
//   C. profile 两处上传入口（onChooseAvatar / uploadPickerImage）此前无忙碌守卫，
//      连点会并发触发「压缩 + secCheck + 写文件」异步链，且都向固定 avatar.png 写文件，
//      存在竞态覆盖；现加 _avatarBusy / _pickerBusy 互斥守卫（与 template.js _saveBusy 同款）。
//   B. profile.onLoad 此前裸调 wx.getStorageSync('userInfo_safe'/'userInfo')，存储损坏抛错会
//      中断整页 onLoad 导致白屏；现包裹 try/catch 回退未登录。
// 采用 scoped require 拦截（同 profile_onchooseavatar_tempfile_cleanup 风格）。,
const path = require('path');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

let compressCalls = [];
let secCheckCalls = [];
let removeCalls = [];
let copyCalls = [];
let toasts = [];
let secCheckShouldPass = true;
let compressFallback = false;
let copyShouldFail = false;
const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p) => {
    compressCalls.push(p);
    if (compressFallback) return { tempFilePath: p, width: 100, height: 100 };
    return { tempFilePath: 'compressed://' + p, width: 100, height: 100 };
  },
  getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: (p) => { removeCalls.push(p); },
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 },
  safeShowLoading: () => {},
  safeHideLoading: () => {}
};
const fakeSecCheck = {
  checkImageByPath: async (p, opts) => {
    secCheckCalls.push({ path: p, opts });
    return secCheckShouldPass
      ? { pass: true, suggest: 'pass', skipped: false }
      : { pass: false, suggest: 'risky', skipped: false };
  },
  blockMessage: (r, def) => def
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.indexOf('utils/util') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeSecCheck;
  return origRequire.apply(this, arguments);
};

global.getApp = () => ({ globalData: {} });
let chooseMediaSuccessCb = null;
let chooseMediaCalls = 0;
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getFileSystemManager: () => ({
    copyFileSync: (src, dest) => { if (copyShouldFail) throw new Error('quota'); copyCalls.push({ src, dest }); },
    accessSync: () => {}
  }),
  getImageInfo: (opts) => { if (opts.success) opts.success({ width: 100, height: 100 }); },
  showToast: (o) => { toasts.push(o && o.title); },
  getStorageSync: () => null,
  chooseMedia: (opts) => { chooseMediaCalls++; chooseMediaSuccessCb = opts.success; },
  removeStorageSync: () => {},
  setStorageSync: () => {}
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
  compressCalls = []; secCheckCalls = []; removeCalls = []; copyCalls = []; toasts = [];
  secCheckShouldPass = true; compressFallback = false; copyShouldFail = false;
  chooseMediaCalls = 0; chooseMediaSuccessCb = null;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

(async () => {
  // ===== C1: onChooseAvatar 并发守卫 =====
  // 同一 ctx 连续两次触发（模拟连点头像按钮）：首个链在 await 处让出时 _avatarBusy 已置 true，
  // 第二次同步进入即被守卫忽略，不应再次调用 secCheck / 写文件。
  reset();
  secCheckShouldPass = true;
  const a = makeCtx();
  const p1 = a.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/av_A.png' } });
  const p2 = a.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/av_B.png' } });
  await Promise.all([p1, p2]);
  ok('C1. onChooseAvatar 并发：第二次被 _avatarBusy 守卫忽略，secCheck 仅调用 1 次', secCheckCalls.length === 1);
  ok('C1. onChooseAvatar 并发：仅首次 A 被持久化到 avatar.png（无并发覆盖）', copyCalls.length === 1 && copyCalls[0].src.indexOf('av_A') !== -1);
  ok('C1. 守卫正确复位：完成后 _avatarBusy 恢复 false', a._avatarBusy === false);

  // ===== C2: uploadPickerImage 并发守卫 =====
  reset();
  const b = makeCtx();
  b.uploadPickerImage();                 // 第一次触发 chooseMedia
  ok('C2. 第一次调用触发 chooseMedia（chooseMediaCalls === 1）', chooseMediaCalls === 1);
  b.uploadPickerImage();                 // 连点第二次，入口 _pickerBusy 守卫直接 return
  ok('C2. 第二次调用被入口守卫拦截（chooseMedia 未再次触发，chooseMediaCalls 仍为 1）', chooseMediaCalls === 1);
  const s1 = chooseMediaSuccessCb({ tempFiles: [{ tempFilePath: 'wxfile://tmp/pk_A.png' }] });
  await s1;
  ok('C2. 处理完成后 secCheck 仅调用 1 次（无并发重复检测）', secCheckCalls.length === 1);
  ok('C2. 仅首次 A 进入展示读取流程', b.data.pickerImagePath.indexOf('pk_A') !== -1);
  ok('C2. 守卫正确复位：完成后 _pickerBusy 恢复 false', b._pickerBusy === false);

  // ===== B: onLoad 存储读取异常不崩溃 =====
  reset();
  global.wx.getStorageSync = () => { throw new Error('corrupted storage'); };
  let threw = false;
  try {
    const c = makeCtx();
    c.onLoad();   // 同步执行；裸调用时代会在此抛未捕获异常致白屏，包裹后回退未登录
  } catch (e) {
    threw = true;
    console.log('   onLoad 抛错:', e.message);
  }
  global.wx.getStorageSync = () => null;
  ok('B. onLoad 存储读取异常时不崩溃（try/catch 包裹生效，回退未登录）', !threw);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();


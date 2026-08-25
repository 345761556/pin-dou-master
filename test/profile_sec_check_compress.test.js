// test/profile_sec_check_compress.test.js
// M2 回归（profile 两条上传路径无压缩前置）：验证 profile 页在调用内容安全检测前，
// 对送检图片执行 compressImageIfNeeded 前置压缩（与 index.chooseImage 对齐），
// 从而避免 >7MB 原图触发 secCheck 体积守卫跳过检测（可复现的违规图绕过路径）。
//
// 采用 scoped require 拦截：仅对 profile.js 引用的 '../../utils/util' 与 '../../utils/secCheck'
// 替换为可观测桩（其余模块仍走真实实现），从而断言"压缩确实发生在送检之前、且送检的是压缩后路径"。
// 运行：node test/profile_sec_check_compress.test.js,
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

// ---- scoped require 拦截：仅 profile.js 引用替换为可观测桩 ----,
let compressCalls = [];   // { p, max }
let secCheckCalls = [];   // { path, opts }
let removeCalls = [];     // removeFileIfExists 被调用的路径,
let secCheckShouldPass = true;  // 控制 secCheck 返回 pass/fail（验证拦截分支清理）,
let getImageInfoShouldFail = false;  // 控制展示用 getImageInfoWithTimeout 成功/失败（验证 B10 读取失败分支）,
const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p, max) => {
    compressCalls.push({ p, max });
    return { tempFilePath: 'compressed://' + p, width: 100, height: 100 };
  },
  getImageInfoWithTimeout: (src) => {
    getImageInfoCalls.push(src);
    if (getImageInfoShouldFail) return Promise.reject(new Error('read failed'));
    return Promise.resolve({ width: 100, height: 100, type: 'png' });
  },
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
  blockMessage: (r, def) => def   // 失败时返回默认文案（含"违规"，供断言）
};

const origRequire = Module.prototype.require;
// Windows 下 module.filename 使用反斜杠，统一归一化后再匹配（否则 scoped 拦截在 Win 上失效）
Module.prototype.require = function (id) {
  if (id.indexOf('utils/util') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeSecCheck;
  return origRequire.apply(this, arguments);
};

// ---- mock 微信环境 ----,
let copyCalls = [];
let getImageInfoCalls = [];
let chooseMediaSuccess = null;
let chooseMediaDone = null;   // 捕获 success 异步回调返回的 promise，便于测试 await 完成,
let toasts = [];
global.getApp = () => ({ globalData: {} });
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getFileSystemManager: () => ({
    copyFileSync: (src, dest) => { copyCalls.push({ src, dest }); },
    accessSync: () => {}
  }),
  chooseMedia: (opts) => { if (chooseMediaSuccess) chooseMediaDone = chooseMediaSuccess(opts); },
  getImageInfo: (opts) => { getImageInfoCalls.push(opts.src); if (opts.success) opts.success({ width: 100, height: 100 }); },
  cloud: { uploadFile: () => {}, callFunction: () => {}, deleteFile: () => {} },
  showToast: (o) => { toasts.push(o && o.title); }
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };
require('../pages/profile/profile.js');

function makeCtx(init) {
  const ctx = Object.assign({}, pageObj, {
    data: Object.assign({ editAvatarUrl: '', pickerImagePath: '' }, init || {}),
    setData: (d) => Object.assign(ctx.data, d)
  });
  return ctx;
}
function reset() { compressCalls = []; secCheckCalls = []; removeCalls = []; copyCalls = []; getImageInfoCalls = []; toasts = []; chooseMediaSuccess = null; chooseMediaDone = null; secCheckShouldPass = true; getImageInfoShouldFail = false; }

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 静态断言：导入与 WXML 结构 ----,
const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'), 'utf8');
ok('profile.js 导入 compressImageIfNeeded', /compressImageIfNeeded/.test(src));
ok('profile.js 导入 CONSTANTS', /CONSTANTS/.test(src));
ok('profile.js 含 _compressForSecCheck 私有方法', /_compressForSecCheck/.test(src));
const wxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.wxml'), 'utf8');
ok('profile.wxml 含 #__compress-canvas（让压缩真正生效）', /id="__compress-canvas"/.test(wxml));

(async () => {
  // 场景1：onChooseAvatar(scene=1) 送检前压缩，且把压缩后路径交给 secCheck、存档用压缩后路径
  reset();
  const a = makeCtx();
  await a.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar.png' } });
  ok('onChooseAvatar 调用 compressImageIfNeeded 前置压缩(maxSide=800)',
    compressCalls.length === 1 && compressCalls[0].p === 'wxfile://tmp/avatar.png' && compressCalls[0].max === 800);
  ok('onChooseAvatar 把【压缩后】路径交给 secCheck（非原图）',
    secCheckCalls.length === 1 && secCheckCalls[0].path === 'compressed://wxfile://tmp/avatar.png' && secCheckCalls[0].opts.scene === 1);
  ok('onChooseAvatar 头像存档使用压缩后路径',
    copyCalls.length === 1 && copyCalls[0].src === 'compressed://wxfile://tmp/avatar.png');
  ok('onChooseAvatar 成功 → 持久化后清理全部临时文件（checkPath + 原始 tempPath，避免累积）',
    removeCalls.indexOf('compressed://wxfile://tmp/avatar.png') !== -1 &&
    removeCalls.indexOf('wxfile://tmp/avatar.png') !== -1 &&
    removeCalls.length === 2);

  // 场景2：uploadPickerImage(scene=2) 送检前压缩，并把压缩后路径用于展示与取色
  reset();
  const b = makeCtx();
  chooseMediaSuccess = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker.png' }] });
  await b.uploadPickerImage();
  await chooseMediaDone; // 等待 success 异步回调内所有 await（压缩+检测+展示）完成
  ok('uploadPickerImage 调用 compressImageIfNeeded 前置压缩(maxSide=800)',
    compressCalls.length === 1 && compressCalls[0].p === 'wxfile://tmp/picker.png' && compressCalls[0].max === 800);
  ok('uploadPickerImage 把【压缩后】路径交给 secCheck（非原图）',
    secCheckCalls.length === 1 && secCheckCalls[0].path === 'compressed://wxfile://tmp/picker.png' && secCheckCalls[0].opts.scene === 2);
  ok('uploadPickerImage 展示与取色使用压缩后路径',
    getImageInfoCalls.length === 1 && getImageInfoCalls[0] === 'compressed://wxfile://tmp/picker.png' && b.data.pickerImagePath === 'compressed://wxfile://tmp/picker.png');

  // 场景3：[9]/[4] 对齐 —— onChooseAvatar 内容安全拦截(违规)分支也要清理压缩临时文件，
  //         避免反复换违规头像累积临时文件；压缩回退原图(checkPath===tempPath)时不删原图
  reset();
  secCheckShouldPass = false;
  const c = makeCtx();
  await c.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar.png' } });
  ok('onChooseAvatar 安全拦截 → 给出违规 toast',
    toasts.length === 1 && /违规/.test(toasts[0]));
  ok('onChooseAvatar 安全拦截 → 清理【压缩后】临时文件 checkPath',
    removeCalls.indexOf('compressed://wxfile://tmp/avatar.png') !== -1);
  ok('onChooseAvatar 安全拦截 → 一并清理原始头像临时文件 tempPath（被拒头像无需保留，避免高频换头像累积）',
    removeCalls.indexOf('wxfile://tmp/avatar.png') !== -1);
  ok('onChooseAvatar 安全拦截 → 共清理 2 个临时文件（checkPath + tempPath）',
    removeCalls.length === 2);

  // 场景4：[9]/[4] 对齐 —— uploadPickerImage 安全拦截分支同样清理压缩临时文件
  reset();
  secCheckShouldPass = false;
  const d = makeCtx();
  chooseMediaSuccess = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker.png' }] });
  await d.uploadPickerImage();
  await chooseMediaDone;
  ok('uploadPickerImage 安全拦截 → 清理【压缩后】临时文件（checkPath !== tempFilePath）',
    removeCalls.length === 2 && removeCalls[0] === 'compressed://wxfile://tmp/picker.png');
  ok('uploadPickerImage 安全拦截 → 一并清理原始临时文件 tempFilePath（本图被拒、非当前展示，防孤儿累积）',
    removeCalls.indexOf('wxfile://tmp/picker.png') !== -1);

  // 场景5：B10 —— 展示图读取（getImageInfoWithTimeout）失败分支：
  //        不应残留旧图 + 「读取失败」提示矛盾的脏展示态；压缩临时图顺手清理防累积。,
  //        用预置 pickerImagePath('wxfile://old.png') 模拟「用户已有一张旧图、本次换图读取失败」场景。
  reset();
  getImageInfoShouldFail = true;
  const e = makeCtx({ pickerImagePath: 'wxfile://old.png', pickerImageInfo: { width: 50, height: 50, type: 'png' } });
  chooseMediaSuccess = (opts) => opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/picker.png' }] });
  await e.uploadPickerImage();
  await chooseMediaDone;
  ok('B10 读取失败 → 给出「图片读取失败」toast', toasts.length === 1 && /读取失败/.test(toasts[0]));
  ok('B10 读取失败 → 清空展示态 pickerImagePath（不再残留旧图）',
    e.data.pickerImagePath === '');
  ok('B10 读取失败 → 清空展示态 pickerImageInfo 为 null',
    e.data.pickerImageInfo === null);
  ok('B10 读取失败 → 清理【压缩后】临时文件（checkPath !== tempFilePath，防累积）',
    removeCalls.indexOf('compressed://wxfile://tmp/picker.png') !== -1);
  ok('B10 读取失败 → 一并清理原始临时文件 tempFilePath（读取失败不再需要，防孤儿累积）',
    removeCalls.indexOf('wxfile://tmp/picker.png') !== -1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();


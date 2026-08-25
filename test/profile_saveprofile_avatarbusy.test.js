// test/profile_saveprofile_avatarbusy.test.js
// 修复 ① 回归：saveProfile 与 onChooseAvatar 并发时丢新头像的竞态。
const path = require('path');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

let compressCalls = [];
let secCheckCalls = [];
let copyCalls = [];
let toasts = [];
let storage = {};
let storageWrites = 0;
const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p) => {
    compressCalls.push(p);
    return { tempFilePath: 'compressed://' + p, width: 100, height: 100 };
  },
  getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: () => {},
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 },
  safeShowLoading: () => {},
  safeHideLoading: () => {}
};
const fakeSecCheck = {
  checkImageByPath: async (p, opts) => {
    secCheckCalls.push({ path: p, opts });
    return { pass: true, suggest: 'pass', skipped: false };
  },
  checkText: async () => ({ pass: true, suggest: 'pass', skipped: false }),
  blockMessage: (r, def) => def
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.indexOf('utils/util') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeSecCheck;
  return origRequire.apply(this, arguments);
};

const USER_DATA_PATH = 'wxfile://usr';
const NEW_DEST = USER_DATA_PATH + '/avatar.png';
global.getApp = () => ({ globalData: {} });
global.wx = {
  env: { USER_DATA_PATH },
  getFileSystemManager: () => ({
    copyFileSync: (src, dest) => { copyCalls.push({ src, dest }); },
    accessSync: () => {}
  }),
  getImageInfo: (opts) => { if (opts.success) opts.success({ width: 100, height: 100 }); },
  showToast: (o) => { toasts.push(o && o.title); },
  getStorageSync: (k) => (k in storage ? storage[k] : null),
  setStorageSync: (k, v) => { storage[k] = v; if (k === 'userInfo_safe') storageWrites++; },
  removeStorageSync: (k) => { delete storage[k]; }
};
global.Page = (o) => { pageObj = o; };
require(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'));

function makeCtx(init) {
  const ctx = Object.assign({}, pageObj, {
    data: Object.assign({ editAvatarUrl: '', pickerImagePath: '' }, init || {}),
    setData: (d) => Object.assign(ctx.data, d)
  });
  return ctx;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

(async () => {
  const OLD = 'wxfile://usr/avatar_old.png';
  const NEW_TEMP = 'wxfile://tmp/avatar_new.png';
  storage = {}; storageWrites = 0; compressCalls = []; secCheckCalls = []; copyCalls = []; toasts = [];

  const ctx = makeCtx({ editAvatarUrl: OLD });
  let lastSavePromise = null;
  const origSave = ctx.saveProfile;
  ctx.saveProfile = (...args) => { const p = origSave.apply(ctx, args); lastSavePromise = p; return p; };

  const pAvatar = ctx.onChooseAvatar({ detail: { avatarUrl: NEW_TEMP } });
  const earlyPromise = ctx.saveProfile();

  ok('① 头像链中点保存：saveProfile 早退、未立即持久化任何 userInfo_safe', storageWrites === 0);
  ok('① 头像链中点保存：saveProfile 触发了挂起续存标记（已早退）', ctx._saveAfterAvatar === true || earlyPromise !== undefined);

  await pAvatar;
  if (lastSavePromise && lastSavePromise !== earlyPromise) await lastSavePromise;

  ok('① onChooseAvatar 完成后自动续存最新头像', storageWrites === 1);
  ok('① 续存后 userInfo_safe.avatarUrl === 新头像路径（丢失新头像竞态已修复）',
    storage['userInfo_safe'] && storage['userInfo_safe'].avatarUrl === NEW_DEST);
  ok('① 续存持久化的是【新】头像而非【旧】头像', storage['userInfo_safe'].avatarUrl !== OLD);
  ok('① 头像链最终正确复位 _avatarBusy', ctx._avatarBusy === false);
  ok('① 续存标记已消费复位', ctx._saveAfterAvatar === false);

  {
    storage = {}; storageWrites = 0; compressCalls = []; secCheckCalls = []; copyCalls = []; toasts = [];
    const c2 = makeCtx({ editAvatarUrl: '' });
    await c2.onChooseAvatar({ detail: { avatarUrl: NEW_TEMP } });
    ok('对照：头像链完成后 editAvatarUrl 已被更新为新头像', c2.data.editAvatarUrl === NEW_DEST);
    await c2.saveProfile();
    ok('对照：顺序保存正常持久化新头像', storage['userInfo_safe'] && storage['userInfo_safe'].avatarUrl === NEW_DEST);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

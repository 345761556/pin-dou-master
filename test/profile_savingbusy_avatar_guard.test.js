// test/profile_savingbusy_avatar_guard.test.js
// F1 回归：保存进行中换头像 → 新头像静默丢失。
const path = require('path');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

let toasts = [];
let copyCalls = [];
let storage = {};
let storageWrites = 0;
let resolveNickCheck = null;

const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p) => ({ tempFilePath: 'compressed://' + p, width: 100, height: 100 }),
  getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: () => {},
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 },
  safeShowLoading: () => {},
  safeHideLoading: () => {}
};
const fakeSecCheck = {
  checkImageByPath: async () => ({ pass: true, suggest: 'pass', skipped: false }),
  checkText: async () => {
    await new Promise((resolve) => { resolveNickCheck = resolve; });
    return { pass: true, suggest: 'pass', skipped: false };
  },
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

  storage = {}; storageWrites = 0; copyCalls = []; toasts = [];

  const ctx = makeCtx({ editAvatarUrl: OLD, showProfileEdit: true });

  const pSave = ctx.saveProfile();
  ok('T1 保存链已进入 busy 态（_savingBusy=true）', ctx._savingBusy === true);

  await ctx.onChooseAvatar({ detail: { avatarUrl: NEW_TEMP } });

  ok('T1 被拦截并弹出提示', toasts.indexOf('保存中，请稍候再更换头像') !== -1);
  ok('T1 头像链未启动（未置 _avatarBusy）', ctx._avatarBusy === undefined || ctx._avatarBusy === false);
  ok('T1 未发生写盘（copyFileSync 未调用）', copyCalls.length === 0);
  ok('T1 弹窗头像未被更新为新图', ctx.data.editAvatarUrl === OLD);

  resolveNickCheck();
  await pSave;

  ok('T1 保存链正常持久化旧头像', storage['userInfo_safe'] && storage['userInfo_safe'].avatarUrl === OLD);
  ok('T1 保存完成后 _savingBusy 复位', ctx._savingBusy === false);

  storage = {}; storageWrites = 0; copyCalls = []; toasts = [];
  const c2 = makeCtx({ editAvatarUrl: OLD, showProfileEdit: true });
  await c2.onChooseAvatar({ detail: { avatarUrl: NEW_TEMP } });
  ok('T2 保存完成后换头像不再被拦（无提示 toast）', toasts.indexOf('保存中，请稍候再更换头像') === -1);
  ok('T2 头像链正常写盘', copyCalls.length === 1 && copyCalls[0].dest === NEW_DEST);
  ok('T2 editAvatarUrl 更新为新头像', c2.data.editAvatarUrl === NEW_DEST);
  ok('T2 _avatarBusy 正常复位', c2._avatarBusy === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

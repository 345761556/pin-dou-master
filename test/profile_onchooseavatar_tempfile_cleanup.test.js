// test/profile_onchooseavatar_tempfile_cleanup.test.js
// B15 回归：onChooseAvatar 在「内容安全检测失败」与「持久化成功」两条路径下，
// 都必须显式清理原始头像临时文件 tempPath（不只压缩件 checkPath），避免高频换头像时
// wxfile://tmp_avatar_*.png 临时文件累积（此前仅在成功路径清 checkPath、失败路径连 checkPath
// 也仅条件清理，tempPath 始终遗留，依赖系统回收）。
//
// 采用 scoped require 拦截：仅对 profile.js 引用的 '../../utils/util' 与 '../../utils/secCheck'
// 替换为可观测桩（其余模块走真实实现）。运行：node test/profile_onchooseavatar_tempfile_cleanup.test.js
const path = require('path');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

let compressCalls = [];
let secCheckCalls = [];
let removeCalls = [];        // removeFileIfExists 被调用的路径（B15 重点观测）
let copyCalls = [];
let toasts = [];
let secCheckShouldPass = true;
let compressFallback = false; // true 时压缩回退原图（checkPath === tempPath）
const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p) => {
    compressCalls.push(p);
    if (compressFallback) return { tempFilePath: p, width: 100, height: 100 }; // 回退原图：checkPath===tempPath
    return { tempFilePath: 'compressed://' + p, width: 100, height: 100 };
  },
  getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: (p) => { removeCalls.push(p); },
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 }
,
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
let copyShouldFail = false;
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
  compressCalls = []; secCheckCalls = []; removeCalls = []; copyCalls = []; toasts = [];
  secCheckShouldPass = true; compressFallback = false; copyShouldFail = false;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

(async () => {
  // 场景A：安全检测失败（压缩生成独立 checkPath）→ 同时清理 checkPath 与 tempPath
  reset();
  secCheckShouldPass = false;
  const a = makeCtx();
  await a.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_A.png' } });
  ok('A. 失败：清理压缩件 checkPath', removeCalls.indexOf('compressed://wxfile://tmp/avatar_A.png') !== -1);
  ok('A. 失败：清理原始临时文件 tempPath（B15 核心：此前遗漏）', removeCalls.indexOf('wxfile://tmp/avatar_A.png') !== -1);
  ok('A. 失败：共清理 2 个文件', removeCalls.length === 2);

  // 场景B：安全检测失败 + 压缩回退原图（checkPath === tempPath）→ 同一文件幂等删除，仅 1 次
  reset();
  secCheckShouldPass = false;
  compressFallback = true;
  const b = makeCtx();
  await b.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_B.png' } });
  ok('B. 压缩回退：单文件被清理', removeCalls.indexOf('wxfile://tmp/avatar_B.png') !== -1);
  ok('B. 压缩回退：不重复删除同一文件', removeCalls.length === 1);

  // 场景C：持久化成功 → 同时清理 checkPath 与 tempPath
  reset();
  const c = makeCtx();
  await c.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_C.png' } });
  ok('C. 成功：头像持久化到 USER_DATA_PATH/avatar.png', c.data.editAvatarUrl === 'wxfile://usr/avatar.png');
  ok('C. 成功：清理压缩件 checkPath', removeCalls.indexOf('compressed://wxfile://tmp/avatar_C.png') !== -1);
  ok('C. 成功：清理原始临时文件 tempPath（B15 对称修复）', removeCalls.indexOf('wxfile://tmp/avatar_C.png') !== -1);
  ok('C. 成功：共清理 2 个文件', removeCalls.length === 2);

  // 场景D：持久化失败（复制异常）→ 回退以 tempPath 为当前头像，绝不能清理 tempPath
  reset();
  copyShouldFail = true;
  const d = makeCtx();
  await d.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_D.png' } });
  ok('D. 复制失败：回退使用 tempPath 作为当前头像', d.data.editAvatarUrl === 'wxfile://tmp/avatar_D.png');
  ok('D. 复制失败：tempPath 不被清理（仍作为活动头像）', removeCalls.indexOf('wxfile://tmp/avatar_D.png') === -1);

  // 场景E：高频连续换违规头像 3 次 → 每次的原始 tempPath 都被清理，无累积
  reset();
  secCheckShouldPass = false;
  const temps = ['wxfile://tmp/avatar_E1.png', 'wxfile://tmp/avatar_E2.png', 'wxfile://tmp/avatar_E3.png'];
  for (const t of temps) {
    const e = makeCtx();
    await e.onChooseAvatar({ detail: { avatarUrl: t } });
  }
  ok('E. 高频失败：3 个原始 tempPath 全部被清理', temps.every(t => removeCalls.indexOf(t) !== -1));
  ok('E. 高频失败：共清理 6 个文件（3 checkPath + 3 tempPath），无遗漏累积', removeCalls.length === 6);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

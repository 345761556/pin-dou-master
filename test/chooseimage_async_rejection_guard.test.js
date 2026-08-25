// test/chooseimage_async_rejection_guard.test.js
// H1 回归：chooseImage(index.js) / uploadPickerImage(profile.js) 的 wx.chooseMedia success 是 async 回调，
// 内部多个 await（validateImageFile / compressImageIfNeeded / secCheck.checkImageByPath / setData 等）
// 若抛异常，会被吞成「未处理的 Promise 拒绝」——wx.chooseMedia 的 fail 回调只捕获 chooseMedia 自身失败，
// 拦不到 success 内的异步异常，导致用户无任何提示、操作静默失败。
//
// 修复：success 回调体顶层包 try-catch，异常时 log.error + wx.showToast('图片处理失败，请重试')，
// 把「未处理拒绝」转成「用户可见的失败提示」（fail-closed，绝不静默吞错）。
//
// 本测试用「可抛函数注入」验证：让 validateImageFile / secCheck.checkImageByPath 主动 reject，
// 断言① 弹出通用失败 toast；② 无未处理的 Promise 拒绝逃逸（吞掉）；③ success 返回的 promise 已 resolve
// （而非 reject，否则测试自身的 await 会抛 unhandledRejection）。
// 运行：node test/chooseimage_async_rejection_guard.test.js

const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const utilPath = path.join(root, 'utils', 'util.js');
const secCheckPath = path.join(root, 'utils', 'secCheck.js');
const colorLibPath = path.join(root, 'utils', 'colorLibrary.js');
const indexPath = path.join(root, 'pages', 'index', 'index.js');
const profilePath = path.join(root, 'pages', 'profile', 'profile.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 共享：可抛函数注入 + 微信运行时 mock ----
function makeThrower(msg) { return () => Promise.reject(new Error(msg)); }

let toasts = [];
let unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// 通用 wx mock（index / profile 共用，每次 reset 时清空 toasts）
function makeWx() {
  return {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getStorageSync: () => null,
    getImageInfo: (opts) => { if (opts.success) opts.success({ width: 100, height: 100 }); },
    createSelectorQuery: () => { const q = { select() { return q; }, fields() { return q; }, exec(cb) { cb([{}]); } }; return q; },
    chooseMedia: (opts) => { chooseMediaDone = opts.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/x.png', size: 100, fileType: 'image' }] }); },
    cloud: { uploadFile: () => {}, callFunction: () => {}, deleteFile: () => {} },
    showToast: (o) => { toasts.push(o && o.title); }
  };
}
let chooseMediaDone = null;

function clearCaches() {
  [utilPath, secCheckPath, colorLibPath, indexPath, profilePath].forEach((p) => { delete require.cache[p]; });
}

async function driveAndAwait(callFn) {
  // 触发 chooseMedia：success 回调返回的 promise 被 chooseMediaDone 捕获
  callFn();
  let resolved = true;
  try { await chooseMediaDone; } catch (e) { resolved = false; }
  // 再 flush 一个微任务，确保任何逃逸的 unhandledRejection 已被 process 捕获
  await new Promise((r) => setImmediate(r));
  return resolved;
}

// ============ 静态断言（修复存在性）============
const indexSrc = fs.readFileSync(indexPath, 'utf8');
const profileSrc = fs.readFileSync(profilePath, 'utf8');

ok('index.chooseImage catch (err) 顶层捕获异步体异常',
  /\}\s*catch\s*\(err\)\s*\{/.test(indexSrc));
ok('index.chooseImage 异步异常兜底通用 toast 文案存在',
  /wx\.showToast\(\{\s*title:\s*'图片处理失败，请重试'/.test(indexSrc));

ok('profile.uploadPickerImage catch (err) 顶层捕获异步体异常',
  /\}\s*catch\s*\(err\)\s*\{/.test(profileSrc));
ok('profile.uploadPickerImage 异步异常兜底通用 toast 文案存在',
  /wx\.showToast\(\{\s*title:\s*'图片处理失败，请重试'/.test(profileSrc));

ok('index.chooseImage catch 仅兜底、不吞掉 chooseMedia 自身失败语义',
  /\[chooseImage\] 异步处理异常/.test(indexSrc));

ok('profile.uploadPickerImage catch 仅兜底、不吞掉 chooseMedia 自身失败语义',
  /\[uploadPickerImage\] 异步处理异常/.test(profileSrc));

// ============ 运行时：index.js chooseImage ============
(async () => {
  // ---- Part 1：index.js ----
  global.wx = makeWx();
  global.App = () => {};
  global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
  global.Page = (o) => { indexPage = o; };
  let indexPage = null;

  const realUtil = require(utilPath); // 先取真实实现，再整体替换缓存（保留其余符号）
  // 可注入的 validateImageFile / compressImageIfNeeded / secCheck
  let validateThrows = false, secThrows = false;
  require.cache[colorLibPath] = {
    id: colorLibPath, filename: colorLibPath, loaded: true,
    exports: { getCurrentPaletteKey: () => 'artkal_c', getPaletteName: () => 'c', getPaletteList: () => [], getCurrentColors: () => [], switchPalette: () => [] }
  };
  require.cache[utilPath] = {
    id: utilPath, filename: utilPath, loaded: true,
    exports: Object.assign({}, realUtil, {
      validateImageFile: (f) => validateThrows ? Promise.reject(new Error('validate_throw')) : Promise.resolve(true),
      compressImageIfNeeded: (p) => Promise.resolve({ tempFilePath: p, width: 100, height: 100 })
    })
  };
  require.cache[secCheckPath] = {
    id: secCheckPath, filename: secCheckPath, loaded: true,
    exports: {
      checkImageByPath: () => secThrows ? Promise.reject(new Error('sec_throw')) : Promise.resolve({ pass: true, suggest: 'pass', skipped: false }),
      blockMessage: () => '图片内容含违规信息，请更换后重试'
    }
  };

  delete require.cache[indexPath];
  require(indexPath);
  indexPage.setData = function (obj) {
    for (const k of Object.keys(obj)) {
      if (k.indexOf('.') === -1) { this.data[k] = obj[k]; continue; }
      const parts = k.split('.'); let t = this.data;
      for (let i = 0; i < parts.length - 1; i++) { if (!t[parts[i]] || typeof t[parts[i]] !== 'object') t[parts[i]] = {}; t = t[parts[i]]; }
      t[parts[parts.length - 1]] = obj[k];
    }
  };

  // 场景 I-A：validateImageFile 抛异常
  validateThrows = true; secThrows = false; toasts = []; unhandled = []; chooseMediaDone = null;
  const ctxA = Object.assign({}, indexPage, { data: { selectedPalette: 'artkal_c' }, setData: indexPage.setData });
  const resolvedA = await driveAndAwait(() => ctxA.chooseImage());
  ok('[index] validateImageFile 抛异常 → success promise 已 resolve（未逃逸为拒绝）', resolvedA === true);
  ok('[index] validateImageFile 抛异常 → 弹出通用失败 toast', toasts.indexOf('图片处理失败，请重试') !== -1);
  ok('[index] validateImageFile 抛异常 → 无「未处理 Promise 拒绝」逃逸', unhandled.length === 0);

  // 场景 I-B：secCheck.checkImageByPath 抛异常（validate 通过）
  validateThrows = false; secThrows = true; toasts = []; unhandled = []; chooseMediaDone = null;
  const ctxB = Object.assign({}, indexPage, { data: { selectedPalette: 'artkal_c' }, setData: indexPage.setData });
  const resolvedB = await driveAndAwait(() => ctxB.chooseImage());
  ok('[index] secCheck 抛异常 → success promise 已 resolve（未逃逸为拒绝）', resolvedB === true);
  ok('[index] secCheck 抛异常 → 弹出通用失败 toast', toasts.indexOf('图片处理失败，请重试') !== -1);
  ok('[index] secCheck 抛异常 → 无「未处理 Promise 拒绝」逃逸', unhandled.length === 0);

  // 对照：正常路径不弹该 toast（validate+secCheck 均通过，应走到 setData 完成）
  validateThrows = false; secThrows = false; toasts = []; unhandled = []; chooseMediaDone = null;
  const ctxC = Object.assign({}, indexPage, { data: { selectedPalette: 'artkal_c' }, setData: indexPage.setData });
  await driveAndAwait(() => ctxC.chooseImage());
  ok('[index] 正常路径不弹「处理失败」toast（仅成功完成）', toasts.indexOf('图片处理失败，请重试') === -1);

  clearCaches();

  // ============ 运行时：profile.js uploadPickerImage ============
  global.wx = makeWx();
  global.App = () => {};
  global.getApp = () => ({ globalData: {} });
  let profilePage = null;
  global.Page = (o) => { profilePage = o; };

  // profile 用 scoped require 拦截：仅 profile.js 引用的 util / secCheck 替换为可观测桩
  let pValidateThrows = false, pSecThrows = false;
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    const fn = this.filename ? this.filename.replace(/\\/g, '/') : '';
    if (id.indexOf('utils/util') !== -1 && fn.indexOf('pages/profile/profile.js') !== -1) {
      return {
        validateImageFile: () => pValidateThrows ? Promise.reject(new Error('p_validate_throw')) : Promise.resolve(true),
        getTemplateHistory: () => [],
        compressImageIfNeeded: (p) => Promise.resolve({ tempFilePath: 'compressed://' + p, width: 100, height: 100 }),
        // B10 回归配套：uploadPickerImage 在展示图读取分支会调用 getImageInfoWithTimeout / removeFileIfExists，
        // 桩须提供二者，否则正常路径 P-C 会在 getImageInfo 步骤即抛「is not a function」（与 profile_sec_check_compress.test.js 同口径）。
        getImageInfoWithTimeout: () => Promise.resolve({ width: 100, height: 100, type: 'png' }),
        removeFileIfExists: () => {},
        CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 },
        // F3：profile.js 统一从 utils/util 解构 safeShowLoading/safeHideLoading，桩必须提供
        safeShowLoading: () => {},
        safeHideLoading: () => {}
      };
    }
    if (id.indexOf('utils/secCheck') !== -1 && fn.indexOf('pages/profile/profile.js') !== -1) {
      return {
        checkImageByPath: () => pSecThrows ? Promise.reject(new Error('p_sec_throw')) : Promise.resolve({ pass: true, suggest: 'pass', skipped: false }),
        blockMessage: () => '图片内容含违规信息，请更换后重试'
      };
    }
    return origRequire.apply(this, arguments);
  };

  delete require.cache[profilePath];
  require(profilePath);
  const pmkCtx = (extra) => Object.assign({}, profilePage, Object.assign({ data: Object.assign({ editAvatarUrl: '', pickerImagePath: '' }, extra || {}) }, {}), {
    data: Object.assign({ editAvatarUrl: '', pickerImagePath: '' }, extra || {}),
    setData: function (d) { Object.assign(this.data, d); }
  });

  // 场景 P-A：validateImageFile 抛异常
  pValidateThrows = true; pSecThrows = false; toasts = []; unhandled = []; chooseMediaDone = null;
  const pctxA = pmkCtx();
  const presolvedA = await driveAndAwait(() => pctxA.uploadPickerImage());
  ok('[profile] validateImageFile 抛异常 → success promise 已 resolve（未逃逸为拒绝）', presolvedA === true);
  ok('[profile] validateImageFile 抛异常 → 弹出通用失败 toast', toasts.indexOf('图片处理失败，请重试') !== -1);
  ok('[profile] validateImageFile 抛异常 → 无「未处理 Promise 拒绝」逃逸', unhandled.length === 0);

  // 场景 P-B：secCheck.checkImageByPath 抛异常（validate 通过、压缩前置通过）
  pValidateThrows = false; pSecThrows = true; toasts = []; unhandled = []; chooseMediaDone = null;
  const pctxB = pmkCtx();
  const presolvedB = await driveAndAwait(() => pctxB.uploadPickerImage());
  ok('[profile] secCheck 抛异常 → success promise 已 resolve（未逃逸为拒绝）', presolvedB === true);
  ok('[profile] secCheck 抛异常 → 弹出通用失败 toast', toasts.indexOf('图片处理失败，请重试') !== -1);
  ok('[profile] secCheck 抛异常 → 无「未处理 Promise 拒绝」逃逸', unhandled.length === 0);

  // 对照：正常路径不弹该 toast
  pValidateThrows = false; pSecThrows = false; toasts = []; unhandled = []; chooseMediaDone = null;
  const pctxC = pmkCtx();
  await driveAndAwait(() => pctxC.uploadPickerImage());
  ok('[profile] 正常路径不弹「处理失败」toast（仅成功完成）', toasts.indexOf('图片处理失败，请重试') === -1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

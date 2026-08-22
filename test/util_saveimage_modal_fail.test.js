// test/util_saveimage_modal_fail.test.js - saveImageToAlbum Promise 终结保障（R7 健壮性修复）
// 背景：wx.showModal 原先只有 success 回调、缺 fail → showModal 失败时 Promise 既不 resolve
// 也不 reject，template.js saveTemplate 的 await 永久悬挂、loading 遮罩残留到页面卸载。
// 验证：
//   1) showModal fail 触发 → reject('modal_failed')，且 Promise 在短时限内终结（不悬挂）
//   2) showModal 用户取消 → reject('user_cancel')（原有行为回归）
//   3) 已授权路径保存成功 → resolve（原有行为回归）
// 运行：node test/util_saveimage_modal_fail.test.js
const util = require('../utils/util');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

// 悬挂检测：Promise 超时未 settle 即视为失败（正是本次修复要消灭的场景）
function withHangGuard(p, ms = 500) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('promise_hang')), ms))
  ]);
}

// 可编程 wx mock
let albumAuth = true;        // getSetting 返回的 scope.writePhotosAlbum
let modalBehavior = 'ok';    // 'fail' | 'cancel' | 'ok'
let albumSaveResult = 'success';

global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getFileSystemManager: () => ({ accessSync: () => {} }),
  getSetting: ({ success }) => success({ authSetting: { 'scope.writePhotosAlbum': albumAuth } }),
  showModal: (opts) => {
    if (modalBehavior === 'fail' && opts.fail) { opts.fail({ errMsg: 'showModal:fail' }); return; }
    opts.success({ confirm: modalBehavior !== 'cancel' });
  },
  openSetting: ({ success }) => success({ authSetting: { 'scope.writePhotosAlbum': true } }),
  saveImageToPhotosAlbum: ({ success }) => {
    if (albumSaveResult === 'success') success({ errMsg: 'saveImageToPhotosAlbum:ok' });
  }
};

(async () => {
  // 1) showModal 失败 → 必须以 modal_failed 终结（修复前：永久悬挂 → promise_hang）
  albumAuth = false;
  modalBehavior = 'fail';
  let err = null;
  try {
    await withHangGuard(util.saveImageToAlbum('wxfile://tmp_x.png'));
  } catch (e) { err = e; }
  ok('showModal fail → Promise 终结（不悬挂）', err && err.message !== 'promise_hang');
  eq(err, 'modal_failed');

  // 2) showModal 用户取消 → user_cancel（原有行为回归）
  modalBehavior = 'cancel';
  err = null;
  try {
    await withHangGuard(util.saveImageToAlbum('wxfile://tmp_x.png'));
  } catch (e) { err = e; }
  ok('showModal 取消 → user_cancel（回归）', err && err.message === 'user_cancel');

  // 3) 已授权 + 保存成功 → resolve（原有行为回归）
  albumAuth = true;
  albumSaveResult = 'success';
  let resolved = false;
  try { await withHangGuard(util.saveImageToAlbum('wxfile://tmp_x.png')); resolved = true; } catch (e) {}
  ok('已授权保存成功 → resolve（回归）', resolved);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

function eq(err, expected) {
  if (err && err.message === expected) { passed++; console.log('PASS', '错误码为 ' + expected); }
  else { failed++; console.log('FAIL', '错误码应为 ' + expected + '，实际', err && err.message); }
}

/**
 * profile.clearHistory 存储泄漏修复测试
 * 验证：清除历史时，USER_DATA_PATH 下的本地原图（history_source_*.png）被 unlink，
 *       远程网络图被跳过，存储键被删除。
 */
const assert = require('assert');

// ---- mock 微信运行时 ----
const unlinkCalls = [];
let removedKey = null;
const fakeHistory = [
  { sourceImage: 'http://store/history_source_1.png' },   // 部分平台 USER_DATA_PATH → 本地
  { sourceImage: 'wxfile://usr/history_source_2.png' },    // 工具/iOS 本地
  { sourceImage: 'http://tmp/history_source_3.png' },      // Android 本地
  { sourceImage: 'https://cdn.example.com/remote.png' },   // 真实远程域名 → 跳过
  { sourceImage: '' },                                    // 空串 → 跳过
  { sourceImage: null },                                  // null → 跳过
  {},                                                     // 无字段 → 跳过
];

global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getStorageSync: (k) => (k === 'template_history' ? fakeHistory : null),
  removeStorageSync: (k) => { removedKey = k; },
  getFileSystemManager: () => ({
    unlinkSync: (p) => { unlinkCalls.push(p); },
    saveFile: () => {},
  }),
  showModal: (opts) => { if (opts && opts.success) opts.success({ confirm: true }); },
  showToast: () => {},
};
global.getApp = () => ({ globalData: {} });
let capturedPage = null;
global.Page = (opts) => { capturedPage = Object.assign({}, opts, { setData: () => {}, data: {} }); };

// 载入被测模块
require('../pages/profile/profile.js');

// 触发清除（showModal mock 会同步 confirm）
capturedPage.clearHistory();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

test('本地原图全部被 unlink', () => {
  assert.strictEqual(unlinkCalls.length, 3, '应恰好 unlink 3 个本地原图，实际 ' + unlinkCalls.length);
  assert.ok(unlinkCalls.includes('http://store/history_source_1.png'));
  assert.ok(unlinkCalls.includes('wxfile://usr/history_source_2.png'));
  assert.ok(unlinkCalls.includes('http://tmp/history_source_3.png'));
});

test('远程图被跳过', () => {
  assert.ok(!unlinkCalls.includes('https://cdn.example.com/remote.png'), '远程图不应被 unlink');
});

test('空/null/缺失字段被跳过', () => {
  assert.ok(!unlinkCalls.includes(''), '空串不应被 unlink');
  assert.ok(!unlinkCalls.includes(null), 'null 不应被 unlink');
});

test('存储键被删除', () => {
  assert.strictEqual(removedKey, 'template_history');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

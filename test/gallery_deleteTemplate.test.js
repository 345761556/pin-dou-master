/**
 * gallery.deleteTemplate 删除失效修复测试
 * 复现 BUG：存储的 item.id 为 Date.now() 数字，而部分真机/基础库下
 *          e.currentTarget.dataset.id 被转为字符串，原代码 item.id === id 恒 false
 *          → find 找不到、filter 删不掉，却仍 toast '已删除'（静默失效）。
 * 验证：统一转 String 比较后，删除生效、原图被 unlink、且未匹配时不再误报。
 */
const assert = require('assert');

let savedHistory = null;
let unlinkCalls = [];
let toastTitle = null;

const localPathA = 'http://tmp/history_source_A.png';   // Android 临时路径 + 我们管理的 history_source_ 前缀 → 本地，应清理
const localPathB = 'http://tmp/history_source_B.png';
const baseHistory = () => ([
  { id: 1710000000001, sourceImage: localPathA, totalBeads: 10 },
  { id: 1710000000002, sourceImage: localPathB, totalBeads: 20 },
]);

global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getStorageSync: (k) => (k === 'template_history' ? baseHistory() : null),
  setStorageSync: (k, v) => { if (k === 'template_history') savedHistory = v; },
  removeStorageSync: () => {},
  getFileSystemManager: () => ({ unlinkSync: (p) => { unlinkCalls.push(p); }, saveFile: () => {} }),
  showModal: (opts) => { if (opts && opts.success) opts.success({ confirm: true }); },
  showToast: (o) => { toastTitle = o && o.title; },
  showShareMenu: () => {},
};
global.getApp = () => ({ globalData: {} });
let capturedPage = null;
global.Page = (opts) => { capturedPage = Object.assign({}, opts, { setData: () => {}, data: {} }); };

require('../pages/gallery/gallery.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

function runDelete(datasetId) {
  savedHistory = null; unlinkCalls = []; toastTitle = null;
  capturedPage.deleteTemplate({ currentTarget: { dataset: { id: datasetId } } });
}

test('dataset.id 为字符串时仍能正确删除（复现并修复 BUG）', () => {
  runDelete(String(1710000000001));
  assert.ok(savedHistory, '应写入更新后的历史');
  assert.strictEqual(savedHistory.length, 1, '应只剩 1 条，实际 ' + (savedHistory && savedHistory.length));
  assert.strictEqual(savedHistory[0].id, 1710000000002, '剩余应为 id=2 的记录');
  assert.ok(unlinkCalls.includes(localPathA), '应清理被删记录的原图');
  assert.ok(!unlinkCalls.includes(localPathB), '不应清理未删记录的原图');
  assert.strictEqual(toastTitle, '已删除', '应提示已删除');
});

test('dataset.id 为数字时同样正确删除（健壮性）', () => {
  runDelete(1710000000002);
  assert.strictEqual(savedHistory.length, 1);
  assert.strictEqual(savedHistory[0].id, 1710000000001);
  assert.ok(unlinkCalls.includes(localPathB));
  assert.strictEqual(toastTitle, '已删除');
});

test('未匹配到记录时不误报“已删除”', () => {
  runDelete('9999999999999');
  assert.strictEqual(savedHistory, null, '不应写入历史（原样保留）');
  assert.ok(unlinkCalls.length === 0, '不应清理任何原图');
  assert.strictEqual(toastTitle, '未找到该模板', '应提示未找到而非已删除');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

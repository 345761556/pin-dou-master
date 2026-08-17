/**
 * gallery.onShow 5s 防抖陈旧修复测试
 * 复现 BUG：gallery 的 onShow 仅按 "距上次加载 >5s" 决定是否 reload。
 *   - 生成新模板 / 清空历史 / 删除记录后，若在 5s 内切回 gallery，
 *     因 _lastLoadTime 未过期 → 跳过 reload → 显示陈旧列表（新模板/清空不可见）。
 * 验证：引入全局 historyVersion（每次写入/清空/删除 template_history 自增），
 *   onShow 在"版本变化 或 超时"时才 reload；无变化且未超时仍走防抖（不重复读）。
 */
const assert = require('assert');

let templateReads = 0;
const store = { template_history: [] };

// 共享的 globalData 引用（gallery.js 在 require 时通过 getApp() 捕获）
const globalDataRef = { historyVersion: 0 };

global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getStorageSync: (k) => {
    if (k === 'template_history') { templateReads++; return store[k] || []; }
    return store[k] || null;
  },
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: (k) => { delete store[k]; },
  getFileSystemManager: () => ({ unlinkSync: () => {}, saveFile: () => {} }),
  showModal: (opts) => { if (opts && opts.success) opts.success({ confirm: true }); },
  showToast: () => {},
  showShareMenu: () => {},
};
global.getApp = () => ({ globalData: globalDataRef });

let capturedPage = null;
global.Page = (opts) => { capturedPage = Object.assign({}, opts, { setData: () => {}, data: {} }); };

require('../pages/gallery/gallery.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

// 模拟：生成新模板/清空历史/删除记录 → 自增版本号（与实际 3 处写入点一致）
function bumpVersion() { globalDataRef.historyVersion = (globalDataRef.historyVersion || 0) + 1; }

test('首次 onShow 立即加载（版本 0 ≠ undefined）', () => {
  templateReads = 0;
  capturedPage.onShow();
  assert.strictEqual(templateReads, 1, '首次应读取一次 storage');
});

test('5s 内无变更再次 onShow → 防抖生效，不重复加载', () => {
  templateReads = 0;
  capturedPage.onShow(); // 紧接上一次，未超时且版本未变
  assert.strictEqual(templateReads, 0, '无变更且未超时不应再读 storage');
});

test('5s 内版本变化（生成新模板）再次 onShow → 必须刷新', () => {
  templateReads = 0;
  bumpVersion(); // 模拟 saveToHistory 写入
  capturedPage.onShow();
  assert.strictEqual(templateReads, 1, '版本变化必须重新读取 storage');
});

test('版本变化后再次 onShow 且未超时 → 防抖再次出现（无新变更不重复加载）', () => {
  templateReads = 0;
  capturedPage.onShow(); // 版本已同步，未超时
  assert.strictEqual(templateReads, 0, '已同步版本且未超时不应再读');
});

test('5s 内清空历史（版本变化）再次 onShow → 必须刷新为空列表', () => {
  // 先放一条数据
  store.template_history = [{ id: 1 }];
  templateReads = 0;
  // 模拟 clearHistory 自增版本
  bumpVersion();
  store.template_history = []; // 清空
  capturedPage.onShow();
  assert.strictEqual(templateReads, 1, '清空后切回必须重新读取');
});

test('deleteTemplate 后版本自增，切回 onShow 不显示陈旧列表', () => {
  store.template_history = [{ id: 1 }, { id: 2 }];
  templateReads = 0;
  const before = globalDataRef.historyVersion;
  capturedPage.deleteTemplate({ currentTarget: { dataset: { id: String(1) } } });
  assert.ok(globalDataRef.historyVersion === before + 1, 'deleteTemplate 应自增 historyVersion');
  // 5s 内切回：版本已变 → 应刷新（此处只统计 onShow 自身的读取，deleteTemplate 内部读取已发生）
  templateReads = 0;
  capturedPage.onShow();
  assert.strictEqual(templateReads, 1, '删除后切回应立即刷新（onShow 读取一次）');
});

test('超时（>5s）即使无版本变化也刷新', () => {
  // 记录当前 _lastLoadTime，手动后推
  capturedPage._lastLoadTime = Date.now() - 6000;
  templateReads = 0;
  capturedPage.onShow();
  assert.strictEqual(templateReads, 1, '超时即使无变更也应刷新');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

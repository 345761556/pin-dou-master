// BUG-25 回归测试：unlink 前缀校验收紧
// 问题：弹出/删除历史时，原 unlink 守卫为「不是远程 URL 就删」的宽松口径
//      （仅 isRemoteImageUrl 否定），对任意非远程本地路径都尝试 unlinkSync；
//      且报告指出的「空串也尝试 unlink」在旧 indexOf('http') 时代存在（现已由 isRemoteImageUrl
//       + 真值判定拦截，但宽松口径本身仍是隐患）。
// 修复：新增 security.isManagedHistorySource，仅当路径非空、非远程、无 '..' 遍历、且含我们管理的
//       history_source_ 前缀时才允许删除——只删自己拥有的文件。
//
// 本测试守两关：
//   1) isManagedHistorySource 单测：覆盖空串/null/远程/遍历/无前缀本地路径(应 false) 与 各类 history_source_ 本地路径(应 true)
//   2) 集成：gallery.deleteTemplate 调用点，对「非 history_source_ 前缀的本地路径」「空串」「远程图」
//      均不再 unlink，仅对 history_source_ 本地副本 unlink（证明站点级收紧生效）

const assert = require('assert');

// 为 security.js 可能引用的 wx.env 提供最小环境
global.wx = { env: { USER_DATA_PATH: 'wxfile://usr' } };
const security = require('../utils/security.js');
const isManagedHistorySource = security.isManagedHistorySource;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' :: ' + e.message); failed++; }
}

// ---------- 1) isManagedHistorySource 单测 ----------
const UD = 'wxfile://usr';
check('空串 / null / undefined / 非字符串 均返回 false', () => {
  assert.strictEqual(isManagedHistorySource(''), false, '空串不应被判定为可删');
  assert.strictEqual(isManagedHistorySource(null), false);
  assert.strictEqual(isManagedHistorySource(undefined), false);
  assert.strictEqual(isManagedHistorySource(123), false);
});

check('真实远程域名 URL 返回 false（不删远程图）', () => {
  assert.strictEqual(isManagedHistorySource('https://cdn.example.com/x.png'), false);
  assert.strictEqual(isManagedHistorySource('http://images.example.org/y.jpg'), false);
});

check('含路径遍历 .. 的本地路径返回 false（防误删/攻击）', () => {
  assert.strictEqual(isManagedHistorySource('http://tmp/../secret.png'), false);
  assert.strictEqual(isManagedHistorySource(UD + '/history_source_1.png/../../etc/passwd'), false);
});

check('本地临时路径但不含 history_source_ 前缀 → false（旧宽松口径会误删，现已拦截）', () => {
  // 这些是「本地但非我们拥有」的路径：旧代码 !isRemoteImageUrl 会 unlink，新守卫不再删
  assert.strictEqual(isManagedHistorySource('wxfile://tmp_abc.png'), false);
  assert.strictEqual(isManagedHistorySource('http://tmp/photo.jpg'), false);
  assert.strictEqual(isManagedHistorySource('/data/other/unrelated.png'), false);
});

check('各类 history_source_ 本地副本均返回 true（应被清理）', () => {
  assert.strictEqual(isManagedHistorySource('wxfile://usr/history_source_2.png'), true, 'iOS/工具 wxfile://');
  assert.strictEqual(isManagedHistorySource('http://tmp/history_source_3.png'), true, 'Android http://tmp/');
  assert.strictEqual(isManagedHistorySource('http://store/history_source_4.png'), true, 'Android http://store/');
  assert.strictEqual(isManagedHistorySource(UD + '/history_source_5.png'), true, 'USER_DATA_PATH 绝对路径');
  assert.strictEqual(isManagedHistorySource('/abs/history_source_6.png'), true, '绝对路径含前缀');
});

// ---------- 2) 集成：gallery.deleteTemplate 调用点收紧 ----------
const { runDelete, unlinkCalls, toastTitleRef } = (() => {
  let savedHistory = null;
  const unlinkCalls = [];
  let toastTitle = null;
  // 混合来源：A=我们管理的副本(应删)；B=本地但无前缀(不应删)；C=空串(不应删)；D=远程(不应删)
  const pathA = 'wxfile://usr/history_source_A.png';
  const pathB = 'wxfile://tmp_some_other.png';   // 本地但非 history_source_ 前缀
  const pathC = '';
  const pathD = 'https://cdn.example.com/r.png';
  const base = [
    { id: 1, sourceImage: pathA, totalBeads: 10 },
    { id: 2, sourceImage: pathB, totalBeads: 20 },
    { id: 3, sourceImage: pathC, totalBeads: 30 },
    { id: 4, sourceImage: pathD, totalBeads: 40 },
  ];
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => (k === 'template_history' ? JSON.parse(JSON.stringify(base)) : null),
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
  function runDelete(datasetId) {
    unlinkCalls.length = 0;
    capturedPage.deleteTemplate({ currentTarget: { dataset: { id: datasetId } } });
  }
  return {
    runDelete,
    unlinkCalls,
    toastTitleRef: () => toastTitle,
    saved: () => savedHistory,
    paths: { pathA, pathB, pathC, pathD },
  };
})();

check('删除 A 时：仅 history_source_ 副本被 unlink，其余本地/空串/远程均不删', () => {
  runDelete(1);
  assert.ok(unlinkCalls.includes('wxfile://usr/history_source_A.png'), 'A(history_source_) 应被 unlink');
  assert.ok(!unlinkCalls.includes('wxfile://tmp_some_other.png'), 'B(本地无前缀) 不应被 unlink（收紧关键）');
  assert.ok(!unlinkCalls.includes(''), 'C(空串) 不应被 unlink');
  assert.ok(!unlinkCalls.includes('https://cdn.example.com/r.png'), 'D(远程) 不应被 unlink');
  assert.strictEqual(unlinkCalls.length, 1, '应恰好 unlink 1 个，实际 ' + unlinkCalls.length);
  assert.strictEqual(toastTitleRef(), '已删除');
});

check('删除 B(本地无前缀) 时：不删任何本地文件，仅移除记录', () => {
  runDelete(2);
  assert.strictEqual(unlinkCalls.length, 0, 'B 非 history_source_ 前缀，不应 unlink 任何文件');
  assert.strictEqual(toastTitleRef(), '已删除');
});

console.log('\n全部通过：' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);

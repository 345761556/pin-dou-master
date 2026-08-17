// 回归测试：L2 —— profile.loadStats 的 totalBeads 汇总必须对脏记录钳制
// 原 bug：history.reduce 累加原始 item.totalBeads，脏记录 1e20 → 总数显示为
// "10000000000000000.0万" 超长串，且单条脏记录污染总数统计。
// 修复：累加前对每项 totalBeads 用 clampDisplayNumber(..., 20000) 收敛。

const assert = require('assert');

// 脏记录（1e20）+ 两条合法记录（2500 / 3000）
const fakeHistory = [
  { totalBeads: 1e20, materialList: [{ color: { id: 'C01' }, count: 4 }] },
  { totalBeads: 2500, materialList: [{ color: { id: 'C02' }, count: 10 }] },
  { totalBeads: 3000, materialList: [] }
];

global.wx = {
  getStorageSync: (k) => (k === 'template_history' ? fakeHistory : null),
  setStorageSync: () => {},
  showToast: () => {},
  showModal: () => {},
  getFileSystemManager: () => ({ unlinkSync: () => {}, saveFile: () => {} })
};
global.getApp = () => ({ globalData: {} });

let capturedPage = null;
global.Page = (opts) => {
  capturedPage = Object.assign({}, opts, {
    data: {},
    setData: function (o) { Object.assign(this.data, o); }
  });
};

require('../pages/profile/profile.js');
capturedPage.loadStats();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

const tb = capturedPage.data.totalBeads;

test('脏记录未让总数出现 1e20 超长串', () => {
  assert.strictEqual(typeof tb, 'string');
  assert.ok(!String(tb).includes('1e+20') && !String(tb).includes('1e20'));
});

test('钳制后总数 = 20000(脏上限) + 2500 + 3000 = 25500 → "2.6万"', () => {
  assert.strictEqual(tb, (25500 / 10000).toFixed(1) + '万');
});

test('单条脏记录只贡献上限 20000，不污染总数（对照未钳制时 = "10000000000000000.0万"）', () => {
  assert.notStrictEqual(tb, (1e20 / 10000).toFixed(1) + '万');
});

console.log(`\nprofile_loadstats_clamp: ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

// BUG-24 回归测试：色卡数据瑕疵
// 问题：photoPearl 的 PP05 与 PP43 曾共用 hex #FFD54F，
//       matchToPalette 用 dist < minDist 严格比较，两者 lab 相同，
//       数组靠前的 PP05 永远先锁定，导致 PP43 永不入选 materialList。
// 修复：将 PP05 向日葵调整为可区分的 #FFCC33，使两者 lab 分离。
//
// 本测试守三道关：
//   1) 每个色卡内部不存在 hex 重复（杜绝此类数据瑕疵复现）
//   2) photoPearl 的 PP05 与 PP43 现在 hex 不同
//   3) 功能验证：PP05 / PP43 各自的像素经匹配后分别命中自身 id
//      （即 PP43 不再被 PP05 永久压制，可被材料清单选中）

const assert = require('assert');
const cd = require('../utils/colorData.js');
const bead = require('../utils/beadEngine.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// 1) 每个色卡内部 hex 不重复
const palettes = ['artkalC', 'hama', 'perler', 'photoPearl', 'neko'];
check('每个色卡内部不存在 hex 重复', function () {
  for (const key of palettes) {
    const arr = cd[key];
    assert.ok(Array.isArray(arr) && arr.length > 0, key + ' 应为非空数组');
    const seen = new Map();
    for (const c of arr) {
      const h = (c.hex || '').toUpperCase();
      assert.ok(/^#[0-9A-F]{6}$/i.test(h), key + ' 的 ' + c.id + ' hex 非法: ' + c.hex);
      assert.ok(!seen.has(h), key + ' 色卡内 hex 重复: ' + h + ' (' + seen.get(h) + ' 与 ' + c.id + ')');
      seen.set(h, c.id);
    }
  }
});

// 2) photoPearl 的 PP05 与 PP43 现在 hex 不同
check('photoPearl PP05 与 PP43 hex 已区分', function () {
  const pp = cd.photoPearl;
  const pp05 = pp.find(c => c.id === 'PP05');
  const pp43 = pp.find(c => c.id === 'PP43');
  assert.ok(pp05, 'PP05 存在');
  assert.ok(pp43, 'PP43 存在');
  assert.notStrictEqual(pp05.hex.toUpperCase(), pp43.hex.toUpperCase(),
    'PP05 与 PP43 不应再共用同一 hex');
  assert.strictEqual(pp05.hex.toUpperCase(), '#FFCC33', 'PP05 向日葵应为 #FFCC33');
  assert.strictEqual(pp43.hex.toUpperCase(), '#FFD54F', 'PP43 金色保持 #FFD54F（与 hama/neko 金色一致）');
});

// 3) 功能验证：PP05 / PP43 各自像素可分别命中自身
check('PP05 / PP43 均可被匹配选中（不再被对方压制）', function () {
  const palette = bead.initPalette(cd.photoPearl); // 附加 lab / r / g / b
  const pp05 = cd.photoPearl.find(c => c.id === 'PP05');
  const pp43 = cd.photoPearl.find(c => c.id === 'PP43');

  const rgb05 = bead.hexToRgb(pp05.hex);
  const rgb43 = bead.hexToRgb(pp43.hex);

  const m05 = bead.matchToPalette(rgb05.r, rgb05.g, rgb05.b, palette, 255);
  const m43 = bead.matchToPalette(rgb43.r, rgb43.g, rgb43.b, palette, 255);

  assert.strictEqual(m05.id, 'PP05', 'PP05 像素应命中 PP05，实际命中 ' + m05.id);
  assert.strictEqual(m43.id, 'PP43', 'PP43 像素应命中 PP43，实际命中 ' + m43.id + '（修复前永远被 PP05 压制）');
});

console.log('\n全部通过：' + passed + ' 项断言块');

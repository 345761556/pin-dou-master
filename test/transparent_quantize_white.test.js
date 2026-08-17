/**
 * beadEngine 透明像素量化污染回归测试（BUG-12）
 * 背景（用户报告，已核实属实）：
 *   1) medianCutQuantize 量化前未过滤 alpha<128 像素：透明黑像素 (0,0,0,0) 占颜色预算、
 *      产出纯黑量化色，污染 usedPalette（挤掉真实图像颜色）。
 *   2) 透明区匹配 usedPalette（量化子集）而非完整色卡：图无近白色调时透明区映射到灰/米/红
 *      而非真白；且真实白色不进 materialList（白豆数量少计）。
 * 修复：量化前过滤 alpha<128 像素；透明/近白像素统一用完整色卡（palette）找白。
 * 本测试锁定：
 *   A) 透明黑像素不占颜色预算 → usedPalette 仅含真实不透明颜色（无杂色/黑色）；
 *   B) 无近白不透明内容 + fillBackgroundWhite=true 时，透明区映射到完整色卡的「真白」，
 *      且真白计入 materialList（白豆数量正确）。
 */
const assert = require('assert');
const beadEngine = require('../utils/beadEngine');

// 与 beadEngine.test.js 相同的最小 mock：getImageData 直接返回给定 buffer（绕过 drawImage）
function makeMockCanvas(buf) {
  return {
    width: 0, height: 0,
    getContext: () => ({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
      drawImage: () => {},
      getImageData: () => ({ data: buf }),
    }),
  };
}

function mkPalette(defs) {
  return defs.map(d => ({ id: d.id, name: d.name, hex: d.hex, lab: beadEngine.rgbToLab(d.r, d.g, d.b) }));
}
// 不含黑/灰的色卡，便于检测「杂色」是否混入
const palette = mkPalette([
  { id: 'R01', name: '红', hex: '#FF0000', r: 200, g: 0, b: 0 },
  { id: 'W01', name: '白', hex: '#FFFFFF', r: 255, g: 255, b: 255 },
  { id: 'B01', name: '蓝', hex: '#0000FF', r: 0, g: 0, b: 200 },
  { id: 'G01', name: '绿', hex: '#00FF00', r: 0, g: 200, b: 0 },
]);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

// ============ A) 透明黑像素不占颜色预算 ============
test('A) 含大量透明黑像素时 usedPalette 仅含真实不透明颜色（无杂色）', () => {
  const cols = 80, rows = 80; // 6400 像素 > SAMPLE_PIXELS(5000)，触发采样
  const buf = [];
  for (let i = 0; i < cols * rows; i++) {
    if (i % 10 < 3) {
      // ~30% 不透明红
      buf.push(200, 0, 0, 255);
    } else {
      // ~70% 透明黑 (0,0,0,0)
      buf.push(0, 0, 0, 0);
    }
  }
  const tpl = beadEngine.generateTemplate(
    makeMockCanvas(buf), { width: cols, height: rows },
    { beadSize: 29, maxBeadWidth: cols, colorCount: 4, palette, useDithering: false }
  );
  const ids = tpl.usedPalette.map(c => c.id).sort();
  console.log('   usedPalette =', JSON.stringify(ids));
  // 修复后：透明像素被过滤，量化只看到红色 → 子集仅 [R01]
  assert.strictEqual(tpl.usedPalette.length, 1, 'usedPalette 应只含 1 种颜色（仅不透明红）');
  assert.strictEqual(tpl.usedPalette[0].id, 'R01', 'usedPalette 应为真实不透明红 R01，不得混入蓝/绿/黑等杂色');
});

// ============ B) 无近白不透明内容时，透明区映射到完整色卡的「真白」并计入材料 ============
test('B) 透明背景 + fillBackgroundWhite：透明区映射真白 W01 且白豆计数正确', () => {
  // 2×2：红、透明、红、透明（无任何不透明白色）
  const buf = [
    200, 0, 0, 255,   // (0,0) 红
    0, 0, 0, 0,       // (0,1) 透明
    200, 0, 0, 255,   // (1,0) 红
    0, 0, 0, 0,       // (1,1) 透明
  ];
  const tpl = beadEngine.generateTemplate(
    makeMockCanvas(buf), { width: 2, height: 2 },
    { beadSize: 29, maxBeadWidth: 2, colorCount: 3, palette, useDithering: false, fillBackgroundWhite: true }
  );
  console.log('   template =', JSON.stringify(tpl.template));
  console.log('   materialList =', JSON.stringify(tpl.materialList.map(m => ({ id: m.color.id, count: m.count }))));

  // 透明区必须映射到完整色卡的「真白」W01，而非子集里最接近的红色
  assert.strictEqual(tpl.template[0][1], 'W01', '透明 (0,1) 应映射真白 W01');
  assert.strictEqual(tpl.template[1][1], 'W01', '透明 (1,1) 应映射真白 W01');

  const whiteItem = tpl.materialList.find(m => m.color.id === 'W01');
  assert.ok(whiteItem, 'materialList 必须包含 W01');
  assert.strictEqual(whiteItem.count, 2, 'W01 白豆数量应为 2（两个透明格），不得少计');

  const redItem = tpl.materialList.find(m => m.color.id === 'R01');
  assert.ok(redItem, 'materialList 必须包含 R01');
  assert.strictEqual(redItem.count, 2, 'R01 红豆数量应为 2（两个不透明红），不得被透明区多计');

  assert.strictEqual(tpl.totalBeads, 4, 'totalBeads 应为 4');
});

// ============ C) 回归：含不透明白时，透明区仍映射真白（不退化） ============
test('C) 含不透明白时，fillBackgroundWhite 透明区仍映射 W01', () => {
  const buf = [
    255, 255, 255, 255, // (0,0) 不透明白
    0, 0, 0, 0,         // (0,1) 透明
    200, 0, 0, 255,     // (1,0) 红
    0, 0, 0, 0,         // (1,1) 透明
  ];
  const tpl = beadEngine.generateTemplate(
    makeMockCanvas(buf), { width: 2, height: 2 },
    { beadSize: 29, maxBeadWidth: 2, colorCount: 3, palette, useDithering: false, fillBackgroundWhite: true }
  );
  assert.strictEqual(tpl.template[0][1], 'W01', '透明 (0,1) → W01');
  assert.strictEqual(tpl.template[1][1], 'W01', '透明 (1,1) → W01');
  const whiteItem = tpl.materialList.find(m => m.color.id === 'W01');
  assert.strictEqual(whiteItem.count, 3, 'W01 应为 3（1 不透明白 + 2 透明）');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

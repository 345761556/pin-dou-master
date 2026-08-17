/**
 * generateTemplate 默认 maxBeadWidth 一致性测试（BUG-26）
 * 验证：解构默认 maxBeadWidth 已收敛为单一真源 CONSTANTS.DEFAULT_COLS(=50)，
 *       而非遗留的字面量 60；且显式传值仍优先。
 *
 * 原理：省略 maxBeadWidth 时 cols = 默认宽度；对 1:1 方形图，
 *       cols*rows = 默认² < ALGO.MAX_PIXELS(8000)，clampTemplateSize 不触发，
 *       故模板尺寸直接反映默认宽度。默认 50 → 50×50；若仍为 60 → 60×60。
 */
(async () => {
const assert = require('assert');
const beadEngine = require('../utils/beadEngine.js');
const { CONSTANTS } = require('../utils/util.js');

function makeCanvasMock() {
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    fillStyle: '',
    drawImage() {},
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = (i * 7) % 256;
        data[i * 4 + 1] = (i * 13) % 256;
        data[i * 4 + 2] = (i * 29) % 256;
        data[i * 4 + 3] = 255;
      }
      return { data };
    }
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

const PALETTE = beadEngine.initPalette([
  { id: 'C01', hex: '#ff0000' },
  { id: 'C02', hex: '#00ff00' },
  { id: 'W1', hex: '#ffffff' }
]);

// 1:1 方形图，使 cols*rows = 默认²，不触发像素上限钳制
const mockImage = { width: 50, height: 50 };

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.error('  FAIL', name, '->', e.message); fail++; }
}

// 不变量：DEFAULT_COLS 必须为 50（单一真源锁定）
check('CONSTANTS.DEFAULT_COLS === 50', () => {
  assert.strictEqual(CONSTANTS.DEFAULT_COLS, 50, 'DEFAULT_COLS 应为 50');
});

// 省略 maxBeadWidth 时，默认宽度应为 DEFAULT_COLS(50)，而非遗留的 60
check('省略 maxBeadWidth → 默认 50×50（非 60×60）', async () => {
  const tpl = await beadEngine.generateTemplate(
    makeCanvasMock(), mockImage,
    { beadSize: 29, colorCount: 3, palette: PALETTE, useDithering: false }
  );
  // 行数 = rows，列数 = 每行像素数
  const rows = tpl.template.length;
  const cols = tpl.template[0].length;
  assert.strictEqual(rows, 50, 'rows 应为默认 50，得到 ' + rows);
  assert.strictEqual(cols, 50, 'cols 应为默认 50，得到 ' + cols);
});

// 显式传值仍优先：传 12 → 12×12
check('显式 maxBeadWidth=12 → 12×12（覆盖默认）', async () => {
  const tpl = await beadEngine.generateTemplate(
    makeCanvasMock(), mockImage,
    { beadSize: 29, maxBeadWidth: 12, colorCount: 3, palette: PALETTE, useDithering: false }
  );
  const rows = tpl.template.length;
  const cols = tpl.template[0].length;
  assert.strictEqual(rows, 12, 'rows 应为 12，得到 ' + rows);
  assert.strictEqual(cols, 12, 'cols 应为 12，得到 ' + cols);
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAIL') + ' — pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
})();

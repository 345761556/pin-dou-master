/**
 * generateTemplate 图像尺寸上限守卫测试
 * 验证：image.width/height 任一超过 CONSTANTS.MAX_IMAGE_DIMENSION(6000) 时显式抛错，
 *      边界值(=6000)放行，合法小图正常返回。
 *
 * 注：尺寸断言位于任何 ctx 调用之前，因此「超大图」用例无需完整 canvas mock；
 *     「合法小图」用例才需要最小化的 canvas/ctx mock 跑通整条链路。
 */
(async () => {
const assert = require('assert');
const beadEngine = require('../utils/beadEngine.js');

// 用 initPalette 构建带 .lab 的合规调色板（matchToPalette 内部读取 color.lab）
const PALETTE = beadEngine.initPalette([
  { id: 'C01', hex: '#ff0000' },
  { id: 'C02', hex: '#00ff00' },
  { id: 'C03', hex: '#0000ff' },
  { id: 'W1', hex: '#ffffff' }
]);

function makeCanvasMock(cols, rows) {
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

function baseOptions(overrides = {}) {
  return Object.assign(
    { beadSize: 29, maxBeadWidth: 60, colorCount: 30, palette: PALETTE, useDithering: false },
    overrides
  );
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.error('  FAIL', name, '->', e.message); fail++; }
}

// A. 宽度超大
check('宽度 7000 抛错', () => {
  const img = { width: 7000, height: 5000 };
  assert.throws(
    () => beadEngine.generateTemplate({}, img, baseOptions()),
    /6000px/
  );
});

// B. 高度超大（宽度正常）
check('高度 7000 抛错', () => {
  const img = { width: 500, height: 7000 };
  assert.throws(
    () => beadEngine.generateTemplate({}, img, baseOptions()),
    /6000px/
  );
});

// C. 边界值 6000 恰好放行
check('宽度恰好 6000 不抛错', async () => {
  const img = { width: 6000, height: 100 };
  const canvas = makeCanvasMock();
  let threw = false;
  try {
    await beadEngine.generateTemplate(canvas, img, baseOptions());
  } catch (e) {
    threw = true;
    console.error('    意外抛错:', e.message);
  }
  assert.strictEqual(threw, false, '6000 应被放行');
});

// D. 合法小图正常返回
check('100x100 正常生成模板', async () => {
  const img = { width: 100, height: 100 };
  const canvas = makeCanvasMock();
  const result = await beadEngine.generateTemplate(canvas, img, baseOptions());
  assert.ok(result && result.cols > 0 && result.rows > 0, '应返回含 cols/rows 的模板数据');
  assert.ok(Array.isArray(result.template), 'template 应为二维数组');
});

// E. 错误文案不含设备/路径等敏感信息
check('错误文案不含 wxfile/tmp 等泄漏', () => {
  const img = { width: 9000, height: 100 };
  let msg = '';
  try { beadEngine.generateTemplate({}, img, baseOptions()); }
  catch (e) { msg = e.message; }
  assert.ok(!/wxfile|tmp_|USER_DATA_PATH/i.test(msg), '错误文案不应泄漏设备路径');
});

console.log(`\n维度守卫测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
})();

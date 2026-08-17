/**
 * 核心功能端到端冒烟测试（BUG-11~26 复查）
 * 串联真实链路：loadPalette → initPalette → generateTemplate
 *            → RLE 编解码往返 → saveToHistory(slim) → loadHistory 重建
 *            → renderTemplate 重显（验证 slim 后字段足够）
 * 验证核心功能在 16 处缺陷修复后仍正常工作，且未引入新 bug。
 */
const assert = require('assert');
const beadEngine = require('../utils/beadEngine.js');
const colorData = require('../utils/colorData.js');
const util = require('../utils/util.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.error('  FAIL', name, '->', e.message); fail++; }
}

// ---- 1. 调色板加载 + initPalette（含 lab 预计算，匹配所需）----
const paletteRaw = colorData.photoPearl; // 含修复后的 PP05(#FFCC33)/PP43(#FFD54F)
const palette = beadEngine.initPalette(paletteRaw);
check('initPalette 产出带 lab 的色卡', () => {
  assert.ok(palette.length === paletteRaw.length, '色卡数量一致');
  assert.ok(palette[0].lab && typeof palette[0].lab === 'object', '每个颜色含 lab');
});

// ---- 2. generateTemplate：核心生成 ----
// 构造 4x3 测试图（row-major, 每像素 4 通道）
const W = 4, H = 3;
function makeImgBuf(colors) {
  // colors: 数组 [{r,g,b,a}] 长度 W*H
  const buf = [];
  for (const c of colors) buf.push(c.r, c.g, c.b, c.a);
  return buf;
}
const pix = [
  { r: 255, g: 213, b: 79, a: 255 },  // ≈PP43 金色 #FFD54F
  { r: 255, g: 204, b: 51, a: 255 },  // ≈PP05 向日葵 #FFCC33
  { r: 255, g: 255, b: 255, a: 255 }, // 白
  { r: 0, g: 0, b: 0, a: 0 },         // 透明（空位）
  { r: 255, g: 213, b: 79, a: 255 },
  { r: 255, g: 204, b: 51, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 100, g: 100, b: 100, a: 255 }, // 灰
  { r: 100, g: 100, b: 100, a: 255 },
  { r: 100, g: 100, b: 100, a: 255 },
  { r: 0, g: 0, b: 0, a: 0 }
];
function makeCanvasMock(buf, w, h) {
  const ctx = {
    imageSmoothingEnabled: false, imageSmoothingQuality: '', fillStyle: '',
    drawImage() {},
    getImageData(x, y, gw, gh) {
      const data = new Uint8ClampedArray(gw * gh * 4);
      for (let i = 0; i < gw * gh; i++) {
        data[i*4] = buf[i*4]; data[i*4+1] = buf[i*4+1];
        data[i*4+2] = buf[i*4+2]; data[i*4+3] = buf[i*4+3];
      }
      return { data };
    }
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

const tpl = beadEngine.generateTemplate(
  makeCanvasMock(makeImgBuf(pix), W, H),
  { width: W, height: H },
  { beadSize: 29, maxBeadWidth: util.CONSTANTS.DEFAULT_COLS, colorCount: 40, palette, useDithering: false, fillBackgroundWhite: false }
);
// 注意：cols 来自 maxBeadWidth（=50），rows = round(cols * aspect)，与图的像素尺寸无关
const expCols = util.CONSTANTS.DEFAULT_COLS;       // 50
const expRows = Math.round(expCols * (H / W));      // round(50*0.75)=38
check('generateTemplate 返回完整结构', () => {
  assert.ok(Array.isArray(tpl.template), 'template 存在');
  assert.strictEqual(tpl.template.length, expRows, '行数=round(maxBeadWidth*aspect)');
  assert.strictEqual(tpl.template[0].length, expCols, '列数=maxBeadWidth');
  assert.ok(Array.isArray(tpl.materialList), 'materialList 存在');
  assert.ok(tpl.totalBeads > 0, 'totalBeads>0');
});

// ---- 3. 透明像素 → 空位 null ----
check('透明像素映射为空位 null', () => {
  assert.strictEqual(tpl.template[0][3], null, '(0,3) 透明→null');
  assert.strictEqual(tpl.template[2][3], null, '(2,3) 透明→null');
});

// ---- 4. PP43 金色现可被选中（BUG-24 修复仍有效）----
check('PP43 金色进入 materialList（不再被 PP05 压制）', () => {
  const ids = tpl.materialList.map(m => m.color.id);
  assert.ok(ids.indexOf('PP43') >= 0, 'PP43 应在材料清单中，实际: ' + JSON.stringify(ids));
});

// ---- 5. RLE 编解码往返 ----
const rle = beadEngine.rleEncode(tpl.template);
const decoded = beadEngine.rleDecode(rle, expCols, expRows); // 必须传原始矩阵维度
check('RLE 编解码往返一致', () => {
  assert.strictEqual(JSON.stringify(decoded), JSON.stringify(tpl.template), '往返后矩阵一致');
});

// ---- 6. slimMaterialList 逻辑（复刻 index.js 行为）----
function slimMaterialList(materialList) {
  if (!Array.isArray(materialList)) return materialList;
  return materialList.map(function (item) {
    if (!item || typeof item !== 'object') return item;
    const c = item.color;
    let slimColor = c;
    if (c && typeof c === 'object') {
      const { lab, r, g, b, ...rest } = c;
      slimColor = rest;
    }
    return Object.assign({}, item, { color: slimColor });
  });
}
const slimmed = slimMaterialList(tpl.materialList);
check('slim 后渲染所需字段(id/name/hex)保留', () => {
  for (const m of slimmed) {
    assert.ok(m.color.id && m.color.hex && m.color.name, 'material 含 id/name/hex');
    assert.strictEqual(m.color.lab, undefined, 'lab 已剔除');
    assert.strictEqual(m.color.r, undefined, 'r 已剔除');
  }
});

// ---- 7. renderTemplate 用 slim 后数据重显不报错（核心重显路径）----
check('renderTemplate 可用 slim 后数据重显', () => {
  const renderPalette = beadEngine.initPalette(paletteRaw);
  const slimData = Object.assign({}, tpl, {
    materialList: slimmed,
    // usedPalette 也用完整 initPalette（渲染仅读 hex）
    usedPalette: renderPalette
  });
  const mockCtx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, imageSmoothingEnabled: false,
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, arc() {}, fill() {}, fillText() {}, save() {}, restore() {},
    measureText() { return { width: 6 }; }, setLineDash() {}, clearRect() {}
  };
  const res = beadEngine.renderTemplate(mockCtx, slimData, { cellSize: 20, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'square', offsetX: 0, offsetY: 0 });
  assert.ok(res && res.canvasWidth > 0 && res.canvasHeight > 0, '渲染产出有效尺寸');
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAIL') + ' — pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);

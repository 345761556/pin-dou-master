// test/template_preview_dpr.test.js
// 回归测试：预览画布高 DPI 模糊（devicePixelRatio 未处理）
// 根因：renderCanvas 以 canvas.width = CSS 像素（与 WXML 显示尺寸 1:1），
//       高 DPI 真机（DPR 2-3）被拉伸 2-3 倍渲染，网格线/色号文字发虚。
// 修复：backing store = CSS 像素 × DPR，并 ctx.scale(effDpr, effDpr)，
//       renderTemplate 全部绘制坐标仍按 CSS 像素（labelSpace/cellSize 不变）；
//       canvasDisplayWidth/Height（WXML CSS 尺寸）保持 CSS 语义，布局不变。
// 背板钳制（配套修复盲区）：高 DPR 真机放大后 backing store 可能突破 iOS Safari
//       画布硬限制（~16.7MP/4096 维度）→ 预览空白/黑块。故取 effDpr = min(dpr, 4096/CSS尺寸)，
//       并按维度硬截断兜底，保证任一维度 ≤ 4096（宁可微糊也不要空白）。
// 验证：
//   1) 静态：存在 _getDevicePixelRatio 工具、背板维度上限 MAX_PREVIEW_SIDE、动态降 effDpr、绘制前 ctx.scale(背板/CSS 比)
//   2) dpr=2：canvas.width/height == 2×CSS 值；ctx.scale 以 (2,2) 调用；
//      setData 的 canvasDisplayWidth/Height 仍为 CSS 值（显示尺寸不变）
//   3) dpr=1：canvas.width == CSS 值（与修复前行为一致）
//   4) 异常回退：getWindowInfo 抛错 / pixelRatio 非法(NaN/0/负数/非数字) → dpr=1（不崩）
//   5) 兼容回退：无 getWindowInfo 但有 getSystemInfoSync → 取其 pixelRatio
//   6) 两者皆无 → 兜底 1（不崩）
//   7) 静态防线：导出路径（canvasToTempFilePath）仍用 params 尺寸，不受 DPR 影响
//   8) 背板钳制：大模板(dpr=3 @cellSize=12/20、dpr=2 @cellSize=20) backing store 任一维度 ≤ 4096，
//      且较「无钳制 × dpr」明显缩小，scale 按实际背板/CSS 比回落（证明越界盲区已修复）
// 运行：node test/template_preview_dpr.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const beadEngine = require('../utils/beadEngine');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}
// 浮点近似比较（背板/CSS 比可能含四舍五入误差）
function approx(a, b) { return Math.abs(a - b) < 1e-6; }

// ---- 1) 静态断言 ----
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
ok('renderCanvas 引入 _getDevicePixelRatio 工具', /_getDevicePixelRatio\(\)/.test(tplSrc));
ok('背板钳制：定义维度上限 MAX_PREVIEW_SIDE 引用共享常量(=4096)', /MAX_PREVIEW_SIDE\s*=\s*(MAX_CANVAS_SIDE|4096)/.test(tplSrc));
ok('背板钳制：动态降 effDpr = min(dpr, 4096/CSS宽, 4096/CSS高)',
  /let effDpr = Math\.min\(dpr, MAX_PREVIEW_SIDE \/ canvasWidth, MAX_PREVIEW_SIDE \/ canvasHeight\)/.test(tplSrc));
ok('背板钳制：维度硬截断兜底（backingW/H > 上限则截断）',
  /if \(backingW > MAX_PREVIEW_SIDE\)/.test(tplSrc) && /if \(backingH > MAX_PREVIEW_SIDE\)/.test(tplSrc));
ok('绘制前 ctx.scale 用实际背板/CSS 比（同源，不再恒等于 dpr）',
  /ctx\.scale\(backingW \/ canvasWidth, backingH \/ canvasHeight\);/.test(tplSrc));
ok('DPR 非法值回退 1（isFinite 校验）', /isFinite\(ratio\)/.test(tplSrc));
// 导出路径不受 DPR 影响：canvasToTempFilePath 仍按 params 尺寸 1:1 输出
ok('导出路径不受 DPR 影响（destWidth/destHeight 仍用 params 尺寸）',
  /destWidth: params\.width/.test(tplSrc) && /destHeight: params\.height/.test(tplSrc));

// ---- 2) mock 微信运行时 ----
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c', beadType: 'square' } });
let pageObj = null;
global.Page = (obj) => { pageObj = obj; };
require('../pages/template/template.js');

// 生成简单模板数据（全空位；materialList 留空使 legendHeight=0，聚焦 DPR 适配）
function makeTemplateData(cols, rows) {
  const template = [];
  for (let y = 0; y < rows; y++) {
    template.push(new Array(cols).fill(null));
  }
  return {
    cols, rows,
    totalBeads: 0,
    colorCount: 1,
    beadSize: 29,
    beadType: 'square',
    materialList: [],
    template
  };
}

// 记录 ctx：捕获 scale 调用（renderTemplate 内部不调用 scale/setTransform），其余绘制方法 no-op
function makeRecorderCtx() {
  const scaleCalls = [];
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'scale') return (...args) => { scaleCalls.push(args); };
      return (typeof k === 'string') ? (() => {}) : undefined;
    },
    set: (t, k, v) => { t[k] = v; return true; }
  });
  // scaleCalls 经闭包外带返回（不挂到 proxy 上，避免被 get 陷阱拦截成函数）
  return { ctx, scaleCalls };
}

// 功能驱动 renderCanvas：wxOverrides 可覆盖/追加 wx API（getWindowInfo/getSystemInfoSync 等）
function runRenderCanvas(templateData, cellSize, wxOverrides) {
  const { ctx: ctx2d, scaleCalls } = makeRecorderCtx();
  const canvas = { width: 0, height: 0, getContext: () => ctx2d };
  const wxMock = Object.assign({
    showShareMenu: () => {},
    setNavigationBarTitle: () => {},
    showToast: () => {},
    navigateBack: () => {},
    createSelectorQuery: () => {
      const chain = {
        in() { return chain; },
        select() { return chain; },
        fields() { return chain; },
        exec(cb) { cb([{ node: canvas }]); }
      };
      return chain;
    }
  }, wxOverrides || {});
  global.wx = wxMock;
  const ctx = Object.assign({}, pageObj, {
    data: { cellSize, beadType: 'square' },
    _templateData: templateData,
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx.renderCanvas();
  return { canvas, ctx2d, scaleCalls, ctxData: ctx.data };
}

// ---- 3) DPR 适配数值断言 ----
// 基准：20×20 @10 → labelSpace=32（2位标号）→ CSS 宽/高 = 32+200 = 232
const tpl = makeTemplateData(20, 20);
const labelSpace = beadEngine.calcLabelSpace(20, 20, 10, true);
const cssW = labelSpace + 20 * 10;
const cssH = labelSpace + 20 * 10;

// 场景 A：dpr=2 → backing store 翻倍、ctx.scale(2,2)、CSS 显示尺寸不变
{
  const { canvas, scaleCalls, ctxData } = runRenderCanvas(tpl, 10, { getWindowInfo: () => ({ pixelRatio: 2 }) });
  ok('dpr=2 → canvas.width = 2×CSS宽 (' + canvas.width + '=' + (cssW * 2) + ')', canvas.width === cssW * 2);
  ok('dpr=2 → canvas.height = 2×CSS高 (' + canvas.height + '=' + (cssH * 2) + ')', canvas.height === cssH * 2);
  ok('dpr=2 → ctx.scale 恰以 (2,2) 调用 1 次',
    scaleCalls.length === 1 && scaleCalls[0][0] === 2 && scaleCalls[0][1] === 2);
  ok('dpr=2 → CSS 显示宽保持 CSS 像素（canvasDisplayWidth=' + ctxData.canvasDisplayWidth + '）',
    ctxData.canvasDisplayWidth === cssW);
  ok('dpr=2 → CSS 显示高保持 CSS 像素（canvasDisplayHeight=' + ctxData.canvasDisplayHeight + '）',
    ctxData.canvasDisplayHeight === cssH);
}

// 场景 B：dpr=1 → 与修复前行为一致（canvas.width === CSS 值）
{
  const { canvas, scaleCalls } = runRenderCanvas(tpl, 10, { getWindowInfo: () => ({ pixelRatio: 1 }) });
  ok('dpr=1 → canvas.width = CSS宽（与修复前一致）(' + canvas.width + '=' + cssW + ')', canvas.width === cssW);
  ok('dpr=1 → canvas.height = CSS高', canvas.height === cssH);
  ok('dpr=1 → ctx.scale 以 (1,1) 调用',
    scaleCalls.length === 1 && scaleCalls[0][0] === 1 && scaleCalls[0][1] === 1);
}

// 场景 C：getWindowInfo 抛错 → 回退 1（不崩）
{
  const { canvas } = runRenderCanvas(tpl, 10, { getWindowInfo: () => { throw new Error('mock getWindowInfo fail'); } });
  ok('getWindowInfo 抛错 → dpr 回退 1（canvas.width=CSS宽，不崩）', canvas.width === cssW);
}

// 场景 D：pixelRatio 非法（NaN/0/负数/非数字/非有限）→ 回退 1（不崩）
// 补充：Infinity/-Infinity（isFinite 拦截），工程师原列表未覆盖，QA 独立补充
{
  for (const bad of [NaN, 0, -1, '2', undefined, null, Infinity, -Infinity]) {
    const { canvas } = runRenderCanvas(tpl, 10, { getWindowInfo: () => ({ pixelRatio: bad }) });
    ok('pixelRatio=' + String(bad) + ' → 回退 1（canvas.width=CSS宽）', canvas.width === cssW);
  }
}

// 场景 E：无 getWindowInfo 但有 getSystemInfoSync → 兼容回退取其 pixelRatio
{
  const { canvas } = runRenderCanvas(tpl, 10, {
    getWindowInfo: undefined,
    getSystemInfoSync: () => ({ pixelRatio: 3 })
  });
  ok('无 getWindowInfo、getSystemInfoSync.pixelRatio=3 → canvas.width=3×CSS宽 (' + canvas.width + '=' + (cssW * 3) + ')',
    canvas.width === cssW * 3);
}

// 场景 F：两者皆无 → 兜底 1（不崩）
{
  const { canvas } = runRenderCanvas(tpl, 10, {
    getWindowInfo: undefined,
    getSystemInfoSync: undefined
  });
  ok('无任何 DPR API → 兜底 1（canvas.width=CSS宽，不崩）', canvas.width === cssW);
}

// 场景 G（QA 独立补充）：重复渲染（zoomIn/zoomOut → renderCanvas 多次）scale 不叠加
// 关键：canvas.width/height 每次重新赋值会重置变换矩阵，故每次 render 恰好一次 scale(dpr,dpr)，
// 不会出现第二次 render 时在上一次 scale 之上再 scale → 越放越大。
{
  const { ctx: ctx2d, scaleCalls } = makeRecorderCtx();
  const canvas = { width: 0, height: 0, getContext: () => ctx2d };
  const wxMock = {
    showShareMenu: () => {},
    setNavigationBarTitle: () => {},
    showToast: () => {},
    navigateBack: () => {},
    createSelectorQuery: () => {
      const chain = {
        in() { return chain; },
        select() { return chain; },
        fields() { return chain; },
        exec(cb) { cb([{ node: canvas }]); }
      };
      return chain;
    },
    getWindowInfo: () => ({ pixelRatio: 2 })
  };
  global.wx = wxMock;
  const ctx = Object.assign({}, pageObj, {
    data: { cellSize: 10, beadType: 'square' },
    _templateData: tpl,
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx.renderCanvas();
  ctx.renderCanvas();
  ok('重复渲染 2 次 → scale 每次恰好 1 次（共 2 次，非叠加）',
    scaleCalls.length === 2 && scaleCalls.every((s) => s[0] === 2 && s[1] === 2));
  ok('重复渲染 2 次 → canvas.width 仍为 2×CSS（未越放越大）', canvas.width === cssW * 2);
}

// ---- 8) 背板尺寸钳制（修复越界盲区）----
// 关键：大模板 + 高 DPR 下，无钳制的 backing store（CSS×dpr）会突破 iOS 4096 维度上限 → 预览空白。
// 复算（与被测代码同一公式）：effDpr = min(dpr, 4096/cw, 4096/ch)，并维度硬截断 ≤ 4096。
const MAX_SIDE = 4096;
function expectedBacking(cw, ch, dpr) {
  let e = Math.min(dpr, MAX_SIDE / cw, MAX_SIDE / ch);
  if (!isFinite(e) || e <= 0) e = 1;
  let ew = Math.round(cw * e);
  let eh = Math.round(ch * e);
  if (ew > MAX_SIDE) ew = MAX_SIDE;
  if (eh > MAX_SIDE) eh = MAX_SIDE;
  return { ew, eh, e };
}

// 场景 H：120×120 @cellSize=12, dpr=3 → 此前 4452×4782(21.3MP) 越界；应钳制 ≤ 4096
{
  const cs = 12;
  const ls = beadEngine.calcLabelSpace(120, 120, cs, cs >= 6);
  const cw = ls + 120 * cs;
  const ch = ls + 120 * cs; // materialList 为空 → 图例高度 0
  const { ew, eh, e } = expectedBacking(cw, ch, 3);
  const { canvas, scaleCalls } = runRenderCanvas(makeTemplateData(120, 120), cs, { getWindowInfo: () => ({ pixelRatio: 3 }) });
  ok('场景H dpr=3 @cellSize=12 → 背板宽 ≤ 4096 (' + canvas.width + '≤4096)', canvas.width <= MAX_SIDE);
  ok('场景H dpr=3 @cellSize=12 → 背板高 ≤ 4096 (' + canvas.height + '≤4096)', canvas.height <= MAX_SIDE);
  ok('场景H dpr=3 @cellSize=12 → 实际背板=预期钳制值 (w=' + canvas.width + ',h=' + canvas.height + ')',
    canvas.width === ew && canvas.height === eh);
  ok('场景H → 钳制生效（effDpr=' + e.toFixed(3) + ' < 3，较无钳制 4452 明显减小）', e < 3);
  ok('场景H → ctx.scale 按背板/CSS 比回落 (一次)',
    scaleCalls.length === 1 && approx(scaleCalls[0][0], ew / cw) && approx(scaleCalls[0][1], eh / ch));
}

// 场景 I：120×120 @cellSize=20, dpr=3 → 此前 7332×7512(55MP) 严重越界；应钳制 ≤ 4096
{
  const cs = 20;
  const ls = beadEngine.calcLabelSpace(120, 120, cs, cs >= 6);
  const cw = ls + 120 * cs;
  const ch = ls + 120 * cs;
  const { ew, eh, e } = expectedBacking(cw, ch, 3);
  const { canvas, scaleCalls } = runRenderCanvas(makeTemplateData(120, 120), cs, { getWindowInfo: () => ({ pixelRatio: 3 }) });
  ok('场景I dpr=3 @cellSize=20 → 背板宽 ≤ 4096 (' + canvas.width + '≤4096)', canvas.width <= MAX_SIDE);
  ok('场景I dpr=3 @cellSize=20 → 背板高 ≤ 4096 (' + canvas.height + '≤4096)', canvas.height <= MAX_SIDE);
  ok('场景I dpr=3 @cellSize=20 → 实际背板=预期钳制值', canvas.width === ew && canvas.height === eh);
  ok('场景I → 钳制生效（effDpr=' + e.toFixed(3) + ' < 3，较无钳制 7332 大幅减小）', e < 3);
  ok('场景I → ctx.scale 按背板/CSS 比回落 (一次)',
    scaleCalls.length === 1 && approx(scaleCalls[0][0], ew / cw) && approx(scaleCalls[0][1], eh / ch));
}

// 场景 J：120×120 @cellSize=20, dpr=2 → 此前 4888×5008(24.5MP) 越界；应钳制 ≤ 4096
{
  const cs = 20;
  const ls = beadEngine.calcLabelSpace(120, 120, cs, cs >= 6);
  const cw = ls + 120 * cs;
  const ch = ls + 120 * cs;
  const { ew, eh, e } = expectedBacking(cw, ch, 2);
  const { canvas, scaleCalls } = runRenderCanvas(makeTemplateData(120, 120), cs, { getWindowInfo: () => ({ pixelRatio: 2 }) });
  ok('场景J dpr=2 @cellSize=20 → 背板宽 ≤ 4096 (' + canvas.width + '≤4096)', canvas.width <= MAX_SIDE);
  ok('场景J dpr=2 @cellSize=20 → 背板高 ≤ 4096 (' + canvas.height + '≤4096)', canvas.height <= MAX_SIDE);
  ok('场景J dpr=2 @cellSize=20 → 实际背板=预期钳制值', canvas.width === ew && canvas.height === eh);
  ok('场景J → 钳制生效（effDpr=' + e.toFixed(3) + ' < 2，较无钳制 4888 减小）', e < 2);
  ok('场景J → ctx.scale 按背板/CSS 比回落 (一次)',
    scaleCalls.length === 1 && approx(scaleCalls[0][0], ew / cw) && approx(scaleCalls[0][1], eh / ch));
}

// 场景 K（对照）：小模板 20×20 @cellSize=10, dpr=3 → 远未到上限，不应钳制（仍 = CSS×3）
{
  const cs = 10;
  const ls = beadEngine.calcLabelSpace(20, 20, cs, cs >= 6);
  const cw = ls + 20 * cs;
  const ch = ls + 20 * cs;
  const { ew, eh, e } = expectedBacking(cw, ch, 3);
  const { canvas } = runRenderCanvas(makeTemplateData(20, 20), cs, { getWindowInfo: () => ({ pixelRatio: 3 }) });
  ok('场景K 小模板 dpr=3 → 不钳制（effDpr=3，背板=CSS×3）', e === 3 && canvas.width === cw * 3 && canvas.height === ch * 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

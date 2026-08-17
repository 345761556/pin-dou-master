// test/template_preview_autofit.test.js
// 回归测试：预览自适应 cellSize 死代码
// 根因：data.cellSize 初始 10，无任何代码置 0 → renderCanvas 的 `if (!cellSize || cellSize <= 0)`
//       自适应分支永不执行 → 小模板（20×20）预览只有 ~232px，无法自适应放大（且与 H1 叠加）。
// 修复：data.cellSize 初始 0（未确定）→ 首次渲染进入自适应分支；自适应下限取默认 10
//       （小模板放大、大模板保持，避免缩到 3 使行列号/网格/颜色编号消失）；
//       用户 zoomIn/zoomOut 写入正数后不再被自适应覆盖。
// 验证：
//   1) 静态：data.cellSize 初始为 0（自适应哨兵），自适应分支保留
//   2) 小模板 20×20 首次渲染 → cellSize=13（放大）、zoomPercent=130、画布按 13 计算
//   3) 大模板 120×120 首次渲染 → cellSize=10（保持默认，不缩到 3）
//   4) 中模板 50×50 首次渲染 → cellSize=10（保持默认）
//   5) 用户 zoomOut 后 → 手动值固定，再次 renderCanvas 不被自适应覆盖
//   6) 未手动缩放时重复渲染 → 不重复自适应（保持首次结果）
//   7) cellSize 未确定（0）时手动缩放以默认 10 为基准，不产生越界值
// 运行：node test/template_preview_autofit.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const beadEngine = require('../utils/beadEngine');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：死代码已激活 ----
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
ok('data.cellSize 初始为 0（自适应哨兵，不再被 10 占位）', /cellSize:\s*0,/.test(tplSrc));
ok('renderCanvas 保留自适应分支（cellSize≤0 触发）', /if \(!cellSize \|\| cellSize <= 0\)/.test(tplSrc));
ok('自适应下限取默认 10（大模板保持，不缩到 3）', /Math\.max\(DEFAULT_CELL_SIZE, fitted\)/.test(tplSrc));

// ---- 2) mock 微信运行时 ----
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c', beadType: 'square' } });
let pageObj = null;
global.Page = (obj) => { pageObj = obj; };
require('../pages/template/template.js');

// 万能绘制 ctx（renderTemplate 内部 fillRect/strokeRect/fillText 等均为 no-op）
const proxyCtx = new Proxy({}, {
  get: (t, k) => (typeof k === 'string' ? (() => {}) : undefined),
  set: (t, k, v) => { t[k] = v; return true; }
});

function makeCanvasNode() {
  const canvas = { width: 0, height: 0, getContext: () => proxyCtx };
  return canvas;
}

// 生成简单模板数据（全空位；materialList 留空使 legendHeight=0，聚焦自适应 cellSize）
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

// 以「页面初始 data」驱动：ctx.data.cellSize 默认 0（未确定）→ renderCanvas 走自适应路径
function createCtx(templateData) {
  const canvas = makeCanvasNode();
  global.wx = {
    showShareMenu: () => {},
    setNavigationBarTitle: () => {},
    showToast: () => {},
    navigateBack: () => {},
    // dpr=1：预览 backing store 与 CSS 像素 1:1，既有断言（canvas.width === CSS 值）保持成立
    getWindowInfo: () => ({ pixelRatio: 1 }),
    createSelectorQuery: () => {
      const chain = {
        in() { return chain; },
        select() { return chain; },
        fields() { return chain; },
        exec(cb) { cb([{ node: canvas }]); }
      };
      return chain;
    }
  };
  const ctx = Object.assign({}, pageObj, {
    data: Object.assign({}, pageObj.data, { beadType: 'square' }),
    _templateData: templateData,
    setData: (d) => Object.assign(ctx.data, d)
  });
  return { ctx, canvas };
}

// ---- 3) 自适应数值断言 ----
// 场景 A：小模板 20×20 → 首次渲染自适应放大
//   cellByWidth=floor((375-96)/20)=13, cellByHeight=floor(600/20)=30 → fitted=13 → cellSize=13
{
  const { ctx, canvas } = createCtx(makeTemplateData(20, 20));
  ok('前置：页面初始 data.cellSize === 0（未确定）', ctx.data.cellSize === 0);
  ctx.renderCanvas();
  const labelSpace = beadEngine.calcLabelSpace(20, 20, 13, true); // = 32（2位标号）
  const expectW = labelSpace + 20 * 13;
  ok('小模板 20×20 首次渲染 → cellSize=13（自适应放大，原 10 仅 232px）', ctx.data.cellSize === 13);
  ok('小模板 20×20 首次渲染 → zoomPercent=130', ctx.data.zoomPercent === 130);
  ok('小模板 20×20 画布宽 = labelSpace+cols*cellSize (' + canvas.width + '=' + expectW + ')',
    canvas.width === expectW);
}

// 场景 B：大模板 120×120 → 保持默认 10（自适应算得 3 被下限 10 兜住，行列号/网格/颜色编号可读）
{
  const { ctx, canvas } = createCtx(makeTemplateData(120, 120));
  ctx.renderCanvas();
  const labelSpace = beadEngine.calcLabelSpace(120, 120, 10, true); // = 44（3位标号）
  ok('大模板 120×120 首次渲染 → cellSize=10（保持默认，不缩到 3）', ctx.data.cellSize === 10);
  ok('大模板 120×120 首次渲染 → zoomPercent=100', ctx.data.zoomPercent === 100);
  ok('大模板 120×120 画布宽 = labelSpace+cols*cellSize (' + canvas.width + '=' + (labelSpace + 1200) + ')',
    canvas.width === labelSpace + 120 * 10);
}

// 场景 C：中模板 50×50 → 保持默认 10（自适应算得 5 被下限 10 兜住）
{
  const { ctx } = createCtx(makeTemplateData(50, 50));
  ctx.renderCanvas();
  ok('中模板 50×50 首次渲染 → cellSize=10（保持默认）', ctx.data.cellSize === 10);
}

// 场景 D：用户手动缩放后不再被自适应覆盖
{
  const { ctx } = createCtx(makeTemplateData(20, 20));
  ctx.renderCanvas();   // 首次：自适应 → 13
  ctx.zoomOut();        // 用户手动缩小 → 11
  ok('用户 zoomOut 后 cellSize=11（手动值生效）', ctx.data.cellSize === 11);
  ok('用户 zoomOut 后 zoomPercent=110', ctx.data.zoomPercent === 110);
  ctx.renderCanvas();   // 再次渲染 → 不应回到自适应 13
  ok('手动缩放后再次渲染不被自适应覆盖（保持 11）', ctx.data.cellSize === 11);
}

// 场景 E：未手动缩放时重复渲染 → 不重复自适应（首次结果保持）
{
  const { ctx } = createCtx(makeTemplateData(20, 20));
  ctx.renderCanvas();
  const first = ctx.data.cellSize; // 13
  ctx.renderCanvas();
  ctx.renderCanvas();
  ok('重复渲染不重复自适应（保持首次结果 ' + first + '）', ctx.data.cellSize === first);
}

// 场景 F：cellSize 未确定（0）时手动缩放以默认 10 为基准，不产生越界值
{
  const { ctx: ctxIn } = createCtx(makeTemplateData(20, 20));
  ctxIn.zoomIn();       // 不先 renderCanvas → base=10 → 12
  ok('cellSize=0 时 zoomIn 以默认 10 为基准 → 12', ctxIn.data.cellSize === 12);
  ok('cellSize=0 时 zoomIn 后 zoomPercent=120', ctxIn.data.zoomPercent === 120);

  const { ctx: ctxOut } = createCtx(makeTemplateData(20, 20));
  ctxOut.zoomOut();     // base=10 → 8（不低于 CELL_SIZE_MIN=3）
  ok('cellSize=0 时 zoomOut 以默认 10 为基准 → 8', ctxOut.data.cellSize === 8);

  // 显式钳制边界：无论 0 值基准缩放如何计算，结果必须落在 [CELL_SIZE_MIN=3, CELL_SIZE_MAX=20]
  const { ctx: ctxInBound } = createCtx(makeTemplateData(20, 20));
  ctxInBound.zoomIn();
  ok('cellSize=0 zoomIn 结果在 [3,20] 钳制区间内 (' + ctxInBound.data.cellSize + ')',
    ctxInBound.data.cellSize >= 3 && ctxInBound.data.cellSize <= 20);
  const { ctx: ctxOutBound } = createCtx(makeTemplateData(20, 20));
  ctxOutBound.zoomOut();
  ok('cellSize=0 zoomOut 结果在 [3,20] 钳制区间内 (' + ctxOutBound.data.cellSize + ')',
    ctxOutBound.data.cellSize >= 3 && ctxOutBound.data.cellSize <= 20);
}

// 场景 G：导出路径独立于预览 data.cellSize（0 哨兵不污染导出参数）
// 回归防线：_calcExportParams 必须使用传入参数，而非 this.data.cellSize（后者初始 0，
// 若被误读会算出 labelSpace=0 / 画布宽=0 的非法导出参数）。
{
  const { ctx } = createCtx(makeTemplateData(20, 20));
  // 页面 data.cellSize 保持 0（未渲染），导出直接传参 10
  const params = ctx._calcExportParams(10);
  ok('导出 _calcExportParams(10) 用参数 cellSize=10 而非 data.cellSize=0', params.cellSize === 10);
  ok('导出参数宽 > 0（未受 data.cellSize=0 哨兵污染）', params.width > 0 && params.height > 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

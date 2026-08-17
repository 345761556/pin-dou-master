// test/export_legend_whitespace.test.js
// 回归测试：导出图底部恒有 60-160px 多余白条
// 根因：template.js _calcExportParams 按固定 80px/项估算图例行数（多预留），
//       beadEngine.js renderTemplate 按 36-80px 自适应列宽（少画行）→ 预留恒 ≥ 绘制。
// 修复：图例高度统一走 beadEngine.calcLegendHeight，导出预留与绘制严格一致 → 白条消除。
// 运行：node test/export_legend_whitespace.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const beadEngine = require('../utils/beadEngine');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言 ----
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
ok('_calcExportParams 不再按固定 80px/项估算图例行数', !/Math\.floor\(\(canvasWidth\s*-\s*20\)\s*\/\s*80\)/.test(tplSrc));
ok('_calcExportParams 使用 beadEngine.calcLegendHeight', /beadEngine\.calcLegendHeight\(/.test(tplSrc));
const engSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');
ok('renderTemplate 使用 calcLegendHeight（不再内联图例公式）', /legendHeight = calcLegendHeight\(availableWidth, (materialList|matList)\.length\)/.test(engSrc));

// ---- 2) mock 微信运行时 ----
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
let pageObj = null;
global.Page = (o) => { pageObj = o; };
require('../pages/template/template.js');

const proxyCtx = new Proxy({}, {
  get: (t, k) => (typeof k === 'string' ? (() => {}) : undefined),
  set: (t, k, v) => { t[k] = v; return true; }
});

// 生成含 N 色材料清单的模板数据
function makeTemplateData(cols, rows, matCount) {
  const template = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) row.push('C' + String((x + y) % Math.max(1, matCount) + 1).padStart(2, '0'));
    template.push(row);
  }
  const materialList = [];
  for (let i = 0; i < matCount; i++) {
    materialList.push({ color: { id: 'C' + String(i + 1).padStart(2, '0'), name: '色' + i, hex: '#888888' }, count: cols * rows });
  }
  return { cols, rows, totalBeads: cols * rows, colorCount: matCount, beadSize: 29, materialList, template };
}

function makeCtx(templateData) {
  const ctx = Object.assign({}, pageObj, {
    data: { beadType: 'square' },
    _templateData: templateData,
    setData: () => {}
  });
  return ctx;
}

// ---- 3) 数值一致性：导出预留图例高度 == 绘制图例高度（无白条） ----
const CASES = [
  { name: '120×120 @10 × 40色（典型大模板）', cols: 120, rows: 120, cellSize: 10, matCount: 40 },
  { name: '50×50 @10 × 30色（默认模板）', cols: 50, rows: 50, cellSize: 10, matCount: 30 },
  { name: '100×100 @6 × 20色', cols: 100, rows: 100, cellSize: 6, matCount: 20 },
  { name: '20×20 @10 × 4色（小模板）', cols: 20, rows: 20, cellSize: 10, matCount: 4 },
  { name: '120×120 @8 × 50色（最多色数）', cols: 120, rows: 120, cellSize: 8, matCount: 50 },
];

for (const c of CASES) {
  const templateData = makeTemplateData(c.cols, c.rows, c.matCount);
  const ctx = makeCtx(templateData);
  const params = ctx._calcExportParams(c.cellSize);
  const renderResult = beadEngine.renderTemplate(proxyCtx, templateData, {
    cellSize: c.cellSize,
    showGrid: true,
    showLabels: c.cellSize >= 8,
    showColorLabels: c.cellSize >= 8,
    beadType: 'square'
  });

  ok(c.name + ' → 导出高度 == 绘制总高度（' + params.height + '=' + renderResult.canvasHeight + '，白条=0）',
    params.height === renderResult.canvasHeight);
}

// 边界：materialList 为空 → 不画图例，导出高度不含图例区
{
  const templateData = makeTemplateData(50, 50, 0);
  const ctx = makeCtx(templateData);
  const params = ctx._calcExportParams(10);
  const renderResult = beadEngine.renderTemplate(proxyCtx, templateData, {
    cellSize: 10, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'square'
  });
  ok('空材料清单 → 导出高度 == 绘制总高度（均无图例区）', params.height === renderResult.canvasHeight);
}

// ---- 4) 回归前提：旧固定 80px/项公式确实多预留（证明用例有效）----
{
  // 旧公式：legendCols = floor((W-20)/80), rows = ceil(n/cols), height = rows*50+20
  const oldLegend = (W, n) => Math.ceil(n / Math.max(1, Math.floor((W - 20) / 80))) * 50 + 20;
  const W = 30 + 120 * 10; // 120列@10 画布宽（旧 labelSpace=30 时代）
  const newLegend = beadEngine.calcLegendHeight(W - 20, 40);
  ok('回归前提：旧公式在 120×120@10×40色 下多预留白条 (' + oldLegend(W, 40) + ' > ' + newLegend + ')',
    oldLegend(W, 40) > newLegend);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

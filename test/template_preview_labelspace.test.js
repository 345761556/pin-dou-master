// test/template_preview_labelspace.test.js
// 回归测试：BUG-3-5 修复不完整 —— 预览画布(labelSpace 硬编码 30)与引擎绘制起点(calcLabelSpace=44)
// 不一致，导致 120×120 模板在默认 cellSize=10 下最后一整行/列画在画布外被裁。
// 修复：renderCanvas 统一走 beadEngine.calcLabelSpace，与 renderTemplate 绘制严格同源。
// 验证：
//   1) 静态：template.js 不再含硬编码 `cellSize >= 6 ? 30`，且 renderCanvas 使用 beadEngine.calcLabelSpace
//   2) 数值：预览画布宽/高 == renderTemplate 返回的 canvasWidth/canvasHeight（同 labelSpace → 不裁切）
//   3) 核心场景：120×120@10 画布宽 = 44+1200 = 1244 ≥ 渲染终点 1244（修复前 1230 < 1244 裁 14px）
// 运行：node test/template_preview_labelspace.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const beadEngine = require('../utils/beadEngine');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：硬编码已移除、统一走 calcLabelSpace ----
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
// 仅匹配「赋值语句」形态（注释中引用的旧代码描述不算，避免误报）
ok('renderCanvas 不再硬编码 labelSpace = cellSize >= 6 ? 30',
  !/labelSpace\s*=\s*cellSize\s*>=\s*6\s*\?\s*30/.test(tplSrc));
ok('renderCanvas 使用 beadEngine.calcLabelSpace', /beadEngine\.calcLabelSpace\(/.test(tplSrc));

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

// 生成简单模板数据（全空位；materialList 留空使 legendHeight=0，聚焦行列裁切问题）
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

// 功能驱动 renderCanvas：返回 canvas node，供断言实际像素尺寸
function runRenderCanvas(templateData, cellSize) {
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
    data: { cellSize, beadType: 'square' },
    _templateData: templateData,
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx.renderCanvas();
  return canvas;
}

// ---- 3) 数值一致性用例 ----
const CASES = [
  { name: '120×120 @10（核心回归：3位标号 labelSpace=44）', cols: 120, rows: 120, cellSize: 10 },
  { name: '50×50 @10（2位标号 labelSpace=32，旧值 30 裁 2px）', cols: 50, rows: 50, cellSize: 10 },
  { name: '100×100 @6（3位标号 digitWidth=9 → labelSpace=35，旧值裁 5px）', cols: 100, rows: 100, cellSize: 6 },
  { name: '120×120 @3（无标签 labelSpace=0）', cols: 120, rows: 120, cellSize: 3 },
  { name: '20×20 @10（2位标号）', cols: 20, rows: 20, cellSize: 10 },
];

for (const c of CASES) {
  const templateData = makeTemplateData(c.cols, c.rows);
  const canvas = runRenderCanvas(templateData, c.cellSize);

  // 引擎侧基准：renderTemplate 实际绘制范围（offsetX=0、无图例 → totalWidth=labelSpace+cols*cellSize）
  const renderResult = beadEngine.renderTemplate(proxyCtx, templateData, {
    cellSize: c.cellSize,
    showGrid: c.cellSize >= 5,
    showLabels: c.cellSize >= 6,
    showColorLabels: c.cellSize >= 5,
    beadType: 'square'
  });

  const labelSpace = beadEngine.calcLabelSpace(c.cols, c.rows, c.cellSize, c.cellSize >= 6);
  const expectW = labelSpace + c.cols * c.cellSize;
  const expectH = labelSpace + c.rows * c.cellSize;

  ok(c.name + ' → 画布宽 = labelSpace+cols*cellSize (' + canvas.width + '=' + expectW + ')',
    canvas.width === expectW);
  ok(c.name + ' → 画布高 = labelSpace+rows*cellSize (' + canvas.height + '=' + expectH + ')',
    canvas.height === expectH);
  // 不裁切硬性条件：画布尺寸 ≥ renderTemplate 绘制终点（相等即不裁）
  ok(c.name + ' → 画布宽 ≥ 渲染终点 ' + renderResult.canvasWidth + '（不再裁最后一列）',
    canvas.width >= renderResult.canvasWidth);
  ok(c.name + ' → 画布高 ≥ 渲染终点 ' + renderResult.canvasHeight + '（不再裁最后一行）',
    canvas.height >= renderResult.canvasHeight);
}

// ---- 3b) L8 回归：预览画布高度须含底部颜色图例（非空材料）----
// 此前 canvas.height 缺 legendHeight → 整块图例被裁；修复后应与 renderTemplate 绘制范围同源。
// 现有 CASES 用 materialList:[] → legendHeight=0，断言 canvas.height === labelSpace+rows*cellSize 仍成立（无回归）；
// 此处单独构造带 materialList 的模板，验证「图例不再被裁」。
function makeMaterialList(n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({ color: { id: 'A' + (i + 1), hex: '#FF0000' }, count: 10 });
  }
  return list;
}

const LEGEND_CASES = [
  { name: '5 色 50×50 @10（带图例）', cols: 50, rows: 50, cellSize: 10, mat: 5 },
  { name: '30 色 30×30 @10（带图例）', cols: 30, rows: 30, cellSize: 10, mat: 30 },
];

for (const c of LEGEND_CASES) {
  const templateData = makeTemplateData(c.cols, c.rows);
  templateData.materialList = makeMaterialList(c.mat); // 注入非空材料 → 触发图例绘制
  const canvas = runRenderCanvas(templateData, c.cellSize);

  // 引擎侧基准：renderTemplate 实际绘制范围（已含图例）
  const renderResult = beadEngine.renderTemplate(proxyCtx, templateData, {
    cellSize: c.cellSize,
    showGrid: c.cellSize >= 5,
    showLabels: c.cellSize >= 6,
    showColorLabels: c.cellSize >= 5,
    beadType: 'square'
  });

  const labelSpace = beadEngine.calcLabelSpace(c.cols, c.rows, c.cellSize, c.cellSize >= 6);
  const lgCanvasWidth = labelSpace + c.cols * c.cellSize;
  // 与 renderCanvas 修复后同源公式：showColorLabels(cellSize>=5) && cellSize>=5 && 材料非空 → calcLegendHeight(canvasWidth-20, mat)
  const legendHeight = (c.cellSize >= 5 && c.mat > 0)
    ? beadEngine.calcLegendHeight(lgCanvasWidth - 20, c.mat)
    : 0;
  const expectH = labelSpace + c.rows * c.cellSize + legendHeight;

  ok(c.name + ' → 画布高 = labelSpace+rows*cellSize+legendHeight (' + canvas.height + '=' + expectH + ')',
    canvas.height === expectH);
  // 核心断言：图例不再被裁（预览画布高度 ≥ 引擎实际绘制高度，引擎已含图例）
  ok(c.name + ' → 画布高 ≥ 渲染终点 ' + renderResult.canvasHeight + '（图例不被裁）',
    canvas.height >= renderResult.canvasHeight);
}

// ---- 4) 旧值对比：验证旧硬编码 30 在 120×120@10 下确实裁切（证明用例有效）----
{
  const c = CASES[0];
  const labelSpace = beadEngine.calcLabelSpace(c.cols, c.rows, c.cellSize, true); // = 44
  const oldCanvasW = 30 + c.cols * c.cellSize;      // 旧逻辑 = 1230
  const renderEnd = labelSpace + c.cols * c.cellSize; // 绘制终点 = 1244
  ok('回归前提：旧硬编码 30 在 120×120@10 下会裁切 (' + oldCanvasW + ' < ' + renderEnd + ')',
    oldCanvasW < renderEnd);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// 等价性测试：renderTemplate 拆分重构前后行为零变化
// 思路：用录制式 mock ctx 记录每次 canvas 调用的「方法名 + 参数」和「属性赋值」，
// 对比旧实现(快照 _fixture_old)与重构后实现(utils/beadEngine.js)在多种模板/配置下的调用轨迹，
// 若完全一致则证明绘制顺序、坐标、颜色、字号等全部未变（像素级回归靠真机验证）。
const path = require('path');

// ---- 录制式 mock canvas context ----
function makeRecordingCtx() {
  const calls = [];
  const snap = (v) => (typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v);
  const ctx = {};
  const methods = [
    'fillRect', 'strokeRect', 'fillText', 'beginPath', 'arc', 'fill', 'stroke',
    'moveTo', 'lineTo', 'clearRect', 'save', 'restore', 'translate', 'rotate',
    'scale', 'setLineDash', 'closePath', 'rect', 'clip', 'ellipse',
    'quadraticCurveTo', 'bezierCurveTo'
  ];
  for (const m of methods) {
    ctx[m] = (...args) => { calls.push({ t: 'm', name: m, args: args.map(snap) }); };
  }
  // measureText 必须返回确定性宽度（new/old 共用同一 mock，故一致）
  ctx.measureText = (s) => ({ width: (typeof s === 'string' ? s.length : 1) * 7 });
  ctx.createLinearGradient = (...args) => {
    calls.push({ t: 'm', name: 'createLinearGradient', args: args.map(snap) });
    return { addColorStop() {} };
  };
  const props = [
    'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline',
    'globalAlpha', 'lineCap', 'lineJoin', 'lineDashOffset', 'miterLimit',
    'shadowColor', 'shadowBlur'
  ];
  for (const p of props) {
    let v;
    Object.defineProperty(ctx, p, {
      get: () => v,
      set: (nv) => { v = nv; calls.push({ t: 'p', name: p, value: snap(nv) }); }
    });
  }
  return { ctx, calls };
}

// ---- 测试数据构造 ----
function makeTemplate(cols, rows, colors) {
  // colors: ['H1','P2',...]，随机但确定地填充矩阵，含一个不在 colorMap 的透明 id 'X0'
  const template = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const idx = (x * 7 + y * 3) % (colors.length + 1);
      row.push(idx === colors.length ? 'X0' : colors[idx]);
    }
    template.push(row);
  }
  return template;
}

function makeMaterialList(colors) {
  return colors.map((id, i) => ({
    color: { id, hex: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#000000', '#FFFFFF'][i % 8] },
    count: 100 + i * 37
  }));
}

// ---- 加载 old / new ----
global.wx = global.wx || {};
global.__wxConfig = global.__wxConfig || {};
const oldBe = require('./_fixture_old/beadEngine.js');
const newBe = require('../utils/beadEngine.js');

const oldRender = oldBe.renderTemplate;
const newRender = newBe.renderTemplate;
if (typeof oldRender !== 'function' || typeof newRender !== 'function') {
  console.error('renderTemplate 未导出');
  process.exit(1);
}

// ---- 测试矩阵 ----
const colorSets = [
  ['H1', 'H2', 'H3'],
  ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'P24', 'P25'],
];
const sizes = [
  { cols: 10, rows: 8 },
  { cols: 12, rows: 12 },
  { cols: 40, rows: 30 },
];
const optSets = [
  { cellSize: 10, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'square' },
  { cellSize: 10, showGrid: false, showLabels: true, showColorLabels: true, beadType: 'circle' },
  { cellSize: 10, showGrid: true, showLabels: false, showColorLabels: false, beadType: 'square' },
  { cellSize: 4, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'square' },
  { cellSize: 15, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'circle' },
  { cellSize: 20, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'square' },
  { cellSize: 10, showGrid: true, showLabels: true, showColorLabels: true, beadType: 'square', offsetX: 5, offsetY: 7 },
];

let total = 0;
let failed = 0;
for (const colors of colorSets) {
  for (const sz of sizes) {
    const template = makeTemplate(sz.cols, sz.rows, colors);
    const materialList = makeMaterialList(colors);
    const data = { template, cols: sz.cols, rows: sz.rows, materialList };
    for (const opts of optSets) {
      total++;
      const { ctx: c1, calls: o1 } = makeRecordingCtx();
      const r1 = oldRender(c1, data, opts);
      const { ctx: c2, calls: n1 } = makeRecordingCtx();
      const r2 = newRender(c2, data, opts);

      const oJson = JSON.stringify(o1);
      const nJson = JSON.stringify(n1);
      if (oJson !== nJson) {
        failed++;
        console.error(`✗ 不一致 [colors=${colors.length}, ${sz.cols}x${sz.rows}, cellSize=${opts.cellSize}, grid=${opts.showGrid}, labels=${opts.showLabels}, cl=${opts.showColorLabels}, bead=${opts.beadType}]`);
        // 找出首个分歧点
        const minLen = Math.min(o1.length, n1.length);
        for (let i = 0; i < minLen; i++) {
          if (JSON.stringify(o1[i]) !== JSON.stringify(n1[i])) {
            console.error(`   首个分歧 @${i}: old=${JSON.stringify(o1[i])} new=${JSON.stringify(n1[i])}`);
            break;
          }
        }
        if (o1.length !== n1.length) console.error(`   长度 old=${o1.length} new=${n1.length}`);
      }
      // 返回值一致性
      if (JSON.stringify(r1) !== JSON.stringify(r2)) {
        failed++;
        console.error(`✗ 返回值不一致 [colors=${colors.length}, ${sz.cols}x${sz.rows}] old=${JSON.stringify(r1)} new=${JSON.stringify(r2)}`);
      }
    }
  }
}

console.log(`render_template 等价性: 运行 ${total} 组, 失败 ${failed} 组`);
if (failed > 0) {
  console.error('存在行为差异，重构有误！');
  process.exit(1);
}
console.log('✓ 旧/新 renderTemplate 调用轨迹与返回值完全一致');

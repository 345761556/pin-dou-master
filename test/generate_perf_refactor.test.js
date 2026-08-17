/**
 * 性能重构回归测试（High-1 / Medium-2 / Medium-3）
 * 锁定：
 *  A) generateTemplate 现为异步（返回 Promise），结果结构与同步时代一致；
 *  B) onProgress 真实增量刷新：>=2 次调用、末值为 100、单调非降、值域 [0,100]；
 *  C) 抖动分支(Floyd-Steinberg)与简单分支产出的「非空格数」一致（等于不透明像素数），
 *     验证闭包外提(Medium-3)/分块让出(Medium-2)未破坏语义；
 *  D) rgbToLab 精确 key 记忆化：同输入返回同一对象引用（零行为变更削峰）；
 *  E) shouldCancel 触发后立即中止（reject 带 __cancel），避免对已死页面 setData。
 */
const assert = require('assert');
const beadEngine = require('../utils/beadEngine.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

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

const palette = mkPalette([
  { id: 'R01', name: '红', hex: '#FF0000', r: 255, g: 0, b: 0 },
  { id: 'W01', name: '白', hex: '#FFFFFF', r: 255, g: 255, b: 255 },
  { id: 'B01', name: '蓝', hex: '#0000FF', r: 0, g: 0, b: 255 },
  { id: 'G01', name: '绿', hex: '#00FF00', r: 0, g: 255, b: 0 },
]);

// 构造 NxN 图：1/3 透明黑、2/3 不透明红（确定性）
function makeBuf(n) {
  const buf = [];
  for (let i = 0; i < n * n; i++) {
    if (i % 3 === 0) buf.push(0, 0, 0, 0);       // 透明黑（空位）
    else buf.push(200, 0, 0, 255);              // 不透明红
  }
  return buf;
}

(async () => {
  // ---- A) 异步契约 ----
  const p = beadEngine.generateTemplate(makeMockCanvas(makeBuf(8)), { width: 8, height: 8 },
    { beadSize: 29, maxBeadWidth: 8, colorCount: 4, palette, useDithering: false });
  ok('generateTemplate 返回 Promise', p instanceof Promise);

  const tpl = await p;
  ok('await 后返回完整模板结构', Array.isArray(tpl.template) && tpl.template.length === 8 &&
    Array.isArray(tpl.template[0]) && tpl.template[0].length === 8);
  ok('materialList 为数组且 totalBeads>0', Array.isArray(tpl.materialList) && tpl.totalBeads > 0);

  // ---- B) onProgress 真实增量 ----
  const prog = [];
  await beadEngine.generateTemplate(
    makeMockCanvas(makeBuf(16)), { width: 16, height: 16 },
    { beadSize: 29, maxBeadWidth: 16, colorCount: 4, palette, useDithering: true },
    (v) => prog.push(v));
  ok('onProgress 至少被调用 2 次（分块让出 → 真实可见）', prog.length >= 2);
  ok('onProgress 末值为 100', prog[prog.length - 1] === 100);
  ok('onProgress 单调非降', prog.every((v, i) => i === 0 || v >= prog[i - 1]));
  ok('onProgress 值域在 [0,100]', prog.every(v => v >= 0 && v <= 100));

  // ---- C) 抖动/简单分支「非空格数」一致 ----
  const buf8 = makeBuf(8);
  let opaqueCount = 0;
  for (let i = 0; i < buf8.length; i += 4) if (buf8[i + 3] >= 128) opaqueCount++;
  const baseOpts = { beadSize: 29, maxBeadWidth: 8, colorCount: 4, palette, fillBackgroundWhite: false };
  const tplDither = await beadEngine.generateTemplate(makeMockCanvas(buf8), { width: 8, height: 8 }, { ...baseOpts, useDithering: true });
  const tplSimple = await beadEngine.generateTemplate(makeMockCanvas(buf8), { width: 8, height: 8 }, { ...baseOpts, useDithering: false });
  const countNonNull = (t) => { let c = 0; for (const row of t.template) for (const cell of row) if (cell != null) c++; return c; };
  ok('抖动分支非空格数 = 不透明像素数', countNonNull(tplDither) === opaqueCount);
  ok('简单分支非空格数 = 不透明像素数', countNonNull(tplSimple) === opaqueCount);
  ok('抖动与简单分支非空格数一致（语义未变）', countNonNull(tplDither) === countNonNull(tplSimple));

  // ---- D) rgbToLab 精确 key 记忆化 ----
  const c1 = beadEngine.rgbToLab(1, 2, 3);
  const c2 = beadEngine.rgbToLab(1, 2, 3);
  ok('rgbToLab 同输入返回同一对象引用（缓存命中）', c1 === c2);
  ok('rgbToLab 输出为有限数', Number.isFinite(c1.l) && Number.isFinite(c1.a) && Number.isFinite(c1.b));

  // ---- E) shouldCancel 立即中止 ----
  let cancelCall = 0;
  const cancelOpts = {
    beadSize: 29, maxBeadWidth: 16, colorCount: 4, palette, useDithering: true,
    shouldCancel: () => { cancelCall++; return cancelCall >= 2; }
  };
  let cancelled = false;
  try {
    await beadEngine.generateTemplate(makeMockCanvas(makeBuf(16)), { width: 16, height: 16 }, cancelOpts, () => {});
  } catch (e) {
    cancelled = !!(e && e.__cancel);
  }
  ok('shouldCancel 触发后 reject 带 __cancel（页面存活守护）', cancelled);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();

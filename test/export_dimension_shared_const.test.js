// M3 回归测试：导出尺寸上限魔法数漂移
// 缺陷：utils/util.js 曾定义 EXPORT_MAX_SIDE:2048（死常量，全项目零引用），
// 而 pages/template/template.js 实际导出上限是本地硬编码 4096，两者数值矛盾；
// 同一「Canvas 单维硬上限」概念在 template 导出(4096)、template 预览(4096)、
// beadEngine DIM_HARD(4096) 多处硬编码，改一处漏另一处即产生行为漂移。
// 修复：删除死常量 2048；将 4096 提升为 template.js 模块级共享常量 MAX_CANVAS_SIDE，
// 导出与预览均引用之，并加注释说明与 beadEngine.DIM_HARD=4096 同源一致。

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'util.js'), 'utf8');
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
const engSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');

// --- 1. 死常量 EXPORT_MAX_SIDE:2048 已删除（修复核心） ---
ok('util.js 不再含矛盾的死常量 EXPORT_MAX_SIDE:2048', !/EXPORT_MAX_SIDE\s*:\s*2048/.test(utilSrc));
ok('util.js CONSTANTS 中不再导出 EXPORT_MAX_SIDE 键', !/\bEXPORT_MAX_SIDE\s*:/.test(utilSrc));
// 误删护栏：EXPORT_QUALITY 仍在（确认只删了死常量那一行）
ok('util.js 仍保留 EXPORT_QUALITY（未误删相邻项）', /EXPORT_QUALITY\s*:/.test(utilSrc));

// --- 2. template.js 已提升共享常量 MAX_CANVAS_SIDE = 4096 ---
const mCanvas = tplSrc.match(/const\s+MAX_CANVAS_SIDE\s*=\s*(\d+)/);
ok('template.js 定义模块级共享常量 MAX_CANVAS_SIDE', !!mCanvas);
ok('MAX_CANVAS_SIDE 取值为 4096（与 DIM_HARD 同源）', mCanvas && mCanvas[1] === '4096');

// --- 3. 导出路径与预览路径均引用共享常量（消除同源漂移） ---
ok('导出路径 maxSide 引用 MAX_CANVAS_SIDE（非硬编码 4096）', /const\s+maxSide\s*=\s*MAX_CANVAS_SIDE/.test(tplSrc));
ok('预览路径 MAX_PREVIEW_SIDE 引用 MAX_CANVAS_SIDE（非硬编码 4096）', /const\s+MAX_PREVIEW_SIDE\s*=\s*MAX_CANVAS_SIDE/.test(tplSrc));

// --- 4. 跨文件一致性：MAX_CANVAS_SIDE 必须等于 beadEngine.DIM_HARD ---
const mDim = engSrc.match(/const\s+DIM_HARD\s*=\s*(\d+)/);
ok('beadEngine.js 定义 DIM_HARD', !!mDim);
ok('DIM_HARD 取值为 4096', mDim && mDim[1] === '4096');
ok('template.MAX_CANVAS_SIDE(4096) === beadEngine.DIM_HARD(4096) 同源一致',
  mCanvas && mDim && mCanvas[1] === mDim[1]);

// --- 5. 33MB 位图预算仍保留（与 4096 维度上限互补防 OOM） ---
ok('template.js 保留 MAX_EXPORT_BITMAP_BYTES = 33MB 预算',
  /const\s+MAX_EXPORT_BITMAP_BYTES\s*=\s*33\s*\*\s*1024\s*\*\s*1024/.test(tplSrc));

console.log(`\nM3 export_dimension_shared_const: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// 回归测试：L5 闭环 —— calcLabelSpace 对 cols/rows ≤ 0（含负数）的下限守卫。
// 修复前：(cols - 1).toString().length 在 cols=0 时对 -1 取长度（"-1".length=2）、
// cols=-10 时对 -11 取长度（3），不崩溃但语义错误（把空/负网格当成多位数标号）。
// 修复后：入口对 cols/rows 做 Math.max(1, x) 钳制，≤0 一律按 1 列/1 行的最小网格处理，
// 且对正常 cols/rows ≥ 1 调用方输出零变化（导出/渲染共用入口一致性不变）。

const path = require('path');
const fs = require('fs');
const beadEngine = require(path.join(__dirname, '..', 'utils', 'beadEngine.js'));

let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function log(t) { console.log(t); }

const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');

log('=== L5 calcLabelSpace cols/rows ≤ 0 下限守卫 ===');

// —— 静态：源码已对 cols/rows 做 Math.max(1, x) 下限守卫（防止回归回无守卫旧逻辑）——
assert(/Math\.max\(\s*1\s*,\s*cols\s*\)/.test(src),
  '静态：calcLabelSpace 存在 Math.max(1, cols) 下限守卫');
assert(/Math\.max\(\s*1\s*,\s*rows\s*\)/.test(src),
  '静态：calcLabelSpace 存在 Math.max(1, rows) 下限守卫');

// 旧内联公式（无守卫），用于对比「修复前」在 ≤0 时的错误行为
function oldInline(cols, rows, cellSize, showLabels) {
  const maxColDigits = (cols - 1).toString().length;
  const maxRowDigits = (rows - 1).toString().length;
  const digitWidth = Math.max(8, cellSize >= 10 ? 12 : 9);
  const labelSpaceX = showLabels ? Math.max(30, maxColDigits * digitWidth + 8) : 0;
  const labelSpaceY = showLabels ? Math.max(30, maxRowDigits * digitWidth + 8) : 0;
  return Math.max(labelSpaceX, labelSpaceY);
}

// ============ 正常输入（cols/rows ≥ 1）行为零变化（导出/渲染共用入口一致性）============
let mismatch = 0;
for (const cols of [1, 5, 9, 10, 11, 50, 99, 100, 120]) {
  for (const rows of [1, 5, 9, 10, 11, 50, 99, 100, 120]) {
    for (const cellSize of [3, 5, 6, 8, 9, 10, 12, 20]) {
      for (const showLabels of [false, true]) {
        const a = beadEngine.calcLabelSpace(cols, rows, cellSize, showLabels);
        const b = oldInline(cols, rows, cellSize, showLabels);
        if (a !== b) mismatch++;
      }
    }
  }
}
assert(mismatch === 0,
  '正常输入（cols/rows ≥ 1）计算结果与旧公式逐值一致（共校验 1296 组，偏差 ' + mismatch + ' 组）');

// 具体已知值回归基线（与既有测试注释一致）
assert(beadEngine.calcLabelSpace(20, 20, 10, true) === 32,
  'calcLabelSpace(20,20,10,true) = 32（2 位标号，与既有断言一致）');
assert(beadEngine.calcLabelSpace(120, 120, 10, true) === 44,
  'calcLabelSpace(120,120,10,true) = 44（3 位标号，与既有断言一致）');
assert(beadEngine.calcLabelSpace(5, 5, 6, false) === 0,
  'calcLabelSpace(5,5,6,false) = 0（不显示标号则预留为 0）');

// ============ 边界：cols/rows ≤ 0（含负数）被钳制为 1，语义正确 ============
// cols=0 → 钳制为 1 列：labelSpaceX = max(30, (1-1)→"0".length=1 *12+8=20) = 30（而非旧逻辑 32）
const c0 = beadEngine.calcLabelSpace(0, 5, 10, true);
log('   calcLabelSpace(0,5,10,true) = ' + c0 + '  期望 30（cols=0 钳制为 1 列）');
assert(c0 === 30,
  'cols=0 被钳制为 1 列 → labelSpace=30，而非旧逻辑对 -1 取长度得到的 32');
assert(c0 !== oldInline(0, 5, 10, true),
  'cols=0 不再与「无守卫旧公式」结果相同（旧逻辑 32，已修复为 30）');

// cols=0 等价于 cols=1（钳制后语义一致）
assert(beadEngine.calcLabelSpace(0, 5, 10, true) === beadEngine.calcLabelSpace(1, 5, 10, true),
  'cols=0 与 cols=1 计算结果一致（钳制等价）');

// 负数 cols=-10 → 钳制为 1 列
const cNeg = beadEngine.calcLabelSpace(-10, 5, 10, true);
log('   calcLabelSpace(-10,5,10,true) = ' + cNeg + '  期望 30（负数钳制为 1 列）');
assert(cNeg === 30, 'cols=-10 负数被钳制为 1 列 → labelSpace=30');
assert(cNeg === beadEngine.calcLabelSpace(1, 5, 10, true),
  'cols=-10 与 cols=1 计算结果一致（钳制等价）');

// rows=0 / rows 负数 → 钳制为 1 行
assert(beadEngine.calcLabelSpace(5, 0, 10, true) === beadEngine.calcLabelSpace(5, 1, 10, true),
  'rows=0 被钳制为 1 行，与 rows=1 等价');
assert(beadEngine.calcLabelSpace(5, -3, 10, true) === beadEngine.calcLabelSpace(5, 1, 10, true),
  'rows=-3 负数被钳制为 1 行，与 rows=1 等价');

// cols 与 rows 同时 ≤ 0
assert(beadEngine.calcLabelSpace(0, 0, 10, true) === 30,
  'calcLabelSpace(0,0,10,true) = 30（双零钳制为 1×1 最小网格）');

// showLabels=false 时，无论 cols/rows 取值如何，守卫不应影响「返回 0」语义
assert(beadEngine.calcLabelSpace(0, -5, 10, false) === 0,
  'calcLabelSpace(0,-5,10,false) = 0（不显示标号，守卫不影响返回 0）');

log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
} else {
  log('L5 calcLabelSpace cols/rows ≤ 0 下限守卫：全部通过 ✅');
  process.exit(0);
}

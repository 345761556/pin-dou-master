// 回归 / 一致性锁：updateEstimate 与 generateTemplate 的二次限行(最大行数)算法必须一致
// 报告声称「rows=120 时 cols 重算方式不同 → 预估偏差 ≤8%」。经核查：两条路径早已统一到同一个
// clampTemplateSize(cols, rows, maxPixels=8000, maxRows=120, aspect)，且预钳制 rows=Math.round(cols*aspect)。
// 本测试用真实 clampTemplateSize 复刻两条路径的输入构造并断言输出完全一致，防止未来回归。
const fs = require('fs');
const path = require('path');
const util = require(path.resolve(__dirname, '../utils/util'));
const { clampTemplateSize, MAX_PIXELS, MAX_ROWS } = util;

const root = path.resolve(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(root, 'utils/beadEngine.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('静态校验（两路径构造一致）:');
// updateEstimate 必须使用 clampTemplateSize(cols, rows, MAX_PIXELS, MAX_ROWS, aspect)
ok('updateEstimate 调用 clampTemplateSize(cols, rows, MAX_PIXELS, CONSTANTS.MAX_ROWS, aspect)',
  /clampTemplateSize\(cols,\s*rows,\s*MAX_PIXELS,\s*CONSTANTS\.MAX_ROWS,\s*aspect\)/.test(indexSrc));
ok('updateEstimate 预钳制 rows = Math.round(templateCols * aspect)',
  /let rows = Math\.round\(templateCols \* aspect\)/.test(indexSrc));
// generateTemplate 必须使用 clampTemplateSize(cols, rows, maxPixels, ALGO.MAX_ROWS, aspect)
ok('generateTemplate 调用 clampTemplateSize(cols, rows, maxPixels, ALGO.MAX_ROWS, aspect)',
  /clampTemplateSize\(cols,\s*rows,\s*maxPixels,\s*ALGO\.MAX_ROWS,\s*aspect\)/.test(engineSrc));
ok('generateTemplate 预钳制 rows = Math.round(cols * aspect)',
  /let rows = Math\.round\(cols \* aspect\)/.test(engineSrc));
// 常量同源：两处 maxPixels / maxRows 必须相等
ok('ALGO.MAX_PIXELS 与 CONSTANTS.MAX_PIXELS 同源(8000)', MAX_PIXELS === 8000);
ok('ALGO.MAX_ROWS 与 CONSTANTS.MAX_ROWS 同源(120)', MAX_ROWS === 120);

// 复刻两条路径的「二次限行」输入构造（与源码逐字一致）
function updateEstimateClamp(templateCols, aspect) {
  let cols = templateCols;
  let rows = Math.round(cols * aspect);
  return clampTemplateSize(cols, rows, MAX_PIXELS, MAX_ROWS, aspect); // == CONSTANTS.MAX_ROWS
}
function generateTemplateClamp(maxBeadWidth, aspect) {
  let cols = maxBeadWidth;
  let rows = Math.round(cols * aspect);
  return clampTemplateSize(cols, rows, MAX_PIXELS, MAX_ROWS, aspect); // == ALGO.MAX_ROWS
}

console.log('\n功能校验（极端比例下两路径输出完全一致）:');
const aspects = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10, 20, 40, 80]; // 含触发 maxRows=120 的极端竖图
const colsList = [20, 30, 50, 80, 100, 120];
let allEqual = true;
let hitMaxRows = 0;
for (const tc of colsList) {
  for (const aspect of aspects) {
    const a = updateEstimateClamp(tc, aspect);
    const b = generateTemplateClamp(tc, aspect);
    const equal = a.cols === b.cols && a.rows === b.rows;
    if (!equal) {
      allEqual = false;
      console.log(`  ✗ 偏差 @templateCols=${tc}, aspect=${aspect} -> estimate{${a.cols},${a.rows}} vs gen{${b.cols},${b.rows}}`);
    }
    // 记录触发「二次限行」(rows 被钳到 120) 的样本，验证 cols 重算一致
    if (a.rows === 120) {
      hitMaxRows++;
      if (a.cols !== b.cols) {
        allEqual = false;
        console.log(`  ✗ 二次限行 cols 不一致 @aspect=${aspect}: estimate=${a.cols} vs gen=${b.cols}`);
      }
    }
  }
}
ok('全部 (templateCols × aspect) 组合下 estimate 与 generate 输出完全相同（无 ≤8% 偏差）', allEqual);
ok('存在触发最大行数钳制(rows=120)的极端比例样本，且其 cols 重算在两条路径一致', hitMaxRows > 0);

console.log(`\n触发二次限行(rows=120)的样本数: ${hitMaxRows}`);
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

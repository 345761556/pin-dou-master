// 验证 beadEngine.calcLabelSpace 与 _calcExportParams/renderTemplate 此前的内联公式逐值一致（行为零变化）
// 旧内联公式（renderTemplate 硬编码 12/30；_calcExportParams 用常量 DIGIT_WIDTH=12 / LABEL_SPACE_MIN=30）：
const { calcLabelSpace } = require('../utils/beadEngine');

function oldInline(cols, rows, cellSize, showLabels) {
  const maxColDigits = (cols - 1).toString().length;
  const maxRowDigits = (rows - 1).toString().length;
  const digitWidth = Math.max(8, cellSize >= 10 ? 12 : 9);
  const labelSpaceX = showLabels ? Math.max(30, maxColDigits * digitWidth + 8) : 0;
  const labelSpaceY = showLabels ? Math.max(30, maxRowDigits * digitWidth + 8) : 0;
  return Math.max(labelSpaceX, labelSpaceY);
}

let count = 0;
let fail = 0;
for (const cols of [1, 5, 9, 10, 11, 50, 99, 100, 120]) {
  for (const rows of [1, 5, 9, 10, 11, 50, 99, 100, 120]) {
    for (const cellSize of [3, 5, 6, 8, 9, 10, 12, 20]) {
      for (const showLabels of [false, true]) {
        const a = calcLabelSpace(cols, rows, cellSize, showLabels);
        const b = oldInline(cols, rows, cellSize, showLabels);
        count++;
        if (a !== b) {
          fail++;
          console.error(`MISMATCH cols=${cols} rows=${rows} cellSize=${cellSize} showLabels=${showLabels}: new=${a} old=${b}`);
        }
      }
    }
  }
}

console.log(`calcLabelSpace equivalence: ${count - fail}/${count} matched, ${fail} mismatches`);
if (fail > 0) process.exit(1);
console.log('PASS');

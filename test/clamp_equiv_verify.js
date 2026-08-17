// 回归验证：新 clampTemplateSize 必须与 generateTemplate 旧内联钳制在「真实调用路径」逐像素一致
// 真实路径 = maxRows=ALGO.MAX_ROWS(120) 且 aspect>0。
const { clampTemplateSize } = require('../utils/util');

// 复刻 generateTemplate 改动前的旧内联逻辑（像素钳制 + 行数钳制 + 复查）
function oldInline(cols, rows, maxPixels, maxRows, aspect, maxBeadWidth) {
  if (cols < 1) cols = 1;
  if (rows < 1) rows = 1;
  if (cols * rows > maxPixels) {
    const ratio = rows / cols;
    if (ratio > 0) {
      cols = Math.max(1, Math.floor(Math.sqrt(maxPixels / ratio)));
      rows = Math.max(1, Math.floor(cols * ratio));
    } else {
      rows = 1;
      cols = Math.min(maxBeadWidth, Math.floor(maxPixels));
    }
  }
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.round(rows / aspect);
    if (cols < 1) cols = 1;
    if (cols * rows > maxPixels) {
      const ratio = rows / cols;
      if (ratio > 0) {
        cols = Math.max(1, Math.floor(Math.sqrt(maxPixels / ratio)));
      } else {
        cols = Math.min(maxBeadWidth, Math.floor(maxPixels));
      }
    }
  }
  cols = Math.max(1, cols);
  rows = Math.max(1, rows);
  return { cols, rows };
}

const starts = [1, 5, 10, 20, 40, 60, 80, 100, 120, 200];
const aspects = [0.1, 0.25, 0.5, 0.75, 1, 1.3333, 2, 4, 10];
const maxPixelsList = [6000, 8000, 10000];
const maxRows = 120;

let total = 0, fail = 0;
// 1) 真实调用路径：新函数 vs 旧内联，应完全一致
for (const mp of maxPixelsList) {
  for (const sc of starts) {
    for (const a of aspects) {
      const rows0 = Math.round(sc * a);
      const old = oldInline(sc, rows0, mp, maxRows, a, sc);
      const neu = clampTemplateSize(sc, rows0, mp, maxRows, a);
      total++;
      if (old.cols !== neu.cols || old.rows !== neu.rows) {
        fail++;
        console.log(`MISMATCH mp=${mp} startCols=${sc} aspect=${a}: old=${old.cols}x${old.rows} new=${neu.cols}x${neu.rows}`);
      }
    }
  }
}

// 2) maxRows<=0 应为「不限制行数」（向后兼容哨兵值），且新函数不触发旧内联在 maxRows=0 时的误钳 bug
const noLimit = clampTemplateSize(200, 200, 8000, 0, 1);
total++;
if (!(noLimit.cols === 89 && noLimit.rows === 89)) {
  fail++;
  console.log('maxRows=0 应仅做像素钳制(89x89)，实际', noLimit);
}

// 3) 默认签名（仅传 cols,rows）应保持旧「仅像素钳制」行为
const def = clampTemplateSize(200, 200, 8000);
total++;
if (!(def.cols === 89 && def.rows === 89)) {
  fail++;
  console.log('默认签名应像素钳制(89x89)，实际', def);
}

console.log(`\n总数 ${total}，不一致 ${fail}，${fail === 0 ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(fail === 0 ? 0 : 1);

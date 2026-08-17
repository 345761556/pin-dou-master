/**
 * clampTemplateSize 复查分支数学正确性回归测试（BUG：复查只重算 cols 不动 rows）
 *
 * 背景：util.js 步骤 2「最大行数钳制」把 rows 钳为 maxRows 后，若 aspect>0 则
 *       cols = round(rows/aspect)；随后复查像素上限（旧实现）用 sqrt 公式只重算 cols，
 *       rows 保持 maxRows 不动 → cols*rows 可能仍 > maxPixels。
 *       反例 (100,200,8000,120,1.0) 旧实现输出 89×120=10680 > 8000（超限 33%）。
 *
 * 修复：复查分支 rows 已被 maxRows 固定，只能缩 cols，正确公式为
 *       cols = Math.max(1, Math.floor(maxPixels / rows))；
 *       极端退化（maxPixels < rows，cols=1 仍超限）时进一步缩 rows，保证不变式始终成立。
 *
 * 不变式（修复目标）：返回的 cols*rows ≤ maxPixels 且 rows ≤ maxRows（当 maxRows>0）。
 *
 * 注：遍历网格限定「现实域」（maxRows>0 时 maxPixels ≥ maxRows）；
 *     步骤 1 在 maxPixels 极小且输入比例极端时（如 (1,50,4) → ratio=50，
 *     sqrt(4/50)<1 被 Math.max(1,...) 抬到 1）存在既有下限限制，与本次复查分支无关。
 */
const assert = require('assert');
const path = require('path');
const { clampTemplateSize } = require(path.resolve(__dirname, '../utils/util'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.error('  FAIL', name, '->', e.message); fail++; }
}

// 1) 用户反例：修复前 89×120=10680 > 8000；修复后应为 66×120=7920
check('反例 (100,200,8000,120,1.0) → 乘积 ≤ 8000 且 rows ≤ 120', () => {
  const r = clampTemplateSize(100, 200, 8000, 120, 1.0);
  assert.ok(r.cols * r.rows <= 8000, `乘积 ${r.cols}x${r.rows}=${r.cols * r.rows} 应 ≤ 8000`);
  assert.ok(r.rows <= 120, `rows=${r.rows} 应 ≤ 120`);
  assert.strictEqual(r.cols, 66, `cols 应为 floor(8000/120)=66，得到 ${r.cols}`);
  assert.strictEqual(r.rows, 120, `rows 应保持 maxRows=120，得到 ${r.rows}`);
});

// 2) 复查触发路径：aspect 与输入比例不一致（口径不一致才触发复查）→ 只缩 cols，不放大 cols
check('触发复查 (100,130,20000,120,0.5) → 166×120=19920 ≤ 20000', () => {
  const r = clampTemplateSize(100, 130, 20000, 120, 0.5);
  assert.strictEqual(r.rows, 120, 'rows 应保持 120');
  assert.strictEqual(r.cols, 166, 'cols 应为 floor(20000/120)=166');
  assert.ok(r.cols * r.rows <= 20000, `乘积 ${r.cols * r.rows} 应 ≤ 20000`);
});

// 3) 不变式遍历：现实域网格（maxRows>0 时 maxPixels ≥ maxRows）
//    已知范围外：步骤 1 在 maxPixels 小于输入行列较大值时，floor 后的 Math.max(1,...)
//    会把 0 抬回 1，乘积可能仍超限（如 (20,1,4)：sqrt 联动算出 rows=floor(0.4)=0 → 抬回 1，
//    8×1=8>4；(1,50,4)：cols 抬回 1 → 1×50=50>4）。这是步骤 1 既有下限限制，
//    本次修复不涉及步骤 1，故遍历跳过该域（mp < max(c,rw)）。
check('遍历网格：cols*rows ≤ maxPixels 且 rows ≤ maxRows（现实域）', () => {
  const colsList = [1, 20, 50, 100, 200, 500];
  const rowsList = [1, 50, 100, 200, 400, 1000];
  const maxPixelsList = [4, 10, 100, 800, 8000, 20000];
  const maxRowsList = [0, 1, 5, 12, 60, 120, 500];
  const aspects = [0, 0.25, 0.5, 1, 2, 4, 10];
  let total = 0, skipped = 0;
  for (const c of colsList) {
    for (const rw of rowsList) {
      for (const mp of maxPixelsList) {
        if (mp < Math.max(c, rw)) { skipped++; continue; } // 步骤 1 已知下限域，跳过
        for (const mr of maxRowsList) {
          if (mr > 0 && mp < mr) continue; // 现实域限定
          for (const a of aspects) {
            const o = clampTemplateSize(c, rw, mp, mr, a);
            total++;
            assert.ok(o.cols >= 1 && o.rows >= 1, `cols/rows 应为正整数: ${JSON.stringify(o)}`);
            assert.ok(o.cols * o.rows <= mp,
              `违例 (${c},${rw},${mp},${mr},${a}) -> ${o.cols}x${o.rows}=${o.cols * o.rows} > ${mp}`);
            if (mr > 0) {
              assert.ok(o.rows <= mr,
                `rows 违例 (${c},${rw},${mp},${mr},${a}) -> rows=${o.rows} > ${mr}`);
            }
          }
        }
      }
    }
  }
  console.log(`    遍历样本数: ${total}（跳过步骤1已知下限域 ${skipped} 组）`);
});

// 4) 正常路径不回归：不触发复查时不改变输出
check('正常路径 (50,50,8000,0) → 50×50', () => {
  const r = clampTemplateSize(50, 50, 8000, 0);
  assert.deepStrictEqual(r, { cols: 50, rows: 50 });
});

check('默认签名 (200,200,8000) → 89×89（仅像素钳制，不回归）', () => {
  const r = clampTemplateSize(200, 200, 8000);
  assert.deepStrictEqual(r, { cols: 89, rows: 89 });
});

// 5) 各类抽查组合（证明不变式，覆盖 aspect=0 / aspect>1 / maxRows=1 / maxPixels 极小 / 竖图）
check('抽查组合：不变式成立（aspect=0、竖图、maxRows=1、maxPixels 极小等）', () => {
  const cases = [
    [100, 200, 8000, 120, 0],       // aspect=0 → cols=1, rows=120
    [50, 4000, 8000, 120, 80],      // 极端竖图 aspect>1
    [100, 200, 8000, 1, 1.0],       // maxRows=1
    [200, 300, 10, 12, 2],          // maxPixels 极小
    [20, 800, 8000, 120, 40],       // cols<rows 竖图
    [50, 28, 8000, 120, 0.5625],    // 横图 16:9 不触发
    [200, 300, 5, 120, 2]           // 退化域：maxPixels<maxRows（被步骤1提前压到1×1，安全网见下方专项）
  ];
  for (const [c, rw, mp, mr, a] of cases) {
    const o = clampTemplateSize(c, rw, mp, mr, a);
    assert.ok(o.cols >= 1 && o.rows >= 1, `正整数违例: ${JSON.stringify(o)}`);
    assert.ok(o.cols * o.rows <= mp,
      `违例 (${c},${rw},${mp},${mr},${a}) -> ${o.cols}x${o.rows}=${o.cols * o.rows} > ${mp}`);
    assert.ok(o.rows <= mr, `rows 违例 (${c},${rw},${mp},${mr},${a}) -> rows=${o.rows} > ${mr}`);
  }
  // 退化域专项：maxPixels(5) < maxRows(120) 时，安全网必须把 rows 缩到 5 以下
  const deg = clampTemplateSize(200, 300, 5, 120, 2);
  assert.ok(deg.cols * deg.rows <= 5, `退化域乘积 ${deg.cols * deg.rows} 应 ≤ 5`);
  assert.ok(deg.rows <= 120, `退化域 rows=${deg.rows} 应 ≤ 120`);
  console.log(`    退化域 (200,300,5,120,2) -> ${deg.cols}x${deg.rows}=${deg.cols * deg.rows}`);
});

// 6) 退化域安全网专项：真正触发「缩 rows」安全网分支。
//    注意 (200,300,5,120,2) 会被步骤1提前压到 1×1，未走到安全网；
//    (1,300,5,120,2) 步骤2 rows=120、cols=round(120/2)=60 → 复查缩至 1 仍 1×120>5
//    → 安全网 rows=floor(maxPixels/cols)=floor(5/1)=5，这才是安全网真实路径。
check('安全网专项 (1,300,5,120,2) → 1×5（真正触发缩 rows 分支）', () => {
  const r = clampTemplateSize(1, 300, 5, 120, 2);
  assert.strictEqual(r.cols, 1, `cols 应为 1，得到 ${r.cols}`);
  assert.strictEqual(r.rows, 5, `rows 应为 floor(5/1)=5，得到 ${r.rows}`);
  assert.ok(r.cols * r.rows <= 5, `乘积 ${r.cols * r.rows} 应 ≤ 5`);
  assert.ok(r.rows <= 120, `rows=${r.rows} 应 ≤ 120`);
  // aspect=0 变体同样走安全网（步骤2 cols=1，复查 1×120>5 → 缩 rows）
  const r0 = clampTemplateSize(1, 300, 5, 120, 0);
  assert.strictEqual(r0.rows, 5, `aspect=0 时 rows 应为 5，得到 ${r0.rows}`);
  assert.ok(r0.cols * r0.rows <= 5, `aspect=0 乘积 ${r0.cols * r0.rows} 应 ≤ 5`);
  console.log(`    安全网 (1,300,5,120,2) -> ${r.cols}x${r.rows}=${r.cols * r.rows}`);
});

console.log(`\nclamp 复查数学测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// 回归测试：rleDecode 必须钳制异常巨大的 count，防止长循环卡死 / 内存暴涨
// 对应 BUG-19（用户报告 "rleDecode 无 count 上限"）
const path = require('path');
const beadEngine = require(path.join(__dirname, '../utils/beadEngine.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 1) 超大 count（远超网格容量）必须被忽略，且解码不能卡死（毫秒级返回）
const t0 = Date.now();
const huge = beadEngine.rleDecode('C01:999999999', 3, 3);
const dt = Date.now() - t0;
ok('超大 count 被忽略（返回全空位 3x3）', huge.length === 3 && huge[0].length === 3 && huge[0][0] === null);
ok('超大 count 未卡死（<100ms 返回）', dt < 100);

// 2) count 恰好等于网格总格数（合法上界）应正常填充
const exact = beadEngine.rleDecode('C01:9', 3, 3);
ok('count == cols*rows 合法，全部填充 C01', exact.length === 3 && exact[2][2] === 'C01' && exact[0][0] === 'C01');

// 3) count 超过网格总格数 +1 必须被拒绝（防止越界堆积）
const over = beadEngine.rleDecode('C01:10', 3, 3);
ok('count > cols*rows 被拒绝（返回全空位）', over[0][0] === null);

// 4) 空位令牌极大 count 同样被钳制（null 分支也不越界）
const nullHuge = beadEngine.rleDecode('__E__:999999999', 5, 5);
ok('空位令牌超大 count 被忽略（5x5 全空位）', nullHuge.length === 5 && nullHuge[4][4] === null);

// 5) 正常多段数据行为不变（cols=5, rows=1 -> 单行 5 列）
const normal = beadEngine.rleDecode('R01:2;G01:2;__E__:1', 5, 1);
ok('正常多段解码不变（R01,R01,G01,G01,null）',
  normal[0][0] === 'R01' && normal[0][1] === 'R01' &&
  normal[0][2] === 'G01' && normal[0][3] === 'G01' && normal[0][4] === null);

// 6) 大网格下"合法极大但有限"的 run 也要快速完成（证明循环有界）
const bigT0 = Date.now();
const big = beadEngine.rleDecode('C01:14400', 120, 120);
const bigDt = Date.now() - bigT0;
ok('120x120 满载 run 快速完成（<200ms）', bigDt < 200 && big[119][119] === 'C01');

// 7) 累计总长上限：多段各自"合法"但累计远超网格 → 仅填充到 maxCells，不膨胀（M2）
const multi = beadEngine.rleDecode('A:14400;A:14400;A:14400', 120, 120);
let multiCount = 0;
multi.forEach(row => row.forEach(c => { if (c !== null) multiCount++; }));
ok('多段累计被 maxCells(14400) 上限截断（填充数=14400）', multiCount === 14400);

// 8) 脏维度（cols/rows 被篡改为极大值）不 OOM：维度/总格数被硬上限钳制（M2）
const tHuge0 = Date.now();
const poisoned = beadEngine.rleDecode('A:100', 1000000000, 1000000000);
const tHugeDt = Date.now() - tHuge0;
ok('脏维度被钳制（矩阵规模 ≤ 硬上限，未崩溃）', poisoned.length <= 4096 && poisoned[0].length <= 4096);
ok('脏维度解码快速完成（<100ms）', tHugeDt < 100);

// 9) 复现原报告 28.8M 膨胀场景：16KB 2000 段 A:14400 → 填充数钳制为 14400（M2）
const many = Array.from({ length: 2000 }, () => 'A:14400').join(';');
const tRep0 = Date.now();
const rep = beadEngine.rleDecode(many, 120, 120);
const tRepDt = Date.now() - tRep0;
let repCount = 0;
rep.forEach(row => row.forEach(c => { if (c !== null) repCount++; }));
ok('复现报告膨胀场景：填充数被钳制为 14400（非 2880 万）', repCount === 14400);
ok('复现场景快速完成（<200ms，未 OOM）', tRepDt < 200);

console.log(`\nrle_decode_count_cap: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// 回归测试：L1 闭环 —— rleDecode 对空 colorId（:5 形态 chunk）必须归一为空位 null，
// 而非将空串色号填进矩阵（污染材料统计 + 渲染端 colorMap[''] 查不到被静默跳过）。
// 同时必须保持矩阵对齐：空 colorId 代表 count 个空位，不得字面跳过整个 chunk 导致后续错位。

const path = require('path');
const fs = require('fs');

// beadEngine 通过相对路径 require 其它模块；这里用绝对路径加载
const beadEngine = require(path.join(__dirname, '..', 'utils', 'beadEngine.js'));

let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function ok(msg, cond) { assert(cond, msg); }
function log(t) { console.log(t); }

// 读取源码做静态断言（防止回归：未来有人把空串判定删掉）
const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');

log('=== L1 rleDecode 空 colorId 防御 ===');

// 静态：源码明确对空 colorId 做 null 归一
ok('静态：rleDecode 对空 colorId（value===\'\'）做 null 归一',
  /if\s*\(\s*value\s*===\s*''\s*\)\s*value\s*=\s*null/.test(src));

// 动态：':5' 表示 5 个空位（保持矩阵对齐），A01 紧随其后正确填充
// 矩阵声明 cols=8, rows=1：前 5 格应为 null，第 6-8 格为 A01
const dec = beadEngine.rleDecode(':5;A01:3', 8, 1);
ok('解码返回 1 行 8 列', Array.isArray(dec) && dec.length === 1 && dec[0].length === 8);

// 前 5 格必须是 null（空位），不能是空串 ''
let firstFiveNull = true;
for (let c = 0; c < 5; c++) {
  if (dec[0][c] !== null) { firstFiveNull = false; break; }
}
ok('前 5 格（空 colorId 对应）全部为 null 空位，而非空串 \'\'', firstFiveNull);

// 不得出现任何空串色号
let hasEmptyStr = false;
for (const row of dec) for (const cell of row) if (cell === '') hasEmptyStr = true;
ok('矩阵中不存在任何空串色号', !hasEmptyStr);

// 第 6-8 格（索引 5/6/7）必须是 A01 且对齐正确
ok('第 6 格为 A01（对齐未被破坏）', dec[0][5] === 'A01');
ok('第 7 格为 A01', dec[0][6] === 'A01');
ok('第 8 格为 A01', dec[0][7] === 'A01');

// 对照：正常非空色号链路不受任何影响（A01 数量正确）
const a01Count = dec[0].filter(c => c === 'A01').length;
ok('A01 数量 = 3（空 colorId 占位不挤占真实色号计数）', a01Count === 3);

// 材料统计口径：该矩阵不应把空串计入任何色号
const colorSet = new Set();
for (const row of dec) for (const cell of row) if (cell !== null) colorSet.add(cell);
ok('材料统计色号集合仅含 A01，不含空串', colorSet.size === 1 && colorSet.has('A01'));

// 边界：纯空 colorId 串 ':3;:2'（全空位）应整体还原为空位矩阵，不抛、不污染
const allEmpty = beadEngine.rleDecode(':3;:2', 5, 1);
let allNull = true;
for (const cell of allEmpty[0]) if (cell !== null) { allNull = false; break; }
ok('纯空 colorId 串 :3;:2 解码为全空位矩阵', allNull && allEmpty[0].length === 5);

log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
} else {
  log('L1 rleDecode 空 colorId 防御：全部通过 ✅');
  process.exit(0);
}

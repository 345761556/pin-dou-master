// 回归测试：M5 闭环 —— rleEncode 必须对畸形矩阵（缺失行/列数不等/非法元素）做结构防御，
// 既不裸抛异常中断 saveToHistory 链路，也不产出 undefined/NaN 字面脏 RLE 串并持久化；
// 同时 rleDecode 须把历史上可能已落库的 'undefined'/'NaN' 字面令牌归一成空位。
const fs = require('fs');
const path = require('path');
const beadEngine = require('../utils/beadEngine.js');

let passed = 0;
let failed = 0;
const lines = [];
function log(msg) {
  lines.push(msg);
  try { process.stdout.write(msg + '\n'); } catch (e) {}
}
function assert(condition, msg) {
  if (condition) { passed++; log('  PASS: ' + msg); }
  else { failed++; log('  FAIL: ' + msg); }
}

log('=== M5 rleEncode 畸形矩阵结构防御 ===');
const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');

// —— 静态断言：实现已具备结构防御 —— //
assert(!/const cols = template\[0\]\.length;/.test(engineSrc),
  '静态：rleEncode 不再以「首行列数」作为唯一列数来源（避免长行被截断）');
assert(/typeof cell === 'string'/.test(engineSrc),
  '静态：rleEncode 对元素做类型校验（仅字符串色号/空位合法，其余归一空位）');
assert(/value === 'undefined' \|\| value === 'NaN'/.test(engineSrc),
  '静态：rleDecode 对字面令牌 undefined/NaN 归一成空位');

// —— 1. 规整矩阵 round-trip 行为不变（sanity） —— //
const clean = [['R01', 'G01'], ['B01', 'C01']];
const cleanEnc = beadEngine.rleEncode(clean);
const cleanDec = beadEngine.rleDecode(cleanEnc, 2, 2);
assert(cleanEnc === 'R01:1;G01:1;B01:1;C01:1',
  '规整矩阵 encode 格式不变: ' + cleanEnc);
assert(JSON.stringify(cleanDec) === JSON.stringify(clean),
  '规整矩阵 decode 还原一致');

// 全空位矩阵
const empties = [[null, null], [null, null]];
assert(beadEngine.rleEncode(empties) === '__E__:4',
  '全空位矩阵 encode 为 __E__:4（空位令牌正确）');

// —— 2. 稀疏数组缺失行：不抛异常、产出合法 RLE、decode 无崩溃 —— //
const sparse = [];          // 构造 [row0, <hole>, row2]：index 1 为稀疏空洞
sparse[0] = ['R01', 'G01'];
sparse[2] = ['B01', 'C01'];
let sparseEnc;
let threw = false;
try { sparseEnc = beadEngine.rleEncode(sparse); } catch (e) { threw = true; }
assert(!threw, '稀疏数组（缺失中间行）encode 不抛 TypeError');
assert(typeof sparseEnc === 'string' && sparseEnc.length > 0,
  '稀疏数组 encode 产出合法 RLE 串: ' + sparseEnc);
assert(!/undefined:/.test(sparseEnc),
  '稀疏数组 encode 输出不含 undefined: 字面令牌');
let sparseDec;
let decThrew = false;
try { sparseDec = beadEngine.rleDecode(sparseEnc, 2, 3); } catch (e) { decThrew = true; }
assert(!decThrew, '稀疏数组解码不崩溃');
assert(Array.isArray(sparseDec) && sparseDec.length === 3,
  '稀疏数组解码还原 3 行（缺失行归为空位）');

// —— 3. 列数不等：长行不被截断、输出不含 undefined: —— //
const ragged = [['R01', 'G01', 'B01'], ['C01']]; // row0 宽3，row1 宽1
const raggedEnc = beadEngine.rleEncode(ragged);
assert(!/undefined:/.test(raggedEnc),
  '列数不等矩阵 encode 输出不含 undefined: 字面令牌: ' + raggedEnc);
// row1 的 C01 不应被首行列数(3)截断丢失，编码须保留 C01
assert(/C01:1/.test(raggedEnc),
  '列数不等矩阵：短行真实色号 C01 未被截断丢失（取最大行宽）');
const raggedDec = beadEngine.rleDecode(raggedEnc, 3, 2); // maxWidth=3
assert(raggedDec[1][0] === 'C01',
  '列数不等矩阵：row1 的 C01 在解码后仍在原位');

// —— 4. 非法元素（number/object）：归一空位，不产出垃圾令牌 —— //
const badElems = [['R01', 5], [{}, 'B01']]; // 5 是数字、{} 是对象
const badEnc = beadEngine.rleEncode(badElems);
assert(!/5:/.test(badEnc),
  '数字元素 5 不被编码为字面令牌 5:: ' + badEnc);
assert(!/\[object Object\]:/.test(badEnc),
  '对象元素不被编码为 [object Object]:: ' + badEnc);
assert(/__E__/.test(badEnc),
  '数字/对象非法元素被归一为空位令牌 __E__');
const badDec = beadEngine.rleDecode(badEnc, 2, 2);
assert(badDec[0][1] === null && badDec[1][0] === null,
  '非法元素解码后归空位(null)，而非字面垃圾色号');

// —— 5. 解码防御：历史脏令牌 undefined/NaN 归空位 —— //
const undefDec = beadEngine.rleDecode('undefined:3', 3, 1);
assert(undefDec[0][0] === null && undefDec[0][1] === null && undefDec[0][2] === null,
  "rleDecode('undefined:3') 全部归空位(null)，非字面 'undefined' 色号");
const nanDec = beadEngine.rleDecode('NaN:2', 2, 1);
assert(nanDec[0][0] === null && nanDec[0][1] === null,
  "rleDecode('NaN:2') 全部归空位(null)");

// —— 6. 边界：非数组/空矩阵安全返回 '' —— //
assert(beadEngine.rleEncode(null) === '',
  'rleEncode(null) 安全返回空串');
assert(beadEngine.rleEncode([]) === '',
  'rleEncode([]) 安全返回空串');
assert(beadEngine.rleEncode([[]]) === '',
  'rleEncode([[]])（首行为空数组）安全返回空串');

log('');
log('=== 结果: ' + passed + ' passed, ' + failed + ' failed ===');
if (failed > 0) {
  process.exit(1);
}

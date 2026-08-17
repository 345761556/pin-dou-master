// 回归测试：RLE 解码入口对非字符串 templateRLE 的防御（修复 gallery 点作品误报"数据异常"）
// 现象：旧/脏历史记录中 templateRLE 可能为数组、对象、数字、null 等非字符串，
//       rleDecode 直接 encoded.split(';') 会抛 TypeError，被 gallery.viewTemplate catch
//       后 toast "数据异常，无法查看"。
// 修复：rleDecode 在 split 前显式判定 typeof encoded === 'string'，非字符串按空处理返回空矩阵。

const beadEngine = require('../utils/beadEngine');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('rleDecode 非字符串入口防御回归:');

const badInputs = [null, undefined, 12345, true, false, ['C01:1'], { foo: 'bar' }, { split: () => 'x' }];
for (const input of badInputs) {
  let threw = false;
  let result = null;
  try {
    result = beadEngine.rleDecode(input, 5, 5);
  } catch (e) {
    threw = true;
  }
  const typeName = input === null ? 'null' : typeof input;
  ok(`输入 ${typeName} 不抛 TypeError`, !threw);
  ok(`输入 ${typeName} 返回 5x5 空矩阵`, Array.isArray(result) && result.length === 5 && result.every(row => Array.isArray(row) && row.length === 5 && row.every(cell => cell === null)));
}

// 正例：合法 RLE 仍然正常解码
const encoded = 'C01:3;__E__:2'; // 3 格 C01 + 2 格空位
const good = beadEngine.rleDecode(encoded, 5, 1);
ok('合法字符串 RLE 仍正确解码', Array.isArray(good) && good[0][0] === 'C01' && good[0][1] === 'C01' && good[0][2] === 'C01' && good[0][3] === null && good[0][4] === null);

console.log(`\nrleDecode 非字符串入口防御回归: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// [10] 回归：clampDisplayNumber 必须对 max 自身做校验，
// 防止 max=NaN / max<0 时返回未钳制原始值或负数上限。
// 直接 require 真实 util.js（不内联复刻），确保源码逻辑被锁死。

const { clampDisplayNumber } = require('../utils/util');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('[10] clampDisplayNumber 的 max 参数校验:');

// ---- max 非法：统一归零（与 value 非法同口径）----
ok('max=NaN 时返回 0（不返回未钳制的原始值）', clampDisplayNumber(12345, NaN) === 0);
ok('max=Infinity 时返回 0（!isFinite 守卫）', clampDisplayNumber(12345, Infinity) === 0);
ok('max=-5（负数）时返回 0（不返回负数上限）', clampDisplayNumber(3, -5) === 0);
ok('max="abc"（非数字字符串）时返回 0', clampDisplayNumber(3, 'abc') === 0);
ok('max=null 时返回 0', clampDisplayNumber(3, null) === 0);
ok('max=undefined 时返回 0', clampDisplayNumber(3, undefined) === 0);
// max 非法时，即便 value 合法也归零（钳制无意义上限，回落到下界）
ok('max 非法 + value 合法 → 0（而非原值）', clampDisplayNumber(10, NaN) === 0);

// ---- 正常行为不受 max 校验影响（合法 max 路径完全保持旧语义）----
ok('value 合法且 ≤ max → 原值', clampDisplayNumber(50, 20000) === 50);
ok('value 合法且 > max → 截断为 max', clampDisplayNumber(99999, 20000) === 20000);
ok('value=Infinity → 0（!isFinite 守卫，与旧行为一致）', clampDisplayNumber(Infinity, 20000) === 0);
ok('value=-1 → 0（负数归零，与旧行为一致）', clampDisplayNumber(-1, 20000) === 0);
ok('value=NaN → 0（与旧行为一致）', clampDisplayNumber(NaN, 20000) === 0);
// max=0 是合法下限：正数 value 应被钳到 0，且不返回负数
ok('max=0 且 value=5 → 0（不下溢为负数）', clampDisplayNumber(5, 0) === 0);
ok('max=0 且 value=0 → 0', clampDisplayNumber(0, 0) === 0);
// 字符串数字也应正确解析
ok('value="99999" 字符串数字 > max → 截断为 20000', clampDisplayNumber('99999', 20000) === 20000);
ok('max="100" 字符串数字 → 正确生效', clampDisplayNumber(50, '100') === 50);

console.log(`\n[10] 结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

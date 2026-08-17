// 回归测试：M2 闭环 —— formatNumber 对 Infinity / -Infinity 的拦截
// 修复前：`isNaN(Infinity) === false`，formatNumber(Infinity) 返回 'Infinity' 字符串
// 修复后：`!isFinite(num)` 等价于拦截 NaN / Infinity / -Infinity，口径与 clampDisplayNumber 一致
// 触发路径：generateTemplate 直出路径（index.js:431）的 totalBeads 未经 clamp 就传入 formatNumber；
//           template.js:120 `formatNumber(templateData.totalBeads)` 同理。

const path = require('path');
const fs = require('fs');

const utilPath = path.join(__dirname, '..', 'utils', 'util.js');
const utilSrc = fs.readFileSync(utilPath, 'utf8');

let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function log(t) { console.log(t); }

log('=== M2 formatNumber Infinity / -Infinity 拦截 ===');

// ============ 静态：源码已用 !isFinite 替代 isNaN ============
assert(utilSrc.includes('!isFinite(num)'),
  '静态：formatNumber 使用 `!isFinite(num)` 守卫（非 `isNaN(num)`）');
assert(!/function formatNumber.*\n[ \t]*if\s*\(\s*num\s*==\s*null\s*\|\|\s*isNaN/.test(utilSrc),
  '静态：formatNumber 不再用 `isNaN(num)` 裸守卫');
// 兼容多行写法
assert(!/function formatNumber[\s\S]{0,200}isNaN/.test(utilSrc),
  '静态：formatNumber 内无 `isNaN` 残留（避免仅替换了部分条件）');

// ============ 运行时：Infinity / -Infinity / NaN / null 归 '0' ============
const util = require(utilPath);

assert(util.formatNumber(Infinity) === '0',
  '运行时：formatNumber(Infinity) === "0"（非 "Infinity"）');
assert(util.formatNumber(-Infinity) === '0',
  '运行时：formatNumber(-Infinity) === "0"');
assert(util.formatNumber(NaN) === '0',
  '运行时：formatNumber(NaN) === "0"');
assert(util.formatNumber(null) === '0',
  '运行时：formatNumber(null) === "0"');
assert(util.formatNumber(undefined) === '0',
  '运行时：formatNumber(undefined) === "0"');

// ============ 正常运行时不破坏 ============
assert(util.formatNumber(0) === '0', '运行时：formatNumber(0) === "0"');
assert(util.formatNumber(1) === '1', '运行时：formatNumber(1) === "1"');
assert(util.formatNumber(12) === '12', '运行时：formatNumber(12) === "12"');
assert(util.formatNumber(123) === '123', '运行时：formatNumber(123) === "123"');
assert(util.formatNumber(1234) === '1,234', '运行时：formatNumber(1234) === "1,234"');
assert(util.formatNumber(1234567) === '1,234,567', '运行时：formatNumber(1234567) === "1,234,567"');
assert(util.formatNumber(10000000) === '10,000,000', '运行时：formatNumber(10000000) === "10,000,000"');

// ============ 非整数有限数：toString 后仍加逗号（与原有行为一致）============
assert(util.formatNumber(1234.5) === '1,234.5', '运行时：formatNumber(1234.5) === "1,234.5"');
assert(util.formatNumber(1234567890.12) === '1,234,567,890.12', '运行时：formatNumber(1234567890.12) 保留小数');

// ============ 与 clampDisplayNumber 口径一致 ============
// clampDisplayNumber 用 !isFinite(n)，formatNumber 现在也用 !isFinite(num)
assert(utilSrc.includes('!isFinite(n)'),
  '静态：clampDisplayNumber 同样使用 !isFinite 守卫（两函数口径一致）');

log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
} else {
  log('M2 formatNumber Infinity / -Infinity 拦截：全部通过 ✅');
  process.exit(0);
}

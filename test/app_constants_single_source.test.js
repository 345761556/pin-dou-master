// 验证 [6] 常量统一：app.js 的共享数值常量（MAX_HISTORY / BEAD_SIZE.DEFAULT）
// 现引用 util.js CONSTANTS 单一真源，不再各自硬编码，消除「改一处漏另一处」漂移。
// 同时验证 app.js 加载不触发循环依赖（require util.js 安全）。

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// app.js 顶层调用 App({...})；Node 环境 mock 之
global.App = function () {};

let utilConstants, appConstants, loadErr = null;
try {
  utilConstants = require('../utils/util').CONSTANTS;
  const appMod = require('../app');
  appConstants = appMod.CONSTANTS;
} catch (e) {
  loadErr = e;
}

console.log('\n[6] app.js 常量单一真源:');

ok('app.js 与 util.js 均能正常加载（无循环依赖/无 App 报错）', !loadErr);
if (loadErr) {
  console.log('   加载错误:', loadErr && loadErr.message);
  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

// 1) MAX_HISTORY 与 util.js 同源（引用值一致、数值=50）
ok('CONSTANTS.MAX_HISTORY 引用 util.js 同一数值', appConstants.MAX_HISTORY === utilConstants.MAX_HISTORY);
ok('CONSTANTS.MAX_HISTORY 值仍为 50（行为不变）', appConstants.MAX_HISTORY === 50);

// 2) BEAD_SIZE.DEFAULT 与 util.js DEFAULT_BEAD_SIZE 同源（引用值一致、数值=29）
ok('CONSTANTS.BEAD_SIZE.DEFAULT 引用 util.js DEFAULT_BEAD_SIZE', appConstants.BEAD_SIZE.DEFAULT === utilConstants.DEFAULT_BEAD_SIZE);
ok('CONSTANTS.BEAD_SIZE.DEFAULT 值仍为 29（行为不变）', appConstants.BEAD_SIZE.DEFAULT === 29);

// 3) 表现层常量仍由 app.js 本地定义且值正确（不被迁移削弱）
ok('BEAD_SIZE.MIN 仍为 5', appConstants.BEAD_SIZE.MIN === 5);
ok('BEAD_SIZE.MAX 仍为 50', appConstants.BEAD_SIZE.MAX === 50);
ok('LAYOUT.STATUS_BAR_HEIGHT 仍为 20', appConstants.LAYOUT.STATUS_BAR_HEIGHT === 20);
ok('LAYOUT.NAV_BAR_HEIGHT 仍为 64', appConstants.LAYOUT.NAV_BAR_HEIGHT === 64);
ok('BEAD_TYPE.DEFAULT 仍为 square', appConstants.BEAD_TYPE.DEFAULT === 'square');
ok('DEFAULT_PALETTE 仍为 artkal_c', appConstants.DEFAULT_PALETTE === 'artkal_c');

// 4) 语义断言：app.js 不再「独立硬编码」50/29（源码中该两值不再以字面量形式出现于 CONSTANTS 块）
const fs = require('fs');
const path = require('path');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
// 在 CONSTANTS = Object.freeze({ ... }); 块内，DEFAULT 与 MAX_HISTORY 不应再是裸字面量 29 / 50
const constBlock = appSrc.slice(appSrc.indexOf('const CONSTANTS = Object.freeze({'), appSrc.indexOf('});', appSrc.indexOf('const CONSTANTS = Object.freeze({')));
ok('app.js CONSTANTS 块内 BEAD_SIZE.DEFAULT 不再硬编码 29（改为引用 UTIL_CONSTANTS）',
  /DEFAULT:\s*UTIL_CONSTANTS\.DEFAULT_BEAD_SIZE/.test(constBlock));
ok('app.js CONSTANTS 块内 MAX_HISTORY 不再硬编码 50（改为引用 UTIL_CONSTANTS）',
  /MAX_HISTORY:\s*UTIL_CONSTANTS\.MAX_HISTORY/.test(constBlock));

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

// test/app_prefs_defaults_single_source.test.js
// 审计项 #9：app.js 的 BEAD_PREFS_DEFAULTS.colorCount 曾硬编码裸数字 30，
// 而 util.js CONSTANTS.DEFAULT_COLOR_COUNT 才是单一真源（项目「改一处不漏另一处」原则）。
// 已改为引用 UTIL_CONSTANTS.DEFAULT_COLOR_COUNT。本测试锁定该引用不被改回裸数字。
const path = require('path');
const fs = require('fs');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'util.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('app.js 偏好默认值单一真源校验：');

// 1. util.js 仍定义 DEFAULT_COLOR_COUNT = 30（单一真源）
ok('util.js CONSTANTS 定义 DEFAULT_COLOR_COUNT = 30',
  /DEFAULT_COLOR_COUNT:\s*30/.test(utilSrc));

// 2. app.js BEAD_PREFS_DEFAULTS 引用 UTIL_CONSTANTS.DEFAULT_COLOR_COUNT
ok('app.js 引用 UTIL_CONSTANTS.DEFAULT_COLOR_COUNT',
  /colorCount:\s*UTIL_CONSTANTS\.DEFAULT_COLOR_COUNT/.test(appSrc));

// 3. app.js 不再残留裸数字 colorCount: 30
ok('app.js 无裸数字 colorCount: 30（防止改回硬编码）',
  !/colorCount:\s*30\b/.test(appSrc));

// 4. UTIL_CONSTANTS 已在 app.js 顶部导入（引用可行）
ok('app.js 已导入 UTIL_CONSTANTS（require utils/util）',
  /CONSTANTS:\s*UTIL_CONSTANTS/.test(appSrc));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

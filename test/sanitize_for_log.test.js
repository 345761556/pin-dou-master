// 验证 security.sanitizeForLog 对微信本地沙盒路径（含 wx.env.USER_DATA_PATH 真实内容）的脱敏
// 关键回归：USER_DATA_PATH 的真实值是 http://usr/、http://store/、http://cache/ 等，
// 不含 "USER_DATA_PATH" 字面量，旧版正则对其无效，会泄漏设备路径。
const { sanitizeForLog } = require('../utils/security');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name, '=> got', JSON.stringify(actual), 'expect', JSON.stringify(expected)); }
}
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

// 微信沙盒路径（真实 USER_DATA_PATH 内容）—— 报告核心 bug
eq('wxfile tmp', sanitizeForLog('save wxfile://tmp_abc123'), 'save wxfile://***');
eq('wxfile store', sanitizeForLog('path wxfile://store_xyz'), 'path wxfile://***');
eq('http://usr (核心bug)', sanitizeForLog('saved to http://usr/2026/foo.png'), 'saved to http://***');
eq('http://store', sanitizeForLog('http://store/cache/bar.png'), 'http://***');
eq('http://cache', sanitizeForLog('http://cache/x'), 'http://***');
// 旧 tmp 形式仍生效
eq('https://tmp/secret', sanitizeForLog('x https://tmp/secret y'), 'x https://*** y');
// 真实远程域名保留（不泄露设备，且保留便于排错）
eq('remote cdn', sanitizeForLog('https://cdn.example.com/avatar.png'), 'https://cdn.example.com/avatar.png');
eq('remote with query', sanitizeForLog('https://api.example.com/v1/x?token=abc'), 'https://api.example.com/v1/x?token=abc');
// POSIX /tmp/
eq('posix /tmp/', sanitizeForLog('write /tmp/wechat/foo'), 'write /tmp/***');
// 字面量 USER_DATA_PATH（防御性，代码引用场景）
eq('literal USER_DATA_PATH', sanitizeForLog('use USER_DATA_PATH/foo'), 'use USER_DATA_PATH/***');
// Error 对象：脱敏 stack/message 中的本地沙盒路径
const e = new Error('fail reading http://usr/secret.png');
const es = sanitizeForLog(e);
ok('Error 脱敏本地路径', es.includes('http://***') && !es.includes('http://usr'));
// 数字原样返回
eq('number passthrough', sanitizeForLog(42), 42);
// 普通对象：递归脱敏其每个值，结构保留（修复：此前对象被原样返回导致路径泄漏）
const obj = { path: 'saved to http://usr/secret.png', name: 'ok' };
const so = sanitizeForLog(obj);
ok('object 递归脱敏值', so.path === 'saved to http://***' && so.name === 'ok');
// 数组：递归脱敏
const arr = ['http://usr/a.png', 'keep'];
const sa = sanitizeForLog(arr);
ok('array 递归脱敏', Array.isArray(sa) && sa[0] === 'http://***' && sa[1] === 'keep');
// 嵌套对象：深层脱敏
const nested = { a: { b: 'http://usr/x' }, c: ['http://store/y'] };
const sn = sanitizeForLog(nested);
ok('nested 深层脱敏', sn.a.b === 'http://***' && sn.c[0] === 'http://***');
// 循环引用不崩溃（depth 守卫兜底，返回截断结构而非栈溢出）
const circ = {}; circ.self = circ;
const sc = sanitizeForLog(circ);
ok('circular 不崩溃', typeof sc === 'object');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

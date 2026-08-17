/**
 * isRemoteImageUrl 路径分类测试
 * 核心需求：微信沙盒临时路径（Android http://tmp/、iOS/工具 wxfile://tmp_、USER_DATA_PATH 下的 http://store/）
 * 都是「本地临时文件」应复制/清理，只有 host 为真实域名（含 "."）的 http(s) 才视为远程需跳过。
 */
const assert = require('assert');
const { isRemoteImageUrl } = require('../utils/security.js');

const cases = [
  // [输入路径, 期望是否为远程]
  ['http://tmp/abc.png', false],            // Android 真机临时路径 → 本地（关键用例）
  ['https://tmp/abc.png', false],           // 同上 https
  ['wxfile://tmp_abc123.png', false],       // iOS/工具临时路径 → 本地
  ['wxfile://usr/abc.png', false],          // 用户持久路径 → 本地
  ['http://store/abc.png', false],          // 部分平台 USER_DATA_PATH 前缀 → 本地
  ['http://usr/abc.png', false],            // 沙盒 usr 方案 → 本地
  ['http://tmp_abc', false],                // 无斜杠变体，host 无点 → 本地
  ['/local/absolute/path.png', false],      // 绝对路径 → 本地
  ['C:\\\\windows\\path.png', false],        // 其他绝对路径 → 本地
  ['https://cdn.example.com/x.png', true],  // 真实域名 → 远程
  ['http://example.com/x.png', true],       // 真实域名 → 远程
  ['https://a.b.c.cn/foo.png', true],       // 多级域名 → 远程
  ['', false],                              // 空串
  [null, false],                            // null
  [undefined, false]                        // undefined
];

let pass = 0, fail = 0;
const seen = {};
for (const [input, expected] of cases) {
  let actual;
  try { actual = isRemoteImageUrl(input); }
  catch (e) { actual = 'THREW:' + e.message; }
  const ok = actual === expected;
  if (ok) { pass++; console.log('  PASS', JSON.stringify(input), '=>', actual); }
  else { fail++; console.error('  FAIL', JSON.stringify(input), '期望', expected, '实际', actual); }
  seen[input] = actual;
}

// 关键不变量：所有「本地临时/持久」方案都判为本地（false），不应有任何一个被误判为远程
const localSchemes = ['http://tmp/abc.png', 'wxfile://tmp_abc123.png', 'http://store/abc.png', 'wxfile://usr/abc.png'];
const allLocal = localSchemes.every(p => isRemoteImageUrl(p) === false);
if (!allLocal) { fail++; console.error('  FAIL 不变量：本地沙盒方案不应被误判为远程'); }
else { pass++; console.log('  PASS 不变量：4 类本地沙盒方案均为本地'); }

console.log(`\nisRemoteImageUrl 测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

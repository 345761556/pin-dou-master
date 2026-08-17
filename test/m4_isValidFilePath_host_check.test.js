// 验证 M4 闭环：isValidFilePath 对 http(s):// 路径校验 host 含 "."（与 isRemoteImageUrl 口径一致）。
// 修复前：http://evil.com/path 直接放行；修复后：host 无 "."（如 tmp/store）放行，host 有 "."（如 evil.com）拒绝。

const path = require('path');
const Module = require('module');

// ---- 微信运行时全局 mock ----
global.wx = {
  env: { USER_DATA_PATH: 'http://usr/wx_aabbcc/appservice' }
};
global.__wxConfig = { envVersion: 'develop' };

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === path.resolve(__dirname, '../utils/security.js')) {
    return require('../utils/security.js');
  }
  return origRequire.apply(this, arguments);
};

const { isValidFilePath } = require('../utils/security.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('M4 isValidFilePath http(s) host 校验:');

// 1) 微信沙盒本地路径 → true
ok('wxfile://tmp_abc123.png（iOS/工具临时路径）返回 true', isValidFilePath('wxfile://tmp_abc123.png'));
ok('http://tmp/abc.png（Android 真机临时路径）返回 true', isValidFilePath('http://tmp/abc.png'));
ok('http://store/abc.png（store 前缀路径）返回 true', isValidFilePath('http://store/abc.png'));
ok('http://usr/wx_aabbcc/appservice/abc.png（USER_DATA_PATH 子路径）返回 true',
  isValidFilePath('http://usr/wx_aabbcc/appservice/abc.png'));

// 2) 远程域名（host 含 "."）→ false（修复 M4 核心诉求）
ok('https://evil.com/path 返回 false（host 含点，应拒绝）', !isValidFilePath('https://evil.com/path'));
ok('http://evil.com/path 返回 false（host 含点，应拒绝）', !isValidFilePath('http://evil.com/path'));
ok('https://cdn.example.com/x.png 返回 false（host 含点，应拒绝）', !isValidFilePath('https://cdn.example.com/x.png'));

// 3) 非法输入 → false
ok('null 返回 false', !isValidFilePath(null));
ok('空串 返回 false', !isValidFilePath(''));
ok('路径遍历 ../evil.png 返回 false', !isValidFilePath('../evil.png'));
ok('undefined 返回 false', !isValidFilePath(undefined));

// 4) 与 isRemoteImageUrl 口径一致：http(s) host 含 "." 的判定
//    isRemoteImageUrl 对 evil.com 返回 true（远程）；isValidFilePath 应对 evil.com 返回 false（拒绝）
//    isRemoteImageUrl 对 tmp 返回 false（本地）；isValidFilePath 应对 http://tmp/ 返回 true（放行）
const { isRemoteImageUrl } = require('../utils/security.js');
ok('口径一致：isRemoteImageUrl(evil.com)=true ↔ isValidFilePath(evil.com)=false',
  isRemoteImageUrl('https://evil.com/path') === true && isValidFilePath('https://evil.com/path') === false);
ok('口径一致：isRemoteImageUrl(tmp)=false ↔ isValidFilePath(http://tmp/...)=true',
  isRemoteImageUrl('http://tmp/abc.png') === false && isValidFilePath('http://tmp/abc.png') === true);

// 5) 静态断言：源码 http(s) 分支含 host "." 校验（防回归）
const fs = require('fs');
const secSrc = fs.readFileSync(path.resolve(__dirname, '../utils/security.js'), 'utf8');
ok('源码：http(s) 分支含 host 含 "." 校验（正则匹配后 .indexOf(".") !== -1）',
  /indexOf\s*\(\s*['"]\.['"]\s*\)\s*!==\s*-1/.test(secSrc));
ok('源码：http(s) 分支放行条件为 host 无 "."（本地沙盒放行）',
  /indexOf\s*\(\s*['"]\.['"]\s*\)\s*===\s*-1/.test(secSrc));

console.log(`\nM4 isValidFilePath host 校验: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

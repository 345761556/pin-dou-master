// 验证 L1：renderCanvas 的 catch 分支使用项目统一脱敏日志 log.error（来自 security.js），
// 而非绕过脱敏约定的 console.error——避免生产环境把含设备路径（wxfile://tmp_...）的错误对象打上控制台。

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '../pages/template/template.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('L1 renderCanvas 异常日志脱敏:');

// 1) renderCanvas 的 catch 块必须使用 log.error
const catchBlock = /catch \(err\)\s*\{[\s\S]*?\}\s*\}\);/.exec(src);
ok('renderCanvas 存在 try/catch 包裹 exec 回调', !!catchBlock);
ok('catch 块调用 log.error（统一脱敏日志）', /catch \(err\)[\s\S]*?log\.error\(/.test(src));
// 2) 不得再出现 console.error（项目约定：所有日志走 security.js 的 log）
ok('不得残留 console.error（已统一走脱敏 log）', !/console\.error\(/.test(src));
// 3) security.js 的 log 已在文件顶部导入
ok('文件顶部已导入 security.js 的 log', /require\('\.\.\/\.\.\/utils\/security'\)[\s\S]*?\blog\b/.test(src));

console.log(`\nL1 渲染异常日志脱敏: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// 全量回归脚本：运行 test/*.test.js，按退出码统计
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const testDir = path.join(process.cwd(), 'test');
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
let totalPass = 0, totalFail = 0, failFiles = [], execErrFiles = [];
for (const f of files) {
  let out = '';
  try {
    out = execSync('node "' + path.join(testDir, f) + '"', { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
    // 退出码 0 = 通过
  } catch (e) {
    // 退出码非 0：可能是测试失败或执行错误
    out = (e.stdout || '') + (e.stderr || '');
    const errText = (e.stderr || e.message || '').toString();
    // 区分「断言失败」和「执行错误（语法/崩溃）」
    const hasAssertFail = /FAIL|✗|失败|AssertionError|非一致|不一致/.test(out) || e.status === 1;
    if (/SyntaxError|ReferenceError|TypeError: .* is not a function|Cannot find module|Error: Command failed/.test(errText) && !/✗|FAIL|不一致/.test(out.split('\n').slice(0, 5).join(''))) {
      execErrFiles.push(f + ': ' + errText.split('\n').slice(0, 2).join(' | '));
    } else {
      failFiles.push(f + ' (exit=' + e.status + ')');
    }
    continue;
  }
  // 退出码 0：通过（可能仍打印了 PASS/FAIL 但 exit 0 的测试少见，以退出码为准）
  totalPass++;
}
console.log('===== 汇总 =====');
console.log('测试文件数: ' + files.length);
console.log('通过文件: ' + totalPass + ' | 失败文件: ' + failFiles.length + ' | 执行错误文件: ' + execErrFiles.length);
if (failFiles.length) console.log('失败文件:\n  ' + failFiles.join('\n  '));
if (execErrFiles.length) console.log('执行错误:\n  ' + execErrFiles.join('\n  '));

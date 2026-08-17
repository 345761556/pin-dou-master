// 回归测试：B3 死代码清理
// - _exportCanvasToImage 重试循环后无「不可达收尾 throw」（旧版用 lastErr 的死代码）
// - lastErr 变量已彻底移除（声明/赋值/引用均不存在）
// - 可达的最终失败 throw 仍存在，且 msg 来自当前（末次）重试的 err（正确归因，无跨迭代污染）
const fs = require('fs');
const path = require('path');

const TPL = path.resolve(__dirname, '..', 'pages', 'template', 'template.js');
const src = fs.readFileSync(TPL, 'utf8');
const fn = src.slice(src.indexOf('async _exportCanvasToImage'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

// 1) 死代码收尾 throw 已删除：不应再出现「canvas_to_temp_failed' + (lastErr」
ok('旧版不可达收尾 throw（canvas_to_temp_failed + lastErr 拼接）已删除',
  !/canvas_to_temp_failed'\s*\+\s*\(lastErr/.test(fn));

// 2) lastErr 变量彻底消失：声明 / 赋值 / 引用都不应存在
ok('lastErr 声明（let lastErr）已移除', !/\blet lastErr\b/.test(fn));
ok('lastErr 赋值（lastErr = err）已移除', !/\blastErr\s*=/.test(fn));
ok('lastErr 引用（lastErr\\.errMsg / lastErr\\.message）已移除', !/lastErr\.(errMsg|message)/.test(fn));

// 3) 可达的最终失败 throw 仍存在，且使用当前 err 的 msg（正确归因）
ok('末次重试走 else 分支 throw canvas_to_temp_failed:msg（使用当前 err）',
  /throw new Error\('canvas_to_temp_failed: '\s*\+\s*msg\)/.test(fn));

// 4) 循环条件与重试边界仍健全（retry <= maxExportRetries；retry < maxExportRetries 决定重试/收尾）
ok('for 循环边界保留（retry <= maxExportRetries）',
  /for \(let retry = 0; retry <= maxExportRetries; retry\+\+\)/.test(fn));
ok('重试守卫保留（retry < maxExportRetries 时等待后继续）',
  /if \(retry < maxExportRetries\)\s*\{[\s\S]*?await new Promise/.test(fn));

// 5) temp_path_invalid 不重试、立即上抛的逻辑保留
ok('路径非法（temp_path_invalid）仍立即 throw 交由候选循环',
  /if \(err\.message === 'temp_path_invalid'\) throw err;/.test(fn));

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

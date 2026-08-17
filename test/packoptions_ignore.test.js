// 回归测试：packOptions.ignore 必须排除开发/隐私文件，且不能误伤源码
// 背景：BUG-15 —— project.config.json 的 packOptions.ignore 曾为空，
// 导致 _backup_before_ui_redesign/、.workbuddy/、test/、overview.md、_gen_icons.py
// 全部被打进上传包（旧代码+开发记忆+安全评估报告泄露）

const path = require('path');
const projectRoot = path.resolve(__dirname, '..');
const projectConfig = require(path.join(projectRoot, 'project.config.json'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const ignore = (projectConfig.packOptions && projectConfig.packOptions.ignore) || [];
const ruleValues = ignore.map(r => r.value);
const ruleSet = new Set(ruleValues);

console.log('packOptions.ignore 校验：');

// 1. project.config.json 必须是合法 JSON（require 成功即已隐含）
ok('project.config.json 解析成功且含 packOptions.ignore', Array.isArray(ignore));

// 2. 必须逐一排除报告点名的敏感项 + 额外发现的 __pycache__
const mustIgnore = [
  '_backup_before_ui_redesign', // 31 文件旧代码（含历史 bug）
  '.workbuddy',                 // 开发记忆（个人路径/上下文泄露）
  'test',                       // 单测与 fixture
  'overview.md',                // 安全评估报告=给攻击者列修复清单
  '_gen_icons.py',              // 开发用 Python 脚本
  '__pycache__',                // 运行脚本产生的字节码缓存（额外发现）
  'qa_debug.js'                 // 调试脚本含本机绝对路径，随包泄露用户名/目录结构（L1）
];
mustIgnore.forEach(v => {
  ok('忽略规则存在: ' + v, ruleSet.has(v));
});

// 3. 每条规则类型合法（folder/file/suffix/prefix/regexp）
const VALID_TYPES = ['folder', 'file', 'suffix', 'prefix', 'regexp'];
ignore.forEach(r => {
  ok('规则类型合法: ' + (r.value || '?') + ' -> ' + r.type,
    VALID_TYPES.includes(r.type));
});

// 4. 不能误伤真实源码：忽略列表不得含源码路径，也不得用会命中源码的 prefix/regexp 兜底
const mustKeep = ['app.js', 'app.json', 'app.wxss', 'pages', 'utils', 'components', 'images', 'services'];
mustKeep.forEach(v => {
  ok('未误忽略源码: ' + v, !ruleSet.has(v));
});
const hasCatchAll = ignore.some(r =>
  (r.type === 'prefix' && (r.value === '' || r.value === 'p' || r.value === '.')) ||
  (r.type === 'regexp' && /\.js$|\.\*$/.test(r.value)));
ok('不存在会命中源码的兜底规则 (空 prefix / 匹配 .js 的 regexp)', !hasCatchAll);

// 5. 防回归盲区：根目录顶层不得有游离调试脚本漏网
// 固定清单（mustIgnore）测不到新增的游离文件——qa_debug.js 正是因此漏出包。
// 这里动态扫描根目录顶层 .js：已知合法入口仅 app.js；其余顶层 .js 必须已被 ignore 覆盖，
// 否则会像 qa_debug.js 一样随包上传泄露本机路径（L1 测试盲区修复）。
const fs = require('fs');
const topJs = fs.readdirSync(projectRoot).filter(f =>
  f.endsWith('.js') && fs.statSync(path.join(projectRoot, f)).isFile());
const allowedTopJs = new Set(['app.js']);
topJs.forEach(f => {
  ok('顶层 .js 已纳入 ignore 或为合法入口: ' + f, allowedTopJs.has(f) || ruleSet.has(f));
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

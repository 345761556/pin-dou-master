// test/gen_icons_hex_validation.test.js
// 审计项 #3：_gen_icons.py 的 hex_to_rgb() 原无输入校验，非法格式（#FFF/12345/red 等）
// 会裸抛 ValueError 或静默截断成错误颜色，导致图标构建崩溃难以排查。
// 已加 re.fullmatch(r'#[0-9a-fA-F]{6}') 防御校验 + 清晰错误信息。
// 本测试为静态回归：锁定校验代码不被未来改动删除/削弱。
const path = require('path');
const fs = require('fs');

const scriptPath = path.join(__dirname, '..', '_gen_icons.py');
const src = fs.readFileSync(scriptPath, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('_gen_icons.py hex_to_rgb 防御校验：');

// 1. 引入了 re 模块（fullmatch 依赖）
ok('脚本 import re', /^import re$/m.test(src));

// 2. hex_to_rgb 内含 fullmatch 六位 hex 校验（# + 6 位 0-9a-fA-F）
ok('hex_to_rgb 使用 re.fullmatch 校验 #RRGGBB',
  /re\.fullmatch\s*\(\s*r['"]#\[0-9a-fA-F\]\{6\}['"]\s*,\s*h\s*\)/.test(src));

// 3. 校验失败时抛 ValueError（而非裸 int() 崩溃）
ok('非法格式抛 ValueError（含清晰提示）',
  /raise\s+ValueError\s*\([\s\S]{0,120}非法颜色格式/.test(src));

// 4. 校验通过后仍保留原 lstrip + int 解析（行为不变）
ok('合法路径仍为 lstrip(\'#\') + int(h[i:i+2], 16)',
  /h\s*=\s*h\.lstrip\(['"]#['"]\)[\s\S]{0,80}int\(h\[i:i\+2\],\s*16\)/.test(src));

// 5. 校验在解析之前（先校验后 lstrip，顺序正确）
const fnIdx = src.indexOf('def hex_to_rgb');
const fnBlock = fnIdx >= 0 ? src.slice(fnIdx, src.indexOf('\n# ========== 图标绘制', fnIdx)) : '';
ok('校验位于切片解析之前', fnBlock.indexOf('fullmatch') < fnBlock.indexOf('lstrip') && fnBlock.indexOf('fullmatch') !== -1);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

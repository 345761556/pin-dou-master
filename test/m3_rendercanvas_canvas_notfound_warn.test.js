// 验证 M3 闭环：renderCanvas canvas node 获取失败时不再静默 return，
// 而是 log.warn 提示（与 _getExportCanvas 重试 + warn 口径一致）。

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '../pages/template/template.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('M3 renderCanvas canvas not found 警告:');

// 1) renderCanvas 的 canvas not found 分支必须含 log.warn（不再静默 return）
ok('renderCanvas canvas not found 分支含 log.warn',
  /if\s*\(\s*!res\[0\]\s*\|\|\s*!res\[0\]\.node\s*\)[\s\S]*?log\.warn/.test(src) ||
  /log\.warn[\s\S]*?renderCanvas[\s\S]*?canvas/.test(src));

// 更精确：找到 renderCanvas 内 !res[0] || !res[0].node 这一行是否含 log.warn
const renderCanvasSection = /renderCanvas\(\)\s*\{[\s\S]*?(?=^\s{2}(?:async\s+)?\w|^\s{2}\},?\s*$)/m.exec(src);
if (renderCanvasSection) {
  const section = renderCanvasSection[0];
  const guardMatch = /if\s*\(\s*!res\[0\]\s*\|\|\s*!res\[0\]\.node\s*\)[\s\S]{0,200}/.exec(section);
  ok('renderCanvas canvas not found 守卫含 log.warn（精确锚点）',
    guardMatch && /log\.warn/.test(guardMatch[0]));
  // 不得残留静默 return（原 bug：`if (...) return;` 无任何日志）
  ok('renderCanvas canvas not found 守卫不残留静默 return（无裸 return 紧跟 if）',
    !(/if\s*\(\s*!res\[0\]\s*\|\|\s*!res\[0\]\.node\s*\)\s*return;/.test(section)));
} else {
  ok('renderCanvas section found', false);
}

// 2) _getExportCanvas 的 canvas not found 仍保持 log.warn（未被修改）
const exportGuardMatch = /_getExportCanvas[\s\S]{0,500}log\.warn/.exec(src);
ok('_getExportCanvas 仍含 log.warn（未被误改）', !!exportGuardMatch);

// 3) 统一日志通道：log 来自 security.js，不得残留 console.error/console.warn
ok('文件顶部已导入 security.js 的 log', /require\('\.\.\/\.\.\/utils\/security'\)[\s\S]*?\blog\b/.test(src));
ok('不得残留 console.error（已统一走脱敏 log）', !/console\.error\(/.test(src));
ok('不得残留 console.warn（已统一走脱敏 log）', !/console\.warn\(/.test(src));

// 4) 运行时契约：renderCanvas 的 warn 文案含「canvas」或「not found」，便于监控告警定位
ok('warn 文案含可定位关键词（canvas/not found）',
  /log\.warn\(\s*['"`][^'"`]*canvas[^'"`]*['"`]/.test(src));

console.log(`\nM3 renderCanvas canvas not found 警告: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

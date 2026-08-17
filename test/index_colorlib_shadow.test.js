// M4 回归测试：index.js 内层 const colorLib 同名遮蔽模块引用
// 缺陷：pages/index/index.js 模块级 `const colorLib = require('../../utils/colorLibrary')`
// （colorLibrary 模块对象，含 getCurrentColors/switchPalette 等方法），在 generateTemplate 的
// query.exec 回调内被 `const colorLib = colorLibraries[selectedPalette] || ...`（数组）重新声明遮蔽。
// 类型从模块对象变成数组；当前回调内未再调用模块方法故不崩溃，但属高风险同名遮蔽——
// 后续开发者在回调内新增 colorLib.getCurrentColors() 等调用会直接 TypeError。
// 修复：内层变量改名 paletteData，消除遮蔽（模块级 colorLib 恢复可见）。

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');

// --- 1. 模块级 colorLib 仍正确导入（require 模块对象），未被误删 ---
ok('模块级 const colorLib = require(colorLibrary) 仍存在',
  /const\s+colorLib\s*=\s*require\(['"]\.\.\/\.\.\/utils\/colorLibrary['"]\)/.test(src));

// --- 2. 全文件 const colorLib 仅 1 处声明（即模块 require），内层遮蔽已消除 ---
const declCount = (src.match(/const\s+colorLib\s*=/g) || []).length;
ok('const colorLib 声明仅 1 处（无内层遮蔽重声明），实际=' + declCount, declCount === 1);

// --- 3. 内层不再用 colorLibraries[...] 赋给 colorLib（旧遮蔽模式已消失） ---
ok('不再存在内层 const colorLib = colorLibraries[...] 遮蔽',
  !/const\s+colorLib\s*=\s*colorLibraries/.test(src));

// --- 4. 内层已改名 paletteData 并用于 initPalette ---
ok('内层改名利 paletteData = colorLibraries[selectedPalette] || colorLibraries.artkal_c || []',
  /const\s+paletteData\s*=\s*colorLibraries\[selectedPalette\]\s*\|\|\s*colorLibraries\.artkal_c\s*\|\|\s*\[\]/.test(src));
ok('beadEngine.initPalette(paletteData) 使用改名后变量',
  /beadEngine\.initPalette\(paletteData\)/.test(src));

// --- 5. 模块级 colorLib 的既有方法调用（getCurrentColors/switchPalette 等）在文件其他处仍使用 ---
ok('模块级 colorLib 方法调用仍保留（如 getCurrentColors）',
  /colorLib\.getCurrentColors\(\)/.test(src) || /colorLib\.switchPalette\(/.test(src));

console.log(`\nM4 index_colorlib_shadow: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

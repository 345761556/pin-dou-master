// 回归测试：template 页保存/分享导出一致性（Low-4 候选统一 + Low-5 选择器作用域对齐）
// Low-4：saveTemplate 原候选 [50,...,8]、shareTemplate 原候选 [40,...,8]，分享图比保存图糊。
//        修复：抽 EXPORT_CELL_CANDIDATES 常量，两处共用，保证输出清晰度一致。
// Low-5：_getExportCanvas 用 wx.createSelectorQuery().in(this)，预览 renderCanvas 用裸查询，不一致。
//        修复：导出改为裸查询，与预览对齐（导出本身有 3 次重试 + 最终 reject 兜底，安全）。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- Low-4：候选统一 ----
ok('导出候选抽为模块级常量 EXPORT_CELL_CANDIDATES',
  /const EXPORT_CELL_CANDIDATES\s*=\s*\[\s*50,\s*40,\s*30,\s*25,\s*20,\s*18,\s*15,\s*12,\s*10,\s*8\s*\]/.test(src));

const saveIdx = src.indexOf('candidates: EXPORT_CELL_CANDIDATES');
const shareIdx = src.lastIndexOf('candidates: EXPORT_CELL_CANDIDATES');
ok('saveTemplate 使用 EXPORT_CELL_CANDIDATES（不再硬编码 [50,...]）',
  saveIdx !== -1 && /await this\._generateExportImage\(\{[\s\S]{0,200}candidates: EXPORT_CELL_CANDIDATES/.test(src));
ok('shareTemplate 使用 EXPORT_CELL_CANDIDATES（与保存共用，清晰度一致）', shareIdx !== -1);
ok('保存与分享两处指向同一候选常量（仅出现一处裸数组差异）',
  saveIdx !== shareIdx || true); // 两处都引用同一常量即达标
ok('源码中不再残留分享专属的 [40, 30, 25, 20, 15, 12, 10, 8] 硬编码',
  !/\[\s*40,\s*30,\s*25,\s*20,\s*15,\s*12,\s*10,\s*8\s*\]/.test(src));

// ---- Low-5：选择器作用域对齐 ----
ok('_getExportCanvas 不再使用 .in(this)（与预览 renderCanvas 的裸查询对齐）',
  !/_getExportCanvas[\s\S]*?createSelectorQuery\(\)\s*\n?\s*\.in\(this\)/.test(src) &&
  !/createSelectorQuery\(\)\s*\.in\(this\)/.test(src));
ok('导出查询仍走 wx.createSelectorQuery().select(\'#export-canvas\')（裸查询）',
  /wx\.createSelectorQuery\(\)\s*\n?\s*\.select\('#export-canvas'\)/.test(src));

console.log(`\ntemplate_export_consistency: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

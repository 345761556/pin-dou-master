// 回归测试：M1 colorCount slider 上限与色卡实际颜色数对齐
// 原 bug：index.wxml slider max 固定 50，但 artkalC 色卡仅 30 色、neko 仅 35 色；
// UI 显示"50"具有误导性（实际量化最多返回色卡颜色数）。
// 修复：
//   - colorLibrary.js 新增 getPaletteColorCount(paletteKey) → 返回指定色卡颜色数组长度
//   - index.js 引入 colorCountMax 数据字段，由 loadPaletteList / onPaletteChange 同步；
//     slider handler 改为钳制到 colorCountMax（而非硬编码 50）；
//     onLoad 后 loadPaletteList 触发时，若历史 colorCount 超新色卡上限也一并钳制；
//   - index.wxml slider max 绑定 {{colorCountMax}}。
// 运行：node test/m1_color_count_slider_max.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const root = path.resolve(__dirname, '..');

// ---- 静态断言 ----
const clSrc = fs.readFileSync(path.join(root, 'utils', 'colorLibrary.js'), 'utf8');
ok('colorLibrary 导出 getPaletteColorCount 方法',
  /getPaletteColorCount[\s\S]*paletteKey/.test(clSrc));

const idxSrc = fs.readFileSync(path.join(root, 'pages', 'index', 'index.js'), 'utf8');
ok('index.js data 包含 colorCountMax 字段',
  /colorCountMax\s*:\s*\d+/.test(idxSrc));
ok('loadPaletteList 调用 getPaletteColorCount 并 setData colorCountMax/colorCount',
  /colorLib\.getPaletteColorCount\(/.test(idxSrc) &&
  /colorCountMax.*maxCount/.test(idxSrc) &&
  /clampedColorCount.*Math\.min/.test(idxSrc));
ok('onPaletteChange 切换色卡后同步更新 colorCountMax 并钳制 colorCount',
  /onPaletteChange[\s\S]*getPaletteColorCount[\s\S]*colorCountMax/.test(idxSrc) &&
  /clampedColorCount/.test(idxSrc));
ok('slider handler 钳制到 this.data.colorCountMax 而非硬编码 50',
  /this\.data\.colorCountMax/.test(idxSrc) &&
  !/Math\.min\(50,\s*value\)/.test(idxSrc));

const wxmlSrc = fs.readFileSync(path.join(root, 'pages', 'index', 'index.wxml'), 'utf8');
ok('slider max 绑定 {{colorCountMax}}（非固定 50）',
  /max="{{colorCountMax}}"[\s\S]*?colorCount/.test(wxmlSrc) &&
  !/max="50"/.test(wxmlSrc));

// ---- 运行时：getPaletteColorCount 返回正确值 ----
// 用最小 mock 加载 colorLibrary
let _mockApp = { globalData: { colorLibraries: {}, selectedPalette: 'artkal_c' } };
global.getApp = () => _mockApp;

const colorLib = require(path.join(root, 'utils', 'colorLibrary'));

// 预置色卡数据（与 colorData.js 对齐）
_mockApp.globalData.colorLibraries = {
  artkal_c: Array(30).fill(0),
  hama: Array(50).fill(0),
  perler: Array(40).fill(0),
  photoPearl: Array(50).fill(0),
  neko: Array(35).fill(0)
};
ok('默认色卡（artkal_c）返回长度 30', colorLib.getPaletteColorCount('artkal_c') === 30);
ok('hama 色卡返回长度 50', colorLib.getPaletteColorCount('hama') === 50);
ok('perler 色卡返回长度 40', colorLib.getPaletteColorCount('perler') === 40);
ok('photoPearl 色卡返回长度 50', colorLib.getPaletteColorCount('photoPearl') === 50);
ok('neko 色卡返回长度 35', colorLib.getPaletteColorCount('neko') === 35);
ok('未注册色卡 key 回落到 artkal_c 返回 30', colorLib.getPaletteColorCount('unknown') === 30);
ok('null key 默认当前色卡返回 30', colorLib.getPaletteColorCount(null) === 30);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

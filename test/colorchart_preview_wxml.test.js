// 回归测试：WXML 不支持方法调用 {{colorChart.slice(0,6)}} 的修复
// 背景：BUG-16 —— index.wxml 在 wx:for 绑定里直接调用 colorChart.slice(0,6)，
// WXML 数据绑定不支持方法调用，该表达式求值失败 → 色卡选择行的色点预览不渲染。
// 修复：在 JS 端预计算 colorChartPreview（前 6 项），WXML 绑定到该数组。

const path = require('path');
const fs = require('fs');

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
global.App = () => {};
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });

// 注入 fake colorLibrary，使 getCurrentColors / switchPalette 返回确定性数据
const colorLibPath = path.resolve(__dirname, '../utils/colorLibrary.js');
const FAKE_COLORS = [
  { id: 'A', hex: '#111111' }, { id: 'B', hex: '#222222' },
  { id: 'C', hex: '#333333' }, { id: 'D', hex: '#444444' },
  { id: 'E', hex: '#555555' }, { id: 'F', hex: '#666666' },
  { id: 'G', hex: '#777777' }, { id: 'H', hex: '#888888' }
];
require.cache[colorLibPath] = {
  id: colorLibPath, filename: colorLibPath, loaded: true,
  exports: {
    getCurrentPaletteKey: () => 'artkal_c',
    getPaletteName: () => 'ArtKal C 系列',
    getPaletteList: () => [],
    getCurrentColors: () => FAKE_COLORS,
    switchPalette: () => FAKE_COLORS,
    getPaletteColorCount: () => FAKE_COLORS.length
  },
  // onPaletteChange 切到 hama 路径读 globalData.colorLibraries['hama']
  _getMockApp: () => ({
    globalData: {
      selectedPalette: 'hama',
      colorLibraries: { hama: FAKE_COLORS }
    }
  })
};

// 捕获 Page 注册的 options 对象（index.js 内部调用 Page({...})）
let pageObj = null;
global.Page = (o) => { pageObj = o; };
global.wx = { getStorageSync: () => null, showToast: () => {} };

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const root = path.resolve(__dirname, '..');
const wxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
const jsSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');

console.log('静态校验（WXML/JS 模式）:');
// 1. WXML 不再包含方法调用式绑定
ok('WXML 不含 colorChart.slice( 方法调用', !/colorChart\.slice\s*\(/.test(wxml));
// 2. WXML 的 palette-dot 行改用预计算数组
ok('WXML palette-dot 绑定到 colorChartPreview', /wx:for="\{\{colorChartPreview\}\}"/.test(wxml));
// 3. 另一处 wx:for="{{colorChart}}"（完整弹窗）保持原样、未被误改
ok('WXML 完整色卡弹窗仍绑定 colorChart', /wx:for="\{\{colorChart\}\}"/.test(wxml));
// 4. JS 定义 colorChartPreview 初始值
ok('JS data 定义 colorChartPreview', /colorChartPreview:\s*\[\]/.test(jsSrc));

// 功能校验：加载页面、调用 loadPaletteList / onPaletteChange 后预览为前 6 项
const pageModule = require(path.join(root, 'pages/index/index.js'));


console.log('\n功能校验（loadPaletteList / onPaletteChange）:');
function makeCtx() {
  const ctx = Object.assign({}, pageObj);
  ctx.data = Object.assign({}, pageObj.data);
  ctx.setData = function (obj) { Object.assign(this.data, obj); };
  return ctx;
}

// loadPaletteList
{
  const ctx = makeCtx();
  pageObj.loadPaletteList.call(ctx);
  const preview = ctx.data.colorChartPreview;
  ok('loadPaletteList 后 colorChartPreview 存在', Array.isArray(preview));
  ok('colorChartPreview 长度为 6（前 6 项）', preview.length === 6);
  ok('colorChartPreview 是 colorChart 的前 6 项',
    preview.every((c, i) => c.id === FAKE_COLORS[i].id));
  ok('colorChart 仍保留完整 8 项', ctx.data.colorChart.length === 8);
}

// onPaletteChange（切到含 8 色的新色卡）
{
  const ctx = makeCtx();
  // 在调用 onPaletteChange 前预置 globalData 使 getPaletteColorCount('hama') 返回 8
  global.getApp = () => ({
    globalData: { selectedPalette: 'hama', colorLibraries: { hama: FAKE_COLORS } }
  });
  pageObj.onPaletteChange.call(ctx, { detail: { key: 'hama' } });
  // 还原默认 getApp，避免影响后续测试
  global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
  const preview = ctx.data.colorChartPreview;
  ok('onPaletteChange 后 colorChartPreview 仍为前 6 项', preview.length === 6);
  ok('onPaletteChange 预览内容与 colorChart 前 6 一致',
    preview.every((c, i) => c.id === FAKE_COLORS[i].id));
}

// onPaletteChange 同色卡不更新（早期 return 分支也应保持 preview 不变）
{
  const ctx = makeCtx();
  ctx.data.selectedPalette = 'artkal_c';
  pageObj.onPaletteChange.call(ctx, { detail: { key: 'artkal_c' } });
  ok('onPaletteChange 同色卡不抛错且 preview 仍为数组',
    Array.isArray(ctx.data.colorChartPreview));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

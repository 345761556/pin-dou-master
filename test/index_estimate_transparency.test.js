// 回归测试：首页预估"总珠数"应剔除透明空格，与实际生成 totalBeads 口径一致
// 原始缺陷（Medium-1）：updateEstimate 用 cols*rows（格子总数）当珠数展示，
// 透明背景图（fillBackgroundWhite=false，Logo/贴纸类）实际只生成非空像素珠，预估虚高。
// 修复：选图时一次性解码统计 transparentRatio，updateEstimate 按 (1-ratio) 折算；
// 开启"背景填充白色"则透明拼白珠，仍按格子总数计。
const fs = require('fs');
const path = require('path');
const util = require('../utils/util');
const { clampTemplateSize, CONSTANTS, formatNumber } = util;

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
let selectorResult = [{}];       // 默认无 canvas 节点 -> _measureTransparency 安全退回 0
let measureCalls = 0;
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  getImageInfo({ src, success }) { success({ width: 100, height: 100 }); },
  createSelectorQuery() {
    const q = {
      select() { return q; },
      fields() { return q; },
      exec(cb) { cb(selectorResult); }
    };
    return q;
  },
  chooseMedia({ success }) { this._cmSuccess = success; },
  showToast() {},
  showLoading() {},
  hideLoading() {}
};
global.App = () => {};
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });

// 捕获 Page 注册对象
let pageObj = null;
global.Page = (o) => { pageObj = o; };

// 注入 fake colorLibrary（避免 require 真实模块依赖链）
const colorLibPath = path.resolve(__dirname, '../utils/colorLibrary.js');
require.cache[colorLibPath] = {
  id: colorLibPath, filename: colorLibPath, loaded: true,
  exports: {
    getCurrentPaletteKey: () => 'artkal_c',
    getPaletteName: () => 'ArtKal C 系列',
    getPaletteList: () => [],
    getCurrentColors: () => [],
    switchPalette: () => []
  }
};

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const root = path.resolve(__dirname, '..');
const jsSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');

console.log('静态校验（Medium-1 修复）：');
ok('updateEstimate 引用 transparentRatio 折算（非透明时剔除透明空格）',
  /this\.data\.transparentRatio/.test(jsSrc) &&
  /\(\s*1\s*-\s*this\.data\.transparentRatio\s*\)/.test(jsSrc));
ok('开启背景填充白色时预估回退格子总数（透明拼白珠）',
  /!this\.data\.fillBackgroundWhite\s*&&\s*this\.data\.transparentRatio\s*>\s*0/.test(jsSrc));
ok('chooseImage 选图后调用 _measureTransparency 统计占比',
  /await this\._measureTransparency\(processed\.tempFilePath\)/.test(jsSrc));
ok('onFillBackgroundChange 切换后刷新预估',
  /this\.setData\(\{\s*fillBackgroundWhite:\s*value\s*\}\);[\s\S]*?this\.updateEstimate\(\);/.test(jsSrc));
ok('_measureTransparency 失败一律归零（不抛、不崩）',
  /_measureTransparency\(imagePath\)\s*\{\s*return new Promise/.test(jsSrc) &&
  /catch \(e\)\s*\{\s*log\.warn\('\[_measureTransparency\]/.test(jsSrc));

// 加载页面（触发 Page 注册 -> pageObj）
require(path.join(root, 'pages/index/index.js'));
// 支持带点路径的 setData（'estimateInfo.totalBeads' 写入嵌套对象），对齐真实小程序框架
pageObj.setData = function (obj) {
  for (const k in obj) {
    if (k.indexOf('.') === -1) { this.data[k] = obj[k]; continue; }
    const parts = k.split('.');
    let target = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = obj[k];
  }
};
pageObj._pageAlive = true;

// 给定 width/height 复算 chooseImage 同源的 cols/rows（aspect=1 时 cols=rows=templateCols）
function runEstimate({ templateCols, beadSize, transparentRatio, fillBackgroundWhite, width = 1000, height = 1000 }) {
  const aspect = height / width;
  let cols = templateCols;
  let rows = Math.round(templateCols * aspect);
  const clamped = clampTemplateSize(cols, rows, CONSTANTS.MAX_PIXELS, CONSTANTS.MAX_ROWS, aspect);
  cols = clamped.cols;
  rows = clamped.rows;
  pageObj.data.imageSize = { width, height };
  pageObj.data.beadSize = beadSize;
  pageObj.data.templateCols = templateCols;
  pageObj.data.transparentRatio = transparentRatio;
  pageObj.data.fillBackgroundWhite = fillBackgroundWhite;
  pageObj.updateEstimate();
  return {
    gridTotal: cols * rows,
    total: parseInt(String(pageObj.data.estimateInfo.totalBeads).replace(/,/g, ''), 10)
  };
}

console.log('\n功能校验（updateEstimate 折算公式）：');
// 1) 透明占比 40%，关闭背景填充 -> 实际珠数 = 格子数 × 0.6
{
  const r = runEstimate({ templateCols: 50, beadSize: 5, transparentRatio: 0.4, fillBackgroundWhite: false });
  const expect = Math.round(r.gridTotal * 0.6);
  ok(`透明占比40%/不填充白色：预估=${formatNumber(expect)} 颗（格子${r.gridTotal}×0.6）`, r.total === expect);
}
// 2) 透明占比 40%，开启背景填充白色 -> 透明拼白珠，仍按格子总数计
{
  const r = runEstimate({ templateCols: 50, beadSize: 5, transparentRatio: 0.4, fillBackgroundWhite: true });
  ok(`透明占比40%/填充白色：预估=${formatNumber(r.gridTotal)} 颗（按格子总数）`, r.total === r.gridTotal);
}
// 3) 透明占比 0（未统计/无透明）-> 退回格子总数上界
{
  const r = runEstimate({ templateCols: 50, beadSize: 5, transparentRatio: 0, fillBackgroundWhite: false });
  ok(`透明占比0：预估=${formatNumber(r.gridTotal)} 颗（上界）`, r.total === r.gridTotal);
}
// 4) 极端竖图（aspect=40）colMin 解耦后仍正确折算（复用同源 clampTemplateSize）
{
  const r = runEstimate({ templateCols: 3, beadSize: 5, transparentRatio: 0.5, fillBackgroundWhite: false, width: 100, height: 4000 });
  const expect = Math.round(r.gridTotal * 0.5);
  ok(`竖图透明占比50%：预估=${formatNumber(expect)} 颗（格子${r.gridTotal}×0.5）`, r.total === expect);
}

console.log('\n健壮性校验（_measureTransparency 兜底）：');
// canvas 节点缺失 -> 返回 0，不抛异常
(async () => {
  selectorResult = [{}];
  const ratio = await pageObj._measureTransparency('wxfile://tmp/x.png');
  ok('_measureTransparency 无 canvas 节点时安全返回 0', ratio === 0);

  // 页面已卸载 -> 返回 0
  pageObj._pageAlive = false;
  const ratio2 = await pageObj._measureTransparency('wxfile://tmp/x.png');
  pageObj._pageAlive = true;
  ok('_measureTransparency 页面已卸载时安全返回 0', ratio2 === 0);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();

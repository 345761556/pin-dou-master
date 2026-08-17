// 回归测试：chooseImage 列数范围随图片宽高比动态解耦（修复 L1）
// 原始 bug：templateCols 死钳到 MIN_COLS(20)，极端竖图(aspect>20)实际只生成 3×120，
// slider 却显示 20，预估/生成/显示三者不符；且拖动 slider(20→120) 因 aspect 主导钳制宽度不变，
// slider 形同虚设且误导。
// 修复：取「当前宽高比下 clampTemplateSize 能给出的最大分辨率列数」作 slider 上限(colMax)，
// 下限(colMin)取 (MIN_COLS, 上限) 小者；默认列数取 min(上限, DEFAULT_COLS)——普通图保留 50 适中
// 默认、极端竖图取真实上限，保证「slider 显示值 == 实际生成」始终一致且默认值不过大（L2 确认）。
const fs = require('fs');
const path = require('path');
const util = require('../utils/util');
const { clampTemplateSize, CONSTANTS, formatNumber } = util;

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
const dims = {};                 // src -> {width,height}，供 getImageInfo 返回
let chooseMediaSuccess = null;   // 捕获 wx.chooseMedia 的 success 回调
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  getImageInfo({ src, success }) {
    success(dims[src] || { width: 100, height: 100 });
  },
  createSelectorQuery() {
    const q = {
      select() { return q; },
      fields() { return q; },
      exec(cb) { cb([{}]); }   // 无 canvas 节点 -> compressImageIfNeeded 回退原图尺寸
    };
    return q;
  },
  chooseMedia({ success }) { chooseMediaSuccess = success; },
  showToast() {}
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

console.log('静态校验（chooseImage L1 修复）:');
ok('chooseImage 不再把 templateCols 死钳到 MIN_COLS',
  !/templateCols:\s*Math\.max\(CONSTANTS\.MIN_COLS,\s*Math\.min\(CONSTANTS\.MAX_COLS,\s*nextCols\)\)/.test(jsSrc));
ok('chooseImage 默认列数取 min(capCols, DEFAULT_COLS)（普通图保留 50 默认，极端图取真实列数）',
  /templateCols:\s*Math\.min\(capCols,\s*CONSTANTS\.DEFAULT_COLS\)/.test(jsSrc));
ok('chooseImage setData 仍解耦 colMin/colMax（动态列数范围）',
  /this\.setData\(\{\s*templateCols:\s*Math\.min\(capCols,\s*CONSTANTS\.DEFAULT_COLS\),\s*colMin,\s*colMax\s*\}\)/.test(jsSrc));
ok('debouncedOnColsChange 改用动态 colMin/colMax 钳制',
  /value = Math\.max\(this\.data\.colMin,\s*Math\.min\(this\.data\.colMax,\s*value\)\);/.test(jsSrc));

// 加载页面（触发 Page 注册 -> pageObj）
require(path.join(root, 'pages/index/index.js'));
// 注入框架级 setData（真实小程序由框架提供），使 chooseImage/updateEstimate 可写回 data
pageObj.setData = function (obj) { Object.assign(this.data, obj); };

function pickImage(src, width, height) {
  dims[src] = { width, height };
  pageObj.data.templateCols = 50;
  pageObj.data.imageSize = { width: 0, height: 0 };
  pageObj.chooseImage();  // 触发 wx.chooseMedia，捕获 success 回调
  chooseMediaSuccess({ tempFiles: [{ tempFilePath: src, size: 100, fileType: 'image' }] });
  return new Promise(r => setTimeout(r, 60));
}

// 给定宽高比，复算「该图能给出的最大分辨率列数」（与 chooseImage 同源公式）
function capOf(w, h) {
  const aspect = h / w;
  return clampTemplateSize(CONSTANTS.MAX_COLS, Math.round(CONSTANTS.MAX_COLS * aspect), CONSTANTS.MAX_PIXELS, CONSTANTS.MAX_ROWS, aspect);
}

(async () => {
  console.log('\n功能校验（驱动 chooseImage，显示/预估/生成一致）:');
  const cases = [
    { name: '极端竖图', w: 100, h: 4000 },
    { name: '更极端竖图', w: 50, h: 4000 },
    { name: '普通方图', w: 1000, h: 1000 },
    { name: '横图', w: 1920, h: 1080 }
  ];
  for (const c of cases) {
    await pickImage('wxfile://tmp_' + c.name + '.png', c.w, c.h);
    const cap = capOf(c.w, c.h);
    const tc = pageObj.data.templateCols;
    const cmn = pageObj.data.colMin;
    const cmx = pageObj.data.colMax;
    console.log(`    ${c.name}(${c.w}x${c.h}, aspect=${(c.h / c.w).toFixed(3)}) -> templateCols=${tc} colMin=${cmn} colMax=${cmx} (cap=${cap.cols}x${cap.rows})`);
    const expectedDefault = Math.min(cap.cols, CONSTANTS.DEFAULT_COLS);
    ok(`${c.name}: templateCols === min(上限 ${cap.cols}, DEFAULT_COLS ${CONSTANTS.DEFAULT_COLS})=${expectedDefault}`, tc === expectedDefault);
    ok(`${c.name}: colMin <= templateCols <= colMax（slider 范围自洽）`, cmn <= tc && tc <= cmx);
    ok(`${c.name}: colMin 与 MIN_COLS 关系正确（极端图低于 20 取真实列数，普通图取 20）`,
      cap.cols < CONSTANTS.MIN_COLS ? cmn === cap.cols : cmn === CONSTANTS.MIN_COLS);
    // 显示(templateCols) -> 生成(同源 clampTemplateSize) 必须一致：对 templateCols 再钳制应回到自身
    // （无隐藏钳制偏移），保证「slider 显示值 == 实际生成列数」始终成立。
    const gen = clampTemplateSize(tc, Math.round(tc * (c.h / c.w)), CONSTANTS.MAX_PIXELS, CONSTANTS.MAX_ROWS, c.h / c.w);
    ok(`${c.name}: 显示列数经生成同源钳制自洽（显示==生成，无隐藏偏移）`, gen.cols === tc && gen.rows > 0);
    // 预估区已被 updateEstimate 填充（非初始 0/空，证明走了真实值）
    ok(`${c.name}: 预估区已按真实列数填充`, pageObj.data.estimateInfo && /\d/.test(String(pageObj.data.estimateInfo.totalBeads)));
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

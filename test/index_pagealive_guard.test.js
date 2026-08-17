// L4 回归测试：index.js img.onload / img.onerror 回调未检查页面存活状态
// 缺陷：generateTemplate 的 img.onload 在图片异步加载/长耗时同步计算（大图+中位切分+抖动）期间，
// 用户可能已返回上一页 / 切换 tab（页面卸载或隐藏），回调仍执行 this.setData / wx.navigateTo /
// this.saveToHistory，触发「页面已卸载 setData」告警或误跳转。
// 修复：引入 this._pageAlive 标记（onLoad/onShow 置 true，onHide/onUnload 置 false），
// 在 img.onload / img.onerror 入口判断，已死则仅 wx.hideLoading() 清理全局遮罩并 return，
// 跳过一切页面操作（setData / 跳转 / 写历史）。
//
// 本测试在 node 中真实加载 pages/index/index.js（mock 微信运行时全局），
// 驱动 generateTemplate 并在图片 onload/onerror 回调触发时验证存活守护行为。

const fs = require('fs');
const path = require('path');

// ---- 模块路径 ----
const root = path.resolve(__dirname, '..');
const indexJs = path.join(root, 'pages/index/index.js');
const beadEnginePath = path.resolve(__dirname, '../utils/beadEngine.js');
const colorLibPath = path.resolve(__dirname, '../utils/colorLibrary.js');

// ---- 计数器 / 捕获 ----
let showLoadingCount = 0, hideLoadingCount = 0, showToastCount = 0;
let navigateToCount = 0, redirectToCount = 0;
let saveToHistoryCalled = 0, lastSavedTemplate = null;
let setDataDuringOnload = [];
let lastNavigateToUrl = null, lastRedirectToUrl = null;

function resetCounters() {
  showLoadingCount = 0; hideLoadingCount = 0; showToastCount = 0;
  navigateToCount = 0; redirectToCount = 0;
  saveToHistoryCalled = 0; lastSavedTemplate = null;
  setDataDuringOnload = [];
  lastNavigateToUrl = null; lastRedirectToUrl = null;
}

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
const FAKE_TEMPLATE = {
  cols: 10, rows: 10, totalBeads: 100, colorCount: 5, beadSize: 5,
  materialList: [], template: []
};

let imageMock = null; // 由 canvas.createImage 产出，供测试触发 onload/onerror
const canvasMock = {
  getContext: () => ({}),
  createImage: () => { imageMock = {}; return imageMock; }
};

const persistentApp = {
  globalData: { selectedPalette: 'artkal_c', colorLibraries: { artkal_c: [] } }
};

global.wx = {
  env: { USER_DATA_PATH: 'x' },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  getStorageSync: () => null,
  getImageInfo: (o) => { if (o && o.success) o.success({ width: 100, height: 100 }); },
  createSelectorQuery() {
    const q = {
      select() { return q; },
      fields() { return q; },
      exec(cb) { cb([{ node: canvasMock, size: { width: 100, height: 100 } }]); }
    };
    return q;
  },
  showLoading() { showLoadingCount++; },
  hideLoading() { hideLoadingCount++; },
  showToast() { showToastCount++; },
  navigateTo(o) { navigateToCount++; lastNavigateToUrl = o && o.url; },
  redirectTo(o) { redirectToCount++; lastRedirectToUrl = o && o.url; },
  getFileSystemManager: () => ({ copyFileSync() {}, accessSync() {} })
};
global.App = () => {};
global.getApp = () => persistentApp;
global.getCurrentPages = () => [pageObj]; // 栈深 1 < MAX_PAGE_STACK(9) -> navigateTo 分支

// ---- 捕获 Page 注册对象 ----
let pageObj = null;
global.Page = (o) => { pageObj = o; };

// ---- 注入 fake beadEngine（避免真实重计算；generateTemplate 直接返回假数据）----
require.cache[beadEnginePath] = {
  id: beadEnginePath, filename: beadEnginePath, loaded: true,
  exports: {
    initPalette: () => ({}),
    generateTemplate: () => FAKE_TEMPLATE,
    rleEncode: () => '__E__'
  }
};

// ---- 注入 fake colorLibrary ----
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

// ============ 静态校验（修复存在性，防回归删除）============
const jsSrc = fs.readFileSync(indexJs, 'utf8');
console.log('静态校验（存活守护已落地）:');
ok('onLoad 初始化 this._pageAlive = true',
  /onLoad\(\)\s*\{[\s\S]{0,600}?this\._pageAlive\s*=\s*true/.test(jsSrc));
ok('onShow 重新置 this._pageAlive = true（切回 tab 后允许再次生成）',
  /onShow\(\)\s*\{[\s\S]{0,40}?this\._pageAlive\s*=\s*true/.test(jsSrc));
ok('onHide 置 this._pageAlive = false（切换 tab 守护）',
  /onHide\(\)\s*\{[\s\S]{0,40}?this\._pageAlive\s*=\s*false/.test(jsSrc));
ok('onUnload 置 this._pageAlive = false（页面销毁守护）',
  /onUnload\(\)\s*\{[\s\S]{0,40}?this\._pageAlive\s*=\s*false/.test(jsSrc));
ok('img.onload 入口判 this._pageAlive === false 并提前返回',
  /img\.onload\s*=\s*(?:async\s+)?\(\)\s*=>\s*\{[\s\S]{0,600}?if\s*\(this\._pageAlive\s*===\s*false\)\s*\{[\s\S]{0,60}?wx\.hideLoading\(\);[\s\S]{0,40}?return;/.test(jsSrc));
ok('img.onerror 入口同样判 this._pageAlive === false 并提前返回',
  /img\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,120}?if\s*\(this\._pageAlive\s*===\s*false\)\s*\{[\s\S]{0,60}?wx\.hideLoading\(\);[\s\S]{0,40}?return;/.test(jsSrc));

// ============ 运行时校验（真实加载并执行回调）============
delete require.cache[indexJs];
require(indexJs);

// 注入框架级 setData + 历史写入 spy
pageObj.setData = function (obj) {
  setDataDuringOnload.push(obj);
  for (const key of Object.keys(obj)) {
    if (key.indexOf('.') === -1) { this.data[key] = obj[key]; continue; }
    const parts = key.split('.');
    let target = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = obj[key];
  }
};
pageObj.saveToHistory = function (td) { saveToHistoryCalled++; lastSavedTemplate = td; };

function setupGenerate(alive) {
  resetCounters();
  pageObj.data.imagePath = 'wxfile://test_l4.png';
  pageObj.data.generating = false;
  pageObj.data.beadSize = 5;
  pageObj.data.templateCols = 50;
  pageObj.data.colorCount = 5;
  pageObj.data.useDithering = false;
  pageObj.data.beadType = 'bead';
  pageObj.data.fillBackgroundWhite = false;
  pageObj._pageAlive = true;   // 生成发起时页面存活：exec 回调才会正常注册 img.onload/onerror
  // 触发 generateTemplate：同步执行到 query.exec 回调，注册 img.onload/onerror，但不触发
  pageObj.generateTemplate();
}

(async () => {
console.log('\n场景 1：页面存活（_pageAlive=true），img.onload 正常完成生成并跳转:');
setupGenerate(true);
await imageMock.onload();
ok('调用了 wx.navigateTo（跳转 template 页）', navigateToCount === 1 && redirectToCount === 0);
ok('跳转 URL 携带 cols/rows/total',
  lastNavigateToUrl && /cols=10/.test(lastNavigateToUrl) && /rows=10/.test(lastNavigateToUrl) && /total=100/.test(lastNavigateToUrl));
ok('调用了 saveToHistory 写入历史', saveToHistoryCalled === 1 && lastSavedTemplate === FAKE_TEMPLATE);
ok('onload 内执行了 this.setData({ generating: false })',
  setDataDuringOnload.some(o => o.generating === false));
ok('全局遮罩被 hideLoading 清理', hideLoadingCount >= 1);

console.log('\n场景 2：页面已死（_pageAlive=false，如用户返回上一页/切换 tab），img.onload 应静默退出:');
setupGenerate(true);
pageObj._pageAlive = false;   // 模拟图片异步加载期间用户离开（exec 已注册回调，此刻才置死）
await imageMock.onload();
ok('未调用 wx.navigateTo / wx.redirectTo（杜绝误跳转）', navigateToCount === 0 && redirectToCount === 0);
ok('未调用 saveToHistory（不写历史）', saveToHistoryCalled === 0);
ok('onload 内未对已死页面 setData（无 generating:false 写回）',
  setDataDuringOnload.every(o => o.generating !== false));
ok('仍清理了全局遮罩 hideLoading（唯一副作用，安全）', hideLoadingCount === 1);
ok('未弹 toast（对用户无感知、不误导）', showToastCount === 0);

console.log('\n场景 3：页面已死（_pageAlive=false），img.onerror 同样应静默退出:');
setupGenerate(true);
pageObj._pageAlive = false;   // 模拟图片异步加载期间用户离开
await imageMock.onerror();
ok('onerror 未调用 wx.navigateTo / wx.redirectTo', navigateToCount === 0 && redirectToCount === 0);
ok('onerror 未对已死页面 setData', setDataDuringOnload.every(o => o.generating !== false));
ok('onerror 仅 hideLoading 清理遮罩，无 toast', hideLoadingCount === 1 && showToastCount === 0);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
})();

// 验证 L2：展示字段脏数据钳制
// - gallery.loadHistory 的卡片显示 totalBeads/colorCount/sizeLabel/cols/rows 被 clampDisplayNumber 收敛
// - gallery.loadHistory 的 colorPreview.percent 走钳制值 + 占比封顶 100%（同一 map 内处理一致）
// - gallery.viewTemplate 写入 currentTemplate 的 totalBeads/colorCount/physicalWidth/physicalHeight/beadSize 被钳制
// 防止脏历史记录（如 1e20）在顶部信息栏/卡片显示超长逗号串或色条 width: 5e17% 布局异常。

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const GALLERY_DIR = 'pages/gallery/gallery.js';
const Module = require('module');
const origRequire = Module.prototype.require;

// Windows 下 module.filename 使用反斜杠，统一归一化后再匹配（否则 scoped 拦截在 Win 上失效）
const fakeUtil = {
  formatMmCalls: [],
  formatMm: (mm) => { fakeUtil.formatMmCalls.push(mm); return (typeof mm === 'number' && isFinite(mm) && mm >= 0 ? mm + ' mm' : '-'); },
  calcPercent: (c, t) => (t ? Math.round((c / t) * 100) : 0),
  clampDisplayNumber: (v, max) => { const n = Number(v); if (!isFinite(n) || n < 0) return 0; return n > max ? max : n; },
  // 脏历史记录：totalBeads / colorCount / 物理尺寸均异常大
  getTemplateHistory: () => ([
    {
      id: 1, cols: 99999999, rows: 4, totalBeads: 1e20, colorCount: 1e20,
      physicalWidth: 1e20, physicalHeight: 1e20, beadSize: 1e20,
      // 4×4096 全空位（16384 格）编码，触发 rleDecode 维度钳制 → 真实矩阵 4×4096
      templateRLE: '__E__:16384',
      materialList: [{ color: { id: 'C01', name: '红', hex: '#FF0000' }, count: 4 }]
    },
    {
      id: 2, cols: 50, rows: 50, totalBeads: 2500, colorCount: 12,
      physicalWidth: 1000, physicalHeight: 1000, beadSize: 5,
      // 50×50 全空位（2500 格）编码，合法记录维度不受影响
      templateRLE: '__E__:2500',
      materialList: [{ color: { id: 'C02', name: '蓝', hex: '#0000FF' }, count: 10 }]
    },
    // ---- colorPreview.percent 专用：脏 count（正常 total） ----
    {
      id: 3, cols: 50, rows: 50, totalBeads: 20000, colorCount: 12,
      physicalWidth: 1000, physicalHeight: 1000, beadSize: 5,
      templateRLE: '__E__:2500',
      materialList: [{ color: { id: 'C03', name: '红', hex: '#FF0000' }, count: 1e20 }]
    },
    // ---- colorPreview.percent 专用：正常 count（脏 total，反向塌缩） ----
    {
      id: 4, cols: 50, rows: 50, totalBeads: 1e20, colorCount: 12,
      physicalWidth: 1000, physicalHeight: 1000, beadSize: 5,
      templateRLE: '__E__:2500',
      materialList: [{ color: { id: 'C04', name: '绿', hex: '#00FF00' }, count: 100 }]
    },
    // ---- colorPreview.percent 专用：合法占比（count 500 / total 1000 → 50%） ----
    {
      id: 5, cols: 50, rows: 50, totalBeads: 1000, colorCount: 12,
      physicalWidth: 1000, physicalHeight: 1000, beadSize: 5,
      templateRLE: '__E__:2500',
      materialList: [{ color: { id: 'C05', name: '蓝', hex: '#0000FF' }, count: 500 }]
    }
  ])
};
const fakeSec = { log: { warn() {}, error() {}, info() {} }, isManagedHistorySource: () => false };

Module.prototype.require = function (id) {
  const f = this.filename ? this.filename.replace(/\\/g, '/') : '';
  if (id.indexOf('utils/util') !== -1 && f.indexOf(GALLERY_DIR) !== -1) return fakeUtil;
  if (id.indexOf('utils/security') !== -1 && f.indexOf(GALLERY_DIR) !== -1) return fakeSec;
  return origRequire.apply(this, arguments);
};

// 全局桩
let capturedSetData = null;
const appSingleton = {
  globalData: { currentTemplate: null, beadType: 'square', historyVersion: 0 }
};
global.getApp = () => appSingleton;
global.wx = {
  showShareMenu() {},
  showToast() {},
  navigateTo() {},
  createSelectorQuery() { return { select() { return this; }, fields() { return this; }, exec() {} }; }
};

let galleryObj = null;
global.Page = (o) => { galleryObj = o; };

require('../pages/gallery/gallery.js');
// 注入运行时 setData 桩（微信框架会为 Page 注入）
galleryObj.setData = (obj) => { Object.assign(galleryObj.data, obj); };

console.log('L2 展示字段脏数据钳制:');

// ---- 1) 卡片显示钳制 ----
galleryObj.loadHistory();
capturedSetData = galleryObj.data.historyList;
const dirtyCard = capturedSetData[0];
const cleanCard = capturedSetData[1];

ok('脏记录卡片 totalBeads 被钳制到 20000（非 1e20 超长串）', dirtyCard.totalBeads === 20000);
ok('脏记录卡片 colorCount 被钳制到 20000', dirtyCard.colorCount === 20000);
ok('合法记录 totalBeads 显示不变（2500）', cleanCard.totalBeads === 2500);
ok('合法记录 colorCount 显示不变（12）', cleanCard.colorCount === 12);

// ---- 1.5) L1 / L4 扩展：sizeLabel 与卡片角标维度钳制（同一 map 内与 totalBeads/colorCount 处理一致） ----
ok('L1: sizeLabel 的 physicalWidth/Height 经 clampDisplayNumber 收敛（最大传入值 ≤100000，非脏 1e20）',
  fakeUtil.formatMmCalls.length > 0 && Math.max.apply(null, fakeUtil.formatMmCalls) <= 100000);
ok('L1: 脏记录 sizeLabel 不含 1e20 超长串', !String(dirtyCard.sizeLabel).includes('1e20') && !String(dirtyCard.sizeLabel).includes('1e+20'));
ok('L4: 脏记录卡片 cols 钳制到 4096（非声明 99999999）', dirtyCard.cols === 4096);
ok('L4: 脏记录卡片 rows 保持 4（≤4096 不受影响）', dirtyCard.rows === 4);
ok('L4: 合法记录卡片 cols/rows 不变（50×50）', cleanCard.cols === 50 && cleanCard.rows === 50);

// ---- 1.6) colorPreview.percent 钳制 + 封顶 100%（同一 map 内与 totalBeads/colorCount 处理一致） ----
const recDirtyCount = capturedSetData[2];   // count=1e20, totalBeads=20000
const recDirtyTotal = capturedSetData[3];   // count=100, totalBeads=1e20
const recCleanPct  = capturedSetData[4];   // count=500, totalBeads=1000
ok('percent: 脏 count(1e20) 被钳制并封顶 100%（非 5e17% 布局异常）',
  recDirtyCount.colorPreview[0].percent === 100 &&
  isFinite(recDirtyCount.colorPreview[0].percent) &&
  !String(recDirtyCount.colorPreview[0].percent).includes('e'));
ok('percent: 反向（脏 totalBeads）不再塌缩为 0%（钳制后 100/20000×100≈1%）',
  recDirtyTotal.colorPreview[0].percent > 0 &&
  isFinite(recDirtyTotal.colorPreview[0].percent) &&
  recDirtyTotal.colorPreview[0].percent <= 100);
ok('percent: 合法占比不变（count 500 / total 1000 → 50%）',
  recCleanPct.colorPreview[0].percent === 50);
ok('percent: 全部 percent 有限且 ≤100（不存在 Infinity/NaN/e 科学计数法）',
  capturedSetData.every(c => Array.isArray(c.colorPreview) &&
    c.colorPreview.every(p => isFinite(p.percent) && p.percent <= 100 && !String(p.percent).includes('e'))));

// ---- 2) viewTemplate 写 currentTemplate 钳制 ----
galleryObj.viewTemplate({ currentTarget: { dataset: { index: 0 } } });
const ct = appSingleton.globalData.currentTemplate;
ok('currentTemplate.totalBeads 钳制到 20000', ct.totalBeads === 20000);
ok('currentTemplate.colorCount 钳制到 20000', ct.colorCount === 20000);
ok('currentTemplate.physicalWidth 钳制到 100000（mm）', ct.physicalWidth === 100000);
ok('currentTemplate.physicalHeight 钳制到 100000', ct.physicalHeight === 100000);
ok('currentTemplate.beadSize 钳制到 100000', ct.beadSize === 100000);
// 维度仍由解码矩阵驱动（M2 闭环不被破坏，脏 99999999 收敛为真实钳制维度 4096）
ok('currentTemplate.cols 仍取解码矩阵真实维度（4096，非脏 99999999）', ct.cols === 4096 && ct.rows === 4);

// ---- 3) 合法记录 viewTemplate 不被误伤 ----
// 复位路由竞态守卫：真实场景下从 template 页 navigateBack 触发 onShow 复位 _viewNavBusy，
// 否则连续两次 viewTemplate 第二次会被守卫提前 return（并非异常）。
galleryObj._viewNavBusy = false;
galleryObj.viewTemplate({ currentTarget: { dataset: { index: 1 } } });
const ct2 = appSingleton.globalData.currentTemplate;
ok('合法记录 viewTemplate 维度与字段保持不变（50×50 / 2500 / 12 / 1000mm）',
  ct2.cols === 50 && ct2.rows === 50 && ct2.totalBeads === 2500 && ct2.colorCount === 12 && ct2.physicalWidth === 1000);

console.log(`\nL2 展示字段钳制: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

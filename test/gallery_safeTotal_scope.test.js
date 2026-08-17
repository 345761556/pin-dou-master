// 回归测试：gallery.viewTemplate 第133行引用未定义变量 safeTotal 的“作用域 bug”
// 现象：safeTotal 原仅在 loadHistory 的 map 回调内为局部变量，viewTemplate 直接引用会抛 ReferenceError，
//      被外层 catch 捕获后误报“数据异常，无法查看”——每次点击历史都误报异常（功能不崩溃但体验错误）。
// 修复：在 viewTemplate 内本地定义 const safeTotal = clampDisplayNumber(item.totalBeads, DISPLAY_MAX_BEADS)。
// 本测试验证：viewTemplate 不再抛错，且 navigateTo 的 total 传参与 currentTemplate.totalBeads 钳制口径一致。

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const GALLERY_DIR = 'pages/gallery/gallery.js';
const Module = require('module');
const origRequire = Module.prototype.require;

const fakeUtil = {
  formatMm: (mm) => (typeof mm === 'number' && isFinite(mm) && mm >= 0 ? mm + ' mm' : '-'),
  calcPercent: (c, t) => (t ? Math.round((c / t) * 100) : 0),
  clampDisplayNumber: (v, max) => { const n = Number(v); if (!isFinite(n) || n < 0) return 0; return n > max ? max : n; },
  getTemplateHistory: () => ([
    {
      id: 1, cols: 99999999, rows: 4, totalBeads: 1e20, colorCount: 1e20,
      physicalWidth: 1e20, physicalHeight: 1e20, beadSize: 1e20,
      templateRLE: '__E__:16384',
      materialList: [{ color: { id: 'C01', name: '红', hex: '#FF0000' }, count: 4 }]
    },
    {
      id: 2, cols: 50, rows: 50, totalBeads: 2500, colorCount: 12,
      physicalWidth: 1000, physicalHeight: 1000, beadSize: 5,
      templateRLE: '__E__:2500',
      materialList: [{ color: { id: 'C02', name: '蓝', hex: '#0000FF' }, count: 10 }]
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

let lastNavigateUrl = null;
let toastTitle = null;
const appSingleton = {
  globalData: { currentTemplate: null, beadType: 'square', historyVersion: 0 }
};
global.getApp = () => appSingleton;
global.wx = {
  showShareMenu() {},
  showToast(o) { toastTitle = o && o.title; },
  navigateTo(o) { lastNavigateUrl = o && o.url; },
  createSelectorQuery() { return { select() { return this; }, fields() { return this; }, exec() {} }; }
};

let galleryObj = null;
global.Page = (o) => { galleryObj = o; };

require('../pages/gallery/gallery.js');
galleryObj.setData = (obj) => { Object.assign(galleryObj.data, obj); };

console.log('safeTotal 作用域回归:');

// ---- 1) 脏记录：不再抛 ReferenceError，total 钳制为 20000 ----
toastTitle = null;
lastNavigateUrl = null;
let threw = false;
try {
  galleryObj.viewTemplate({ currentTarget: { dataset: { index: 0 } } });
} catch (e) {
  threw = true;
}
ok('脏记录点击查看不抛 ReferenceError（未误报“数据异常”）', !threw);
ok('脏记录未误弹“数据异常，无法查看”toast', toastTitle !== '数据异常，无法查看');
ok('脏记录 navigateTo 被正常调用', typeof lastNavigateUrl === 'string' && lastNavigateUrl.length > 0);
ok('脏记录 URL 的 total 钳制为 20000（非 1e20）',
  lastNavigateUrl && /total=20000(&|$)/.test(lastNavigateUrl));
ok('脏记录 currentTemplate.totalBeads 钳制口径一致（20000）',
  appSingleton.globalData.currentTemplate.totalBeads === 20000);

// ---- 2) 合法记录：total 保持不变（2500） ----
// 复位路由竞态守卫：真实场景下从 template 页返回会触发 onShow 复位 _viewNavBusy
galleryObj._viewNavBusy = false;
toastTitle = null;
lastNavigateUrl = null;
threw = false;
try {
  galleryObj.viewTemplate({ currentTarget: { dataset: { index: 1 } } });
} catch (e) {
  threw = true;
}
ok('合法记录点击查看不抛 ReferenceError', !threw);
ok('合法记录 URL 的 total 保持 2500（未钳制）',
  lastNavigateUrl && /total=2500(&|$)/.test(lastNavigateUrl));
ok('合法记录 currentTemplate.totalBeads 保持 2500',
  appSingleton.globalData.currentTemplate.totalBeads === 2500);

console.log(`\nsafeTotal 作用域回归: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

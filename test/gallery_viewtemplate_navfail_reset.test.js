// 回归测试：B6 gallery.viewTemplate 的 _viewNavBusy 在 navigateTo 异步失败时无复位路径
// 现象：_viewNavBusy 在 navigateTo 前置位 true，但 wx.navigateTo 无 success/fail/complete 回调；
//       若 navigateTo 因「页面栈满 / 重复跳转」异步失败，fail 不进上方 catch，且此刻仍停留本页
//       （不触发 onShow 复位），_viewNavBusy 将永久卡 true → 后续所有点击查看都在入口守卫被拦截。
// 修复：为 wx.navigateTo 增加 fail 回调，导航失败时立即复位 _viewNavBusy（并提示）。
// 运行：node test/gallery_viewtemplate_navfail_reset.test.js
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const GALLERY_DIR = 'pages/gallery/gallery.js';
const Module = require('module');
const origRequire = Module.prototype.require;
const fs = require('fs');
const path = require('path');

const fakeUtil = {
  formatMm: (mm) => (typeof mm === 'number' && isFinite(mm) && mm >= 0 ? mm + ' mm' : '-'),
  calcPercent: (c, t) => (t ? Math.round((c / t) * 100) : 0),
  clampDisplayNumber: (v, max) => { const n = Number(v); if (!isFinite(n) || n < 0) return 0; return n > max ? max : n; },
  getTemplateHistory: () => ([{
    id: 1, cols: 50, rows: 50, totalBeads: 2500, colorCount: 12,
    physicalWidth: 1000, physicalHeight: 1000, beadSize: 5,
    templateRLE: '__E__:2500',
    materialList: [{ color: { id: 'C02', name: '蓝', hex: '#0000FF' }, count: 10 }]
  }])
};
const fakeSec = { log: { warn() {}, error() {}, info() {} }, isManagedHistorySource: () => false };
Module.prototype.require = function (id) {
  const f = this.filename ? this.filename.replace(/\\/g, '/') : '';
  if (id.indexOf('utils/util') !== -1 && f.indexOf(GALLERY_DIR) !== -1) return fakeUtil;
  if (id.indexOf('utils/security') !== -1 && f.indexOf(GALLERY_DIR) !== -1) return fakeSec;
  return origRequire.apply(this, arguments);
};

// ---- 1) 静态断言：navigateTo 带 fail 回调且 fail 内复位 _viewNavBusy ----
const galSrc = fs.readFileSync(path.join(__dirname, '..', GALLERY_DIR), 'utf8');
const navMatch = galSrc.match(/wx\.navigateTo\(\{\s*url:[\s\S]{0,500}?fail:\s*\(\)\s*=>\s*\{[\s\S]{0,260}?this\._viewNavBusy\s*=\s*false/);
ok('wx.navigateTo 携带 fail 回调', /wx\.navigateTo\(\{[\s\S]{0,500}fail:/.test(galSrc));
ok('fail 回调内复位 this._viewNavBusy = false（导航失败解除卡死）', !!navMatch);
ok('fail 回调未误用在 success 内（success 不应复位 busy，以免成功跳转后误放行连点）',
  !/success:\s*\(\)\s*=>\s*\{[\s\S]{0,120}?this\._viewNavBusy\s*=\s*false/.test(galSrc));

// ---- 2) 功能驱动：navigateTo 异步失败时 _viewNavBusy 复位、可再次点击 ----
let navCalls = 0;
let lastNavArg = null;
let toastTitle = null;
const appSingleton = { globalData: { currentTemplate: null, beadType: 'square', historyVersion: 0 } };
global.getApp = () => appSingleton;
global.wx = {
  showShareMenu() {},
  showToast(o) { toastTitle = o && o.title; },
  navigateTo(o) { navCalls++; lastNavArg = o; },
  createSelectorQuery() { return { select() { return this; }, fields() { return this; }, exec() {} }; }
};
let galleryObj = null;
global.Page = (o) => { galleryObj = o; };
delete require.cache[path.join(__dirname, '..', GALLERY_DIR)];
require(path.join(__dirname, '..', GALLERY_DIR));
galleryObj.setData = (obj) => Object.assign(galleryObj.data, obj);

// 第一次点击查看：导航成功分支（不触发 fail）
galleryObj._viewNavBusy = false;
toastTitle = null;
galleryObj.viewTemplate({ currentTarget: { dataset: { index: 0 } } });
ok('首次点击：navigateTo 被调用', navCalls === 1);
ok('首次点击：_viewNavBusy 置为 true（防连点守卫生效）', galleryObj._viewNavBusy === true);

// 模拟 navigateTo 异步失败（如页面栈满）：调用其 fail 回调
lastNavArg.fail();
ok('导航失败 fail 回调后：_viewNavBusy 复位为 false（解除卡死）', galleryObj._viewNavBusy === false);
ok('导航失败 fail 回调后：提示「打开失败，请重试」', toastTitle === '打开失败，请重试');

// 失败后再次点击查看：应正常重新发起跳转（证明不再被入口守卫拦截）
toastTitle = null;
galleryObj.viewTemplate({ currentTarget: { dataset: { index: 0 } } });
ok('失败复位后再次点击：navigateTo 被再次调用（无卡死）', navCalls === 2);
ok('失败复位后再次点击：_viewNavBusy 重新置 true（守卫仍有效）', galleryObj._viewNavBusy === true);

console.log(`\nB6 gallery navigateTo fail 复位: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

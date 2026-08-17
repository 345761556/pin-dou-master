// 回归测试：历史记录字段级脏数据兜底（修复 L2）
// 原 bug：profile.loadStats 中 m.color.id 无判空，单条缺 color 字段的记录 → onShow 抛错；
// gallery.loadHistory 若 item.materialList 是对象/字符串（脏数据）而非数组，.slice 抛错。
// 两个页面都无 try/catch 兜底，单点脏数据可拖垮页面。修复：字段级守卫（Array.isArray + 判空）。
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---- 微信运行时全局 mock ----
const dirtyHistory = [
  { date: Date.now(), totalBeads: 5, materialList: [{ color: { id: 'c1', hex: '#FF0000' }, count: 5 }] },
  { date: Date.now(), totalBeads: 3, materialList: [{ count: 3 }] },                 // 缺 color 字段
  { date: Date.now(), totalBeads: 0, materialList: 'corrupted-string' },             // 字符串脏数据（非数组）
  { date: Date.now(), totalBeads: 2, materialList: { not: 'array' } },               // 对象脏数据（非数组）
  { date: Date.now(), totalBeads: 0 }                                               // 缺 materialList 字段
];
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  getStorageSync: () => dirtyHistory,
  showToast() {},
  showShareMenu() {},
  getFileSystemManager: () => ({ copyFileSync() {}, accessSync() {} }),
  chooseMedia: () => {},
  getImageInfo: (o) => o.success && o.success({ width: 10, height: 10 })
};
global.App = () => {};
global.getApp = () => ({ globalData: {} });

// 捕获 Page 注册对象（每个模块 load 时调用一次 Page）
let captured = null;
global.Page = (o) => { captured = o; };

// 拦截重型依赖（保留真实 util，使 getTemplateHistory 用我们的 wx mock 返回脏数据）
const FAKE_IDS = {
  '../../utils/beadEngine': { renderBeads: () => ({}) },
  '../../utils/colorLibrary': {
    getCurrentPaletteKey: () => 'artkal_c', getPaletteName: () => '',
    getPaletteList: () => [], getCurrentColors: () => [], switchPalette: () => []
  },
  '../../utils/secCheck': { checkImageByPath: async () => ({ pass: true, suggest: 'pass' }) },
  '../../utils/security': {
    log: { info() {}, warn() {}, error() {} },
    isManagedHistorySource: () => false,
    isValidFilePath: () => true
  }
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (FAKE_IDS[id]) return FAKE_IDS[id];
  return origRequire.apply(this, arguments);
};

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  // profile.js
  require(path.join(root, 'pages/profile/profile.js'));
  const profileObj = captured; captured = null;
  profileObj.setData = function (obj) { Object.assign(this.data, obj); };

  // gallery.js
  require(path.join(root, 'pages/gallery/gallery.js'));
  const galleryObj = captured; captured = null;
  galleryObj.setData = function (obj) { Object.assign(this.data, obj); };

  console.log('L2 脏数据兜底:');
  let profileThrew = false;
  try {
    profileObj.loadStats();
  } catch (e) {
    profileThrew = true;
    console.log('    profile.loadStats 抛错:', e && e.message);
  }
  ok('profile.loadStats 遇脏数据不抛错', !profileThrew);
  ok('profile.loadStats 统计条数正确（5 条）', profileObj.data.totalTemplates === 5);
  ok('profile.loadStats 总拼豆数正确（10）', profileObj.data.totalBeads === 10);
  ok('profile.loadStats 仅统计有效 color.id（1 种）', profileObj.data.totalColors === 1);

  let galleryThrew = false;
  try {
    galleryObj.loadHistory();
  } catch (e) {
    galleryThrew = true;
    console.log('    gallery.loadHistory 抛错:', e && e.message);
  }
  ok('gallery.loadHistory 遇脏数据不抛错', !galleryThrew);
  ok('gallery.loadHistory 列表条数正确（5 条）', galleryObj.data.historyList.length === 5);
  ok('gallery.loadHistory 字符串/对象 materialList 不崩溃（colorPreview 为空数组）',
    galleryObj.data.historyList.every(it => Array.isArray(it.colorPreview)));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

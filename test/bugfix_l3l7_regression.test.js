/**
 * L3-L7 代码审查问题修复 专项回归测试
 *
 * 覆盖（可脚本化场景，mock wx.setStorageSync 抛错 / mock app.globalData.historyVersion）：
 *   B. 存储写入失败降级：
 *      - gallery.deleteTemplate：setStorageSync 抛错 → 不自增 historyVersion、不 toast「已删除」、
 *        仅提示「删除失败，请重试」；成功路径正常自增 + toast「已删除」。
 *      - colorLibrary.switchPalette / index.js savePrefs / onFillBackgroundChange：
 *        存储抛错时不向调用方抛异常（UI 不崩）。
 *   C. saveToHistory 的「信号与数据一致」不变量：
 *      ① 首次写入成功 → historyVersion 自增 1；
 *      ② 写入抛错且降级循环内始终失败 → 不自增；
 *      ③ 降级第 N 次尝试成功 → 自增且已 unlink 清理被挤出旧记录的原图。
 *   E. record.id 新格式为「时间戳_随机串」且两次生成不同；
 *      deleteTemplate 对存量两条同 id 记录（含不同 sourceImage 文件）能全部 unlink 并删除两条。
 *   F. profile.wxml 提示文案「点击图片查询颜色」、index.json 标题「拼豆格子」、
 *      onPickerImageTap 在 tapX=0/tapY=0 时不弹「坐标获取失败」且正常进入取色。
 *
 * 运行：node test/bugfix_l3l7_regression.test.js（node 直接可跑）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  PASS | ' + name);
    passed++;
  } catch (e) {
    console.log('  FAIL | ' + name + ' :: ' + e.message);
    failed++;
  }
}

// ================= B 专项：gallery.deleteTemplate =================
let galleryToast = null;
let galleryUnlink = [];
let gallerySaved = null;          // null = 从未写入；数组 = 写入内容
let galleryHistory = [];
let galleryFailSet = false;       // setStorageSync 是否抛错
let galleryApp = { globalData: { historyVersion: 0 } };
let galleryPage = null;

// setData mock：支持普通 key 更新（页面代码通过 this.setData 更新 data，
// 测试需读回更新后的 data 才能断言「开关状态已更新」等行为）
function setDataMock(obj) {
  const d = this.data;
  if (obj && typeof obj === 'object') {
    Object.keys(obj).forEach((k) => {
      if (k.indexOf('.') === -1) d[k] = obj[k];
    });
  }
}

function loadGallery() {
  galleryToast = null; galleryUnlink = []; gallerySaved = null;
  delete require.cache[require.resolve('../pages/gallery/gallery.js')];
  global.App = () => {};
  global.getApp = () => galleryApp;
  global.Page = (opts) => {
    galleryPage = Object.assign({}, opts, {
      setData: setDataMock,
      data: opts.data
    });
  };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => (k === 'template_history' ? JSON.parse(JSON.stringify(galleryHistory)) : null),
    setStorageSync: (k, v) => {
      if (galleryFailSet) throw new Error('quota_full');
      if (k === 'template_history') gallerySaved = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: () => {},
    getFileSystemManager: () => ({ unlinkSync: (p) => { galleryUnlink.push(p); } }),
    showModal: (opts) => { if (opts && opts.success) opts.success({ confirm: true }); },
    showToast: (o) => { galleryToast = o && o.title; },
    showShareMenu: () => {},
  };
  require('../pages/gallery/gallery.js');
}
function galleryDelete(id) {
  galleryPage.deleteTemplate({ currentTarget: { dataset: { id: id } } });
}

check('B1 gallery.deleteTemplate 存储抛错：不自增版本号 / 不误报已删除 / 提示删除失败', () => {
  loadGallery();
  galleryHistory = [{ id: 1, sourceImage: 'wxfile://usr/history_source_A.png', totalBeads: 10 }];
  galleryApp.globalData.historyVersion = 5;
  galleryFailSet = true;
  galleryDelete('1');
  assert.strictEqual(galleryToast, '删除失败，请重试', '应提示「删除失败，请重试」，实际 ' + galleryToast);
  assert.strictEqual(galleryApp.globalData.historyVersion, 5, '存储未变化时版本号不得自增');
  assert.strictEqual(gallerySaved, null, '存储失败时不得写入新历史');
});

check('B2 gallery.deleteTemplate 成功路径：自增版本号 + 已删除 toast', () => {
  loadGallery();
  galleryHistory = [{ id: 1, sourceImage: 'wxfile://usr/history_source_A.png', totalBeads: 10 }];
  galleryApp.globalData.historyVersion = 5;
  galleryFailSet = false;
  galleryDelete('1');
  assert.strictEqual(galleryToast, '已删除', '应提示「已删除」，实际 ' + galleryToast);
  assert.strictEqual(galleryApp.globalData.historyVersion, 6, '写入成功应自增 1');
  assert.ok(Array.isArray(gallerySaved) && gallerySaved.length === 0, '删除后历史应为空');
});

// ================= B 专项：index.js savePrefs / onFillBackgroundChange =================
let indexFailSet = false;
let indexApp = { globalData: { selectedPalette: 'artkal_c', historyVersion: 0 } };
let indexPage = null;
function loadIndex() {
  delete require.cache[require.resolve('../pages/index/index.js')];
  global.App = () => {};
  global.getApp = () => indexApp;
  global.Page = (opts) => {
    indexPage = Object.assign({}, opts, {
      setData: setDataMock,
      data: opts.data
    });
  };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => (k === 'template_history' ? [] : null),
    setStorageSync: () => {
      if (indexFailSet) throw new Error('quota_full');
    },
    removeStorageSync: () => {},
    getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {}, unlinkSync: () => {} }),
    showShareMenu: () => {},
    showToast: () => {},
    chooseMedia: () => {},
  };
  require('../pages/index/index.js');
}

check('B3 index.savePrefs 存储抛错时不向 UI 抛异常', () => {
  loadIndex();
  indexFailSet = true;
  indexPage.data = { beadSize: 29, beadType: 'square', colorCount: 30, useDithering: true };
  let threw = false;
  try { indexPage.savePrefs(); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'savePrefs 不应抛出存储异常');
});

check('B4 index.onFillBackgroundChange 存储抛错时不向 UI 抛异常且更新开关状态', () => {
  loadIndex();
  indexFailSet = true;
  indexPage.data = { fillBackgroundWhite: false };
  let threw = false;
  try { indexPage.onFillBackgroundChange({ detail: { value: true } }); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'onFillBackgroundChange 不应抛出存储异常');
  assert.strictEqual(indexPage.data.fillBackgroundWhite, true, '开关状态应正常更新');
});

// ================= B 专项：colorLibrary.switchPalette =================
// P2-2 修复后：存储失败时内存回退到切换前值、返回 [] 阻止 UI 切换（避免"UI 已切但冷启动回跳"的不一致）。
// 原测试断言"返回新色卡数组 + 内存已切换"反映的是旧行为，已不符合新语义。
check('B5 colorLibrary.switchPalette 存储抛错时不抛异常且内存回退', () => {
  const libApp = {
    globalData: {
      selectedPalette: 'artkal_c',
      colorLibraries: { artkal_c: [{ id: 'c1', hex: '#FFFFFF' }], neko: [{ id: 'n1', hex: '#000000' }] },
      colorLibraryMeta: []
    }
  };
  global.getApp = () => libApp;
  global.wx = { setStorageSync: () => { throw new Error('quota_full'); } };
  const colorLib = require('../utils/colorLibrary.js');
  let threw = false;
  let colors = null;
  try { colors = colorLib.switchPalette('neko'); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'switchPalette 不应抛出存储异常');
  assert.ok(Array.isArray(colors) && colors.length === 0, '存储失败应返回空数组阻止 UI 切换');
  assert.strictEqual(libApp.globalData.selectedPalette, 'artkal_c', '内存全局色卡应回退到切换前值（与 storage 一致）');
});

// ================= C 专项 + E id 格式：index.saveToHistory =================
let idxHistory = [];          // getStorageSync 返回的存量历史
let idxWritten = null;        // 最后一次成功写入的历史
let idxFailCalls = 0;         // 前 N 次 setStorageSync 抛错
let idxUnlink = [];
let idxStorageCalls = 0;
let idxApp = { globalData: { selectedPalette: 'artkal_c', historyVersion: 0 } };
let idxPage = null;
function loadIdxForHistory() {
  delete require.cache[require.resolve('../pages/index/index.js')];
  global.App = () => {};
  global.getApp = () => idxApp;
  global.Page = (opts) => {
    idxPage = Object.assign({}, opts, {
      setData: setDataMock,
      data: opts.data
    });
  };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => (k === 'template_history' ? JSON.parse(JSON.stringify(idxHistory)) : null),
    setStorageSync: (k, v) => {
      idxStorageCalls++;
      if (idxFailCalls > 0) { idxFailCalls--; throw new Error('quota_full'); }
      if (k === 'template_history') {
        // 模拟真实持久化：写入后 getStorageSync 能读到（saveToHistory 连续调用依赖此联动）
        idxHistory = JSON.parse(JSON.stringify(v));
        idxWritten = JSON.parse(JSON.stringify(v));
      }
    },
    removeStorageSync: () => {},
    getFileSystemManager: () => ({
      copyFileSync: () => {},
      accessSync: () => {},
      unlinkSync: (p) => { idxUnlink.push(p); }
    }),
    showShareMenu: () => {},
    showToast: () => {},
    chooseMedia: () => {},
  };
  require('../pages/index/index.js');
}
function makeTemplateData() {
  return {
    cols: 2, rows: 2, totalBeads: 4, colorCount: 2, beadSize: 29,
    physicalWidth: 58, physicalHeight: 58,
    materialList: [
      { id: 'c1', name: '白', count: 2, color: { id: 'c1', name: '白', hex: '#FFFFFF', r: 255, g: 255, b: 255 } }
    ],
    template: [['c1', null], [null, 'c1']]
  };
}
function oldRecord(i) {
  return {
    id: 1700000000000 + i,
    date: '2026-01-01T00:00:00.000Z',
    cols: 1, rows: 1, totalBeads: 1, colorCount: 1, beadSize: 29,
    materialList: [],
    templateRLE: 'x:1',
    sourceImage: 'wxfile://usr/history_source_old' + i + '.png'
  };
}

check('C1 saveToHistory 首次写入成功 → historyVersion 自增 1', () => {
  loadIdxForHistory();
  idxHistory = [];
  idxApp.globalData.historyVersion = 0;
  idxFailCalls = 0; idxWritten = null;
  idxPage.data.imagePath = 'wxfile://tmp_test.png';
  idxPage.saveToHistory(makeTemplateData());
  assert.strictEqual(idxApp.globalData.historyVersion, 1, '写入成功应自增 1，实际 ' + idxApp.globalData.historyVersion);
  assert.ok(idxWritten && idxWritten.length === 1, '历史应有 1 条记录');
});

check('C2 saveToHistory 写入始终失败（降级循环内也失败）→ 不自增且保留原图文件（避免悬空引用）', () => {
  loadIdxForHistory();
  idxHistory = [oldRecord(1), oldRecord(2), oldRecord(3)];
  idxApp.globalData.historyVersion = 0;
  idxFailCalls = 100;   // 首次 try + while 循环内重试 + 最后兜底全部抛错
  idxWritten = null; idxUnlink = []; idxStorageCalls = 0;
  idxPage.data.imagePath = 'wxfile://tmp_test.png';
  idxPage.saveToHistory(makeTemplateData());
  assert.strictEqual(idxApp.globalData.historyVersion, 0, '全部失败时版本号不得自增');
  assert.strictEqual(idxWritten, null, '从未写入成功，不得伪造写入结果');
  assert.ok(idxStorageCalls >= 4, '应发生多次写入尝试（首次+降级循环+兜底），实际 ' + idxStorageCalls);
  // #4b 修复后：写入全失败时，被挤出旧记录（toUnlink）的原图不被消费——
  // 否则存储仍含记录却已删除其原图 → 历史页「对照原图」打开空白（悬空引用）。
  // M2 修复后：当前新记录刚复制的 sourceImage 已无任何引用（从未写入成功），
  // 必须作为孤儿立即回收，避免配额满时反复生成模板线性累积（见 M2 文件孤儿治理）。
  const OLD_IMAGES = ['wxfile://usr/history_source_old1.png','wxfile://usr/history_source_old2.png','wxfile://usr/history_source_old3.png'];
  OLD_IMAGES.forEach(p => assert.ok(!idxUnlink.includes(p), '全部写入失败时不得删除旧记录原图（避免悬空引用）: ' + p));
  assert.strictEqual(idxUnlink.length, 1, '全部写入失败时仅应回收当前孤儿原图 1 个，实际 ' + idxUnlink.length);
  assert.ok(String(idxUnlink[0]).indexOf('history_source_') !== -1 && OLD_IMAGES.indexOf(idxUnlink[0]) === -1, '被删的应为当前新记录孤儿原图（非旧记录）');
});

check('C3 saveToHistory 降级第 N 次尝试成功 → 自增且已清理对应旧记录', () => {
  loadIdxForHistory();
  idxHistory = [oldRecord(1), oldRecord(2), oldRecord(3)];
  idxApp.globalData.historyVersion = 0;
  idxFailCalls = 2;    // 第 1 次 try 抛错、第 2 次（pop 后）抛错、第 3 次成功
  idxWritten = null; idxUnlink = [];
  idxPage.data.imagePath = 'wxfile://tmp_test.png';
  idxPage.saveToHistory(makeTemplateData());
  assert.strictEqual(idxApp.globalData.historyVersion, 1, '最终写入成功应自增 1');
  assert.ok(idxWritten && idxWritten.length === 2, '降级成功后应保留 2 条（新记录 + 最旧 1 条），实际 ' + (idxWritten && idxWritten.length));
  assert.ok(idxUnlink.includes('wxfile://usr/history_source_old3.png'), '被挤出最旧记录3 原图应被 unlink');
  assert.ok(idxUnlink.includes('wxfile://usr/history_source_old2.png'), '被挤出记录2 原图应被 unlink');
  assert.ok(!idxUnlink.includes('wxfile://usr/history_source_old1.png'), '未被挤出的记录1 原图不应被 unlink');
});

check('E1 record.id 为「时间戳_随机串」格式且两次生成不同', () => {
  loadIdxForHistory();
  idxHistory = [];
  idxApp.globalData.historyVersion = 0;
  idxFailCalls = 0; idxWritten = null;
  idxPage.data.imagePath = 'wxfile://tmp_test.png';
  idxPage.saveToHistory(makeTemplateData());
  idxPage.saveToHistory(makeTemplateData());
  const ids = (idxWritten || []).map(r => r.id);
  assert.strictEqual(ids.length, 2, '应写入 2 条记录');
  ids.forEach(id => {
    assert.ok(/^\d+_[a-z0-9]{6}$/.test(id), 'id 格式应为 时间戳_6位随机串，实际 ' + id);
  });
  assert.notStrictEqual(ids[0], ids[1], '两次生成的 id 不得相同');
  // 数据与信号一致：写入 2 次成功 → 版本号自增 2
  assert.strictEqual(idxApp.globalData.historyVersion, 2, '两次成功写入版本号应自增 2');
});

// ================= E 专项：gallery.deleteTemplate 同 id 多删 =================
check('E2 deleteTemplate 对存量两条同 id 记录（不同 sourceImage）全部 unlink 并删除', () => {
  loadGallery();
  galleryHistory = [
    { id: 1710000000001, sourceImage: 'wxfile://usr/history_source_X.png', totalBeads: 10 },
    { id: '1710000000001', sourceImage: 'http://tmp/history_source_Y.png', totalBeads: 20 },
    { id: 1710000000002, sourceImage: 'wxfile://usr/history_source_Z.png', totalBeads: 30 }
  ];
  galleryApp.globalData.historyVersion = 0;
  galleryFailSet = false;
  galleryDelete('1710000000001');
  assert.ok(Array.isArray(gallerySaved) && gallerySaved.length === 1, '应仅剩 1 条，实际 ' + (gallerySaved && gallerySaved.length));
  assert.strictEqual(gallerySaved[0].id, 1710000000002, '剩余应为不同 id 的记录');
  assert.ok(galleryUnlink.includes('wxfile://usr/history_source_X.png'), '同 id 记录1 原图应被 unlink');
  assert.ok(galleryUnlink.includes('http://tmp/history_source_Y.png'), '同 id 记录2 原图应被 unlink');
  assert.ok(!galleryUnlink.includes('wxfile://usr/history_source_Z.png'), '不同 id 记录原图不应被误删');
  assert.strictEqual(galleryToast, '已删除');
});

// ================= F 专项：文案 / 标题 / onPickerImageTap 0 坐标 =================
check('F1 profile.wxml 提示文案为「点击图片查询颜色」', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.wxml'), 'utf8');
  assert.ok(wxml.includes('点击图片查询颜色'), 'wxml 应包含新提示文案');
});

check('F2 index.json 导航标题为「拼豆格子」', () => {
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.json'), 'utf8'));
  assert.strictEqual(json.navigationBarTitleText, '拼豆格子');
});

let profileToast = null;
let profilePickCalls = [];
let profilePage = null;
function loadProfile() {
  profileToast = null; profilePickCalls = [];
  delete require.cache[require.resolve('../pages/profile/profile.js')];
  global.App = () => {};
  global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
  global.Page = (opts) => {
    profilePage = Object.assign({}, opts, {
      setData: setDataMock,
      data: opts.data
    });
  };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (o) => { profileToast = o && o.title; },
    showModal: () => {},
    createSelectorQuery: () => ({
      select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }),
      fields: () => ({ exec: () => {} }),
      exec: () => {}
    }),
    getFileSystemManager: () => ({ copyFileSync: () => {}, unlinkSync: () => {} }),
    chooseMedia: () => {},
    getImageInfo: () => {},
  };
  require('../pages/profile/profile.js');
}

check('F3 onPickerImageTap tapX=0/tapY=0 不弹「坐标获取失败」且正常进入取色', () => {
  loadProfile();
  profilePage.data = { pickerImagePath: 'wxfile://tmp_pick.png', pickerImageInfo: { width: 100, height: 100 } };
  profilePage.pickColorAtPoint = (x, y) => { profilePickCalls.push([x, y]); };
  profilePage.onPickerImageTap({ touches: [{ clientX: 0, clientY: 0 }] });
  assert.notStrictEqual(profileToast, '坐标获取失败', '坐标 0 是合法值，不得误报');
  assert.deepStrictEqual(profilePickCalls, [[0, 0]], '应以 (0,0) 进入取色');
});

check('F4 onPickerImageTap 无 touch 时提示「坐标获取失败」', () => {
  loadProfile();
  profilePage.data = { pickerImagePath: 'wxfile://tmp_pick.png', pickerImageInfo: { width: 100, height: 100 } };
  profilePage.pickColorAtPoint = (x, y) => { profilePickCalls.push([x, y]); };
  profilePage.onPickerImageTap({ touches: [] });
  assert.strictEqual(profileToast, '坐标获取失败');
  assert.strictEqual(profilePickCalls.length, 0, '无坐标时不得进入取色');
});

check('F5 onPickerImageTap touch.clientX 缺失时提示「坐标获取失败」', () => {
  loadProfile();
  profilePage.data = { pickerImagePath: 'wxfile://tmp_pick.png', pickerImageInfo: { width: 100, height: 100 } };
  profilePage.pickColorAtPoint = (x, y) => { profilePickCalls.push([x, y]); };
  profilePage.onPickerImageTap({ touches: [{ clientY: 5 }] });
  assert.strictEqual(profileToast, '坐标获取失败');
  assert.strictEqual(profilePickCalls.length, 0);
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);

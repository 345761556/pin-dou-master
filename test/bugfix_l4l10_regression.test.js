/**
 * L4-L10 代码审查低危健壮性缺口 专项回归测试（#10b 经评估无功能收益，本次跳过）
 *
 * 覆盖（可脚本化场景）：
 *   #4  先删文件后写存储 → 写入失败留悬空引用
 *        - gallery.deleteTemplate：setStorageSync 抛错 → 匹配项原图不被 unlink；
 *          写入成功 → 之后才 unlink。
 *        - index.saveToHistory：setStorageSync 抛错 → 被挤出记录原图不被 unlink（toUnlink 未消费）。
 *   #6  template_history 脏数据防护：getTemplateHistory 对 string/object 返回 [] 且不抛错；
 *        5 处读取点静态确认改用 helper。
 *   #7  二次分享先删旧图后存新图 → 存失败 shareImagePath 悬空：
 *        shareTemplate 新图持久化失败 → shareImagePath 清空、旧图不被删。
 *   #8  取色依赖 e.touches[0]：e.touches 空但 changedTouches 有值 → 取到坐标。
 *   #9  chooseImage 列数钳制缺 MAX_ROWS/aspect：极端竖图下 templateCols 与 updateEstimate 同源一致。
 *   #10c readImageSize 字符串数字未校验：收到字符串数字 width → reject（走失败分支）。
 *
 * 运行：node test/bugfix_l4l10_regression.test.js（node 直接可跑）
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
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
function setDataMock(obj) {
  const d = this.data;
  if (obj && typeof obj === 'object') {
    Object.keys(obj).forEach((k) => { if (k.indexOf('.') === -1) d[k] = obj[k]; });
  }
}

// ================= #4 专项：gallery.deleteTemplate =================
let gToast = null, gUnlink = [], gSaved = null, gHistory = [], gFailSet = false, gApp = { globalData: { historyVersion: 0 } }, gPage = null;
function loadGallery() {
  gToast = null; gUnlink = []; gSaved = null;
  delete require.cache[require.resolve(path.join(root, 'pages/gallery/gallery.js'))];
  global.App = () => {};
  global.getApp = () => gApp;
  global.Page = (opts) => { gPage = Object.assign({}, opts, { setData: setDataMock, data: opts.data }); };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => (k === 'template_history' ? JSON.parse(JSON.stringify(gHistory)) : null),
    setStorageSync: (k, v) => {
      if (gFailSet) throw new Error('quota_full');
      if (k === 'template_history') gSaved = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: () => {},
    getFileSystemManager: () => ({ unlinkSync: (p) => { gUnlink.push(p); } }),
    showModal: (opts) => { if (opts && opts.success) opts.success({ confirm: true }); },
    showToast: (o) => { gToast = o && o.title; },
    showShareMenu: () => {}
  };
  require(path.join(root, 'pages/gallery/gallery.js'));
}
function galleryDelete(id) { gPage.deleteTemplate({ currentTarget: { dataset: { id: id } } }); }

check('#4a gallery.deleteTemplate 写入失败 → 匹配项原图不被 unlink（避免悬空引用）', () => {
  loadGallery();
  gHistory = [
    { id: 1, sourceImage: 'wxfile://usr/history_source_A.png', totalBeads: 10 },
    { id: 1, sourceImage: 'wxfile://usr/history_source_B.png', totalBeads: 20 }
  ];
  gApp.globalData.historyVersion = 5;
  gFailSet = true;
  galleryDelete('1');
  assert.strictEqual(gToast, '删除失败，请重试', '应提示「删除失败，请重试」');
  assert.strictEqual(gApp.globalData.historyVersion, 5, '存储未变化，版本号不得自增');
  assert.strictEqual(gSaved, null, '存储失败时不得写入新历史');
  assert.deepStrictEqual(gUnlink, [], '写入失败不得删除任何原图文件（避免悬空引用）');
});

check('#4a gallery.deleteTemplate 写入成功 → 之后才 unlink 匹配项原图', () => {
  loadGallery();
  gHistory = [{ id: 1, sourceImage: 'wxfile://usr/history_source_A.png', totalBeads: 10 }];
  gApp.globalData.historyVersion = 5;
  gFailSet = false;
  galleryDelete('1');
  assert.strictEqual(gToast, '已删除', '应提示「已删除」');
  assert.strictEqual(gApp.globalData.historyVersion, 6, '写入成功应自增 1');
  assert.ok(Array.isArray(gSaved) && gSaved.length === 0, '删除后历史应为空');
  assert.deepStrictEqual(gUnlink, ['wxfile://usr/history_source_A.png'], '写入成功后才删除原图文件');
});

// ================= #4 专项：index.saveToHistory =================
let iHistory = [], iWritten = null, iFailCalls = 0, iUnlink = [], iStorageCalls = 0, iApp = { globalData: { selectedPalette: 'artkal_c', historyVersion: 0 } }, iPage = null;
function loadIdxHistory() {
  delete require.cache[require.resolve(path.join(root, 'pages/index/index.js'))];
  global.App = () => {};
  global.getApp = () => iApp;
  global.Page = (opts) => { iPage = Object.assign({}, opts, { setData: setDataMock, data: opts.data }); };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => (k === 'template_history' ? JSON.parse(JSON.stringify(iHistory)) : null),
    setStorageSync: (k, v) => {
      iStorageCalls++;
      if (iFailCalls > 0) { iFailCalls--; throw new Error('quota_full'); }
      if (k === 'template_history') { iHistory = JSON.parse(JSON.stringify(v)); iWritten = JSON.parse(JSON.stringify(v)); }
    },
    removeStorageSync: () => {},
    getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {}, unlinkSync: (p) => { iUnlink.push(p); } }),
    showShareMenu: () => {}, showToast: () => {}, chooseMedia: () => {}
  };
  require(path.join(root, 'pages/index/index.js'));
}
function mkTemplateData() {
  return {
    cols: 2, rows: 2, totalBeads: 4, colorCount: 2, beadSize: 29,
    physicalWidth: 58, physicalHeight: 58,
    materialList: [{ id: 'c1', name: '白', count: 2, color: { id: 'c1', name: '白', hex: '#FFFFFF' } }],
    template: [['c1', null], [null, 'c1']]
  };
}
function oldRecord(i) {
  return {
    id: 1700000000000 + i, date: '2026-01-01T00:00:00.000Z',
    cols: 1, rows: 1, totalBeads: 1, colorCount: 1, beadSize: 29,
    materialList: [], templateRLE: 'x:1',
    sourceImage: 'wxfile://usr/history_source_old' + i + '.png'
  };
}

check('#4b index.saveToHistory 写入始终失败 → 被挤出记录原图不被 unlink（避免悬空引用）', () => {
  loadIdxHistory();
  iHistory = [oldRecord(1), oldRecord(2), oldRecord(3)];
  iFailCalls = 100; iWritten = null; iUnlink = []; iStorageCalls = 0;
  iPage.data.imagePath = 'wxfile://tmp_test.png';
  iPage.saveToHistory(mkTemplateData());
  assert.strictEqual(iApp.globalData.historyVersion, 0, '全部失败时版本号不得自增');
  assert.strictEqual(iWritten, null, '从未写入成功，不得伪造写入结果');
  assert.ok(iStorageCalls >= 4, '应发生多次写入尝试，实际 ' + iStorageCalls);
  // toUnlink（被挤出旧记录）的原图不得被删（否则存储仍含记录却已删其原图 → 悬空引用）；
  // 但 M2 修复后，当前新记录刚复制的孤儿 sourceImage 应被立即回收（防反复失败累积）。
  const OLD_IMAGES = ['wxfile://usr/history_source_old1.png','wxfile://usr/history_source_old2.png','wxfile://usr/history_source_old3.png'];
  OLD_IMAGES.forEach(p => assert.ok(!iUnlink.includes(p), '所有写入均失败时不得删除旧记录原图（避免悬空引用）: ' + p));
  assert.strictEqual(iUnlink.length, 1, '所有写入均失败时仅应回收当前孤儿原图 1 个，实际 ' + iUnlink.length);
  assert.ok(String(iUnlink[0]).indexOf('history_source_') !== -1 && OLD_IMAGES.indexOf(iUnlink[0]) === -1, '被删的应为当前新记录孤儿原图（非旧记录）');
});

// ================= #6 专项：getTemplateHistory 脏数据防护 =================
function requireUtilFresh() {
  delete require.cache[require.resolve(path.join(root, 'utils/util.js'))];
  delete require.cache[require.resolve(path.join(root, 'utils/security.js'))];
  global.App = () => {};
  global.getApp = () => ({ globalData: {} });
  global.wx = {
    getStorageSync: (k) => (k === 'template_history' ? currentRaw : null),
    getFileSystemManager: () => ({ unlinkSync: () => {}, copyFileSync: () => {}, accessSync: () => {} }),
    getLogManager: () => ({ warn() {}, info() {}, error() {}, log() {} })
  };
  return require(path.join(root, 'utils/util.js'));
}
let currentRaw = null;
check('#6a getTemplateHistory 脏数据(string) → 返回 [] 且不抛错', () => {
  currentRaw = 'not_an_array';
  const util = requireUtilFresh();
  let res = null, threw = false;
  try { res = util.getTemplateHistory(); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, '脏数据不得导致白屏抛错');
  assert.deepStrictEqual(res, [], 'string 脏数据应回退为 []');
});
check('#6a getTemplateHistory 脏数据(object) → 返回 [] 且不抛错', () => {
  currentRaw = { foo: 1 };
  const util = requireUtilFresh();
  let res = null, threw = false;
  try { res = util.getTemplateHistory(); } catch (e) { threw = true; }
  assert.strictEqual(threw, false);
  assert.deepStrictEqual(res, []);
});
check('#6a getTemplateHistory 合法数组 → 原样透传', () => {
  const arr = [{ id: 1 }];
  currentRaw = arr;
  const util = requireUtilFresh();
  assert.strictEqual(util.getTemplateHistory(), arr, '合法数组应原样返回引用');
});

// #6b 静态：5 处读取点改用 getTemplateHistory()
const idxSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const galSrc = fs.readFileSync(path.join(root, 'pages/gallery/gallery.js'), 'utf8');
const proSrc = fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8');
check('#6b 源码：三页 require 均引入 getTemplateHistory', () => {
  assert.ok(/getTemplateHistory/.test(idxSrc), 'index.js 应解构导入 getTemplateHistory');
  assert.ok(/getTemplateHistory/.test(galSrc), 'gallery.js 应解构导入 getTemplateHistory');
  assert.ok(/getTemplateHistory/.test(proSrc), 'profile.js 应解构导入 getTemplateHistory');
});
check('#6b 源码：读取点不再用 getStorageSync(template_history) || []', () => {
  const livePoints = (galSrc.match(/getStorageSync\('template_history'\)/g) || []).length;
  assert.strictEqual(livePoints, 0, 'gallery.js 不应再有裸 getStorageSync(template_history) 读取点，实际 ' + livePoints);
  assert.strictEqual((proSrc.match(/getStorageSync\('template_history'\)/g) || []).length, 0, 'profile.js 不应再有裸读取点');
  assert.strictEqual((idxSrc.match(/getStorageSync\('template_history'\)/g) || []).length, 0, 'index.js 不应再有裸读取点');
});

// ================= #8 专项：onPickerImageTap changedTouches 兜底 =================
let pToast = null, pPick = [], pPage = null;
function loadProfile() {
  pToast = null; pPick = [];
  delete require.cache[require.resolve(path.join(root, 'pages/profile/profile.js'))];
  global.App = () => {};
  global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
  global.Page = (opts) => { pPage = Object.assign({}, opts, { setData: setDataMock, data: opts.data }); };
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {},
    showToast: (o) => { pToast = o && o.title; }, showModal: () => {},
    createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }), fields: () => ({ exec: () => {} }), exec: () => {} }),
    getFileSystemManager: () => ({ copyFileSync: () => {}, unlinkSync: () => {} }),
    chooseMedia: () => {}, getImageInfo: () => {}
  };
  require(path.join(root, 'pages/profile/profile.js'));
}
check('#8 onPickerImageTap e.touches 空但 changedTouches 有值 → 取到坐标（不误报坐标获取失败）', () => {
  loadProfile();
  pPage.data = { pickerImagePath: 'wxfile://tmp_pick.png', pickerImageInfo: { width: 100, height: 100 } };
  pPage.pickColorAtPoint = (x, y) => { pPick.push([x, y]); };
  pPage.onPickerImageTap({ touches: [], changedTouches: [{ clientX: 5, clientY: 7 }] });
  assert.notStrictEqual(pToast, '坐标获取失败', 'changedTouches 兜底，不得误报坐标获取失败');
  assert.deepStrictEqual(pPick, [[5, 7]], '应以 (5,7) 进入取色');
});

// ================= 异步专项：#7 / #9 / #10c =================
const secCheckPath = path.resolve(root, 'utils/secCheck.js');
const colorLibPath = path.resolve(root, 'utils/colorLibrary.js');

(async () => {
  // ---------- #7 shareTemplate：持久化失败分支 ----------
  let sApp = { globalData: { selectedPalette: 'artkal_c', shareImagePath: '' },
    resetTemplateState: (opts) => {
      if (opts.clearShareFile !== false) sApp.globalData.shareImagePath = '';
      if (opts.clearCurrentTemplate !== false) sApp.globalData.currentTemplate = null;
    }
  }, sPage = null, sUnlink = [], sShareToast = null;
  (function loadTemplate() {
    delete require.cache[require.resolve(path.join(root, 'pages/template/template.js'))];
    sUnlink = []; sShareToast = null;
    global.App = () => {};
    global.getApp = () => sApp;
    global.Page = (opts) => { sPage = Object.assign({}, opts, { setData: setDataMock, data: opts.data }); };
    global.wx = {
      env: { USER_DATA_PATH: 'wxfile://usr' },
      showLoading: () => {}, hideLoading: () => {},
      showToast: (o) => { sShareToast = o && o.title; },
      showShareMenu: () => {}, showModal: () => {},
      // 模拟持久化失败（配额满）：saveFile 直接走 fail 回调
      getFileSystemManager: () => ({
        saveFile: ({ fail }) => { if (typeof fail === 'function') fail(new Error('quota_full')); },
        unlinkSync: (p) => { sUnlink.push(p); },
        copyFileSync: () => {}, accessSync: () => {}
      })
    };
    require(path.join(root, 'pages/template/template.js'));
  })();
  sApp.globalData.shareImagePath = 'wxfile://usr/bead_share_old.png';
  sPage._templateData = { cols: 2, rows: 2 };
  // 跳过真实 canvas 导出，直接给出临时图路径
  sPage._generateExportImage = async () => 'wxfile://tmp_fake.png';
  try { await sPage.shareTemplate(); } catch (e) { /* 外层已捕获并 toast */ }
  check('#7 shareTemplate 新图持久化失败 → shareImagePath 清空且旧图不被删（避免悬空引用）', () => {
    assert.strictEqual(sApp.globalData.shareImagePath, '', '持久化失败应清空 shareImagePath（让微信回退默认截图）');
    assert.ok(!sUnlink.includes('wxfile://usr/bead_share_old.png'), '失败分支不得删除旧分享图');
    assert.strictEqual(sShareToast, '制作分享图失败，请重试', '应提示分享失败');
  });

  // ---------- #9 chooseImage 列数钳制与 updateEstimate 同源 ----------
  let colsPage = null, dims9 = {}, clampSpyCalls = [];
  (function loadIndexForCols() {
    dims9 = {}; clampSpyCalls = [];
    delete require.cache[require.resolve(path.join(root, 'pages/index/index.js'))];
    global.App = () => {};
    global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
    require.cache[colorLibPath] = { id: colorLibPath, filename: colorLibPath, loaded: true, exports: {
      getCurrentPaletteKey: () => 'artkal_c', getPaletteName: () => 'ArtKal C', getPaletteList: () => [],
      getCurrentColors: () => [], switchPalette: () => []
    } };
    require.cache[secCheckPath] = { id: secCheckPath, filename: secCheckPath, loaded: true, exports: {
      checkImageByPath: async () => ({ pass: true })
    } };
    global.wx = {
      env: { USER_DATA_PATH: 'x' },
      getImageInfo({ src, success }) { success(dims9[src] || { width: 100, height: 100 }); },
      createSelectorQuery() { const q = { select() { return q; }, fields() { return q; }, exec(cb) { cb([{}]); } }; return q; },
      chooseMedia({ success }) { chooseMediaSuccess9 = success; },
      showToast() {}, showShareMenu() {}, getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {}, unlinkSync: () => {} })
    };
    global.Page = (o) => { colsPage = Object.assign({}, o, { setData: function (obj) { Object.assign(this.data, obj); }, data: o.data }); };
    const util = require(path.join(root, 'utils/util.js'));
    const orig = util.clampTemplateSize;
    util.clampTemplateSize = function (cols, rows, maxPixels, maxRows, aspect) {
      clampSpyCalls.push({ cols, rows, maxPixels, maxRows, aspect });
      return orig(cols, rows, maxPixels, maxRows, aspect);
    };
    require(path.join(root, 'pages/index/index.js'));
  })();
  let chooseMediaSuccess9 = null;
  async function pick9(src, w, h) {
    dims9[src] = { width: w, height: h };
    colsPage.data.templateCols = 50;
    colsPage.data.imageSize = { width: 0, height: 0 };
    colsPage.chooseImage();
    chooseMediaSuccess9({ tempFiles: [{ tempFilePath: src, size: 100, fileType: 'image' }] });
    return new Promise((r) => setTimeout(r, 60));
  }

  await pick9('wxfile://tmp_v5.png', 100, 500); // aspect=5
  const util9 = require(path.join(root, 'utils/util.js'));
  const expectedMax = util9.clampTemplateSize(50, 250, util9.MAX_PIXELS, util9.MAX_ROWS, 5).cols; // 24
  const expectedCols = Math.max(util9.CONSTANTS.MIN_COLS, Math.min(util9.CONSTANTS.MAX_COLS, Math.min(50, expectedMax)));
  const got = colsPage.data.templateCols;
  console.log('    竖图(100x500, aspect=5) -> templateCols =', got, ' (期望', expectedCols, ')');
  check('#9 chooseImage 极端竖图 templateCols 与 updateEstimate 同源钳制一致', () => {
    assert.strictEqual(got, expectedCols, 'templateCols 应等于同源 clampTemplateSize+二次钳制结果');
  });
  check('#9 chooseImage 与 updateEstimate 均向 clampTemplateSize 传入 MAX_ROWS+aspect', () => {
    const chooseCall = clampSpyCalls.find((c) => c.cols === 50 && c.rows === 250);
    assert.ok(chooseCall, 'chooseImage 应调用 clampTemplateSize(50,250,...)');
    assert.strictEqual(chooseCall.maxRows, util9.MAX_ROWS, 'chooseImage 应传入 MAX_ROWS');
    assert.strictEqual(chooseCall.aspect, 5, 'chooseImage 应传入 aspect=5');
    clampSpyCalls = [];
    colsPage.updateEstimate();
    const estCall = clampSpyCalls.find((c) => c.aspect === 5);
    assert.ok(estCall, 'updateEstimate 应调用 clampTemplateSize(... aspect=5)');
    assert.strictEqual(estCall.maxRows, util9.MAX_ROWS, 'updateEstimate 应传入 MAX_ROWS（同源）');
  });

  // ---------- #10c readImageSize 字符串数字未校验 ----------
  let risCalls = 0, cPage = null, chooseMediaSuccessC = null;
  global.wx = {
    env: { USER_DATA_PATH: 'x' },
    getImageInfo({ src, success, fail }) {
      risCalls++;
      if (risCalls === 1) { success({ width: 1000, height: 1000, type: 'png' }); return; } // validate 通过（数值）
      if (risCalls === 2) { if (fail) fail(new Error('compress_no_info')); return; }        // 压缩失败 → 触发 readImageSize
      success({ width: '800', height: '800', type: 'png' });                              // readImageSize 收到字符串数字
    },
    createSelectorQuery() { const q = { select() { return q; }, fields() { return q; }, exec(cb) { cb([{}]); } }; return q; },
    chooseMedia({ success }) { chooseMediaSuccessC = success; },
    showToast() {}, showShareMenu() {}, getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {}, unlinkSync: () => {} })
  };
  global.Page = (o) => { cPage = Object.assign({}, o, { setData: function (obj) { Object.assign(this.data, obj); }, data: o.data }); };
  delete require.cache[require.resolve(path.join(root, 'pages/index/index.js'))];
  require(path.join(root, 'pages/index/index.js'));
  await new Promise((resolve) => {
    cPage.data.templateCols = 50;
    cPage.data.imageSize = { width: 0, height: 0 };
    cPage.chooseImage();
    chooseMediaSuccessC({ tempFiles: [{ tempFilePath: 'wxfile://tmp_c.png', size: 100, fileType: 'image' }] });
    setTimeout(resolve, 80);
  });
  check('#10c readImageSize 收到字符串数字 width → reject（imageSize 回退 {0,0} 不带入字符串）', () => {
    const img = cPage.data.imageSize;
    assert.ok(img && img.width === 0 && img.height === 0, '字符串数字应被守卫 reject，processed 回退为 {0,0}，实际 ' + JSON.stringify(img));
  });
  const idxSrc2 = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
  check('#10c 源码：readImageSize 含 typeof width/height !== number 守卫', () => {
    assert.ok(/typeof width !== 'number' \|\| typeof height !== 'number'/.test(idxSrc2), 'readImageSize 应增加 typeof number 守卫');
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();

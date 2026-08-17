// test/file_orphan_cleanup.test.js
// 中危 Bug 回归：会话内失败残留清理
//   M1: pages/template/template.js saveTemplate —— 相册保存失败时清理 bead_export_*.png
//   M2: pages/index/index.js saveToHistory —— 历史存储写入失败时回收 history_source_* 孤儿原图
//   M2: utils/util.js gcBeadTempFiles —— 启动兜底清理孤儿 history_source_*（仅删无记录引用的）
//
// 通过 mock wx + require-cache 桩替换 app.js/secCheck，干净加载 page 模块做行为级断言。
// 运行：node test/file_orphan_cleanup.test.js

'use strict';
const path = require('path');

// ---------- 内存文件系统 + wx mock ----------
const UD = '/userdata';
let fsStore = {};          // 完整路径 -> true（存在）
let storage = {};          // 存储 key -> value
let storageThrow = false;  // 模拟 setStorageSync 抛错（配额满）
let albumFail = false;     // M1 模拟相册保存失败

function makeManager() {
  return {
    saveFile({ filePath, success }) {
      fsStore[filePath] = true;
      if (success) success({ savedFilePath: filePath });
    },
    unlinkSync(p) {
      if (fsStore[p]) { delete fsStore[p]; }
      else { const e = new Error('no such file'); e.errMsg = 'unlinkSync:fail'; throw e; }
    },
    copyFileSync(src, dest) { fsStore[dest] = true; },
    accessSync(p) {
      if (!fsStore[p]) { const e = new Error('no such file'); e.errMsg = 'accessSync:fail'; throw e; }
    },
    readdirSync(dir) {
      const base = dir.endsWith('/') ? dir : dir + '/';
      return Object.keys(fsStore).filter(k => k.indexOf(base) === 0).map(k => k.slice(base.length));
    },
    statSync() { return { size: 1024 }; },
  };
}

global.__wxConfig = undefined; // 使 security 的 IS_RELEASE=true，log 静默
global.wx = {
  env: { USER_DATA_PATH: UD },
  getFileSystemManager: () => makeManager(),
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    if (storageThrow) { const e = new Error('quota exceeded'); e.errMsg = 'setStorageSync:fail'; throw e; }
    storage[k] = v;
  },
  getSetting: ({ success }) => success({ authSetting: {} }),
  saveImageToPhotosAlbum: ({ filePath, success, fail }) => {
    if (albumFail) (fail && fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }));
    else (success && success({}));
  },
  showLoading: () => {}, hideLoading: () => {}, showToast: () => {}, showModal: () => {},
};
global.getApp = () => ({ globalData: {} });
const pages = [];
global.Page = (cfg) => pages.push(cfg);
global.App = () => {};

// 桩替换重型入口模块，避免 App() 副作用
const appStubPath = path.resolve(__dirname, '..', 'app.js');
const secCheckStubPath = path.resolve(__dirname, '..', 'utils', 'secCheck.js');
require.cache[appStubPath] = { id: appStubPath, filename: appStubPath, loaded: true, exports: { getBeadPrefs: () => ({}), CONSTANTS: { BEAD_SIZE: { MIN: 5, MAX: 50, DEFAULT: 29 } } } };
require.cache[secCheckStubPath] = { id: secCheckStubPath, filename: secCheckStubPath, loaded: true, exports: {} };

// 加载被测模块（触发 Page → 捕获配置）
require('../pages/index/index');
require('../pages/template/template');
const util = require('../utils/util');

const indexCfg = pages[0];
const templateCfg = pages[1];

// ---------- 断言工具 ----------
let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}
function count(prefix) {
  return Object.keys(fsStore).filter(k => k.indexOf(UD + '/' + prefix) === 0).length;
}
function resetFs() { fsStore = {}; }

const SAMPLE_TD = { cols: 2, rows: 2, totalBeads: 4, colorCount: 2, beadSize: 29, physicalWidth: 10, physicalHeight: 10, materialList: [], template: [[0, 1], [1, 0]] };

async function run() {
  // ===== M1: saveTemplate 相册保存失败 → 清理 bead_export_ =====
  resetFs(); storage = {}; storageThrow = false; albumFail = true;
  {
    const before = count('bead_export_');
    await templateCfg.saveTemplate.call({
      _templateData: { cols: 2, rows: 2, totalBeads: 4 },
      async _generateExportImage() { return '/tmp/gen.png'; },
    });
    const after = count('bead_export_');
    ok('M1 失败路径: 无 bead_export_ 残留 (前=' + before + ', 后=' + after + ')', before === 0 && after === 0);
  }
  // 成功路径对照（确认成功仍清、改动不误伤）
  resetFs(); storage = {}; storageThrow = false; albumFail = false;
  {
    await templateCfg.saveTemplate.call({
      _templateData: { cols: 2, rows: 2, totalBeads: 4 },
      async _generateExportImage() { return '/tmp/gen.png'; },
    });
    ok('M1 成功路径: 无 bead_export_ 残留', count('bead_export_') === 0);
  }

  // ===== M2: saveToHistory 存储写入失败 → 回收 history_source_ 孤儿 =====
  resetFs(); storage = {}; storageThrow = true;
  {
    const thisCtx = { data: { imagePath: '/local/tmp_abc.png', beadType: 'square' } };
    indexCfg.saveToHistory.call(thisCtx, SAMPLE_TD);
    ok('M2 存储失败: 无 history_source_ 孤儿残留 (count=' + count('history_source_') + ')', count('history_source_') === 0);
  }
  // 成功路径对照
  resetFs(); storage = {}; storageThrow = false;
  {
    const thisCtx = { data: { imagePath: '/local/tmp_def.png', beadType: 'square' } };
    indexCfg.saveToHistory.call(thisCtx, SAMPLE_TD);
    ok('M2 存储成功: history_source_ 原图被保留 (count=' + count('history_source_') + ')', count('history_source_') === 1);
  }

  // ===== M2: gcBeadTempFiles 兜底清理孤儿 history_source_ =====
  resetFs(); storage = {};
  {
    storage['template_history'] = [{ sourceImage: UD + '/history_source_keep.png' }];
    fsStore[UD + '/history_source_keep.png'] = true;   // 被引用 → 保留
    fsStore[UD + '/history_source_orphan.png'] = true;  // 孤儿 → 删除
    fsStore[UD + '/bead_export_x.png'] = true;          // 删除
    fsStore[UD + '/bead_share_old.png'] = true;         // 删除
    fsStore[UD + '/bead_share_keep.png'] = true;        // keepSharePath → 保留
    const removed = util.gcBeadTempFiles({ keepSharePath: UD + '/bead_share_keep.png' });
    ok('M2-gc 引用中的 history_source_ 保留', !!fsStore[UD + '/history_source_keep.png']);
    ok('M2-gc 孤儿 history_source_ 被清理', !fsStore[UD + '/history_source_orphan.png']);
    ok('M2-gc bead_export_ 被清理', !fsStore[UD + '/bead_export_x.png']);
    ok('M2-gc 旧 bead_share_ 被清理', !fsStore[UD + '/bead_share_old.png']);
    ok('M2-gc keepSharePath bead_share_ 保留', !!fsStore[UD + '/bead_share_keep.png']);
    ok('M2-gc 共清理 3 个文件', removed === 3);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });

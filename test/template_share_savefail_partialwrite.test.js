// test/template_share_savefail_partialwrite.test.js
// 回归测试：B5 shareTemplate 持久化失败时，新尝试写入的 stablePath 可能已留下半成品/0字节文件
//           （磁盘异常、部分写入、WX_WRITE 模式）。必须在 catch 中显式 removeFileIfExists(stablePath)，
//           否则 bead_share_*.png 会在反复重试中累积逼近 USER_DATA_PATH 配额。
// 运行：node test/template_share_savefail_partialwrite.test.js
const fs = require('fs');
const path = require('path');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

function makeTemplate() {
  const template = [];
  for (let y = 0; y < 3; y++) template.push(new Array(3).fill('C01'));
  return {
    cols: 3, rows: 3, totalBeads: 9, colorCount: 1, beadSize: 29,
    physicalWidth: 87, physicalHeight: 87,
    materialList: [{ id: 'x', color: { id: 'C01', name: '白', hex: '#FFFFFF' }, count: 9 }],
    sourceImagePath: '', template
  };
}

const OLD = 'wxfile://usr/bead_share_old_999.png';

function runShareSaveFailPartialWrite() {
  const deleted = [];
  const savedPaths = [];
  const fakeApp = {
    globalData: {
      shareImagePath: OLD,
      sourceImagePath: '',
      currentTemplate: makeTemplate(),
      beadType: 'square'
    }
  };
  attachResetTemplateState(fakeApp);
  global.getApp = () => fakeApp;
  global.wx = {
    showLoading: () => {}, hideLoading: () => {}, showToast: () => {},
    showModal: () => {}, showShareMenu: () => {},
    env: { USER_DATA_PATH: 'wxfile://usr' }
  };
  let pageObj = null;
  global.Page = (o) => { pageObj = o; };
  delete require.cache[path.join(__dirname, '..', 'pages', 'template', 'template.js')];
  require(path.join(__dirname, '..', 'pages', 'template', 'template.js'));

  const ctx = Object.assign({}, pageObj, {
    data: { cols: 3, rows: 3, beadType: 'square' },
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx._templateData = makeTemplate();
  ctx._generateExportImage = async () => 'wxfile://tmp/export.png';
  // 模拟「部分写入」：saveFile 先在 filePath 落一个 0 字节半成品，再触发 fail 回调
  global.wx.getFileSystemManager = () => ({
    unlinkSync: (p) => { deleted.push(p); },
    saveFile: ({ tempFilePath, filePath, success, fail }) => {
      savedPaths.push(filePath);                 // 记录实际尝试写入的新路径
      if (fail) fail(new Error('save failed (partial write left behind)'));
    }
  });
  return { ctx, fakeApp, deleted, savedPaths };
}

(async () => {
  const { ctx, fakeApp, deleted, savedPaths } = runShareSaveFailPartialWrite();
  try { await ctx.shareTemplate(); } catch (e) { /* 外层 try/catch 收敛为 showToast */ }

  const newStablePath = savedPaths[0];
  ok('saveFile 被调用且传入新的 stablePath（bead_share_ 前缀）',
    !!newStablePath && newStablePath.indexOf('bead_share_') !== -1);
  ok('saveFile 失败时旧分享图 oldSharePath 仍被删除', deleted.includes(OLD));
  ok('saveFile 失败时新 stablePath 半成品文件被显式删除（B5 核心修复）',
    !!newStablePath && deleted.includes(newStablePath));
  ok('未误删稳定路径以外的内容', deleted.every(p => p.indexOf('bead_share_') !== -1));
  ok('saveFile 失败后分享图指针被清空', fakeApp.globalData.shareImagePath === '');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

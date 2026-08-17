// test/template_share_rejects_on_failure.test.js
// 回归测试：修复 #7 根因——shareTemplate 在 saveFile 失败时曾静默 resolve（外层 catch 不 re-throw），
//           导致调用方无法经 .catch() 感知失败。本测试锁死新契约：
//           失败时 shareTemplate 必须 reject，且仍执行孤儿文件清理副作用。
// 运行：node test/template_share_rejects_on_failure.test.js
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

function runShareSaveFail() {
  const deleted = [];
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
  // 强制 saveFile 失败：fail 回调触发 reject（内层 Promise 已正确 reject，外层 catch 必须再 re-throw）
  global.wx.getFileSystemManager = () => ({
    unlinkSync: (p) => { deleted.push(p); },
    saveFile: ({ tempFilePath, filePath, success, fail }) => { if (fail) fail(new Error('save failed')); }
  });
  return { ctx, fakeApp, deleted };
}

(async () => {
  const { ctx, fakeApp, deleted } = runShareSaveFail();

  let rejected = false, rejectedMsg = '';
  try {
    await ctx.shareTemplate();
  } catch (e) {
    rejected = true;
    rejectedMsg = (e && e.message) || String(e);
  }

  // —— 核心契约：失败时必须 reject ——
  ok('saveFile 失败时 shareTemplate 必须 reject（不再静默 resolve）', rejected);
  ok('reject 携带错误信息（调用方可据此降级/回滚）', rejected && /失败/.test(rejectedMsg));

  // —— 副作用仍须正确执行（reject 不应破坏清理逻辑）——
  ok('saveFile 失败时旧分享图 oldSharePath 被删除（不遗留孤儿）', deleted.includes(OLD));
  ok('saveFile 失败时新尝试写入的 stablePath 也一并清理（防 partial-write 孤儿）',
    deleted.some(p => p.startsWith('wxfile://usr/bead_share_') && p !== OLD));
  ok('saveFile 失败后分享图指针被清空（_validShareImage 回退默认截图）',
    fakeApp.globalData.shareImagePath === '');
  ok('saveFile 失败仅清理旧图与新图两处（无额外误删）', deleted.length === 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

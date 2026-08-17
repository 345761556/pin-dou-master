// test/template_share_savefail_orphan.test.js
// 回归测试：[3] shareTemplate 旧图清理时机不一致
// Bug：saveFile 失败时 catch 只清空 shareImagePath 指针，未删 oldSharePath 指向的旧分享图，
//      指针清空后旧文件成为孤儿 → 下次成功路径读空串跳过删除 → 累积 bead_share_*.png。
// 修复：catch 中清空指针前先 removeFileIfExists(oldSharePath)。
// 运行：node test/template_share_savefail_orphan.test.js
const fs = require('fs');
const path = require('path');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：catch 块内通过 app.resetTemplateState 集中清理（含 clearCurrentTemplate:false） ----
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
const shareIdx = tplSrc.indexOf('async shareTemplate()');
const shareMethod = tplSrc.slice(shareIdx);
const idxCatch = shareMethod.indexOf('} catch (e) {');
const afterCatch = shareMethod.slice(idxCatch);
ok('catch 块调用 app.resetTemplateState 集中清理旧分享图（clearCurrentTemplate:false, clearSource:false）',
  /app\.resetTemplateState\(\{\s*clearCurrentTemplate:\s*false,\s*clearSource:\s*false/.test(afterCatch));

// ---- 2) 功能驱动：saveFile 失败时 oldSharePath 必须被删除（无孤儿） ----
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
      shareImagePath: OLD,        // 模拟已有旧分享图
      sourceImagePath: '',
      currentTemplate: makeTemplate(),
      beadType: 'square'
    }
  };
  attachResetTemplateState(fakeApp);
  global.getApp = () => fakeApp;
  // 基础 wx mock（_generateExportImage 将被覆盖，不依赖 canvas）
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
  // 覆盖 _generateExportImage 直接返回临时图，让流程进入 saveFile 段
  ctx._generateExportImage = async () => 'wxfile://tmp/export.png';
  // 强制 saveFile 失败（fail 回调触发 reject）
  global.wx.getFileSystemManager = () => ({
    unlinkSync: (p) => { deleted.push(p); },
    saveFile: ({ tempFilePath, filePath, success, fail }) => { if (fail) fail(new Error('save failed')); }
  });
  return { ctx, fakeApp, deleted };
}

(async () => {
  const { ctx, fakeApp, deleted } = runShareSaveFail();
  // shareTemplate 内部有外层 try/catch 收敛为 showToast，不会向上抛；关注副作用
  try { await ctx.shareTemplate(); } catch (e) { /* 不应到这 */ }

  ok('saveFile 失败时旧分享图 oldSharePath 被删除（不遗留孤儿）', deleted.includes(OLD));
  ok('saveFile 失败后分享图指针被清空（_validShareImage 回退默认截图）',
    fakeApp.globalData.shareImagePath === '');
  ok('saveFile 失败时新尝试写入的 stablePath 也一并清理（防 B5 partial-write 孤儿）',
    deleted.some(p => p.startsWith('wxfile://usr/bead_share_') && p !== OLD));
  ok('saveFile 失败仅清理旧图与新图两处（无额外误删）', deleted.length === 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

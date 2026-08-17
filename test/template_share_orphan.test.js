// test/template_share_orphan.test.js
// 回归测试：会话内分享图孤儿文件累积（BUG-10 复发路径）
// 根因：template.js onLoad 重置 globalData.shareImagePath='' 但未删磁盘旧 bead_share_*；
//       shareTemplate「写新图前删旧图」读到的已是空串 → 跳过删除。
//       同一会话多次"生成新模板→分享"累积 1-4MB/个，逼近 10MB 配额。
// 修复：onLoad 重置指针前，先删除指针指向的旧分享图文件。
// 运行：node test/template_share_orphan.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：onLoad 通过 app.resetTemplateState 集中清理 share/source（保留 currentTemplate） ----
const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
ok('onLoad 调用 app.resetTemplateState 集中清理（clearCurrentTemplate:false）',
  /app\.resetTemplateState\(\{\s*clearCurrentTemplate:\s*false/.test(tplSrc));

// ---- 2) 功能驱动：mock onLoad ----
// 构造有效模板数据（onLoad 前 60 行会校验 currentTemplate，必须有效）
function makeTemplate() {
  const template = [];
  for (let y = 0; y < 3; y++) template.push(new Array(3).fill('C01'));
  return {
    cols: 3, rows: 3,
    totalBeads: 9,
    colorCount: 1,
    beadSize: 29,
    physicalWidth: 87,
    physicalHeight: 87,
    materialList: [{ id: 'x', color: { id: 'C01', name: '白', hex: '#FFFFFF' }, count: 9 }],
    sourceImagePath: '',
    template
  };
}

// 运行 onLoad 并返回断言环境
function runOnLoad(initialSharePath) {
  const unlinked = [];
  const fakeApp = {
    globalData: {
      shareImagePath: initialSharePath,
      sourceImagePath: '',
      currentTemplate: makeTemplate(),
      beadType: 'square'
    }
  };
  attachResetTemplateState(fakeApp);
  global.getApp = () => fakeApp;
  global.wx = {
    showShareMenu: () => {},
    setNavigationBarTitle: () => {},
    showToast: () => {},
    navigateBack: () => {},
    getFileSystemManager: () => ({ unlinkSync: (p) => { unlinked.push(p); } })
  };
  let pageObj = null;
  global.Page = (o) => { pageObj = o; };
  delete require.cache[path.join(__dirname, '..', 'pages', 'template', 'template.js')];
  require(path.join(__dirname, '..', 'pages', 'template', 'template.js'));
  const ctx = Object.assign({}, pageObj, {
    data: {},
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx.onLoad({});
  return { unlinked, fakeApp };
}

{
  // 场景 A：进入模板页时 globalData 残留旧分享图（bead_share_*）→ 必须删除，且指针清空
  const { unlinked, fakeApp } = runOnLoad('wxfile://usr/bead_share_old_123.png');
  ok('场景A: 旧分享图被 unlink（孤儿不再累积）',
    unlinked.length === 1 && unlinked[0] === 'wxfile://usr/bead_share_old_123.png');
  ok('场景A: 指针重置为空', fakeApp.globalData.shareImagePath === '');

  // 场景 B：指针为空串 → 不误删任何文件
  const b = runOnLoad('');
  ok('场景B: shareImagePath 为空时无删除动作', b.unlinked.length === 0);

  // 场景 C：指针指向非 bead_share_ 文件（防御性：不删无关文件）
  const c = runOnLoad('wxfile://usr/history_source_9.png');
  ok('场景C: 非 bead_share_ 前缀不删除', c.unlinked.length === 0);
}

// ---- 3) 端到端语义验证：连续"生成新模板→分享"只留 1 份分享图 ----
// 模拟两个模板页实例的生命周期（onLoad 清理 + shareTemplate 写入），统计磁盘峰值文件数
{
  const disk = new Set();           // 磁盘上存在的 bead_share_*
  const fakeApp = {
    globalData: { shareImagePath: '', sourceImagePath: '', currentTemplate: makeTemplate(), beadType: 'square' }
  };
  attachResetTemplateState(fakeApp);
  global.getApp = () => fakeApp;
  global.wx = {
    showShareMenu: () => {},
    setNavigationBarTitle: () => {},
    showToast: () => {},
    navigateBack: () => {},
    getFileSystemManager: () => ({
      unlinkSync: (p) => { disk.delete(p); },
      saveFile: ({ tempFilePath, filePath, success }) => success()
    }),
    env: { USER_DATA_PATH: 'wxfile://usr' },
    showLoading: () => {},
    hideLoading: () => {},
    showModal: () => {},
    showShareMenu: () => {},
    canvasToTempFilePath: () => {},
    createSelectorQuery: () => ({
      in() { return this; },
      select() { return this; },
      fields() { return this; },
      exec(cb) { cb([null]); } // 无 export canvas → 分享走失败路径也不影响孤儿判定
    })
  };
  let pageObj = null;
  global.Page = (o) => { pageObj = o; };
  delete require.cache[path.join(__dirname, '..', 'pages', 'template', 'template.js')];
  require(path.join(__dirname, '..', 'pages', 'template', 'template.js'));

  // 模拟两次「进入模板页 → 分享」：
  // 实例1：onLoad(有旧指针) → shareTemplate 生成文件A
  const ctx1 = Object.assign({}, pageObj, {
    data: { beadType: 'square' },
    setData: (d) => Object.assign(ctx1.data, d)
  });
  fakeApp.globalData.shareImagePath = 'wxfile://usr/bead_share_prev.png';
  disk.add('wxfile://usr/bead_share_prev.png');
  ctx1.onLoad({});
  // 实例1 的 shareTemplate 会因 export canvas 缺失失败，但我们只验证 onLoad 清理：
  ok('实例1 onLoad 后旧分享图已被删除', !disk.has('wxfile://usr/bead_share_prev.png'));

  // 实例2：再次进入（模拟第二次生成新模板）→ onLoad 同样先清理
  const ctx2 = Object.assign({}, pageObj, {
    data: { beadType: 'square' },
    setData: (d) => Object.assign(ctx2.data, d)
  });
  fakeApp.globalData.shareImagePath = 'wxfile://usr/bead_share_2nd.png';
  disk.add('wxfile://usr/bead_share_2nd.png');
  ctx2.onLoad({});
  ok('实例2 onLoad 后上一份分享图已被删除', !disk.has('wxfile://usr/bead_share_2nd.png'));
  ok('连续进入模板页后磁盘无累积分享图', disk.size === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// 验证 [7] app.js resetTemplateState 单一真源契约：
// 集中清理跨页模板态（currentTemplate / sourceImagePath / shareImagePath），
// 且重置 shareImagePath 指针前先删磁盘旧分享图（bead_share_*），避免孤儿累积（BUG-10 复发路径）。
// 运行：node test/app_reset_template_state.test.js
const path = require('path');

let unlinked = [];
global.wx = {
  getFileSystemManager: () => ({ unlinkSync: (p) => { unlinked.push(p); } }),
  env: { USER_DATA_PATH: 'x' }
};

// 捕获 App 实例（mini-program 运行时由框架注入 getApp()，此处用 mock 复刻）
let appInstance = null;
global.App = (cfg) => { appInstance = cfg; };
global.getApp = () => appInstance;

require(path.join(__dirname, '..', 'app.js'));
const app = getApp();

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

console.log('\n[7] app.js resetTemplateState 契约:');

// 准备：globalData 初始态
app.globalData.currentTemplate = { cols: 2, rows: 2 };
app.globalData.sourceImagePath = 'wxfile://usr/src_1.png';
app.globalData.shareImagePath = 'wxfile://usr/bead_share_old_1.png';

// 1) 默认（clear 全部）：删 bead_share_ 旧图 + 三态清空
unlinked = [];
app.resetTemplateState();
ok('默认调用删除 bead_share_ 旧分享图', unlinked.length === 1 && unlinked[0] === 'wxfile://usr/bead_share_old_1.png');
ok('默认调用后 shareImagePath 为空', app.globalData.shareImagePath === '');
ok('默认调用后 sourceImagePath 为空', app.globalData.sourceImagePath === '');
ok('默认调用后 currentTemplate 为 null', app.globalData.currentTemplate === null);

// 2) clearCurrentTemplate:false → 保留 currentTemplate（onLoad 语义）
app.globalData.currentTemplate = { cols: 3, rows: 3 };
app.globalData.sourceImagePath = 'wxfile://usr/src_2.png';
app.globalData.shareImagePath = 'wxfile://usr/bead_share_old_2.png';
unlinked = [];
app.resetTemplateState({ clearCurrentTemplate: false });
ok('clearCurrentTemplate:false 保留 currentTemplate', app.globalData.currentTemplate && app.globalData.currentTemplate.cols === 3);
ok('clearCurrentTemplate:false 仍清 share/source', app.globalData.shareImagePath === '' && app.globalData.sourceImagePath === '');
ok('clearCurrentTemplate:false 仍删旧分享图', unlinked.length === 1 && unlinked[0] === 'wxfile://usr/bead_share_old_2.png');

// 3) clearShareFile:false → 不动 shareImagePath（onUnload 语义）
app.globalData.currentTemplate = { cols: 4, rows: 4 };
app.globalData.shareImagePath = 'wxfile://usr/bead_share_old_3.png';
unlinked = [];
app.resetTemplateState({ clearCurrentTemplate: true, clearShareFile: false, clearSource: false });
ok('clearShareFile:false 保留 shareImagePath', app.globalData.shareImagePath === 'wxfile://usr/bead_share_old_3.png');
ok('clearShareFile:false 不删分享图', unlinked.length === 0);
ok('clearCurrentTemplate:true 仍清 currentTemplate', app.globalData.currentTemplate === null);

// 4) 防御：非 bead_share_ 前缀的 shareImagePath 不删除（避免误删无关文件）
app.globalData.shareImagePath = 'wxfile://usr/history_source_9.png';
unlinked = [];
app.resetTemplateState();
ok('非 bead_share_ 前缀的 shareImagePath 不删除', unlinked.length === 0 && app.globalData.shareImagePath === '');

// 4.5) 防御：含路径遍历 ".." 的 bead_share_ 路径不删除（社区安全审查 #6：纵深防御，避免越权删文件）
app.globalData.shareImagePath = 'wxfile://usr/bead_share_../../critical_file.png';
unlinked = [];
app.resetTemplateState();
ok('含 ".." 遍历的分享图路径被拦截、不删除', unlinked.length === 0 && app.globalData.shareImagePath === '');

// 5) 空串 shareImagePath 不触发删除
app.globalData.shareImagePath = '';
unlinked = [];
app.resetTemplateState();
ok('空串 shareImagePath 无删除动作', unlinked.length === 0);

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

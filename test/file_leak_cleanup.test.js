// 验证 P2-3 文件泄漏修复：USER_DATA_PATH 下 bead_export_*/bead_share_* 中间产物被清理
// 覆盖：removeFileIfExists 安全删除 / gcBeadTempFiles 兜底扫描删除 / 启动 GC 不误删无关文件
const path = require('path');

// ---- mock 微信文件系统 ----
let unlinkCalls = [];
let readdirNames = [
  'bead_export_111.png',
  'bead_export_222.png',
  'bead_share_aaa.png',   // 旧的分享图（应被删）
  'bead_share_bbb.png',   // 当前活跃分享图（keepSharePath，应保留）
  'history_source_999.png', // 无关文件，绝不删
  'avatar_a.png'            // 无关文件，绝不删
];

global.wx = {
  getFileSystemManager: () => ({
    unlinkSync: (p) => { unlinkCalls.push(p); },
    readdirSync: () => readdirNames
  }),
  getStorageSync: (key) => {
    if (key === 'template_history') {
      // 让 gcBeadTempFiles 识别 history_source_999.png 为仍在使用，避免误删
      return [{ id: 1, sourceImage: '/usr/history_source_999.png' }];
    }
    return undefined;
  },
  env: { USER_DATA_PATH: '/usr' }
};

const { removeFileIfExists, gcBeadTempFiles } = require('../utils/util.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}`);
  cond ? pass++ : fail++;
}

// ---- 1. removeFileIfExists 基础删除 ----
unlinkCalls = [];
const deleted = removeFileIfExists('/usr/bead_export_111.png');
ok('removeFileIfExists 返回 true 且调用 unlink', deleted === true && unlinkCalls.includes('/usr/bead_export_111.png'));

// ---- 2. removeFileIfExists 空路径安全 ----
unlinkCalls = [];
const deletedNull = removeFileIfExists('');
ok('removeFileIfExists 空路径不抛错、返回 false', deletedNull === false && unlinkCalls.length === 0);

// ---- 3. gcBeadTempFiles 删 bead_export 全部 + 旧 bead_share，保留 keepSharePath 与无关文件 ----
unlinkCalls = [];
const removed = gcBeadTempFiles({ keepSharePath: '/usr/bead_share_bbb.png' });
ok('gc 删除了 2 个 bead_export', unlinkCalls.filter(p => p.indexOf('bead_export') >= 0).length === 2);
ok('gc 删除了 1 个旧 bead_share（aaa）', unlinkCalls.includes('/usr/bead_share_aaa.png'));
ok('gc 保留了 keepSharePath（bbb）', !unlinkCalls.includes('/usr/bead_share_bbb.png'));
ok('gc 未误删 history_source_*', !unlinkCalls.some(p => p.indexOf('history_source') >= 0));
ok('gc 未误删 avatar_*', !unlinkCalls.some(p => p.indexOf('avatar') >= 0));
ok('gc 返回删除计数 = 3', removed === 3);

// ---- 4. gcBeadTempFiles keepSharePath 为空 → 所有 bead_share 都删（启动场景）----
readdirNames = ['bead_share_x.png', 'bead_share_y.png', 'bead_export_z.png'];
unlinkCalls = [];
gcBeadTempFiles({ keepSharePath: '' });
ok('启动 GC（keepSharePath 空）删除全部 bead_share', unlinkCalls.filter(p => p.indexOf('bead_share') >= 0).length === 2);
ok('启动 GC 删除全部 bead_export', unlinkCalls.filter(p => p.indexOf('bead_export') >= 0).length === 1);

// ---- 5. readdir 异常不抛错（兜底健壮）----
global.wx.getFileSystemManager = () => ({ unlinkSync: () => {}, readdirSync: () => { throw new Error('no permission'); } });
let threw = false;
try { gcBeadTempFiles({}); } catch (e) { threw = true; }
ok('readdir 异常时 gc 不抛出（静默兜底）', threw === false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

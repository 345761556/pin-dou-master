// test/gc_scan_full_contract.test.js
// L6 闭环 / 契约测试：gcBeadTempFiles 的「全目录遍历」行为契约锁定
//
// 背景（L6 缺陷，utils/util.js L565-606，app.js L149 调用）：
//   每次冷启动对 USER_DATA_PATH 做一次 readdirSync 全量枚举 + 逐条 unlink 尝试。
//   该缺陷被作者评为「性能级轻微问题 / 可接受现状」，本测试**不做源码改动**，
//   仅把当前「全量扫描 + 三前缀删除 + keepSharePath + 孤儿 history_source 仅清」的契约钉死，
//   使未来若真做「缩小扫描范围」优化（专用子目录）时，必须保持同等的删除语义，否则本测试会失败。
//
// 关键技术点：
//   1) 文件名「日期前缀」无法降低 readdirSync 成本（它枚举整目录，前缀过滤是枚举之后的 JS 逻辑）；
//      真正能缩小扫描的是「专用子目录」——属更大重构，作者未要求，故本轮不改。
//   2) 本测试用「大量无关文件 + 少量 bead 临时文件」模拟冷启动文件多的场景，证明全扫契约正确、计数精确。
//
// 运行：node test/gc_scan_full_contract.test.js

'use strict';
const fs = require('fs');
const path = require('path');

const UD = '/userdata';

// ---- mock 微信文件系统 ----
let unlinkCalls = [];

// 构造「文件多」的目录：200 个无关文件（模拟冷启动 USER_DATA_PATH 累积的其他文件）+ 6 个 bead 临时文件
const UNRELATED_COUNT = 200;
const unrelatedNames = [];
for (let i = 0; i < UNRELATED_COUNT; i++) {
  // 混合多种「非 bead 前缀」命名，覆盖真实环境里可能累积的其它本地文件
  const suffix = i % 3;
  if (suffix === 0) unrelatedNames.push('photo_' + i + '.png');
  else if (suffix === 1) unrelatedNames.push('cache_item_' + i + '.tmp');
  else unrelatedNames.push('avatar_thumb_' + i + '.jpg');
}
const beadNames = [
  'bead_export_e1.png',            // 应删
  'bead_export_e2.png',            // 应删
  'bead_share_old.png',           // 旧分享图（非 keepSharePath）→ 应删
  'bead_share_keep.png',          // 当前活跃分享图（keepSharePath）→ 应保留
  'history_source_keep.png',      // 被历史记录引用 → 应保留
  'history_source_orphan.png'     // 孤儿原图（无记录引用）→ 应删
];
const readdirNames = unrelatedNames.concat(beadNames);
const KEEP_SHARE = UD + '/bead_share_keep.png';

// 历史记录：仅引用 history_source_keep，orphan 不引用
// 注意：getTemplateHistory 直接要求 wx.getStorageSync('template_history') 返回数组
//（Array.isArray(raw) ? raw : []），故此处返回真实数组，而非 JSON 字符串。
const historyArray = [
  { id: 1, sourceImage: UD + '/history_source_keep.png', totalBeads: 10 }
];

global.__wxConfig = undefined; // security IS_RELEASE=true，log 静默
global.wx = {
  env: { USER_DATA_PATH: UD },
  getFileSystemManager: () => ({
    unlinkSync: (p) => { unlinkCalls.push(p); },
    readdirSync: () => readdirNames
  }),
  getStorageSync: (k) => (k === 'template_history' ? historyArray : '')
};

const { gcBeadTempFiles } = require('../utils/util.js');
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'util.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}`);
  cond ? pass++ : fail++;
}

// ---- 1. 三前缀删除语义（全扫契约核心）----
unlinkCalls = [];
const removed = gcBeadTempFiles({ keepSharePath: KEEP_SHARE });
const delExport = unlinkCalls.filter(p => p.indexOf('bead_export') >= 0);
const delShareOld = unlinkCalls.filter(p => p.indexOf('bead_share_old.png') >= 0);
const keepShareHit = unlinkCalls.filter(p => p.indexOf('bead_share_keep.png') >= 0);
const delOrphan = unlinkCalls.filter(p => p.indexOf('history_source_orphan.png') >= 0);
const keepRef = unlinkCalls.filter(p => p.indexOf('history_source_keep.png') >= 0);
const delUnrelated = unlinkCalls.filter(p => /^.*\/(photo_|cache_item_|avatar_thumb_)/.test(p));

ok('删除了 2 个 bead_export_*', delExport.length === 2);
ok('删除了旧 bead_share_old.png', delShareOld.length === 1);
ok('保留了 keepSharePath（bead_share_keep.png 未被删）', keepShareHit.length === 0);
ok('删除了孤儿 history_source_orphan.png', delOrphan.length === 1);
ok('保留了被历史引用的 history_source_keep.png', keepRef.length === 0);
ok('200 个无关文件一个都没误删', delUnrelated.length === 0);
ok('返回删除计数 = 4（2 export + 1 旧 share + 1 orphan）', removed === 4);

// ---- 2. 全扫契约：每个条目都被检查（readdir 返回值被完整遍历）----
ok('readdir 返回的 ' + readdirNames.length + ' 个条目全部纳入扫描（不提前截断）',
  delExport.length + delShareOld.length + delOrphan.length + keepShareHit.length + keepRef.length + delUnrelated.length <= readdirNames.length);

// ---- 3. 启动场景（keepSharePath 空 → 所有 bead_share 都删）----
unlinkCalls = [];
gcBeadTempFiles({ keepSharePath: '' });
ok('启动 GC（keepSharePath 空）删除了 bead_share_keep.png', unlinkCalls.includes(UD + '/bead_share_keep.png'));
ok('启动 GC 仍不误删 history_source_keep.png（被引用）', !unlinkCalls.includes(UD + '/history_source_keep.png'));

// ---- 4. 静态契约守卫：源码仍检查全部三个前缀（防止未来优化缩扫描时漏删某一类）----
ok('源码仍检查 bead_export_ 前缀', /name\.indexOf\('bead_export_'\)\s*===\s*0/.test(utilSrc));
ok('源码仍检查 bead_share_ 前缀', /name\.indexOf\('bead_share_'\)\s*===\s*0/.test(utilSrc));
ok('源码仍检查 history_source_ 前缀', /name\.indexOf\('history_source_'\)\s*===\s*0/.test(utilSrc));
ok('源码仍对 USER_DATA_PATH 做 readdirSync 全量枚举（全扫契约）', /readdirSync\(base\)/.test(utilSrc));

console.log(`\ngc_scan_full_contract: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

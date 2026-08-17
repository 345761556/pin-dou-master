// test/sec_check_migration_dual_doc.test.js
// L1 回归：云函数限频「灰度/回滚双文档竞态」修复验证。
// 场景：旧版用 coll.add 自动 _id 建记录（如 {_id:'r1', openid:'userX', count:100}），
// 新版改用 doc(openid).set 幂等 upsert。若旧记录残留，where({openid}) 会返回两份文档，
// data[0] 命中旧文档 → 计数写向另一份 → 限频静默失效。
// 修复：优先取 _id===openid 的规范文档作为唯一读写目标，并删除非规范文档，限频恢复生效。
// 运行：node test/sec_check_migration_dual_doc.test.js
const Module = require('module');

let currentOpenid = 'userX';
let dbRows = [];
let nextId = 1;

// ---- mock wx-server-sdk（拦截 require('wx-server-sdk')）----
// 支持 CloudBase 命令操作符的轻量内存库（与 sec_check_cloudfunction.test.js 同款），
// 用于验证 S3 原子限频下双文档竞态仍被消除（_.inc/_.lt/_.neq + updated 返回）。
const _ = {
  lt: (v) => ({ __op: 'lt', v }),
  neq: (v) => ({ __op: 'neq', v }),
  inc: (v) => ({ __op: 'inc', v })
};
function rowMatches(row, q) {
  for (const k of Object.keys(q)) {
    const cond = q[k];
    if (cond && typeof cond === 'object' && cond.__op) {
      const v = cond.v;
      if (cond.__op === 'lt') { if (!(row[k] < v)) return false; }
      else if (cond.__op === 'neq') { if (!(row[k] !== v)) return false; }
      else return false;
    } else if (row[k] !== cond) return false;
  }
  return true;
}
function applyData(row, data) {
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v && typeof v === 'object' && v.__op === 'inc') row[k] = (row[k] || 0) + v.v;
    else row[k] = v;
  }
}
const db = {
  command: _,
  collection: () => ({
    where: (q) => ({
      get: async () => ({ data: dbRows.filter((r) => rowMatches(r, q)) }),
      update: async ({ data }) => {
        const matched = dbRows.filter((r) => rowMatches(r, q));
        matched.forEach((r) => applyData(r, data));
        return { updated: matched.length };
      }
    }),
    doc: (id) => ({
      set: async ({ data }) => {
        let r = dbRows.find((x) => x._id === id);
        if (r) Object.assign(r, data);
        else { r = { _id: id, ...data }; dbRows.push(r); }
        return {};
      },
      get: async () => {
        const r = dbRows.find((x) => x._id === id);
        return { data: r };
      },
      update: async ({ data }) => {
        const r = dbRows.find((x) => x._id === id);
        if (r) { applyData(r, data); return { updated: 1 }; }
        return { updated: 0 };
      },
      remove: async () => {
        dbRows = dbRows.filter((x) => x._id !== id);
        return {};
      }
    }),
    add: async ({ data }) => {
      const r = { _id: String(nextId++), ...data };
      dbRows.push(r);
      return { _id: r._id };
    }
  })
};
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init: () => {},
  getWXContext: () => ({ OPENID: currentOpenid }),
  downloadFile: async ({ fileID }) => ({ fileContent: Buffer.from('dummy-image-bytes') }),
  deleteFile: async () => ({}),
  openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } },
  database: () => db
};
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'wx-server-sdk') return fakeCloud;
  return realRequire.apply(this, arguments);
};
const secCheckMain = require('../cloudfunctions/secCheck/index.js').main;
Module.prototype.require = realRequire;

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

(async () => {
  // 预置旧格式记录（_id 为 auto-id，非 openid），count 已用满
  dbRows = [{ _id: 'r1', openid: 'userX', windowStart: Date.now(), count: 100 }];
  currentOpenid = 'userX';

  let denied = false;
  for (let i = 0; i < 110; i++) {
    const r = await secCheckMain({ type: 'image', scene: 2, fileID: `cloud://env-test/sec_check/1700000000000_x${i}.png` });
    if (r && r.errcode === -6) denied = true;
  }

  const canon = dbRows.find((r) => r._id === 'userX');
  const orphan = dbRows.find((r) => r._id === 'r1');

  ok('限频在双文档竞态下仍生效（出现 errcode -6 拒绝）', denied);
  ok('规范文档 _id===openid 被创建并用于计数', !!canon);
  ok('计数作用在规范文档上（count 在合理区间 1..100）', canon && canon.count > 0 && canon.count <= 100);
  ok('旧格式孤立文档已被删除（消除双文档竞态）', !orphan);
  ok('限频集合最终只含规范文档（无重复文档）', dbRows.filter((r) => r.openid === 'userX').length === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

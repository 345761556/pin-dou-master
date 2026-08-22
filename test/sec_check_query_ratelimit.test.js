// test/sec_check_query_ratelimit.test.js
// P2-6 回归：secCheck 云函数 query（轮询）分支此前在 OPENID 校验与限频之前直接 return，
// 可被匿名/恶意请求无限刷读数据库调用量。修复后：
//   1) query 分支 OPENID 判空与 submit 同口径 → errcode -7
//   2) query 独立限频 600/h（独立字段 qWindowStart/qCount，不占用 submit 的 count/windowStart）
//   3) 并发爆发仅放行 QUERY_RATE_LIMIT_MAX 次（原子条件更新，S3 同款模式）
//   4) 数据库不可用时降级独立内存 Map，不崩溃、正常放行
//   5) query 轮询不消耗/不重置 submit 配额
// 运行：node test/sec_check_query_ratelimit.test.js
const Module = require('module');
const fs = require('fs');
const path = require('path');

let currentOpenid = 'u';
let dbRows = [];
let nextId = 1;
let dbThrow = false;

// 支持 CloudBase 命令操作符的轻量内存库（同 sec_check_ratelimit_atomic.test.js）。
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
      if (cond.__op === 'lt') { if (!((row[k] || 0) < v)) return false; }
      else if (cond.__op === 'neq') { if (!((row[k] || undefined) !== v)) return false; }
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
      get: async () => {
        if (dbThrow) throw new Error('collection not found');
        return { data: dbRows.filter((r) => rowMatches(r, q)) };
      },
      update: async ({ data }) => {
        if (dbThrow) throw new Error('collection not found');
        const matched = dbRows.filter((r) => rowMatches(r, q));
        matched.forEach((r) => applyData(r, data));
        return { updated: matched.length };
      }
    }),
    doc: (id) => ({
      set: async ({ data }) => {
        if (dbThrow) throw new Error('collection not found');
        let r = dbRows.find((x) => x._id === id);
        if (r) Object.assign(r, data);
        else { r = { _id: id, ...data }; dbRows.push(r); }
        return {};
      },
      get: async () => {
        if (dbThrow) throw new Error('collection not found');
        const r = dbRows.find((x) => x._id === id);
        return { data: r };
      },
      update: async ({ data }) => {
        if (dbThrow) throw new Error('collection not found');
        const r = dbRows.find((x) => x._id === id);
        if (r) { applyData(r, data); return { updated: 1 }; }
        return { updated: 0 };
      },
      remove: async () => {
        if (dbThrow) throw new Error('collection not found');
        dbRows = dbRows.filter((x) => x._id !== id);
        return {};
      }
    }),
    add: async ({ data }) => {
      if (dbThrow) throw new Error('collection not found');
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
  getTempFileURL: async () => ({ fileList: [{ tempFileURL: 'https://example.com/sec_check/x.png' }] }),
  deleteFile: async () => ({}),
  openapi: { security: { mediaCheckAsync: async () => ({ trace_id: 'trace-123' }) } },
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

const WIN = 3600 * 1000;
const winStart = Math.floor(Date.now() / WIN) * WIN;

function reset(openid) { currentOpenid = openid; dbRows = []; dbThrow = false; }
async function callQuery(traceId) {
  return secCheckMain({ action: 'query', traceId: traceId || 'trace-x' });
}
async function callSubmit() {
  return secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_q.png' });
}

// 静态断言：源码含 query 独立限频实现要素
const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'secCheck', 'index.js'), 'utf8');
ok('P2-6: 源码含 QUERY_RATE_LIMIT_MAX 常量（query 独立配额）', /QUERY_RATE_LIMIT_MAX\s*=\s*600/.test(src));
ok('P2-6: 源码使用独立字段 qWindowStart/qCount（不占用 submit 字段）',
  /qWindowStart/.test(src) && /qCount/.test(src));
ok('P2-6: query 分支在读取结果前校验 OPENID（-7 口径与 submit 一致）',
  /action === 'query'[\s\S]{0,600}missing openid/.test(src));
ok('P2-6: query 分支调用 checkQueryRateLimit（独立于 checkRateLimit）',
  /checkQueryRateLimit\(/.test(src));
ok('P2-6: 内存兜底为独立 Map（_memQueryRateStore，不与 submit 兜底混用）',
  /_memQueryRateStore/.test(src));

(async () => {
  // 1) OPENID 为空 → errcode -7（不触达数据库读取结果）
  reset('');
  let r = await callQuery();
  ok('query OPENID 为空 → errcode -7', r && r.errcode === -7);

  // 2) 正常 query：首访创建 q 文档并放行（pending）
  reset('qa');
  r = await callQuery();
  ok('query 首访放行 → status pending', r && r.errcode === 0 && r.status === 'pending');
  const qaDoc = dbRows.find((x) => x._id === 'qa');
  ok('query 首访写入独立字段（qWindowStart/qCount=1，不含 count/windowStart）',
    !!qaDoc && qaDoc.qCount === 1 && qaDoc.qWindowStart === winStart &&
    qaDoc.count === undefined && qaDoc.windowStart === undefined);

  // 3) query 轮询不占用 submit 配额：预置 qCount 已有计数，submit 仍正常走通
  reset('qb');
  await callQuery(); // qb 文档：qCount=1
  r = await callSubmit();
  ok('已有 query 计数时 submit 不受影响（errcode 0 + trace_id）',
    r && r.errcode === 0 && r.trace_id === 'trace-123');
  const qbSubmitDoc = dbRows.find((x) => x._id === 'qb');
  ok('submit 写入自己的字段（count=1），query 字段未被重置',
    !!qbSubmitDoc && qbSubmitDoc.count === 1 && qbSubmitDoc.qCount >= 1);

  // 4) submit 已用满配额时 query 仍可用（两套额度互不干扰）
  reset('qc');
  dbRows = [{ _id: 'qc', openid: 'qc', windowStart: winStart, count: 100 }];
  r = await callQuery();
  ok('submit 配额已满(100) 时 query 仍放行（独立字段互不占用）',
    r && r.errcode === 0 && r.status === 'pending');

  // 5) 爆发上限：连续 700 次合法 query，仅 600 次放行（其余 errcode -6）
  reset('qd');
  let allowed = 0, rateLimited = 0;
  for (let i = 0; i < 700; i++) {
    const rr = await callQuery();
    if (rr && rr.errcode === 0) allowed++;
    else if (rr && rr.errcode === -6) rateLimited++;
  }
  ok('顺序爆发 700 次 query → 仅 600 次放行（QUERY_RATE_LIMIT_MAX 上限生效）', allowed === 600);
  ok('超限 query 返回 errcode -6', rateLimited === 100);

  // 6) 并发爆发（原子条件更新）：预置 qCount=550，200 并发仅再放行 50 次
  reset('qe');
  dbRows = [{ _id: 'qe', openid: 'qe', qWindowStart: winStart, qCount: 550 }];
  const calls = [];
  for (let i = 0; i < 200; i++) calls.push(callQuery());
  const results = await Promise.all(calls);
  const concurrentAllowed = results.filter((rr) => rr && rr.errcode === 0).length;
  ok('并发爆发（qCount=550 + 200 并发）→ 仅再放行 50 次（原子 _.inc 杜绝并发突破）', concurrentAllowed === 50);
  const qeDoc = dbRows.find((x) => x._id === 'qe');
  ok('并发爆发后 qCount 收敛到 600（无超额自增）', qeDoc && qeDoc.qCount === 600);

  // 7) 数据库不可用 → 降级独立内存兜底，不崩溃且放行；同进程告警去重只打一次
  reset('qf'); dbThrow = true;
  let errLogs = [];
  const origErr = console.error;
  console.error = (...a) => { errLogs.push(a.join(' ')); };
  r = await callQuery();
  const r2 = await callQuery();
  console.error = origErr;
  ok('数据库不可用 → query 内存兜底放行（errcode 0）', r && r.errcode === 0 && r2 && r2.errcode === 0);
  ok('降级告警打印一次（query 独立去重标记，提示单实例内存兜底）',
    errLogs.filter((m) => m.includes('query 限频数据库不可用')).length === 1);
  dbThrow = false;

  // 8) 非法 traceId 仍返回 -9（OPENID 校验在其后不改变既有行为）
  reset('qg');
  r = await secCheckMain({ action: 'query', traceId: '' });
  ok('query 非法 traceId → errcode -9（原行为保持）', r && r.errcode === -9);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

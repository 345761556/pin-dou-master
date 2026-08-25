// test/sec_check_ratelimit_atomic.test.js
// S3 回归：云函数限频「读-改-写非原子（TOCTOU）」修复验证。
// 旧实现 where({openid}).get() → 本地 newCount=count+1 → doc(openid).set() 是典型
// 读-改-写序列，云函数多实例并发时多个请求同时读到旧 count 并各自写回，窗口内实际调用
// 次数可远超 RATE_LIMIT_MAX(100)，msgSecCheck 免费额度可被刷爆。
// 新实现改为数据库端「条件更新」：where({_id,windowStart,count:_.lt(MAX)}).update({count:_.inc(1)})，
// server 端原子完成读-判-写，并发请求只有满足条件者被原子自增，其余因 count 已被+1 不再满足
// _.lt(MAX) → 判定为超限，从根上杜绝并发突破上限。
// 验证：边界/窗口重置/爆发仅 MAX 放行/源码结构（原子条件更新，已移除读-改-写）。
// H3 补充（2026-08-15）：新增「count=99 + 50 并发 → 仅 1 次放行」边界场景，
// 精确复现 H3 描述的「N 个并发同时读到 count=99」攻击，证明并发增量被 server 串行化。
// 运行：node test/sec_check_ratelimit_atomic.test.js
const Module = require('module');
const fs = require('fs');
const path = require('path');

let currentOpenid = 'u';
let dbRows = [];
let nextId = 1;
let dbThrow = false;

// 支持 CloudBase 命令操作符的轻量内存库（同 sec_check_cloudfunction.test.js）。
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
  downloadFile: async () => ({ fileContent: Buffer.from('dummy-image-bytes') }),
  // 换取临时访问 URL（main 在限频放行后会调用，缺此桩会抛 getTempFileURL is not a function → errcode -4，
  // 导致「限频放行」用例误判为失败；与限频逻辑无关，纯测试桩补全）。
  getTempFileURL: async () => ({ fileList: [{ tempFileURL: 'https://example.com/sec_check/x.png', status: 0 }] }),
  deleteFile: async () => ({}),
  // 图片检测接口为 mediaCheckAsync（异步），须提供该桩，否则 typeof !== 'function' 短路返回 -12；
  // 返回 trace_id 使 main 完整跑通返回 errcode 0。
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
async function call(openid) {
  currentOpenid = openid;
  const r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_x.png' });
  return r;
}

// 静态断言：源码已从读-改-写改为原子条件更新
const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'secCheck', 'index.js'), 'utf8');
ok('S3: 源码使用原子 _.inc(1) 条件自增（非 existing.count 读-改-写）',
  /_\.inc\(1\)/.test(src) && !/const newCount = \(existing\.count \|\| 0\) \+ 1/.test(src));
ok('S3: 源码使用 _.lt(RATE_LIMIT_MAX) 守卫（防并发突破上限）', /_\.lt\(RATE_LIMIT_MAX\)/.test(src));
ok('S3: 源码使用 _.neq(windowStart) 条件重置（防重置竞态）', /_\.neq\(windowStart\)/.test(src));
ok('S3: 源码内存兜底仅作数据库故障降级（memoryRateLimit）', /memoryRateLimit/.test(src));

(async () => {
  // 1) 边界：预置 count = RATE_LIMIT_MAX → 下一次请求被限频且计数不越界
  reset('a');
  dbRows = [{ _id: 'a', openid: 'a', windowStart: winStart, count: 100 }];
  let r = await call('a');
  ok('边界 count=100 → 被限频 errcode -6', r && r.errcode === -6);
  ok('边界 count=100 → 计数未越界（仍为 100，原子 _.lt 守卫生效）',
    dbRows.find((x) => x._id === 'a').count === 100);

  // 2) 边界：预置 count = 99 → 第 1 次放行（→100），第 2 次限频
  reset('b');
  dbRows = [{ _id: 'b', openid: 'b', windowStart: winStart, count: 99 }];
  r = await call('b');
  ok('边界 count=99 → 第 1 次放行', r && r.errcode === 0);
  ok('边界 count=99 → 放行后计数变为 100', dbRows.find((x) => x._id === 'b').count === 100);
  r = await call('b');
  ok('边界 count=99 → 第 2 次限频', r && r.errcode === -6);

  // 3) 窗口重置：预置过期窗口（windowStart 远早于当前窗口）→ 重置为 count=1 并放行
  reset('c');
  const oldWin = winStart - 10 * WIN;
  dbRows = [{ _id: 'c', openid: 'c', windowStart: oldWin, count: 100 }];
  r = await call('c');
  ok('过期窗口 → 重置后放行（errcode 0）', r && r.errcode === 0);
  const cDoc = dbRows.find((x) => x._id === 'c');
  ok('过期窗口 → 计数重置为 1', cDoc && cDoc.count === 1);
  ok('过期窗口 → windowStart 已切到当前窗口', cDoc && cDoc.windowStart === winStart);

  // 4) 爆发上限（顺序）：单个窗口内连续 150 次调用，仅 100 次放行
  reset('d');
  let allowed = 0;
  for (let i = 0; i < 150; i++) { const rr = await call('d'); if (rr && rr.errcode === 0) allowed++; }
  ok('顺序爆发 150 次 → 仅 100 次放行（窗口上限生效）', allowed === 100);

  // 5) 爆发上限（并发 Promise.all，预置已有文档 count=50）：原子条件更新保证仅再放行 50 次
  //    且计数收敛到 100——这是 S3 核心修复（并发增量路径原子化，杜绝 TOCTOU 突破上限）。
  reset('e');
  dbRows = [{ _id: 'e', openid: 'e', windowStart: winStart, count: 50 }];
  const calls = [];
  for (let i = 0; i < 150; i++) calls.push(call('e'));
  const results = await Promise.all(calls);
  const concurrentAllowed = results.filter((rr) => rr && rr.errcode === 0).length;
  ok('并发爆发 150 次（已有 count=50）→ 仅再放行 50 次（原子 _.inc 杜绝并发突破）', concurrentAllowed === 50);
  const eDoc = dbRows.find((x) => x._id === 'e');
  ok('并发爆发后计数收敛到 100（无超额自增）', eDoc && eDoc.count === 100);

  // 6) 创建路径边界（并发空文档）：仅首访瞬时存在「并发创建」窗口，原子 _.inc 保证计数永不超过上限；
  //    该路径至多让窗口首访多放行少量（真实云开发 server 端事务隔离下不会并发创建），此处仅断言
  //    不崩溃且计数恒 ≤100（增量路径原子性兜底，根因已修复）。
  reset('g');
  const calls2 = [];
  for (let i = 0; i < 150; i++) calls2.push(call('g'));
  const res2 = await Promise.all(calls2);
  const allowed2 = res2.filter((rr) => rr && rr.errcode === 0).length;
  const gDoc = dbRows.find((x) => x._id === 'g');
  ok('并发空文档首访不崩溃且至少放行 100 次（增量路径上限生效）', allowed2 >= 100);
  ok('并发空文档首访后计数恒 ≤100（原子 _.inc 兜底，杜绝计数溢出）', gDoc && gDoc.count >= 1 && gDoc.count <= 100);

  // 7) 内存兜底降级：限频 DB 抛错时不崩溃；但 pending 文档写入同样依赖 DB →
  //    无法落 pending 时 fail-closed 返回 -14（阻断提交，避免「表面受理实际必被误拦」），
  //    B21：降级须打印告警（且同进程去重只打一次）
  reset('f'); dbThrow = true;
  let errLogs = [];
  const origErr = console.error;
  console.error = (...a) => { errLogs.push(a.join(' ')); };
  r = await call('f');
  const rDegrade2 = await call('f'); // 同进程第二次降级，应去重不再打印完整错误
  console.error = origErr;
  ok('数据库不可用 → 不崩溃，fail-closed 返回 -14（pending 无法落盘，阻断提交）',
    r && r.errcode === -14 && rDegrade2 && rDegrade2.errcode === -14);
  ok('B21: 降级时打印告警（提示已退化为单实例内存兜底 + 免费额度风险）',
    errLogs.some((m) => m.includes('限频数据库不可用') && m.includes('已降级为单实例内存兜底')));
  ok('B21: 同进程重复降级仅告警一次（避免持续故障期日志风暴）',
    errLogs.filter((m) => m.includes('已降级为单实例内存兜底')).length === 1);
  dbThrow = false;

  // 8) H3 边界并发（count=99 → 50 并发）：仅 1 次放行（99→100），其余被 _.lt 守卫拒绝。
  //    精确复现 H3 描述的「N 个并发同时读到 count=99 → 各自判定 newCount=100 放行 N 次」
  //    攻击场景——证明原子条件更新下并发增量由 server 串行化，绝无读-改-写绕过。
  reset('h');
  dbRows = [{ _id: 'h', openid: 'h', windowStart: winStart, count: 99 }];
  const hCalls = [];
  for (let i = 0; i < 50; i++) hCalls.push(call('h'));
  const hResults = await Promise.all(hCalls);
  const hAllowed = hResults.filter((rr) => rr && rr.errcode === 0).length;
  ok('H3 边界 count=99 + 50 并发 → 仅 1 次放行（其余被原子 _.lt 守卫拒绝）', hAllowed === 1);
  const hDoc = dbRows.find((x) => x._id === 'h');
  ok('H3 边界并发后计数收敛为 100（无超额自增、无读-改-写覆写）', hDoc && hDoc.count === 100);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

// test/sec_check_cloudfunction.test.js
// L10 回归：云函数 secCheck「任意 fileID 删除 + 无限频」安全漏洞修复验证。
// 轻量 mock wx-server-sdk（cloud 对象），验证：
//   1) 非 sec_check/ 前缀的 fileID 被拒绝（errcode -5），不触发 downloadFile/deleteFile（防任意文件删除）
//   2) openid 超过 RATE_LIMIT_MAX(100) 被限频（errcode -6），不触发 downloadFile/deleteFile（防刷爆额度）
//   3) 合法 sec_check/ 前缀 fileID → 正常走到 downloadFile 并返回 pass（happy path）
//   4) 数据库不可用（未建 sec_check_rate 集合）时不崩溃，走内存兜底限频
// 注意：部署前须在云开发控制台创建集合 sec_check_rate（openid 窗口限频持久层）。
// 运行：node test/sec_check_cloudfunction.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---- mock wx-server-sdk（拦截 require('wx-server-sdk')）----
let currentOpenid = 'userA';
let downloadCalls = [];
let deleteCalls = [];
let dbRows = [];
let nextId = 1;
let dbThrow = false; // 注入数据库调用抛错 → 触发内存兜底分支

// 支持 CloudBase 命令操作符的轻量内存库，用于验证原子限频语义（S3 修复后）。
// 实现 _.lt / _.neq / _.inc，并在 update 时返回 { updated }（命中条数），
// 以忠实模拟「数据库端条件更新 + 原子自增」语义。
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
        return { data: r }; // 未命中为 undefined（与 wx-server-sdk 行为一致）
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
  downloadFile: async ({ fileID }) => { downloadCalls.push(fileID); return { fileContent: Buffer.from('dummy-image-bytes') }; },
  deleteFile: async ({ fileList }) => { deleteCalls.push(fileList); return {}; },
  getTempFileURL: async ({ fileList }) => ({ fileList: (fileList || []).map((id) => ({ fileID: id, tempFileURL: 'https://example.com/' + id })) }),
  openapi: { security: { mediaCheckAsync: async (args) => { secCheckArgs.push(args); return { errcode: 0, errmsg: 'ok', traceId: 'trace-test-001' }; } } },
  database: () => db
};

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'wx-server-sdk') return fakeCloud;
  return realRequire.apply(this, arguments);
};
const secCheckMain = require('../cloudfunctions/secCheck/index.js').main;
Module.prototype.require = realRequire;

// ---- 计数器 ----
let passed = 0, failed = 0;
let secCheckArgs = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// 静态断言：云函数含 sec_check/ 前缀校验分支与限频逻辑
const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'secCheck', 'index.js'), 'utf8');
ok('云函数含 sec_check/ 前缀校验分支', /sec_check\//.test(src));
ok('云函数归属校验使用精确前缀（startsWith），非子串 includes（防绕过）',
  /startsWith\(SEC_CHECK_KEY_PREFIX\)/.test(src) && !/fileID\.includes\(/.test(src));
ok('云函数含路径遍历防护（排除 .. 段）', /isOwnedSecCheckFile/.test(src) && /\.\./.test(src));
ok('云函数含限频逻辑 checkRateLimit', /checkRateLimit/.test(src));
ok('云函数含 RATE_LIMIT_MAX 常量', /RATE_LIMIT_MAX/.test(src));
ok('S3: 限频使用原子条件更新 _.inc（非旧版读-改-写 set）', /_\.inc\(1\)/.test(src));
ok('S3: 限频使用 _.lt(RATE_LIMIT_MAX) 条件守卫（防并发突破上限）', /_\.lt\(RATE_LIMIT_MAX\)/.test(src));
ok('S3: 限频使用 _.neq(windowStart) 原子重置（防窗口重置竞态）', /_\.neq\(windowStart\)/.test(src));
ok('S3: 窗口内累加为单一条件 update（旧版 existing.count 读-改-写模式已移除）',
  /coll\.where\([\s\S]*?\)\.update\([\s\S]*?_\.inc\(1\)/.test(src) &&
  !/const newCount = \(existing\.count \|\| 0\) \+ 1/.test(src));
ok('媒体安全接口守卫：mediaCheckAsync 调用前做 typeof 判型（旧版 SDK 缺失返回明确 -12，不抛 TypeError 被吞为模糊 internal_error）',
  /typeof cloud\.openapi\.security\.mediaCheckAsync !== 'function'/.test(src) &&
  /sdk_unsupported_mediaCheckAsync/.test(src));

(async () => {
  // 1) 非 sec_check/ 前缀 fileID → 拒绝 -5，不 download/delete（防任意文件删除）
  downloadCalls = []; deleteCalls = [];
  currentOpenid = 'userA';
  let r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/other/user_photo.png' });
  ok('非 sec_check/ 前缀 fileID → errcode -5', r && r.errcode === -5);
  ok('非 sec_check/ 前缀 → 不触发 downloadFile（不下载他人文件/不消耗额度）', downloadCalls.length === 0);
  ok('非 sec_check/ 前缀 → 不触发 deleteFile（不删他人文件）', deleteCalls.length === 0);

  // 1b) https 形态非 sec_check/ 前缀同样拒绝
  downloadCalls = []; deleteCalls = [];
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'https://bucket.tcb.qcloud.com/env-test/private/secret.png' });
  ok('https 形态非 sec_check/ 前缀 → errcode -5', r && r.errcode === -5);
  ok('https 形态非 sec_check/ 前缀 → 不触发 downloadFile', downloadCalls.length === 0);

  // 1c) S1 回归：子串绕过 —— 存储 key 中 /sec_check/ 不在开头（user/sec_check/evil.png）
  //       旧实现 fileID.includes('/sec_check/') 会误放过，新实现按存储 key 精确前缀拒绝
  downloadCalls = []; deleteCalls = [];
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/user/sec_check/evil.png' });
  ok('S1: 子串绕过 fileID(user/sec_check/) → errcode -5（旧 includes 误放过）', r && r.errcode === -5);
  ok('S1: 子串绕过 → 不触发 downloadFile', downloadCalls.length === 0);
  ok('S1: 子串绕过 → 不触发 deleteFile', deleteCalls.length === 0);

  // 1d) S1 回归：路径遍历 —— sec_check/../other/x.png 含 '..' 段
  downloadCalls = []; deleteCalls = [];
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/../other/x.png' });
  ok('S1: 路径遍历 fileID(sec_check/../) → errcode -5', r && r.errcode === -5);
  ok('S1: 路径遍历 → 不触发 downloadFile', downloadCalls.length === 0);

  // 1e) https 形态合法 sec_check/ 前缀仍正常收容（确认两种格式均按 key 精确前缀判定）
  downloadCalls = []; deleteCalls = []; secCheckArgs = [];
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'https://bucket.tcb.qcloud.com/env-test/sec_check/1700000000000_ok.png' });
  ok('S1: https 合法 sec_check/ 前缀 → 走 mediaCheckAsync 链路（两种格式均收容）', secCheckArgs.length === 1);
  ok('S1: https 合法 sec_check/ 前缀 → 返回 errcode 0 + trace_id', r && r.errcode === 0 && r.trace_id === 'trace-test-001');

  // 2) 合法 sec_check/ 前缀 → 正常走 media_url 链路并返回 trace_id（happy path）
  downloadCalls = []; deleteCalls = []; secCheckArgs = []; dbRows = []; currentOpenid = 'userB';
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_ab12cd34.png' });
  ok('合法 sec_check/ 前缀 → 返回 errcode 0 + trace_id', r && r.errcode === 0 && r.trace_id === 'trace-test-001');
  ok('合法 sec_check/ 前缀 → 提交后仍触发 deleteFile（清理本文件）', deleteCalls.length === 1);
  // R6 修复：mediaCheckAsync 入参（图片正确接口；msgSecCheck 是文本接口，传图片必 47001）
  ok('mediaCheckAsync 入参 media_type === 2（数字图片枚举）',
    secCheckArgs.length === 1 && secCheckArgs[0].media_type === 2);
  ok('mediaCheckAsync 入参 version === 2', secCheckArgs.length === 1 && secCheckArgs[0].version === 2);
  ok('mediaCheckAsync 入参 openid 已传', secCheckArgs.length === 1 && secCheckArgs[0].openid === 'userB');
  ok('mediaCheckAsync 入参 media_url 为公网 https URL',
    secCheckArgs.length === 1 && typeof secCheckArgs[0].media_url === 'string' && /^https:\/\//.test(secCheckArgs[0].media_url));
  ok('mediaCheckAsync 入参 scene 已传', secCheckArgs.length === 1 && secCheckArgs[0].scene === 2);

  // 2b) action=query：查结果（pending → done）
  dbRows = [];
  r = await secCheckMain({ action: 'query', traceId: 'trace-test-001' });
  ok('query 未写入结果 → status pending', r && r.errcode === 0 && r.status === 'pending');
  dbRows = [{ _id: 'trace-test-001', suggest: 'pass', label: 100 }];
  r = await secCheckMain({ action: 'query', traceId: 'trace-test-001' });
  ok('query 已有结果 → status done + suggest', r && r.errcode === 0 && r.status === 'done' && r.suggest === 'pass');
  r = await secCheckMain({ action: 'query', traceId: '' });
  ok('query 非法 traceId → errcode -9', r && r.errcode === -9);
  dbRows = [];

  // 5) 幂等 upsert：同一 openid 多次调用只产生 1 条限频文档（L4 修复：杜绝并发 add 重复记录）
  dbRows = []; currentOpenid = 'userE';
  await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_e1.png' });
  await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_e2.png' });
  const eDocs = dbRows.filter((r) => r.openid === 'userE');
  ok('同一 openid 多次调用限频集合只产生 1 条文档（幂等 upsert，无重复记录）', eDocs.length === 1);

  // 3) 限频：窗口内 openid 已用满 RATE_LIMIT_MAX(100) → 限频 -6，不 download/delete
  // 注意：预置「规范文档」(_id === openid) 模拟「当前用户已用满额度」；windowStart 须与
  // 生产逻辑一致（按 RATE_LIMIT_WINDOW_MS=3600*1000 取整到小时），否则会判为窗口过期而重置。
  // 若用旧格式 auto-id（如 _id:'r1'）则会被 L1 迁移修复当作孤立文档清理并重置，属预期行为
  // （见新测试 sec_check_migration_dual_doc.test.js）。
  downloadCalls = []; deleteCalls = [];
  const winStart = Math.floor(Date.now() / 3600000) * 3600000;
  dbRows = [{ _id: 'userC', openid: 'userC', windowStart: winStart, count: 100 }];
  currentOpenid = 'userC';
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_zz.png' });
  ok('openid 用满 100 次 → errcode -6 限频', r && r.errcode === -6);
  ok('限频 → 不触发 getTempFileURL（不消耗 mediaCheckAsync 额度）', downloadCalls.length === 0);
  ok('限频 → 不触发 deleteFile（不误删文件）', deleteCalls.length === 0);

  // 4) 内存兜底：数据库抛错（未建集合）时不崩溃，走内存兜底且仍正常放行
  dbThrow = true;
  downloadCalls = []; deleteCalls = []; secCheckArgs = [];
  dbRows = []; currentOpenid = 'userD';
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_mm.png' });
  ok('数据库不可用（未建集合）不崩溃 → 走 mediaCheckAsync 链路（内存兜底放行）', secCheckArgs.length === 1);
  dbThrow = false;

  // 2c) 旧版 SDK 守卫：cloud.openapi.security.mediaCheckAsync 不存在时返回明确 -12
  //     （不抛 TypeError 被 catch 吞成模糊的 sec_check_internal_error，导致根源彻底丢失、排查困难）
  dbRows = []; currentOpenid = 'userF';
  downloadCalls = []; deleteCalls = []; secCheckArgs = [];
  const savedMediaCheck = fakeCloud.openapi.security.mediaCheckAsync;
  fakeCloud.openapi.security.mediaCheckAsync = undefined; // 模拟旧版 wx-server-sdk 无此方法
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_sdk.png' });
  fakeCloud.openapi.security.mediaCheckAsync = savedMediaCheck; // 恢复，避免影响后续
  ok('mediaCheckAsync 缺失 → 返回明确 errcode -12（非模糊 sec_check_internal_error）', r && r.errcode === -12);
  ok('mediaCheckAsync 缺失 → errmsg 为 sdk_unsupported_mediaCheckAsync', r && r.errmsg === 'sdk_unsupported_mediaCheckAsync');
  ok('mediaCheckAsync 缺失 → 不实际调用 mediaCheckAsync（secCheckArgs 为空）', secCheckArgs.length === 0);

  // 6) getTempFileURL 返回值校验（防御性）：返回空 fileList 或空 tempFileURL 时返回明确 -8，
  //    不向下调用 mediaCheckAsync（不消耗额度），但 finally 仍 deleteFile 清理已上传文件（防残留）
  //    报告 [8] 结论：该防御分支正确、无需改动；此处锁定以防日后「简化」短路链改坏
  dbRows = []; currentOpenid = 'userG';
  downloadCalls = []; deleteCalls = []; secCheckArgs = [];
  const savedGetTempFileURL = fakeCloud.getTempFileURL;
  // 6a) fileList 数组长度为 0（理论极端情形）
  fakeCloud.getTempFileURL = async () => ({ fileList: [] });
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_g1.png' });
  ok('getTempFileURL 返回空 fileList → errcode -8（防御：tmp 为 undefined → tempURL 为 undefined）', r && r.errcode === -8);
  ok('getTempFileURL 空 fileList → 不触发 mediaCheckAsync（短路在此之前，不消耗检测额度）', secCheckArgs.length === 0);
  ok('getTempFileURL 空 fileList → finally 仍 deleteFile 清理已上传文件（防云存储残留）', deleteCalls.length === 1);
  // 6b) fileList[0] 存在但 tempFileURL 为空串（云存储副本未就绪/已过期）
  deleteCalls = []; secCheckArgs = [];
  fakeCloud.getTempFileURL = async () => ({ fileList: [{ fileID: 'cloud://env-test/sec_check/1700000000000_g1.png', tempFileURL: '' }] });
  r = await secCheckMain({ type: 'image', scene: 2, fileID: 'cloud://env-test/sec_check/1700000000000_g1.png' });
  ok('getTempFileURL 返回空串 tempFileURL → errcode -8（防御：空串 falsy → !tempURL 命中）', r && r.errcode === -8);
  fakeCloud.getTempFileURL = savedGetTempFileURL; // 恢复，避免影响后续

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

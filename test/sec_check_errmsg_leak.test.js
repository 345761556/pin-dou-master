// test/sec_check_errmsg_leak.test.js
// M6 回归：云函数 secCheck 的 catch 分支曾将底层异常消息（e.errMsg / e.message）
// 原样塞进返回的 errmsg 透传客户端，可能泄露资源名/调用链/SDK 版本/region 等内部细节。
// 修复后：errmsg 收敛为固定通用令牌 'sec_check_internal_error'，详细错误仅 console.error
// 写入服务端日志（不回传客户端）；前端仅依据 errcode 数字做 fail-closed 分支，不依赖 errmsg。
// 运行：node test/sec_check_errmsg_leak.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let currentOpenid = 'userM6';
let downloadCalls = [];
let deleteCalls = [];
let dbRows = [];
let nextId = 1;
let dbThrow = false;
let msgSecCheckShouldThrow = false;
let msgSecCheckError = null;

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
  getTempFileURL: async ({ fileList }) => {
    // 模拟返回临时 URL
    return { fileList: [{ fileID: fileList[0], tempFileURL: 'https://example.com/temp.png', status: 0 }] };
  },
  downloadFile: async ({ fileID }) => { downloadCalls.push(fileID); return { fileContent: Buffer.from('dummy-image-bytes') }; },
  deleteFile: async ({ fileList }) => { deleteCalls.push(fileList); return {}; },
  openapi: {
    security: {
      mediaCheckAsync: async () => {
        if (msgSecCheckShouldThrow) throw msgSecCheckError;
        return { trace_id: 'test-trace-001', traceId: 'test-trace-001' };
      }
    }
  },
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

// ---- 静态断言：源码已消除「底层异常消息透传客户端」模式 ----
const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'secCheck', 'index.js'), 'utf8');
ok('云函数不再把 e.errMsg/e.message 直接作为返回 errmsg（旧泄露模式已移除）',
  !/errmsg:\s*\(e && \(e\.errMsg \|\| e\.message\)\)/.test(src));
ok('云函数 errmsg 收敛为固定通用令牌 sec_check_internal_error',
  /errmsg:\s*'sec_check_internal_error'/.test(src));
ok('云函数对底层异常详细错误仅 console.error 服务端日志（不回传）',
  /console\.error\(['\"]\[secCheck\].*?内部/.test(src) || /console\.error\(['\"]\[secCheck\].*?detail/.test(src) || /console\.error\(['\"]\[secCheck\].*?内部错误/.test(src));
ok('云函数注释声明 errmsg 固定通用令牌、不透传内部细节（L10 前端约定）',
  /errmsg:\s*'sec_check_internal_error'/.test(src) && /不[透泄]传/.test(src));

(async () => {
  // ---- 动态断言 1：msgSecCheck 抛含内部细节的异常，返回 errmsg 不得泄露 ----
  const SENSITIVE = 'wx openapi security.msgSecCheck:fail api unauthorized (env:prod-xyz,sdk:2.3.1,region:ap-shanghai,bucket:sec-check-12345)';
  msgSecCheckShouldThrow = true;
  msgSecCheckError = new Error(SENSITIVE);
  msgSecCheckError.errCode = -100; // 模拟微信接口返回的错误码

  downloadCalls = []; deleteCalls = []; dbRows = []; currentOpenid = 'userM6a';
  // 捕获服务端 console.error 输出
  const serverLogs = [];
  const origErr = console.error;
  console.error = (...args) => { serverLogs.push(args.map(String).join(' ')); };

  const r = await secCheckMain({
    type: 'image', scene: 2,
    fileID: 'cloud://env-test/sec_check/1700000000000_m6.png'
  });

  console.error = origErr;

  ok('异常路径：返回 errcode 保留底层数值(-100)', r && r.errcode === -100);
  ok('异常路径：errmsg 为固定令牌 sec_check_internal_error', r && r.errmsg === 'sec_check_internal_error');
  ok('异常路径：errmsg 不含原始敏感消息（无资源名/env/sdk/region 泄露）',
    r && r.errmsg.indexOf(SENSITIVE) === -1 && r.errmsg.indexOf('api unauthorized') === -1 && r.errmsg.indexOf('ap-shanghai') === -1);
  ok('异常路径：原始敏感细节仅出现在服务端 console.error 日志（未回传）',
    serverLogs.some((l) => l.indexOf(SENSITIVE) !== -1));
  ok('异常路径：已下载文件仍触发 deleteFile 清理（隐私/配额）', deleteCalls.length === 1);

  // ---- 动态断言 2：errCode 缺省时 fallback 为 -4，errmsg 仍为固定令牌 ----
  msgSecCheckShouldThrow = true;
  msgSecCheckError = new Error('some low-level exception without errCode');
  // 清掉 errCode，模拟仅 message 的情况
  delete msgSecCheckError.errCode;

  downloadCalls = []; deleteCalls = []; dbRows = []; currentOpenid = 'userM6b';
  const r2 = await secCheckMain({
    type: 'image', scene: 4,
    fileID: 'cloud://env-test/sec_check/1700000000000_m6b.png'
  });
  ok('errCode 缺省：errcode fallback 为 -4', r2 && r2.errcode === -4);
  ok('errCode 缺省：errmsg 仍为固定令牌（不回退到 sec_check_failed 或原始消息）',
    r2 && r2.errmsg === 'sec_check_internal_error');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

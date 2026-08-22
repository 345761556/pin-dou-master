// test/sec_check_text_action.test.js
// P1-1 回归：secCheck 云函数新增 action=text 分支（昵称等 UGC 文本接入 msgSecCheck v2）。
// 验证：
//   1) 入参校验：空/非字符串 → -1；超长(>50) → -2
//   2) OPENID 判空 → -7（与 submit 口径一致）
//   3) 过 submit 同款限频（共享 100/h 额度，超限 → -6）
//   4) msgSecCheck 正常返回 result.suggest → { errcode:0, suggest }
//   5) msgSecCheck 缺失（旧版 SDK）→ 明确 -12（仿 mediaCheckAsync 的 -12 分支）
//   6) msgSecCheck 抛异常 → errmsg 收敛为固定令牌 sec_check_internal_error（M6 口径，不透传细节）
// 前端 utils/secCheck.checkText：fail-closed 与图片链路同口径（develop 放行 / 生产拦截）。
// 运行：node test/sec_check_text_action.test.js
const Module = require('module');
const fs = require('fs');
const path = require('path');

let currentOpenid = 'u';
let dbRows = [];
let nextId = 1;
let dbThrow = false;
let msgSecCheckImpl = async () => ({ errcode: 0, result: { suggest: 'pass', label: 100 } });

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
  openapi: { security: { mediaCheckAsync: async () => ({ trace_id: 'trace-123' }), msgSecCheck: (args) => msgSecCheckImpl(args) } },
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

function reset(openid) { currentOpenid = openid; dbRows = []; dbThrow = false; }
function callText(content) {
  return secCheckMain({ action: 'text', content });
}

// 静态断言：源码含 text 分支实现要素
const src = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'secCheck', 'index.js'), 'utf8');
ok('P1-1: 云函数含 action=text 分支', /action === 'text'/.test(src));
ok('P1-1: text 分支 typeof 判型 msgSecCheck（旧版 SDK 返回明确 -12）',
  /typeof cloud\.openapi\.security\.msgSecCheck !== 'function'/.test(src) &&
  /sdk_unsupported_msgSecCheck/.test(src));
ok('P1-1: text 分支异常收敛为固定令牌 sec_check_internal_error（M6 口径）',
  /errmsg:\s*'sec_check_internal_error'/.test(src));
ok('P1-1: text 分支超长拒绝（errcode -2，不静默截断）', /content too long/.test(src));

// 前端 utils/secCheck.checkText 静态断言
const feSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'secCheck.js'), 'utf8');
ok('P1-1: 前端导出 checkText', typeof require('../utils/secCheck').checkText === 'function');
ok('P1-1: checkText 复用 resolveFail（fail-closed 与图片链路同口径）',
  /function checkText\(/.test(feSrc) && /resolveFail\('invalid_text'/.test(feSrc));

(async () => {
  // 1) 入参校验
  reset('t1');
  let r = await callText('');
  ok('text 空 content → errcode -1', r && r.errcode === -1);
  r = await callText('   ');
  ok('text 纯空白 content → errcode -1', r && r.errcode === -1);
  r = await callText('a'.repeat(51));
  ok('text 超长 content(51) → errcode -2', r && r.errcode === -2);
  r = await callText(12345);
  ok('text 非字符串 content → errcode -1', r && r.errcode === -1);

  // 2) OPENID 判空
  reset('');
  r = await callText('正常昵称');
  ok('text OPENID 为空 → errcode -7', r && r.errcode === -7);

  // 3) 正常检测：pass / risky
  reset('t3');
  let capturedArgs = null;
  msgSecCheckImpl = async (args) => { capturedArgs = args; return ({ errcode: 0, result: { suggest: 'pass', label: 100 } }); };
  r = await callText('拼豆爱好者');
  ok('text msgSecCheck pass → errcode 0 + suggest=pass', r && r.errcode === 0 && r.suggest === 'pass');
  // R1 回归：msgSecCheck v2 的 scene 为必填参数，昵称属资料场景固定 scene=1
  ok('R1: text msgSecCheck 入参含 scene=1 且 version=2',
    capturedArgs && capturedArgs.scene === 1 && capturedArgs.version === 2);
  msgSecCheckImpl = async () => ({ errcode: 0, result: { suggest: 'risky', label: 20001 } });
  r = await callText('违规昵称');
  ok('text msgSecCheck risky → suggest=risky 透传（拦截判定由前端做）', r && r.errcode === 0 && r.suggest === 'risky');

  // 4) msgSecCheck 未返回 suggest → -11
  msgSecCheckImpl = async () => ({ errcode: 0 });
  r = await callText('无建议');
  ok('text msgSecCheck 无 suggest → errcode -11', r && r.errcode === -11);

  // 5) 限频：预置 count=100（submit 同款字段）→ text 也被 -6 拦截（共享 100/h 额度）
  reset('t5');
  const winStart = Math.floor(Date.now() / 3600000) * 3600000;
  dbRows = [{ _id: 't5', openid: 't5', windowStart: winStart, count: 100 }];
  r = await callText('限频昵称');
  ok('text 与图片共享 100/h 限频（超限 → errcode -6）', r && r.errcode === -6);

  // 6) 旧版 SDK：msgSecCheck 缺失 → 明确 -12
  reset('t6');
  const saved = fakeCloud.openapi.security.msgSecCheck;
  fakeCloud.openapi.security.msgSecCheck = undefined;
  r = await callText('版本过低');
  fakeCloud.openapi.security.msgSecCheck = saved;
  ok('text msgSecCheck 缺失 → errcode -12（非模糊 internal_error）', r && r.errcode === -12);
  ok('text msgSecCheck 缺失 → errmsg=sdk_unsupported_msgSecCheck', r && r.errmsg === 'sdk_unsupported_msgSecCheck');

  // 7) 异常不透传：msgSecCheck 抛含敏感细节异常 → errmsg 固定令牌
  reset('t7');
  const SENSITIVE = 'wx openapi security.msgSecCheck:fail api unauthorized (env:prod-xyz,sdk:2.3.1)';
  msgSecCheckImpl = async () => { throw new Error(SENSITIVE); };
  const serverLogs = [];
  const origErr = console.error;
  console.error = (...a) => { serverLogs.push(a.map(String).join(' ')); };
  r = await callText('异常昵称');
  console.error = origErr;
  ok('text 异常 → errmsg 固定令牌 sec_check_internal_error（不透传敏感细节）',
    r && r.errmsg === 'sec_check_internal_error' && r.errmsg.indexOf('api unauthorized') === -1);
  ok('text 异常 → 详细错误仅落服务端日志', serverLogs.some((l) => l.indexOf(SENSITIVE) !== -1));

  // 8) 前端 checkText 动态断言（fail-closed 口径）
  const secCheck = require('../utils/secCheck');
  global.wx = {
    getAccountInfoSync: () => null, // 无法判定环境 → fail-closed
    cloud: {
      uploadFile: () => {},
      callFunction({ data, success }) {
        if (data && data.action === 'text') {
          success({ result: { errcode: 0, errmsg: 'ok', suggest: 'risky' } });
          return;
        }
        success({ result: { errcode: -1 } });
      },
      deleteFile: () => {}
    }
  };
  let fr = await secCheck.checkText('违规昵称');
  ok('checkText risky → 拦截（pass=false, blockType=violation）',
    fr.pass === false && fr.blockType === 'violation');
  delete global.wx.cloud;
  fr = await secCheck.checkText('任意昵称');
  ok('checkText 云不可用 → fail-closed 拦截（blockType=unavailable）',
    fr.pass === false && fr.blockType === 'unavailable');
  // develop 环境 → fail-open 放行
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'develop' } });
  fr = await secCheck.checkText('任意昵称');
  ok('checkText develop 云不可用 → fail-open 放行（与图片链路同口径）', fr.pass === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

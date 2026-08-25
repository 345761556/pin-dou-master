// test/media_check_result.test.js
// M1 回归：mediaCheckResult 来源校验（防内容安全绕过）。
// 验证：
//   1) 缺少信封字段的伪造调用（直接 callFunction / 云端测试）被忽略，不写入 sec_check_results
//   2) 含 MsgType:'event' + Event:'wxa_media_check' 的合法微信推送被正常处理并写入
//   3) 合法推送但 result 不可信（errcode!=0 / 缺 result）不写入（fail-closed）
//   4) 信封字段伪造但错误（MsgType 不符）被忽略
// 运行：node test/media_check_result.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let written = [];   // 记录写入 sec_check_results 的记录
let dbThrow = false;

const db = {
  // L4 原子化条件更新的操作符桩：exists(false) 返回哨兵值，where 条件据此判断
  command: { exists: (v) => ({ __exists: v }) },
  collection: () => ({
    doc: (id) => ({
      set: async ({ data }) => {
        if (dbThrow) throw new Error('collection not found');
        written.push({ _id: id, ...data });
        return {};
      },
      get: async () => {
        if (dbThrow) throw new Error('collection not found');
        const r = written.find((x) => x._id === id);
        return { data: r };
      }
    }),
    // L4 原子化：结果写入走 where({_id, suggest: exists(false)}).update 条件更新
    where: (cond) => ({
      update: async ({ data }) => {
        if (dbThrow) throw new Error('collection not found');
        const rec = written.find((x) => x._id === cond._id && (x.suggest === undefined || x.suggest === null));
        if (!rec) return { stats: { updated: 0 } };
        Object.assign(rec, data);
        return { stats: { updated: 1 } };
      }
    })
  })
};

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init: () => {},
  database: () => db
};

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'wx-server-sdk') return fakeCloud;
  return realRequire.apply(this, arguments);
};
const main = require('../cloudfunctions/mediaCheckResult/index.js').main;
Module.prototype.require = realRequire;

// 静态断言：源码含信封来源校验
const src = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'mediaCheckResult', 'index.js'), 'utf8'
);
assert.ok(/MsgType\s*!==\s*['"]event['"]/.test(src), '源码应校验 MsgType === event');
assert.ok(/Event\s*!==\s*['"]wxa_media_check['"]/.test(src), '源码应校验 Event === wxa_media_check');

(async () => {
  // 0) 先写入 pending 文档（L2 pending 存在性校验：推送结果只允许覆盖真实 submit 过的 trace_id）
  const seedPending = (traceId, appid) => {
    written.push({ _id: traceId, status: 'pending', appid, createdAt: Date.now() });
  };

  // 1) 伪造直接调用（无信封）→ 忽略，不写入
  written = [];
  let r = await main({ trace_id: 'forge-1', errcode: 0, result: { suggest: 'pass' } });
  assert.strictEqual(r.errmsg, 'ignored', '伪造调用应被忽略');
  assert.strictEqual(written.length, 0, '伪造调用不得写入 sec_check_results');

  // 2) 合法微信推送（含信封 + 已提交的 pending）→ 写入
  written = [];
  seedPending('push-1', 'wx_test_appid_fixture');
  r = await main({
    MsgType: 'event', Event: 'wxa_media_check', appid: 'wx_test_appid_fixture',
    trace_id: 'push-1', errcode: 0, result: { suggest: 'pass', label: 100 }
  });
  assert.strictEqual(r.errmsg, 'ok', '合法推送应写入成功');
  assert.strictEqual(written.length, 1, '合法推送应原地更新 pending（共 1 条记录）');
  const finalDoc = written.find((x) => x._id === 'push-1');
  assert.ok(finalDoc, '推送结果应更新 pending 文档');
  assert.strictEqual(finalDoc._id, 'push-1', '写入 _id 应为 trace_id');
  assert.strictEqual(finalDoc.suggest, 'pass', '写入 suggest 应为 pass');

  // 3) 合法推送但不可信（errcode=-1008）→ 不写入（fail-closed）
  written = [];
  seedPending('push-2', 'wx_test_appid_fixture');
  r = await main({
    MsgType: 'event', Event: 'wxa_media_check',
    trace_id: 'push-2', errcode: -1008, result: { suggest: 'pass' }
  });
  assert.strictEqual(r.errmsg, 'ignored_untrusted', '不可信结果应 fail-closed 忽略');
  assert.strictEqual(written.length, 1, '不可信结果不得写入（仅保留 pending）');

  // 3b) 合法推送但无 pending（伪造 trace_id）→ 忽略不写入（L2 校验）
  written = [];
  r = await main({
    MsgType: 'event', Event: 'wxa_media_check', appid: 'wx_test_appid_fixture',
    trace_id: 'push-forged', errcode: 0, result: { suggest: 'pass' }
  });
  assert.strictEqual(r.errmsg, 'ignored_unverified', '无 pending 的伪造推送应被 L2 拒绝');
  assert.strictEqual(written.length, 0, '伪造 trace_id 不得写入');

  // 4) 信封字段伪造但错误（MsgType 不符）→ 忽略
  written = [];
  seedPending('push-3', 'wx_test_appid_fixture');
  r = await main({
    MsgType: 'text', Event: 'wxa_media_check',
    trace_id: 'push-3', errcode: 0, result: { suggest: 'pass' }
  });
  assert.strictEqual(r.errmsg, 'ignored', '信封不符应被忽略');
  assert.strictEqual(written.length, 1, '信封不符不得写入（仅保留 pending）');

  console.log('ALL MEDIA_CHECK_RESULT TESTS PASSED');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

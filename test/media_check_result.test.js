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
  // 1) 伪造直接调用（无信封）→ 忽略，不写入
  written = [];
  let r = await main({ trace_id: 'forge-1', errcode: 0, result: { suggest: 'pass' } });
  assert.strictEqual(r.errmsg, 'ignored', '伪造调用应被忽略');
  assert.strictEqual(written.length, 0, '伪造调用不得写入 sec_check_results');

  // 2) 合法微信推送（含信封）→ 写入
  written = [];
  r = await main({
    MsgType: 'event', Event: 'wxa_media_check', appid: 'wx33440d447b366a9d',
    trace_id: 'push-1', errcode: 0, result: { suggest: 'pass', label: 100 }
  });
  assert.strictEqual(r.errmsg, 'ok', '合法推送应写入成功');
  assert.strictEqual(written.length, 1, '合法推送应写入 1 条');
  assert.strictEqual(written[0]._id, 'push-1', '写入 _id 应为 trace_id');
  assert.strictEqual(written[0].suggest, 'pass', '写入 suggest 应为 pass');

  // 3) 合法推送但不可信（errcode=-1008）→ 不写入（fail-closed）
  written = [];
  r = await main({
    MsgType: 'event', Event: 'wxa_media_check',
    trace_id: 'push-2', errcode: -1008, result: { suggest: 'pass' }
  });
  assert.strictEqual(r.errmsg, 'ignored_untrusted', '不可信结果应 fail-closed 忽略');
  assert.strictEqual(written.length, 0, '不可信结果不得写入');

  // 4) 信封字段伪造但错误（MsgType 不符）→ 忽略
  written = [];
  r = await main({
    MsgType: 'text', Event: 'wxa_media_check',
    trace_id: 'push-3', errcode: 0, result: { suggest: 'pass' }
  });
  assert.strictEqual(r.errmsg, 'ignored', '信封不符应被忽略');
  assert.strictEqual(written.length, 0, '信封不符不得写入');

  console.log('ALL MEDIA_CHECK_RESULT TESTS PASSED');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });

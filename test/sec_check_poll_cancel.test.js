/**
 * P1-1 回归：pollSecCheckResult 取消机制
 *
 * 问题：原函数通过 setTimeout 递归调度轮询，页面卸载/用户切走时轮询不会中止，
 * 最坏持续 25-35s 消耗云函数 callFunction 配额与前端网络资源。
 * 修复后：返回值从 Promise 改为 { promise, cancel }；cancel() 通过 cancelled 标志 +
 * clearTimeout 双重机制中止后续 tick。
 *
 * 覆盖：
 *  ① cancel() 立即调用 → 仅首次 tick 触发 callFunction（1 次），后续 tick 全部短路；
 *     Promise 静默悬空（永不出结果的 mock 下），不触发任何新 callFunction。
 *  ② cancel() 幂等：多次调用安全，不再二次触发副作用。
 *  ③ cancel() 之后再 await promise：不应 resolve（永不出结果 mock 下，悬空 promise
 *     在测试窗口内不 settle）——用 setTimeout 计时兜底，超过测试窗口视为通过。
 *  ④ 取消后恢复正常轮询：新建实例照常可 resolve（验证模块可复用，cancel 不污染全局状态）。
 */
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 极短测试窗口（ms）：用于确认取消后的悬空 promise 不再 settle
const IDLE_WINDOW_MS = 200;

(async () => {
  // ① 立刻 cancel：应仅触发 1 次 callFunction，后续 tick 全部短路
  {
    let calls = 0;
    global.wx = {
      cloud: {
        callFunction(opts) {
          calls++;
          // 永远返回「未完成」，逼轮询走到下一个 tick（若未被取消）
          setTimeout(() => {
            opts.success && opts.success({ result: { errcode: 0, status: 'pending' } });
          }, 0);
        }
      }
    };
    const { promise, cancel } = require('../utils/secCheck').pollSecCheckResult('trace-cancel-1', 100000, 1, 60000);
    // 立刻取消：此时首次 callFunction 已入队但回调尚未触发；cancelled 标志置 true，
    // 后续所有 callback 入口都会命中 cancelled 短路。
    cancel();
    // 给事件循环足够时间消化已入队的 callback
    await new Promise((r) => setTimeout(r, 30));
    ok('cancel 后 callFunction 调用次数 = 1（仅首次 tick）', calls === 1);
    // promise 悬空，200ms 内不应 settle
    let settled = false;
    promise.then(
      () => { settled = true; },
      () => { settled = true; }
    );
    await new Promise((r) => setTimeout(r, IDLE_WINDOW_MS));
    ok('cancel 后 promise 在窗口内未 settle（静默悬空）', settled === false);
  }

  // ② cancel() 幂等：多次调用不抛错、不改变 calls 数
  {
    let calls = 0;
    global.wx = {
      cloud: {
        callFunction(opts) {
          calls++;
          setTimeout(() => {
            opts.success && opts.success({ result: { errcode: 0, status: 'pending' } });
          }, 0);
        }
      }
    };
    let threw = false;
    try {
      const handle = require('../utils/secCheck').pollSecCheckResult('trace-cancel-2', 100000, 1, 60000);
      handle.cancel();
      handle.cancel();
      handle.cancel();
    } catch (e) { threw = true; }
    await new Promise((r) => setTimeout(r, 30));
    ok('cancel() 多次调用不抛错', threw === false);
    ok('cancel() 多次调用不触发额外 callFunction', calls === 1);
  }

  // ③ 取消之后再 await promise：永不出结果 mock 下，promise 在窗口内不应 resolve/reject
  {
    let calls = 0;
    global.wx = {
      cloud: {
        callFunction(opts) {
          calls++;
          setTimeout(() => {
            opts.success && opts.success({ result: { errcode: 0, status: 'pending' } });
          }, 0);
        }
      }
    };
    const handle = require('../utils/secCheck').pollSecCheckResult('trace-cancel-3', 100000, 1, 60000);
    handle.cancel();
    let settled = null;
    const settleRace = new Promise((resolve) => {
      handle.promise.then(
        (v) => { settled = { kind: 'resolve', value: v }; resolve(); },
        (e) => { settled = { kind: 'reject', error: e }; resolve(); }
      );
    });
    const timeoutRace = new Promise((r) => setTimeout(r, IDLE_WINDOW_MS));
    await Promise.race([settleRace, timeoutRace]);
    ok('cancel() 之后再 await：promise 在窗口内未 settle', settled === null);
    ok('cancel() 之后再 await：无额外 callFunction', calls === 1);
  }

  // ④ 模块可复用：cancel 后新建实例仍可正常 resolve
  {
    let calls = 0;
    global.wx = {
      cloud: {
        callFunction(opts) {
          calls++;
          setTimeout(() => {
            opts.success && opts.success({ result: { errcode: 0, status: 'done', suggest: 'pass' } });
          }, 0);
        }
      }
    };
    // 先建一个并立刻取消，验证「取消不污染全局」
    const h1 = require('../utils/secCheck').pollSecCheckResult('trace-cancel-4a', 100000, 1, 60000);
    h1.cancel();
    await new Promise((r) => setTimeout(r, 10));
    const r = await require('../utils/secCheck').pollSecCheckResult('trace-cancel-4b').promise;
    ok('取消后的模块：新建实例仍正常 resolve 且 suggest 正确', r && r.suggest === 'pass' && calls === 2);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();

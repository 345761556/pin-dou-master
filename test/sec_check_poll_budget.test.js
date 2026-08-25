/**
 * 第十三轮审查 R2 回归：pollSecCheckResult 总时间预算
 *
 * 修复前：maxAttempts 只数次数不看时钟，弱网下单次调用可打满 timeout:10s，
 * 最坏 20×(10s+1s)≈219s 才 reject，远超「约 20s」设计意图（期间全屏 mask 卡死用户）。
 * 修复后：新增 totalBudgetMs 总预算（默认 25s），success/fail 分支在调度下一轮前
 * 检查 deadline，到点即 reject('sec_check_poll_timeout')。
 *
 * P1-1 结构变更：pollSecCheckResult 返回值从 Promise 改为 { promise, cancel }，
 * 本测试中所有 await 改为 `.promise` 访问（cancel 在预算测试中不需要，测试用完后 GC 收回）。
 *
 * 测试用极小预算（60ms）+ 微秒级间隔验证：
 *  ① success 分支：结果永不出 → 在预算内被切断，attempt 数远小于 maxAttempts；
 *  ② fail 分支：调用持续失败 → 同样受预算约束；
 *  ③ 正常命中不受预算影响（首个结果即返回）。
 */
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ---- mock wx.cloud.callFunction ----
function makeMockWx(mode) {
  let calls = 0;
  const wx = {
    cloud: {
      callFunction(opts) {
        calls++;
        // 模拟客户端异步回调（微秒级，避免真实等待）
        setTimeout(() => {
          if (mode === 'fail') {
            opts.fail && opts.fail({ errMsg: 'cloud.callFunction:fail timeout' });
          } else {
            // 永远返回「未完成」的查询结果，逼轮询走到超时
            opts.success && opts.success({ result: { errcode: 0, status: 'pending' } });
          }
        }, 0);
      }
    }
  };
  return { wx, getCalls: () => calls };
}

(async () => {
  // ① success 分支（永不出结果）：预算应切断轮询
  {
    const { wx, getCalls } = makeMockWx('pending');
    global.wx = wx;
    const t0 = Date.now();
    let rejected = null;
    try {
      await require('../utils/secCheck').pollSecCheckResult('trace-budget', 100000, 1, 60).promise;
    } catch (e) { rejected = e; }
    const elapsed = Date.now() - t0;
    ok('success 分支：永不出结果时按预算 reject', rejected && rejected.message === 'sec_check_poll_timeout');
    ok('attempt 数被预算截断（远小于 maxAttempts=100000）', getCalls() < 5000);
    ok('总耗时 ≈ 预算（≥50ms 且 <2s）', elapsed >= 40 && elapsed < 2000);
  }

  // ② fail 分支：持续失败同样受预算约束
  {
    const { wx, getCalls } = makeMockWx('fail');
    global.wx = wx;
    const t0 = Date.now();
    let rejected = null;
    try {
      await require('../utils/secCheck').pollSecCheckResult('trace-budget-fail', 100000, 1, 60).promise;
    } catch (e) { rejected = e; }
    const elapsed = Date.now() - t0;
    ok('fail 分支：按预算 reject（携带原始错误）',
      rejected && rejected.errMsg === 'cloud.callFunction:fail timeout');
    ok('fail 分支 attempt 数同样被截断', getCalls() < 5000);
    ok('fail 分支总耗时 ≈ 预算（<2s）', elapsed < 2000);
  }

  // ③ 正常命中：首个结果即 resolve，不受预算影响
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
    const r = await require('../utils/secCheck').pollSecCheckResult('trace-ok', 20, 1000, 25000).promise;
    ok('正常命中立即 resolve 且 suggest 正确', r && r.suggest === 'pass' && calls === 1);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();

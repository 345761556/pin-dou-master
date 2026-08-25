/**
 * utils 层三处健壮性加固回归测试
 *
 * ① saveImageToAlbum authSetting 判空：
 *    getSetting/openSetting 异常返回缺 authSetting 字段时，原实现直接取值在 wx 回调内抛
 *    TypeError → Promise 永不 settle → 调用方 loading 永久悬挂。
 *    修复后缺失视为「未授权也未拒绝」走 doSave()（语义不变）；
 *    openSetting 缺失时明确 reject('权限未开启') 而非抛错悬挂。
 *
 * ② compressImageIfNeeded 超时守护：
 *    wx.compressImage / img.onload / wx.canvasToTempFilePath 三处异步路径无超时，
 *    回调永不触发时调用方（index/profile）永久 await。修复后：
 *    - compressImage 挂起 → 超时走 fallbackCanvas()（与 fail 分支同路径）；
 *    - img 解码 / canvas 导出挂起 → reject(new Error('image_compress_timeout'))；
 *    - 超时后迟到的回调被 settled 标志拦截；定时器三路径均清理防泄漏。
 *    超时阈值经环境变量 UTIL_ASYNC_TIMEOUT_MS 注入缩短（参考 secCheck 注入手法）。
 *
 * ③ clampTemplateSize 极端宽高比守卫：
 *    ratio > maxPixels 时 sqrt 钳制失效（floor 后为 0 被 Math.max(1,...) 钳成 1），
 *    rows=floor(cols*ratio) 失控（如 1×100000 乘积远超 maxPixels），破坏
 *    「cols×rows ≤ maxPixels」契约。修复后步骤 1 末尾安全复查强制收敛不变式。
 */
const assert = require('assert');
const path = require('path');

// ⏱ 超时阈值注入：必须在首次 require utils/util.js 之前设置
process.env.UTIL_ASYNC_TIMEOUT_MS = '60';

const root = path.resolve(__dirname, '..');

// ==================== 通用 mock 基础设施 ====================

function makeBaseWx(overrides) {
  return Object.assign({
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => ({ accessSync: () => {}, unlinkSync: () => {} }),
    getImageInfo: ({ success }) => success({ width: 1600, height: 1200 }),
    showToast: () => {}
  }, overrides || {});
}

/** 带 watchdog 的 settle 等待：若 Promise 在 deadline 内未 settle 则判定为「悬挂」失败 */
function withWatchdog(promise, label, ms) {
  const limit = ms || 2000;
  let timer = null;
  return Promise.race([
    promise.then(
      (v) => { clearTimeout(timer); return { settled: true, resolved: true, value: v }; },
      (e) => { clearTimeout(timer); return { settled: true, resolved: false, error: e }; }
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false, label }), limit);
    })
  ]);
}

// 可编程的压缩 canvas mock：
// - fireOnloadOnSrc=true 时 src 赋值即同步触发 onload；
// - captureImg 用于超时后手动触发迟到回调（拦截验证）。
let capturedImgRef = null;
function makeCompressCanvas(opts) {
  opts = opts || {};
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    createImage: () => {
      const img = { onload: null, onerror: null };
      Object.defineProperty(img, 'src', {
        set(v) {
          capturedImgRef = img;
          if (opts.fireOnloadOnSrc && img.onload) setTimeout(() => img.onload(), 0);
        },
        get() { return null; }
      });
      return img;
    }
  };
}

function makeCanvasQuery(node) {
  // 注意：wx.createSelectorQuery().select().fields().exec(cb) 的回调入参是节点数组，
  // fields({node:true}) 时元素形如 { node: <canvas> }——必须包一层 node 字段
  return () => ({
    select: () => ({
      fields: () => ({ exec: (cb) => cb([{ node }]) })
    })
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS | ' + name); }
  catch (e) { failed++; console.log('FAIL | ' + name + ' :: ' + e.message); }
}

(async () => {
  // ==================== ① saveImageToAlbum authSetting 判空 ====================
  console.log('\n--- ① saveImageToAlbum authSetting 判空 ---');

  // Case 1a：getSetting success 返回缺 authSetting 字段（平台异常）→ 应走 doSave 并 resolve
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    global.wx = makeBaseWx({
      getSetting: ({ success }) => success({}), // ⚠️ 无 authSetting 字段
      saveImageToPhotosAlbum: ({ success }) => success()
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('① getSetting 缺 authSetting → 走 doSave 正常 resolve（不悬挂不抛 TypeError）', async () => {
      let saved = false;
      global.wx.saveImageToPhotosAlbum = ({ success }) => { saved = true; success(); };
      const r = await withWatchdog(util.saveImageToAlbum('wxfile://tmp/a.png'), 'save-1a');
      assert.ok(r.settled, 'Promise 必须 settle（旧实现在此抛 TypeError 永久悬挂）');
      assert.ok(r.resolved, '应 resolve，实际 reject: ' + (r.error && r.error.message));
      assert.ok(saved, '应实际调用 wx.saveImageToPhotosAlbum（doSave 路径）');
    });
  }

  // Case 1b：getSetting 返回 authSetting=false（曾拒绝）→ showModal 确认 → openSetting 缺 authSetting
  //          → 应明确 reject('权限未开启')，不得抛 TypeError 悬挂
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    global.wx = makeBaseWx({
      getSetting: ({ success }) => success({ authSetting: { 'scope.writePhotosAlbum': false } }),
      showModal: ({ success }) => success({ confirm: true }),
      openSetting: ({ success }) => success({}) // ⚠️ 无 authSetting 字段
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('① openSetting 缺 authSetting → 明确 reject 权限未开启（不悬挂不抛 TypeError）', async () => {
      const r = await withWatchdog(util.saveImageToAlbum('wxfile://tmp/a.png'), 'save-1b');
      assert.ok(r.settled, 'Promise 必须 settle');
      assert.ok(!r.resolved, 'openSetting 未授权应 reject');
      assert.strictEqual(r.error && r.error.message, '权限未开启',
        '错误信息应为「权限未开启」，实际: ' + (r.error && r.error.message));
    });
  }

  // Case 1c：openSetting 返回 authSetting=true → 授权成功走 doSave resolve（语义回归）
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    global.wx = makeBaseWx({
      getSetting: ({ success }) => success({ authSetting: { 'scope.writePhotosAlbum': false } }),
      showModal: ({ success }) => success({ confirm: true }),
      openSetting: ({ success }) => success({ authSetting: { 'scope.writePhotosAlbum': true } }),
      saveImageToPhotosAlbum: ({ success }) => success()
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('① 回归：openSetting 明确授权 → doSave resolve（语义不变）', async () => {
      const r = await withWatchdog(util.saveImageToAlbum('wxfile://tmp/a.png'), 'save-1c');
      assert.ok(r.settled && r.resolved,
        '授权后应 resolve，实际: ' + (!r.settled ? '悬挂' : ('reject:' + (r.error && r.error.message))));
    });
  }

  // ==================== ② compressImageIfNeeded 超时守护 ====================
  console.log('\n--- ② compressImageIfNeeded 超时守护 ---');

  // Case 2a：jpg 走 wx.compressImage 且永不回调 → 超时后必须走 fallbackCanvas() 并 resolve
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    const canvas = makeCompressCanvas({ fireOnloadOnSrc: true });
    global.wx = makeBaseWx({
      getImageInfo: ({ success }) => success({ width: 1600, height: 1200 }),
      createSelectorQuery: makeCanvasQuery(canvas),
      compressImage: () => { /* 永不回调：模拟极端机型挂起 */ },
      canvasToTempFilePath: ({ success }) => success({ tempFilePath: 'wxfile://tmp/compressed.png' })
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('② wx.compressImage 永不回调 → 超时后走 fallbackCanvas resolve（非悬挂）', async () => {
      const r = await withWatchdog(util.compressImageIfNeeded('wxfile://tmp/big.jpg', 800), 'compress-2a', 1500);
      assert.ok(r.settled, '必须在注入的超时阈值(' + process.env.UTIL_ASYNC_TIMEOUT_MS + 'ms×2 阶段)内 settle，实际永久悬挂');
      assert.ok(r.resolved, '超时应回退 fallbackCanvas 并 resolve，实际 reject: ' + (r.error && r.error.message));
      assert.strictEqual(r.value.tempFilePath, 'wxfile://tmp/compressed.png', '应返回 canvas 导出路径');
    });
  }

  // Case 2b：png 走 canvas 路径，img.onload/onerror 永不触发 → 超时 reject image_compress_timeout
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    const canvas = makeCompressCanvas({ fireOnloadOnSrc: false }); // 解码永不完成
    global.wx = makeBaseWx({
      createSelectorQuery: makeCanvasQuery(canvas),
      canvasToTempFilePath: ({ success }) => success({ tempFilePath: 'wxfile://tmp/x.png' })
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('② img.onload 永不触发 → 超时 reject image_compress_timeout（reject 是安全方向）', async () => {
      const p = util.compressImageIfNeeded('wxfile://tmp/big.png', 800);
      const r = await withWatchdog(p, 'compress-2b', 1500);
      assert.ok(r.settled, '必须在超时阈值内 settle，实际永久悬挂（调用方 index/profile 会卡死）');
      assert.ok(!r.resolved, '解码挂起应 reject（调用方 catch 后回退原图/引导重试）');
      assert.strictEqual(r.error && r.error.message, 'image_compress_timeout',
        '错误码应为 image_compress_timeout，实际: ' + (r.error && r.error.message));
    });
  }

  // Case 2c：onload 触发但 wx.canvasToTempFilePath 永不回调 → 导出阶段独立超时 reject
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    const canvas = makeCompressCanvas({ fireOnloadOnSrc: true });
    global.wx = makeBaseWx({
      createSelectorQuery: makeCanvasQuery(canvas),
      canvasToTempFilePath: () => { /* 永不回调 */ }
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('② canvasToTempFilePath 永不回调 → 导出阶段超时 reject image_compress_timeout', async () => {
      const r = await withWatchdog(util.compressImageIfNeeded('wxfile://tmp/big.png', 800), 'compress-2c', 1500);
      assert.ok(r.settled, '导出阶段必须在超时阈值内 settle');
      assert.ok(!r.resolved, '导出挂起应 reject');
      assert.strictEqual(r.error && r.error.message, 'image_compress_timeout');
    });
  }

  // Case 2d：超时后迟到的 img.onload 被 settled 标志拦截（不产生二次 settle / 未处理异常）
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    capturedImgRef = null;
    const canvas = makeCompressCanvas({ fireOnloadOnSrc: false });
    global.wx = makeBaseWx({
      createSelectorQuery: makeCanvasQuery(canvas),
      canvasToTempFilePath: ({ success }) => success({ tempFilePath: 'wxfile://tmp/late.png' })
    });
    const util = require(path.join(root, 'utils/util.js'));
    await test('② 超时后迟到的 onload 被拦截：无 unhandled rejection、结果不被改写', async () => {
      let lateSettle = null;
      const p = util.compressImageIfNeeded('wxfile://tmp/big.png', 800).then(
        (v) => { lateSettle = { resolved: true, v }; return v; },
        (e) => { lateSettle = { resolved: false, e }; throw e; }
      );
      const r = await withWatchdog(p, 'compress-2d', 1500);
      assert.ok(r.settled && !r.resolved, '应先以 image_compress_timeout reject，实际: '
        + (!r.settled ? '悬挂' : ('resolved:' + JSON.stringify(r.value))));
      assert.strictEqual(r.error && r.error.message, 'image_compress_timeout');
      // 此时迟到触发 onload：若 settled 标志失效，会再次 drawImage/canvasToTempFilePath
      // 并对已 settle 的 Promise 二次 resolve（静默无效但可能伴随副作用/告警）
      const img = capturedImgRef;
      assert.ok(img && typeof img.onload === 'function', '应能取到被捕获的 img 引用');
      assert.doesNotThrow(() => { if (img.onload) img.onload(); }, '迟到 onload 不应抛异常');
      await new Promise((res) => setImmediate(res));
      assert.ok(lateSettle && !lateSettle.resolved, '最终 settle 结果仍应为超时 reject，未被迟到回调改写');
    });
  }

  // Case 2e：runWithTimeout 内部辅助函数直接单测（回调先到 resolve / 超时 reject / 迟到回调拦截）
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    const util = require(path.join(root, 'utils/util.js'));
    await test('② runWithTimeout：回调先到 clearTimeout 正常 resolve', async () => {
      const v = await util.runWithTimeout((ok) => ok(42), 100, 't');
      assert.strictEqual(v, 42);
    });
    await test('② runWithTimeout：超时 reject(tag)，迟到的 onOk 被拦截', async () => {
      const realST = global.setTimeout;
      let fireTimer = null;
      let lateOk = null;
      // 定时器手动触发桩：精确控制超时时点（不真正等待）
      global.setTimeout = (cb) => { fireTimer = cb; return 7; };
      try {
        const p = util.runWithTimeout((ok) => { lateOk = ok; }, 50, 'tag_x');
        fireTimer(); // 立即触发超时
        const err = await p.then(() => null, (e) => e);
        assert.ok(err instanceof Error && err.message === 'tag_x', '应 reject(tag_x)');
        // 超时后迟到的成功回调：不得改写结果、不得抛错
        assert.doesNotThrow(() => { if (lateOk) lateOk('late'); });
        const final = await p.then(() => 'resolved', (e) => 'rejected:' + e.message);
        assert.strictEqual(final, 'rejected:tag_x', '迟到回调不得改写已 reject 的结果');
      } finally {
        global.setTimeout = realST;
      }
    });
    await test('② runWithTimeout：成功 settle 后 clearTimeout 防泄漏（真实定时器路径）', async () => {
      const realCT = global.clearTimeout;
      let cleared = false;
      global.clearTimeout = (id) => { cleared = true; realCT(id); };
      try {
        const v = await util.runWithTimeout((ok) => setTimeout(() => ok(1), 5), 1000, 't2');
        assert.strictEqual(v, 1);
        assert.ok(cleared, '成功 settle 后必须 clearTimeout，避免定时器泄漏');
      } finally {
        global.clearTimeout = realCT;
      }
    });
  }

  // ==================== ③ clampTemplateSize 极端宽高比守卫 ====================
  console.log('\n--- ③ clampTemplateSize 极端宽高比守卫 ---');
  {
    delete require.cache[path.join(root, 'utils/util.js')];
    const util = require(path.join(root, 'utils/util.js'));

    await test('③ 反例 (cols=1,rows=100000,maxPixels=8000,maxRows=0)：乘积 ≤ 8000', async () => {
      const o = util.clampTemplateSize(1, 100000, 8000, 0);
      assert.ok(o.cols >= 1 && o.rows >= 1, '正整数违例: ' + JSON.stringify(o));
      assert.ok(o.cols * o.rows <= 8000,
        `不变式破坏: ${o.cols}x${o.rows}=${o.cols * o.rows} > 8000`);
      console.log(`      (1,100000,8000,0) -> ${o.cols}x${o.rows}`);
    });

    await test('③ 同反例带 maxRows=120：乘积 ≤ 8000 且 rows ≤ 120', async () => {
      const o = util.clampTemplateSize(1, 100000, 8000, 120, 0);
      assert.ok(o.cols * o.rows <= 8000, `乘积违例 ${o.cols * o.rows} > 8000`);
      assert.ok(o.rows <= 120, `rows 违例 ${o.rows} > 120`);
    });

    await test('③ 全域网格遍历（含旧版跳过的 mp < max(c,rw) 下限域）：不变式处处成立', async () => {
      const colsList = [1, 20, 50, 100, 200, 500];
      const rowsList = [1, 50, 100, 200, 400, 1000];
      const maxPixelsList = [4, 10, 100, 800, 8000, 20000];
      const maxRowsList = [0, 1, 5, 12, 60, 120, 500];
      const aspects = [0, 0.25, 0.5, 1, 2, 4, 10];
      let total = 0;
      for (const c of colsList) for (const rw of rowsList) for (const mp of maxPixelsList)
        for (const mr of maxRowsList) for (const a of aspects) {
          const o = util.clampTemplateSize(c, rw, mp, mr, a);
          total++;
          assert.ok(o.cols >= 1 && o.rows >= 1, `正整数违例 (${c},${rw},${mp},${mr},${a}) -> ${JSON.stringify(o)}`);
          assert.ok(o.cols * o.rows <= mp,
            `不变式违例 (${c},${rw},${mp},${mr},${a}) -> ${o.cols}x${o.rows}=${o.cols * o.rows} > ${mp}`);
          if (mr > 0) assert.ok(o.rows <= mr, `rows 违例 (${c},${rw},${mp},${mr},${a}) -> rows=${o.rows}`);
        }
      console.log(`      全域样本数: ${total}（含旧版 clamp_recheck_math 测试被迫跳过的下限域）`);
    });

    // 常规路径回归：现有等价性依赖的口径不得漂移
    await test('③ 回归：常规输入输出与修复前完全一致', async () => {
      assert.deepStrictEqual(util.clampTemplateSize(50, 50, 8000, 0), { cols: 50, rows: 50 });
      assert.deepStrictEqual(util.clampTemplateSize(200, 200, 8000), { cols: 89, rows: 89 });
      assert.deepStrictEqual(util.clampTemplateSize(100, 200, 8000, 120, 1.0), { cols: 66, rows: 120 });
      assert.deepStrictEqual(util.clampTemplateSize(1, 300, 5, 120, 2), { cols: 1, rows: 5 });
      // 守卫不误伤常规超限缩放：ratio < maxPixels 时结果与 sqrt 公式一致
      const o = util.clampTemplateSize(100, 130, 20000, 120, 0.5);
      assert.deepStrictEqual(o, { cols: 166, rows: 120 }, '复查分支行为不得变化');
    });
  }

  console.log(`\nutil_robustness_hardening.test.js: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试框架异常:', e);
  process.exit(1);
});

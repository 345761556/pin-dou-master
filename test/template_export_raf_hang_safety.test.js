// test/template_export_raf_hang_safety.test.js
// 回归测试：B17 —— _exportCanvasToImage 的 rAF 等待永久挂起隐患
// 问题：原代码 `await new Promise(resolve => { if (exportCanvas.requestAnimationFrame) { ... } else { setTimeout(resolve,150) } })`
//       仅依赖 rAF 回调触发 resolve。部分极端基础库下 canvas.requestAnimationFrame 可能「存在但回调永不触发」
//       （离屏/异常画布状态）→ 内层 Promise 永久挂起 → _generateExportImage 候选循环卡死 →
//       上层 wx.showLoading({mask:true}) 永不 hideLoading，用户被永久阻塞。报告称「上层 30s 超时」经核查并不存在。
// 修复：统一加安全兜底定时器（finish 幂等），无论 rAF 是否触发必然 resolve；rAF 同步抛错降级 setTimeout 兜底。
// 运行：node test/template_export_raf_hang_safety.test.js
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// 超时护栏：若安全兜底失效（rAF 永不触发且无限挂起），测试应在 1.5s 内判定为挂起而非随进程卡死
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('HANG:' + label)), ms))
  ]);
}

// ---- 复用与 template_export_pagealive_guard 同款的轻量 harness 加载真实 template.js ----
function buildCtx() {
  const template = [];
  for (let y = 0; y < 3; y++) template.push(new Array(3).fill('C01'));
  const makeTemplate = () => ({ cols: 3, rows: 3, totalBeads: 9, colorCount: 1, beadSize: 29, physicalWidth: 87, physicalHeight: 87, materialList: [], sourceImagePath: '', template });
  const fakeApp = { globalData: { shareImagePath: '', sourceImagePath: '', currentTemplate: makeTemplate(), beadType: 'square' } };
  global.getApp = () => fakeApp;
  global.wx = {
    showLoading: () => {}, hideLoading: () => {}, showToast: () => {}, showModal: () => {},
    env: { USER_DATA_PATH: 'wxfile://usr' },
    canvasToTempFilePath: (opts) => opts.success({ tempFilePath: 'wxfile://tmp/export.png' })
  };
  let pageObj = null;
  global.Page = (o) => { pageObj = o; };
  delete require.cache[path.join(__dirname, '..', 'pages', 'template', 'template.js')];
  require(path.join(__dirname, '..', 'pages', 'template', 'template.js'));
  const ctx = Object.assign({}, pageObj, {
    data: { cols: 3, rows: 3, beadType: 'square' },
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx._templateData = makeTemplate();
  return ctx;
}

const PARAMS = { width: 100, height: 100 };

(async () => {
  // 场景 1：正常 rAF 路径（回调立即触发）→ 必然 resolve 并返回合法路径
  {
    const ctx = buildCtx();
    const canvas = { requestAnimationFrame: (cb) => cb(), width: 100, height: 100 };
    let result = null, err = null;
    try { result = await withTimeout(ctx._exportCanvasToImage(canvas, PARAMS, '[t1]'), 1500, 'rAF-normal'); }
    catch (e) { err = e; }
    ok('场景1：rAF 正常触发 → resolve 并返回合法路径', !err && result === 'wxfile://tmp/export.png');
  }

  // 场景 2：无 requestAnimationFrame（else 分支）→ 必然 resolve
  {
    const ctx = buildCtx();
    const canvas = { width: 100, height: 100 }; // 不含 requestAnimationFrame
    let result = null, err = null;
    try { result = await withTimeout(ctx._exportCanvasToImage(canvas, PARAMS, '[t2]'), 1500, 'no-raf'); }
    catch (e) { err = e; }
    ok('场景2：无 rAF（else 分支 setTimeout 兜底）→ resolve 并返回合法路径', !err && result === 'wxfile://tmp/export.png');
  }

  // 场景 3（B17 核心）：rAF 存在但回调永不触发 → 安全定时器（400ms）必须解挂，不再永久挂起
  {
    const ctx = buildCtx();
    const canvas = { requestAnimationFrame: (cb) => { /* 吞掉回调，永不触发 */ }, width: 100, height: 100 };
    const t0 = Date.now();
    let result = null, err = null;
    try { result = await withTimeout(ctx._exportCanvasToImage(canvas, PARAMS, '[t3]'), 1500, 'raf-never-fires'); }
    catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    ok('场景3：rAF 永不触发 → 安全兜底解挂（未永久挂起，HANG 护栏未触发）', !err && result === 'wxfile://tmp/export.png');
    ok('场景3：解挂耗时受安全定时器上界约束（<1500ms，非无限）', err === null && elapsed < 1500);
  }

  // 场景 4：rAF 调用同步抛错 → try/catch 降级 setTimeout 兜底 → resolve（不触发外层重试抖动）
  {
    const ctx = buildCtx();
    const canvas = {
      requestAnimationFrame: () => { throw new Error('rAF boom'); },
      width: 100, height: 100
    };
    let result = null, err = null;
    try { result = await withTimeout(ctx._exportCanvasToImage(canvas, PARAMS, '[t4]'), 1500, 'raf-throw'); }
    catch (e) { err = e; }
    ok('场景4：rAF 同步抛错 → 降级兜底 resolve 并返回合法路径', !err && result === 'wxfile://tmp/export.png');
  }

  // 场景 5（反向回归）：若刻意移除安全定时器则场景3会挂起——静态断言安全定时器已就位
  {
    const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');
    const slice = tplSrc.slice(tplSrc.indexOf('async _exportCanvasToImage'));
    // finish 幂等守卫 + 安全兜底定时器（setTimeout(finish, 400) 附近）必须存在
    ok('静态：rAF 等待 Promise 内含幂等 finish 守卫（if (!settled)）',
      /if \(!settled\)\s*\{\s*settled = true;\s*resolve\(\);\s*\}/.test(slice));
    ok('静态：安全兜底定时器已就位（setTimeout(finish, 400) 防永久挂起）',
      /setTimeout\(finish,\s*400\)/.test(slice));
    ok('静态：rAF 调用被 try/catch 包裹以降级兜底',
      /try\s*\{\s*exportCanvas\.requestAnimationFrame/.test(slice) && /catch \(e\)/.test(slice));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

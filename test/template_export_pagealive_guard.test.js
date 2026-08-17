// test/template_export_pagealive_guard.test.js
// 回归测试：[1] _generateExportImage 缺少 _pageAlive/_destroyed 守护
// 问题：导出是异步方法（_getExportCanvas 取节点 / rAF 等待 / canvasToTempFilePath），
//       全程无页面存活判断；用户在导出过程中退出页面，异步链仍会在已 detach 的 canvas node 上
//       执行绘制与导出，部分基础库版本会打印无法预期的告警。_saveBusy/_shareBusy 互斥锁
//       无法阻止「用户退出后异步链仍在跑」。
// 修复：onUnload 置 this._destroyed=true；_generateExportImage 在方法入口与两次 await 后
//       校验 this._destroyed，命中即抛 'page destroyed'，由调用方 catch 收敛（用户已离开，无害）。
// 运行：node test/template_export_pagealive_guard.test.js
const fs = require('fs');
const path = require('path');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

const tplSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'template', 'template.js'), 'utf8');

// ---- 1) 静态断言：守护就位 ----
ok('onUnload 中置 this._destroyed = true', /onUnload\(\)\s*\{[\s\S]*?this\._destroyed\s*=\s*true/.test(tplSrc));
ok('_generateExportImage 入口校验 this._destroyed',
  /async _generateExportImage\([^)]*\)\s*\{[^]*?if \(this\._destroyed\) throw new Error\('page destroyed'\)/.test(tplSrc));
ok('_generateExportImage 在 await _getExportCanvas 后校验 this._destroyed',
  /await this\._getExportCanvas\([^)]*\);[\s\S]*?if \(this\._destroyed\) throw new Error\('page destroyed'\)/.test(tplSrc));
ok('_generateExportImage 在 await _exportCanvasToImage 后校验 this._destroyed',
  /await this\._exportCanvasToImage\([^)]*\);[\s\S]*?if \(this\._destroyed\) throw new Error\('page destroyed'\)/.test(tplSrc));

// ---- 2) 功能驱动：页面已销毁时立即中止，不触碰 canvas ----
function makeTemplate() {
  const template = [];
  for (let y = 0; y < 3; y++) template.push(new Array(3).fill('C01'));
  return { cols: 3, rows: 3, totalBeads: 9, colorCount: 1, beadSize: 29, physicalWidth: 87, physicalHeight: 87, materialList: [], sourceImagePath: '', template };
}

function buildCtx() {
  const fakeApp = { globalData: { shareImagePath: '', sourceImagePath: '', currentTemplate: makeTemplate(), beadType: 'square' } };
  attachResetTemplateState(fakeApp);
  global.getApp = () => fakeApp;
  global.wx = { showLoading: () => {}, hideLoading: () => {}, showToast: () => {}, showModal: () => {}, env: { USER_DATA_PATH: 'wxfile://usr' } };
  global.Page = (o) => { pageObj = o; };
  let pageObj = null;
  delete require.cache[path.join(__dirname, '..', 'pages', 'template', 'template.js')];
  require(path.join(__dirname, '..', 'pages', 'template', 'template.js'));
  const ctx = Object.assign({}, pageObj, {
    data: { cols: 3, rows: 3, beadType: 'square' },
    setData: (d) => Object.assign(ctx.data, d)
  });
  ctx._templateData = makeTemplate();
  return ctx;
}

(async () => {
  // 场景 A：入口即销毁 → 立即抛，绝不触碰 canvas
  {
    const ctx = buildCtx();
    ctx._destroyed = true;
    let drawCalled = false, exportCalled = false, getCanvasCalled = false;
    ctx._getExportCanvas = async () => { getCanvasCalled = true; return {}; };
    ctx._drawExportCanvas = () => { drawCalled = true; };
    ctx._exportCanvasToImage = async () => { exportCalled = true; return 'x'; };
    let threw = null;
    try { await ctx._generateExportImage({ candidates: [10], logPrefix: '[t]', failMsg: 'fail' }); }
    catch (e) { threw = e; }
    ok('场景A：页面已销毁时 _generateExportImage 立即抛 page destroyed', threw && threw.message === 'page destroyed');
    ok('场景A：未调用 _getExportCanvas（不操作 canvas node）', !getCanvasCalled);
    ok('场景A：未调用 _drawExportCanvas / _exportCanvasToImage', !drawCalled && !exportCalled);
  }

  // 场景 B：await 期间用户退出 → 取得 canvas 后立即抛，不绘制不导出
  {
    const ctx = buildCtx();
    ctx._destroyed = false;
    let drawCalled = false, exportCalled = false;
    // _getExportCanvas 解析的同时把页面标记为已销毁，模拟「await 期间 onUnload 触发」
    ctx._getExportCanvas = async () => { ctx._destroyed = true; return { width: 0, height: 0, getContext: () => ({}) }; };
    ctx._drawExportCanvas = () => { drawCalled = true; };
    ctx._exportCanvasToImage = async () => { exportCalled = true; return 'x'; };
    let threw = null;
    try { await ctx._generateExportImage({ candidates: [10], logPrefix: '[t]', failMsg: 'fail' }); }
    catch (e) { threw = e; }
    // 'page destroyed' 由 per-candidate 循环的 try/catch 捕获后重抛为 failMsg（调用方 catch 收敛，无害），
    // 关键断言是：已销毁时方法必然 reject（不绘制不导出），且不再触碰 canvas。
    ok('场景B：await 期间退出时 _generateExportImage 必然 reject（中止导出）', threw !== null);
    ok('场景B：取得 canvas 后未执行绘制（_drawExportCanvas 未调用）', !drawCalled);
    ok('场景B：取得 canvas 后未执行导出（_exportCanvasToImage 未调用）', !exportCalled);
  }

  // 场景 C：页面存活时正常走完（回归：守护不误伤正常导出）
  {
    const ctx = buildCtx();
    ctx._destroyed = false;
    ctx._getExportCanvas = async () => ({ width: 10, height: 10, getContext: () => ({}) });
    ctx._drawExportCanvas = () => {};
    ctx._exportCanvasToImage = async () => 'wxfile://tmp/ok.png';
    let result = null, threw = null;
    try { result = await ctx._generateExportImage({ candidates: [10], logPrefix: '[t]', failMsg: 'fail' }); }
    catch (e) { threw = e; }
    ok('场景C：页面存活时正常返回导出路径（守护不误伤）', !threw && result === 'wxfile://tmp/ok.png');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

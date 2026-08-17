// 验证导出位图内存预算守卫（BUG-14）：
//   大模板首候选（cellSize=30 → ~52MB）超过内存预算时应被跳过，
//   直接降级到内存安全的 cellSize=20（~24MB），而非先在低端机尝试 50MB+ 大位图。
// 复用 template_export_refactor.test.js 的 mock 思路，但使用真实的 _calcExportParams 维度计算。
const assert = require('assert');

global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
let pageObj = null;
global.Page = (obj) => { pageObj = obj; };

// 加载页面脚本（内部执行 Page({...}) 捕获到 pageObj）
require('../pages/template/template.js');

global.wx = { env: { USER_DATA_PATH: 'wxfile://usr' } };

const fakeCanvas = {
  requestAnimationFrame: (cb) => cb(),
  width: 0, height: 0,
  getContext: () => ({})
};

// 120×120 模板，50 种颜色（使 legend 高度与线上一致）
const bigTemplate = {
  cols: 120, rows: 120, template: [], colorCount: 50,
  materialList: Array.from({ length: 50 }, (_, i) => ({ color: { id: 'C' + (i + 1) }, count: 1 }))
};

// 80×80 模板：@cellSize=30 仅 ~24MB，应在预算内、保持高分辨率输出
const midTemplate = {
  cols: 80, rows: 80, template: [], colorCount: 30,
  materialList: Array.from({ length: 30 }, (_, i) => ({ color: { id: 'C' + (i + 1) }, count: 1 }))
};

function makeCtx(templateData, opts = {}) {
  let getCanvasCalls = 0;
  let attempted = [];
  const ctx = Object.assign({}, pageObj, {
    data: { beadType: 'square' },
    _templateData: templateData,
    _getExportCanvas(params) {
      getCanvasCalls++;
      attempted.push(params.cellSize);
      return Promise.resolve(fakeCanvas);
    },
    _drawExportCanvas() {},
    _exportCanvasToImage(exportCanvas, params) {
      return Promise.resolve('ok@' + params.cellSize);
    }
  });
  ctx.__getCanvasCalls = () => getCanvasCalls;
  ctx.__attempted = () => attempted;
  return ctx;
}

async function run() {
  // 场景 1：120×120 大模板 —— 内存守卫应跳过 30(52MB)/25(37MB)，落到 20(24MB)
  {
    const ctx = makeCtx(bigTemplate);
    const path = await pageObj._generateExportImage.call(ctx, {
      candidates: [50, 40, 30, 25, 20, 18, 15, 12, 10, 8],
      logPrefix: '[saveTemplate]',
      failMsg: '图片处理失败，请重试'
    });
    assert.strictEqual(path, 'ok@20', '大模板应降级到内存安全的 cellSize=20');
    // 50/40 因 4096 维度越界跳过；30/25 因内存预算跳过；仅 20 真正尝试了 Canvas
    assert.deepStrictEqual(ctx.__attempted(), [20], '只有 cellSize=20 被真正尝试绘制');
    console.log('PASS 场景1 大模板内存守卫 → cellSize=20 (attempted=' + JSON.stringify(ctx.__attempted()) + ')');
  }

  // 场景 2：80×80 中模板 —— @30 仅 ~24MB，应在预算内使用 cellSize=30（行为不变）
  {
    const ctx = makeCtx(midTemplate);
    const path = await pageObj._generateExportImage.call(ctx, {
      candidates: [50, 40, 30, 25, 20, 18, 15, 12, 10, 8],
      logPrefix: '[saveTemplate]',
      failMsg: '图片处理失败，请重试'
    });
    assert.strictEqual(path, 'ok@30', '中模板应在内存预算内保持高分辨率 cellSize=30');
    assert.deepStrictEqual(ctx.__attempted(), [30], '中模板只尝试 cellSize=30');
    console.log('PASS 场景2 中模板内存预算内保持高分辨率 → cellSize=30');
  }

  // 场景 3：前景验证 @cellSize=30 的真实位图字节数确实超预算（守卫触发条件）
  {
    const p = pageObj._calcExportParams.call(makeCtx(bigTemplate), 30);
    const bytes = p.width * p.height * 4;
    assert.ok(bytes > 33 * 1024 * 1024, '@30 位图应 > 33MB 触发守卫，实际 ' + Math.round(bytes / 1048576) + 'MB');
    const p20 = pageObj._calcExportParams.call(makeCtx(bigTemplate), 20);
    const bytes20 = p20.width * p20.height * 4;
    assert.ok(bytes20 <= 33 * 1024 * 1024, '@20 位图应 ≤ 33MB，实际 ' + Math.round(bytes20 / 1048576) + 'MB');
    console.log('PASS 场景3 @30=' + Math.round(bytes / 1048576) + 'MB(超预算) / @20=' + Math.round(bytes20 / 1048576) + 'MB(安全)');
  }

  console.log('\nAll export memory budget tests passed!');
}

run().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});

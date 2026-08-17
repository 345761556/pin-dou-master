// 验证 template.js 导出链路扁平化重构后的控制流
// 场景：候选逐个回退 / 越界跳过 / Canvas 查询重试 / 导出失败重试 / 全失败抛错
const assert = require('assert');

// ---- 微信运行时全局 mock ----
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });
let pageObj = null;
global.Page = (obj) => { pageObj = obj; };

// 加载页面（内部会执行 Page({...})，捕获到 pageObj）
require('../pages/template/template.js');

const VALID = 'wxfile://tmp_ok';
const fakeCanvas = {
  requestAnimationFrame: (cb) => cb(),
  width: 0, height: 0,
  getContext: () => ({})
};

// 确定性 mock：按调用顺序消费脚本
//  script.query:  数组，true=查到 Canvas, false=未查到
//  script.exports:数组，'ok'=导出成功, 'fail'=导出失败
function makeWx(script) {
  let qi = 0, ei = 0;
  const chain = {
    in() { return chain; },
    select() { return chain; },
    fields() { return chain; },
    exec(cb) {
      const found = script.query[qi++];
      setTimeout(() => cb(found ? [{ node: fakeCanvas }] : [null]), 0);
    }
  };
  return {
    _qi: () => qi,
    _ei: () => ei,
    env: { USER_DATA_PATH: 'wxfile://usr' },
    createSelectorQuery() { return chain; },
    canvasToTempFilePath(opts) {
      const r = script.exports[ei++];
      setTimeout(() => {
        if (r === 'ok') opts.success({ tempFilePath: VALID });
        else opts.fail({ errMsg: 'export_busy' });
      }, 0);
    }
  };
}

function makeCtx(calcParams) {
  return Object.assign({}, pageObj, {
    data: { beadType: 'square' },
    _templateData: { cols: 10, rows: 10, template: [], colorCount: 4 },
    _calcExportParams: calcParams || ((c) => ({ width: 800, height: 600, cellSize: c, labelSpace: 30 })),
    _drawExportCanvas: () => {}
  });
}

async function run() {
  // 场景 1：happy path —— 首个候选即成功
  {
    global.wx = makeWx({ query: [true], exports: ['ok'] });
    const path = await pageObj._generateExportImage.call(makeCtx(), {
      candidates: [50], logPrefix: '[t]', failMsg: '失败'
    });
    assert.strictEqual(path, VALID, 'happy: 应返回有效路径');
    assert.strictEqual(global.wx._qi(), 1, 'happy: query 1 次');
    assert.strictEqual(global.wx._ei(), 1, 'happy: export 1 次');
    console.log('PASS 场景1 happy path (query=1, export=1)');
  }

  // 场景 2：候选回退 + 导出失败重试
  //   候选0 Canvas 查不到(4次: 1尝试+3重试)→候选1 查到，导出前2次失败第3次成功
  {
    global.wx = makeWx({ query: [false, false, false, false, true], exports: ['fail', 'fail', 'ok'] });
    const path = await pageObj._generateExportImage.call(makeCtx(), {
      candidates: [8, 50], logPrefix: '[t]', failMsg: '失败'
    });
    assert.strictEqual(path, VALID, 'fallbackRetry: 候选1 重试后应成功');
    assert.strictEqual(global.wx._qi(), 5, 'fallbackRetry: 候选0查4次+候选1查1次=5');
    assert.strictEqual(global.wx._ei(), 3, 'fallbackRetry: 导出重试3次后成功');
    console.log('PASS 场景2 候选回退+导出重试 (query=5, export=3)');
  }

  // 场景 3：全失败 —— 候选 Canvas 四次查不到(1尝试+3重试) → 抛 failMsg
  {
    global.wx = makeWx({ query: [false, false, false, false], exports: [] });
    let threw = null;
    try {
      await pageObj._generateExportImage.call(makeCtx(), {
        candidates: [8], logPrefix: '[t]', failMsg: '图片处理失败'
      });
    } catch (e) { threw = e; }
    assert.ok(threw, 'allFail: 应抛出');
    assert.ok(threw.message.indexOf('图片处理失败') >= 0, 'allFail: 应带 failMsg');
    assert.strictEqual(global.wx._qi(), 4, 'allFail: 查4次后放弃');
    console.log('PASS 场景3 全失败抛错 (' + threw.message + ')');
  }

  // 场景 4：越界跳过 —— 候选0 超大被 skip 不查 Canvas，候选1 成功
  {
    global.wx = makeWx({ query: [true], exports: ['ok'] });
    const ctx = makeCtx((c) => c === 8
      ? { width: 5000, height: 5000, cellSize: 8, labelSpace: 30 }
      : { width: 800, height: 600, cellSize: c, labelSpace: 30 });
    const path = await pageObj._generateExportImage.call(ctx, {
      candidates: [8, 50], logPrefix: '[t]', failMsg: '失败'
    });
    assert.strictEqual(path, VALID, 'skip: 候选1 应成功');
    assert.strictEqual(global.wx._qi(), 1, 'skip: 候选0 越界应被 skip，只查1次(候选1)');
    console.log('PASS 场景4 越界跳过 (query=1)');
  }

  // 场景 5：过小跳过 —— 候选0 过小被 skip 不查 Canvas，候选1 成功
  {
    global.wx = makeWx({ query: [true], exports: ['ok'] });
    const ctx = makeCtx((c) => c === 8
      ? { width: 40, height: 40, cellSize: 8, labelSpace: 30 }
      : { width: 800, height: 600, cellSize: c, labelSpace: 30 });
    const path = await pageObj._generateExportImage.call(ctx, {
      candidates: [8, 50], logPrefix: '[t]', failMsg: '失败'
    });
    assert.strictEqual(path, VALID, 'tooSmall: 候选1 应成功');
    assert.strictEqual(global.wx._qi(), 1, 'tooSmall: 候选0 过小应被 skip，只查1次(候选1)');
    console.log('PASS 场景5 过小跳过 (query=1)');
  }

  console.log('\nAll template export refactor control-flow tests passed!');
}

run().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});

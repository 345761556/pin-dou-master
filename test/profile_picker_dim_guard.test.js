/**
 * profile 取色维度守护回归测试（M1）
 * 背景：pickColorAtPoint 原直接用 pickerImageInfo.width/height 与
 * boundingClientRect.width/height 建画布与算坐标，无正有限数校验。
 *   - 脏数据（pickerImageInfo 异常）或图片元素隐藏时 boundingClientRect 返回 0 尺寸
 *     → viewRatio = viewWidth/viewHeight 除零得 NaN → dispW/dispH 失真；
 *   - canvasW=0 时 canvas.width=0、pixelX 钳制为 -1 → getImageData(-1,...) 越界；
 *   - canvas.width = canvasW 在 try 块外，若 canvasW 为 NaN/0 直接抛异常中断整个回调。
 * 修复：imgWidth/imgHeight/viewWidth/viewHeight 任一非正有限数即 toast 返回；
 *       canvasW/canvasH 钳到至少 1。
 * 本测试锁定：
 *   1) imgWidth=0  → 提示返回、不崩溃、不触发 getImageData；
 *   2) imgHeight=0 → 同上；
 *   3) imgWidth=NaN → 同上；
 *   4) viewWidth=0 → 同上；
 *   5) viewHeight=0（viewRatio 除零场景）→ 同上；
 *   6) 合法维度 → 正常取色且坐标映射正确（不误伤）；
 *   7) 1×1 极端小图 → canvas 钳到 ≥1，getImageData 坐标不越界。
 */
const assert = require('assert');

const state = {
  imgRect: null,
  canvasNode: null,
  getImageDataCalls: [],
  lastToast: null,
};

function makeCtx() {
  return {
    drawImage: () => {},
    getImageData: (px, py, pw, ph) => {
      state.getImageDataCalls.push({ px, py, pw, ph });
      return { data: [10, 20, 30, 255] };
    },
  };
}

function makeCanvas() {
  const ctx = makeCtx();
  const canvas = {
    _w: 0, _h: 0,
    get width() { return this._w; },
    set width(v) { this._w = v; },
    get height() { return this._h; },
    set height(v) { this._h = v; },
    getContext: () => ctx,
    createImage: () => {
      const el = {};
      Object.defineProperty(el, 'src', {
        set(v) { if (typeof el.onload === 'function') el.onload(); },
      });
      return el;
    },
  };
  state.canvasNode = canvas;
  return canvas;
}

global.getApp = () => ({ globalData: {} });
global.Page = (opts) => {
  global.__page = Object.assign({}, opts);
  global.__page.setData = (d) => Object.assign(global.__page.data, d);
};

global.wx = {
  createSelectorQuery: () => {
    const q = {
      select: () => q,
      boundingClientRect: () => q,
      fields: () => q,
      exec: (cb) => cb([state.imgRect, { node: state.canvasNode || makeCanvas() }]),
    };
    return q;
  },
  getImageInfo: ({ success }) => success({ width: 1000, height: 1000 }),
  showToast: (o) => { state.lastToast = o && o.title; },
  showModal: () => {},
  switchTab: () => {},
  getStorageSync: () => null,
  setStorageSync: () => {},
  removeStorageSync: () => {},
};

require('../pages/profile/profile.js');
const page = global.__page;

function setup(imageInfo, rect) {
  state.imgRect = rect;
  state.canvasNode = makeCanvas();
  state.getImageDataCalls = [];
  state.lastToast = null;
  page.setData({
    pickerImagePath: 'wxfile://tmp/pick.png',
    pickerImageInfo: imageInfo,
    pickedColor: null,
    pickerHistory: [],
  });
}

function tap(tapX, tapY) {
  // M1 核心：若 pickColorAtPoint 内部抛异常（如 canvas.width=NaN 或 getImageData 越界），
  // 这里会直接抛出 —— 用 test 包装捕获，从而证明「不再中断回调」。
  page.pickColorAtPoint(tapX, tapY);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

const EXPECT_TOAST = '取色失败，请重新选择图片';

test('imgWidth=0 → 提示返回、不触发 getImageData（无异常中断）', () => {
  setup({ width: 0, height: 100 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.lastToast, EXPECT_TOAST, '应提示取色失败');
  assert.strictEqual(state.getImageDataCalls.length, 0, '不应触发 getImageData');
});

test('imgHeight=0 → 提示返回', () => {
  setup({ width: 100, height: 0 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.lastToast, EXPECT_TOAST);
  assert.strictEqual(state.getImageDataCalls.length, 0);
});

test('imgWidth=NaN → 提示返回（脏数据场景）', () => {
  setup({ width: NaN, height: 100 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.lastToast, EXPECT_TOAST);
  assert.strictEqual(state.getImageDataCalls.length, 0);
});

test('viewWidth=0 → 提示返回（图片元素隐藏场景）', () => {
  setup({ width: 100, height: 100 }, { width: 0, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.lastToast, EXPECT_TOAST);
  assert.strictEqual(state.getImageDataCalls.length, 0);
});

test('viewHeight=0 → 提示返回（避免 viewRatio 除零得 NaN）', () => {
  setup({ width: 100, height: 100 }, { width: 300, height: 0, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.lastToast, EXPECT_TOAST);
  assert.strictEqual(state.getImageDataCalls.length, 0);
});

test('合法维度 400×400 / 300×300 → 正常取色且坐标正确（不误伤）', () => {
  setup({ width: 400, height: 400 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  // 关键：维度合法时取色链路正常推进（getImageData 被触发且坐标正确），
  // 不因守护校验而误伤。色卡匹配环节的「色卡为空」提示属 node 测试环境无色卡数据，非 M1 范畴。
  assert.strictEqual(state.getImageDataCalls.length, 1, '应触发一次 getImageData');
  const c = state.getImageDataCalls[0];
  assert.strictEqual(c.px, 200, 'X 映射应为 200');
  assert.strictEqual(c.py, 200, 'Y 映射应为 200');
});

test('1×1 极端小图 → canvas 钳到 ≥1，getImageData 坐标不越界', () => {
  setup({ width: 1, height: 1 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.canvasNode.width, 1, 'canvasW 至少 1');
  assert.strictEqual(state.canvasNode.height, 1, 'canvasH 至少 1');
  assert.strictEqual(state.getImageDataCalls.length, 1);
  const c = state.getImageDataCalls[0];
  assert.ok(c.px >= 0 && c.px <= 0, 'X 在 [0, canvasW-1] 内（不为 -1）');
  assert.ok(c.py >= 0 && c.py <= 0, 'Y 在 [0, canvasH-1] 内');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

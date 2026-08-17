/**
 * profile 取色画布 OOM 回归测试（BUG-11）
 * 背景：pickColorAtPoint 此前直接按原图尺寸建离屏画布
 *   canvas.width = imgWidth; canvas.height = imgHeight;
 *   而 validateImageFile 允许最大 6000px → 6000×6000×4B ≈ 144MB，
 *   仅用于采样单点像素却占用巨量内存，低端机 OOM 崩溃。
 * 修复：取色前将画布缩放到 ≤1024px，并按比例换算点击坐标。
 * 本测试锁定：
 *   1) 6000×6000 原图 → 画布被钳制为 ≤1024px（非原尺寸）；
 *   2) drawImage 仅绘制缩放后尺寸；
 *   3) 点击坐标按缩放比例正确映射到画布像素；
 *   4) 小图（< 1024）不被放大；
 *   5) 非正方形图按比例映射正确；
 *   6) 边缘点击坐标被钳制在画布内（防浮点越界）。
 */
const assert = require('assert');
const path = require('path');

// ---- 全局 mock 状态 ----
const state = {
  imgRect: null,
  canvasNode: null,
  createdImage: null,
  drawnArgs: null,
  getImageDataCalls: [],
  picked: null,
};

function makeCtx() {
  return {
    drawImage: (img, x, y, w, h) => { state.drawnArgs = { x, y, w, h }; },
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
      state.createdImage = el;
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
  showToast: () => {},
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
  state.drawnArgs = null;
  state.getImageDataCalls = [];
  state.picked = null;
  page.setData({
    pickerImagePath: 'wxfile://tmp/pick.png',
    pickerImageInfo: imageInfo,
    pickedColor: null,
  });
}

function tap(tapX, tapY) {
  page.pickColorAtPoint(tapX, tapY);
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

// 1) 6000×6000 原图 → 画布钳制 ≤1024
test('6000×6000 原图：画布尺寸被钳制为 1024 而非原尺寸', () => {
  setup({ width: 6000, height: 6000 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.canvasNode.width, 1024, '画布宽应被钳制为 1024');
  assert.strictEqual(state.canvasNode.height, 1024, '画布高应被钳制为 1024');
  assert.ok(state.drawnArgs.w <= 1024 && state.drawnArgs.h <= 1024, 'drawImage 仅绘制缩放后尺寸');
});

// 2) 点击坐标按比例映射（正中 → 画布 512,512）
test('6000×6000 原图：正中点击映射到画布 (512,512)', () => {
  setup({ width: 6000, height: 6000 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  const c = state.getImageDataCalls[0];
  assert.strictEqual(c.px, 512, 'X 映射应为 512');
  assert.strictEqual(c.py, 512, 'Y 映射应为 512');
});

// 3) 小图不放大
test('400×400 原图：画布保持原始尺寸（不放大）', () => {
  setup({ width: 400, height: 400 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(150, 150);
  assert.strictEqual(state.canvasNode.width, 400, '小图宽度应保持 400');
  assert.strictEqual(state.canvasNode.height, 400, '小图高度应保持 400');
  const c = state.getImageDataCalls[0];
  assert.strictEqual(c.px, 200, 'X 映射应为 200');
  assert.strictEqual(c.py, 200, 'Y 映射应为 200');
});

// 4) 非正方形按比例映射
test('4000×2000 原图：按比例缩放到 1024×512，坐标映射正确', () => {
  // imgRatio = 2, view 300×300 → dispW=300, dispH=150
  setup({ width: 4000, height: 2000 }, { width: 300, height: 300, left: 0, top: 0 });
  // 点击图片正中：imgX=150, offsetY=75, imgY=75
  tap(150, 150);
  assert.strictEqual(state.canvasNode.width, 1024, '宽应缩放到 1024');
  assert.strictEqual(state.canvasNode.height, 512, '高应缩放到 512（保持 2:1）');
  const c = state.getImageDataCalls[0];
  // pixelX = floor(150*1024/300)=512; pixelY = floor(75*512/150)=256
  assert.strictEqual(c.px, 512, 'X 映射应为 512');
  assert.strictEqual(c.py, 256, 'Y 映射应为 256');
});

// 5) 边界钳制：点击边缘不越界
test('点击图片边缘：坐标被钳制在画布内', () => {
  setup({ width: 6000, height: 6000 }, { width: 300, height: 300, left: 0, top: 0 });
  tap(299, 299); // 接近右下角
  const c = state.getImageDataCalls[0];
  assert.ok(c.px >= 0 && c.px <= 1023, 'X 不超过 1023');
  assert.ok(c.py >= 0 && c.py <= 1023, 'Y 不超过 1023');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

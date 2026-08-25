// test/profile_pickcolor_drawimage_try.test.js
// 修复 ④ 回归：pickColorAtPoint 的 imgEl.onload 中，原实现把 ctx.drawImage 放在 try 之外，
// 弹窗中途关闭使画布节点销毁时 drawImage 抛【未捕获】异常，中断 onload 回调（该回调无外层 try/catch）。
// 修复：把 try 的开启位置提前到 drawImage 之前，使 drawImage 与后续 getImageData/匹配/setData 同处一个 try，
//       异常时 log.warn + 弹出『取色失败，请重试』，不再崩溃。
//
// 运行：node test/profile_pickcolor_drawimage_try.test.js
const path = require('path');

// ---- mock 微信环境 ----
let execCb = null;          // query.exec 回调
let imgOnload = null;       // imgEl.onload
let toastTitles = [];       // 捕获 showToast 文案
let lastWarn = null;        // 捕获 log.warn
// 画布 ctx：drawImage 主动抛错，模拟「弹窗中途关闭 / 画布节点销毁」
const fakeCtx = {
  drawImage() { throw new Error('canvas destroyed'); },
  getImageData: (x, y, w, h) => ({ data: [10, 20, 30, 255] })
};
const fakeCanvas = {
  width: 0, height: 0, getContext: () => fakeCtx,
  createImage: () => {
    const img = {};
    Object.defineProperty(img, 'onload', { set: (fn) => { imgOnload = fn; }, get: () => imgOnload });
    Object.defineProperty(img, 'onerror', { set: () => {}, get: () => null });
    Object.defineProperty(img, 'src', { set: () => {}, get: () => '' });
    return img;
  }
};
global.getApp = () => ({ globalData: {} });
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  createSelectorQuery: () => ({
    select: () => ({ boundingClientRect: () => ({}), fields: () => ({}) }),
    exec: (cb) => { execCb = cb; }
  }),
  showToast: (o) => { toastTitles.push(o && o.title); },
  showModal: () => {},
  getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {} })
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };
require(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'));

function makeCtx(init) {
  const ctx = Object.assign({}, pageObj, {
    data: Object.assign({ pickerImagePath: 'wxfile://tmp/pick.png', pickerImageInfo: { width: 100, height: 100 }, pickerHistory: [] }, init || {}),
    setData: (d) => Object.assign(ctx.data, d)
  });
  return ctx;
}

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

(async () => {
  // 场景：页面存活、图片选好，但 drawImage 抛错（画布已销毁）→ onload 不应崩溃，应弹「取色失败」提示
  {
    execCb = null; imgOnload = null; toastTitles = [];
    const ctx = makeCtx();
    ctx._pageAlive = true;
    ctx.pickColorAtPoint(50, 50);
    execCb([
      { width: 100, height: 100, left: 0, top: 0 }, // imgRect
      { node: fakeCanvas }                            // canvasRes
    ]);
    let threw = false;
    try { if (typeof imgOnload === 'function') imgOnload(); } catch (e) { threw = true; }
    ok('④ drawImage 抛错时 onload 不崩溃（已被 try 包裹）', !threw);
    ok('④ drawImage 抛错 → 弹出「取色失败」提示（try 兜底生效）',
      toastTitles.some((t) => t && t.indexOf('取色失败') !== -1));
    ok('④ drawImage 抛错 → 未 setData pickedColor（失败路径不更新结果）', ctx.data.pickedColor === undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

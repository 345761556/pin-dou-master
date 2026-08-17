/**
 * Medium-6 回归测试：不透明 JPEG 走原生 wx.compressImage 快速路径
 * 验证：
 *  ① 超大 JPG 触发 wx.compressImage（主线程零 canvas 重绘、零 PNG 编码），返回原生压缩路径；
 *  ② 含潜在透明的 PNG 仍走 canvas PNG 路径保 alpha（不调用 wx.compressImage，避免黑底破坏「透明=空位」）。
 */
const assert = require('assert');
const util = require('../utils/util');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

function makeMockWx() {
  const state = { compressCalls: [], queryCalls: 0 };
  const wx = {
    env: { USER_DATA_PATH: 'x' },
    getImageInfo: ({ src, success }) => success({ width: 4000, height: 3000 }),
    compressImage: (o) => { state.compressCalls.push(o); o.success({ tempFilePath: 'wxfile://native_compressed.jpg' }); },
    createSelectorQuery: () => {
      state.queryCalls++;
      const q = {
        select() { return q; },
        fields() { return q; },
        exec(cb) {
          const node = {
            width: 0, height: 0,
            getContext: () => ({ imageSmoothingEnabled: false, imageSmoothingQuality: '', fillStyle: '', drawImage() {}, fillRect() {} }),
            createImage: () => { const img = {}; setTimeout(() => { if (img.onload) img.onload(); }, 0); return img; }
          };
          cb([{ node }]);
        }
      };
      return q;
    },
    canvasToTempFilePath: (o) => o.success({ tempFilePath: 'wxfile://canvas_out.png' })
  };
  return { wx, state };
}

(async () => {
  // ① JPEG：应走原生压缩，不碰 canvas 查询
  let { wx, state } = makeMockWx();
  global.wx = wx;
  const jpg = await util.compressImageIfNeeded('wxfile://tmp_photo.jpg', 800);
  ok('JPEG 触发 wx.compressImage 原生压缩', state.compressCalls.length === 1);
  ok('wx.compressImage 收到正确 src 与等比 compressedWidth',
    state.compressCalls[0] && state.compressCalls[0].src === 'wxfile://tmp_photo.jpg' && state.compressCalls[0].compressedWidth === 800);
  ok('JPEG 返回原生压缩路径且尺寸按 maxSide 缩放',
    jpg.tempFilePath === 'wxfile://native_compressed.jpg' && jpg.width === 800 && jpg.height === 600);
  ok('JPEG 路径未触碰 canvas 查询（零主线程重绘）', state.queryCalls === 0);

  // ② PNG：应走 canvas PNG 路径保 alpha，不调用 wx.compressImage
  ({ wx, state } = makeMockWx());
  global.wx = wx;
  const png = await util.compressImageIfNeeded('wxfile://tmp_logo.png', 800);
  ok('PNG 不调用 wx.compressImage（避免黑底破坏透明语义）', state.compressCalls.length === 0);
  ok('PNG 走 canvas PNG 路径并成功产出', state.queryCalls === 1 && png.tempFilePath === 'wxfile://canvas_out.png');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();

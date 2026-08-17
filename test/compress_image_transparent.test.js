/**
 * compressImageIfNeeded 透明 PNG 压缩黑底回归测试
 * 复现 BUG：原压缩分支 `fileType: 'jpg'` 无 alpha 通道，会把透明区压成黑色底；
 *          同一张透明 PNG 因尺寸不同（>800 走压缩 / <=800 走原图）结果不一致。
 * 修复：压缩分支改输出 PNG 保留 alpha；Canvas 不可用的 fallback 直接返回原路径（同样保留 alpha）。
 * 验证：压缩分支必须传 fileType='png'；fallback 与原图未超限均返回原路径，绝不产出 jpg 黑底。
 */
const assert = require('assert');

let capturedFileType = null;

const mockCanvas = {
  width: 0,
  height: 0,
  getContext: () => ({ drawImage: () => {}, fillRect: () => {} }),
  createImage: () => {
    const img = { onload: null, onerror: null };
    Object.defineProperty(img, 'src', {
      set(v) { if (img.onload) img.onload(); },
      get() { return null; }
    });
    return img;
  }
};

function baseWx(imageSize) {
  return {
    getImageInfo: ({ success }) => success({ width: imageSize.w, height: imageSize.h }),
    createSelectorQuery: () => ({
      select: () => ({
        fields: () => ({
          exec: (cb) => cb([{ node: mockCanvas }])
        })
      })
    }),
    canvasToTempFilePath: (opts) => {
      capturedFileType = opts.fileType;
      opts.success({ tempFilePath: 'wxfile://tmp/compressed.png' });
    },
    getFileSystemManager: () => ({ unlinkSync: () => {} }),
  };
}

const util = require('../utils/util.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('PASS | ' + name); passed++; })
    .catch((e) => { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; });
}

(async () => {
  // 1) 压缩分支（任一边 > 800px）：必须输出 PNG
  global.wx = baseWx({ w: 1600, h: 1200 });
  await test('压缩分支(>800px)输出 PNG，不再变黑底', async () => {
    capturedFileType = null;
    const r = await util.compressImageIfNeeded('wxfile://tmp/big.png', 800);
    assert.strictEqual(capturedFileType, 'png', 'canvasToTempFilePath 必须传 fileType=png，实际=' + capturedFileType);
    assert.ok(r.tempFilePath, '应返回压缩后路径');
  });

  // 2) Canvas 不可用（节点缺失）的 fallback：返回原路径保留 alpha，不产出 jpg 黑底
  global.wx.createSelectorQuery = () => ({
    select: () => ({ fields: () => ({ exec: (cb) => cb([null]) }) })
  });
  await test('Canvas 不可用时 fallback 返回原路径(保留 alpha)', async () => {
    const r = await util.compressImageIfNeeded('wxfile://tmp/big.png', 800);
    assert.strictEqual(r.tempFilePath, 'wxfile://tmp/big.png', 'fallback 应返回原始 path 而非 jpg');
  });

  // 3) 未超限（<=800px）：直接返回原路径
  global.wx = baseWx({ w: 400, h: 300 });
  await test('未超限(<=800px)直接返回原路径', async () => {
    const r = await util.compressImageIfNeeded('wxfile://tmp/small.png', 800);
    assert.strictEqual(r.tempFilePath, 'wxfile://tmp/small.png');
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})();

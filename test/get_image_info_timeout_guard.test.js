// 回归测试：wx.getImageInfo 超时兜底守卫（R2 教训延伸）
// 背景：wx.getImageInfo 没有 timeout 参数，在开发者工具 Windows 模拟器上对
// wxfile:// / http://tmp/ 本地路径可能挂起且不触发 fail 回调 → 框架层裸报
// "Error: timeout"（2026-08-16 三次实测复现），业务日志打不出来。
// 修复：utils/util.js 新增 getImageInfoWithTimeout（Promise.race 兜底 10s），
// 上传链路的 validateImageFile / compressImageIfNeeded / readImageSize 全部改用它，
// 超时按「读取失败」fail-closed 处理，而非框架层裸 timeout。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(msg, cond) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

// ================= 静态断言 =================
console.log('静态校验（utils/util.js getImageInfoWithTimeout）:');
const utilSrc = fs.readFileSync(path.join(root, 'utils/util.js'), 'utf-8');
ok('定义了 getImageInfoWithTimeout 函数', /function getImageInfoWithTimeout/.test(utilSrc));
ok('函数体含 setTimeout 超时兜底', /setTimeout\([\s\S]{0,200}reject\(new Error\('image_info_timeout'\)\)/.test(utilSrc));
ok('函数体含 done 防重入（resolve/reject 只触发一次）',
   /let done = false[\s\S]{0,400}if \(done\) return/.test(utilSrc));
ok('超时后 clearTimeout', /clearTimeout\(timer\)/.test(utilSrc));
ok('已导出 getImageInfoWithTimeout', /getImageInfoWithTimeout,/.test(utilSrc));

console.log('静态校验（上传链路三处调用点）:');
// validateImageFile 使用带超时封装（不再裸调 wx.getImageInfo）
const vif = utilSrc.indexOf('function validateImageFile');
const vifSeg = utilSrc.slice(vif, vif + 2200);
ok('validateImageFile 使用 getImageInfoWithTimeout',
   /getImageInfoWithTimeout\(tempFile\.tempFilePath\)/.test(vifSeg));
ok('validateImageFile 不再裸调 wx.getImageInfo',
   !/wx\.getImageInfo\(/.test(vifSeg));
// compressImageIfNeeded 使用带超时封装
const cin = utilSrc.indexOf('function compressImageIfNeeded');
const cinSeg = utilSrc.slice(cin, cin + 900);
ok('compressImageIfNeeded 使用 getImageInfoWithTimeout',
   /getImageInfoWithTimeout\(imagePath\)/.test(cinSeg));
ok('compressImageIfNeeded 不再裸调 wx.getImageInfo',
   !/wx\.getImageInfo\(/.test(cinSeg));

console.log('静态校验（index.js readImageSize）:');
const idxSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf-8');
ok('readImageSize 改用 getImageInfoWithTimeout',
   /function readImageSize\(src\)\s*\{[\s\S]{0,80}return getImageInfoWithTimeout\(src\)/.test(idxSrc));
ok('index.js 已导入 getImageInfoWithTimeout',
   /getImageInfoWithTimeout,/.test(idxSrc));

// ================= 运行时断言 =================
console.log('运行时校验（超时 → fail-closed 拒绝，非框架裸 timeout）:');
// 用一个「永不回调」的 wx.getImageInfo 桩验证 getImageInfoWithTimeout 超时行为
let captured = null;
global.wx = {
  getImageInfo: () => { /* 永不回调：模拟模拟器挂起 */ }
};
global.setTimeout = (cb, ms) => { captured = { cb, ms }; return 1; };
global.clearTimeout = () => {};
delete require.cache[path.join(root, 'utils/util.js')];
const util = require(path.join(root, 'utils/util.js'));

ok('getImageInfoWithTimeout 返回 Promise', util.getImageInfoWithTimeout('x') instanceof Promise);
const p = util.getImageInfoWithTimeout('x');
ok('超时设置 10000ms（默认）', captured && captured.ms === 10000);
// 触发超时回调 → 应 reject image_info_timeout
let rejected = false;
p.catch((e) => { rejected = e && e.message === 'image_info_timeout'; });
captured.cb();
setImmediate(() => {
  ok('挂起后超时触发 → reject image_info_timeout（fail-closed，非框架裸报错）', rejected === true);

  console.log(`\nget_image_info_timeout_guard.test.js: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
});

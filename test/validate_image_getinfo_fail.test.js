// test/validate_image_getinfo_fail.test.js
// 回归测试：M2 修复 —— validateImageFile 在 getImageInfo 失败时（文件损坏/临时路径失效/非图片内容）
// 必须 fail-closed（resolve(false) + toast），此前错误地 resolve(true) 放行，使破损/超大图片继续
// 流入 compressImageIfNeeded 与生成算法，仅由 beadEngine.generateTemplate 的 6000px 断言兜底，
// 属校验函数自身语义错误（"失败即通过"）。与 S2 内容安全 fail-closed 原则一致：无法验证即拒绝。
// 运行：node test/validate_image_getinfo_fail.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：fail 分支不再「失败时 resolve(true) 放行」 ----
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'util.js'), 'utf8');
// 旧实现形如：fail: () => { // ...注释... resolve(true); }
// 用 [\s\S]*? 跨越注释与换行，锚定到 fail 箭头之后的 resolve(true)
ok('validateImageFile 的 getImageInfo fail 分支不再 resolve(true) 放行',
  !/fail:\s*\(\)\s*=>\s*\{[\s\S]*?resolve\(true\)/.test(utilSrc));

// ---- 2) mock 微信运行时 ----
let imgInfo = null;   // getImageInfo 返回（null 则 fail）
let toasts = [];
global.wx = {
  showToast: (o) => { toasts.push(o && o.title); },
  getImageInfo: ({ src, success, fail }) => {
    if (imgInfo === null) { fail({ errMsg: 'getImageInfo fail' }); return; }
    success(imgInfo);
  }
};
const util = require('../utils/util');

function reset() { toasts = []; imgInfo = { type: 'png', width: 800, height: 600 }; }

(async () => {
  // 核心回归：getImageInfo 失败 → 拒绝放行（fail-closed）
  reset();
  imgInfo = null; // 触发 fail 分支
  let r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_fail', size: 100 * 1024, fileType: 'image' });
  ok('getImageInfo 失败（文件损坏/路径失效）→ resolve(false) 拒绝放行（M2 修复）', r === false);
  ok('getImageInfo 失败时弹出「图片读取失败，请重试」提示', toasts.some(t => /图片读取失败/.test(t || '')));

  // 其他拒绝分支不受影响（尺寸超限仍拒绝）
  reset();
  imgInfo = { type: 'png', width: 6001, height: 600 };
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_big.png', size: 100 * 1024, fileType: 'image' });
  ok('尺寸 >6000px → 仍拒绝（无回归）', r === false);

  // 正常图片仍放行（success 路径不变）
  reset();
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_ok.png', size: 100 * 1024, fileType: 'image' });
  ok('正常图片（success）→ 仍放行（无回归）', r === true);

  // 调用方语义验证：valid=false 时 index/profile 均 if(!valid) return，
  // 破损图不会流入 compressImageIfNeeded / generateTemplate（下游不再承担本应由闸门拒绝的职责）。

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

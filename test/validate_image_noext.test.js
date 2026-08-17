// test/validate_image_noext.test.js
// 回归测试：validateImageFile 按临时路径扩展名判格式（util.js split('.')），
// 与项目自身 BUG-20 兜底（index.js:441 无扩展名回退 png）自相矛盾——
// chooseMedia 真机临时路径在部分平台/基础库不带扩展名（wxfile://tmp_xxx / http://tmp/xxx），
// 旧逻辑会把这些合法图片全部拒绝，核心选图流程断裂，BUG-20 兜底永远到不了。
// 修复：移除扩展名同步校验，真实格式校验完全依赖 getImageInfo().type 白名单。
// 运行：node test/validate_image_noext.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：不再按路径扩展名判格式 ----
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'util.js'), 'utf8');
ok('validateImageFile 不再用 tempFilePath.split(\'.\') 取扩展名',
  !/tempFilePath\.split\(['"]\.['"]\)/.test(utilSrc));

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

// ---- 3) 功能用例 ----
(async () => {
  // 核心回归：无扩展名临时路径（wxfile://tmp_xxx）不得被拒
  reset();
  imgInfo = { type: 'png', width: 800, height: 600 };
  let r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_a1b2c3', size: 100 * 1024, fileType: 'image' });
  ok('无扩展名路径(wxfile://tmp_xxx) + 真实格式 png → 放行（修复前被拒）', r === true);

  // Android 形态：http://tmp/xxx 无扩展名
  reset();
  r = await util.validateImageFile({ tempFilePath: 'http://tmp/abcd', size: 100 * 1024, fileType: 'image' });
  ok('无扩展名路径(http://tmp/xxx) + 真实格式 png → 放行', r === true);

  // 真实格式校验仍生效：无扩展名但内容为 GIF → 拒绝（防御伪装）
  reset();
  imgInfo = { type: 'gif', width: 800, height: 600 };
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_noext', size: 100 * 1024, fileType: 'image' });
  ok('无扩展名路径 + 真实格式 gif → 拒绝（真实格式校验仍生效）', r === false);

  // getImageInfo type 为空 → 沿用既有行为放行（后续流程兜底）
  reset();
  imgInfo = { type: '', width: 800, height: 600 };
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_noext', size: 100 * 1024, fileType: 'image' });
  ok('无扩展名路径 + type 为空 → 放行', r === true);

  // L9 回归：type 为 'unknown'（微信无法判定格式，官方 type 有效值之一）不得误拒 → 放行（见 L9 修复）
  reset();
  imgInfo = { type: 'unknown', width: 800, height: 600 };
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_noext', size: 100 * 1024, fileType: 'image' });
  ok('无扩展名路径 + type=unknown → 放行（L9 修复：不再误拒合法图片）', r === true);
  ok('type=unknown 不弹「不支持 UNKNOWN 格式」提示', !toasts.some(t => /UNKNOWN/i.test(t || '')));

  // 正常带扩展名路径不回归
  reset();
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_abc.png', size: 100 * 1024, fileType: 'image' });
  ok('带 .png 扩展名 + 真实格式 png → 放行（无回归）', r === true);

  // fileType 非 image 仍拒绝
  reset();
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_abc.png', size: 100 * 1024, fileType: 'video' });
  ok('fileType 非 image → 拒绝', r === false);

  // 大小超限仍拒绝
  reset();
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_abc.png', size: 11 * 1024 * 1024, fileType: 'image' });
  ok('大小 >10MB → 拒绝', r === false);

  // 尺寸超限仍拒绝
  reset();
  imgInfo = { type: 'png', width: 6001, height: 600 };
  r = await util.validateImageFile({ tempFilePath: 'wxfile://tmp_abc.png', size: 100 * 1024, fileType: 'image' });
  ok('宽 >6000px → 拒绝', r === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

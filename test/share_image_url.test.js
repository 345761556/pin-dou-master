// 回归测试：onShareAppMessage / onShareTimeline 不得传 imageUrl: ''（空串）
// 对应 BUG-23（用户报告 "分享图空串 imageUrl: '' → 分享卡片回退默认截屏"）。
// 修复：仅在存在有效非空分享图路径时才设置 imageUrl；否则移除该字段，
// 由微信回退到当前页默认截图（imageUrl: '' 在部分基础库版本会渲染空图而非回退截图）。

const path = require('path');

// ---- 微信运行时全局 mock（须在 require template.js 前就位）----
global.App = () => {};
const fakeApp = { globalData: { shareImagePath: '', selectedPalette: 'artkal_c' } };
global.getApp = () => fakeApp;
global.wx = {
  getFileSystemManager: () => ({ saveFileSync: () => '', unlinkSync: () => {}, accessSync: () => {} }),
  getLogManager: () => ({ warn() {}, info() {}, error() {}, log() {} }),
  showToast: () => {},
  getImageInfo: () => {}
};
let pageObj = null;
global.Page = (o) => { pageObj = o; };

delete require.cache[path.join(__dirname, '../pages/template/template.js')];
require(path.join(__dirname, '../pages/template/template.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('onShareAppMessage / onShareTimeline 的 imageUrl 不得为空串:');

// 1) 默认（shareImagePath 为空串）→ 不应出现 imageUrl 字段
fakeApp.globalData.shareImagePath = '';
let msg = pageObj.onShareAppMessage();
ok('空串时 onShareAppMessage 不含 imageUrl 字段', msg.imageUrl === undefined);
let tl = pageObj.onShareTimeline();
ok('空串时 onShareTimeline 不含 imageUrl 字段', tl.imageUrl === undefined);

// 2) undefined → 同样不含
fakeApp.globalData.shareImagePath = undefined;
ok('undefined 时 onShareAppMessage 不含 imageUrl', pageObj.onShareAppMessage().imageUrl === undefined);
ok('undefined 时 onShareTimeline 不含 imageUrl', pageObj.onShareTimeline().imageUrl === undefined);

// 3) 纯空白串 → 同样剔除
fakeApp.globalData.shareImagePath = '   ';
ok('纯空白串时 onShareAppMessage 不含 imageUrl', pageObj.onShareAppMessage().imageUrl === undefined);

// 4) 有效路径 → 正常带 imageUrl
const valid = '/usr/bead_share_123.png';
fakeApp.globalData.shareImagePath = valid;
msg = pageObj.onShareAppMessage();
tl = pageObj.onShareTimeline();
ok('有效路径时 onShareAppMessage 带 imageUrl', msg.imageUrl === valid);
ok('有效路径时 onShareTimeline 带 imageUrl', tl.imageUrl === valid);

// 5) 其余字段不受影响
ok('title 正常生成', typeof msg.title === 'string' && msg.title.indexOf('×') > 0);
ok('path 保持 /pages/index/index', msg.path === '/pages/index/index');
ok('onShareTimeline 保留 query', tl.query === '');

// 6) 静态：源码不再直接 imageUrl: app.globalData.shareImagePath（改为条件设置）
const js = require('fs').readFileSync(path.join(__dirname, '../pages/template/template.js'), 'utf8');
ok('源码移除 imageUrl: app.globalData.shareImagePath 直赋', !/imageUrl:\s*app\.globalData\.shareImagePath\s*\n/.test(js));
ok('源码新增 _validShareImage 条件封装', /_validShareImage\(\)/.test(js));

console.log(`\nshare_image_url: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// 回归测试：saveToHistory 持久化原图时，目标文件扩展名须与源文件真实格式一致
// 对应 BUG-20（用户报告 "扩展名与内容不符：.png 扩展名存 jpg 字节"）
// 复现路径：chooseImage -> compressImageIfNeeded 对"小图"原样返回相机直出的 .jpg 临时文件
//          -> saveToHistory 把 jpg 字节 copyFileSync 进 history_source_<ts>.png -> 扩展名与内容不符

const path = require('path');

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
global.App = () => {};
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });

const copyCalls = [];
global.wx = {
  env: { USER_DATA_PATH: '/usr' },
  getStorageSync: () => [],
  setStorageSync: () => {},
  showToast: () => {},
  getLogManager: () => ({ warn() {}, info() {}, error() {}, log() {} }),
  getFileSystemManager: () => ({
    copyFileSync: (src, dest) => { copyCalls.push([src, dest]); },
    accessSync: () => {}
  })
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };

// 清除缓存，确保 Page 注册被本次 require 捕获
delete require.cache[path.join(__dirname, '../pages/index/index.js')];
require(path.join(__dirname, '../pages/index/index.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 构造一份最小合法的 templateData（saveToHistory 会调用 beadEngine.rleEncode(template)）
const templateData = {
  cols: 2, rows: 1, totalBeads: 2, colorCount: 1, beadSize: 5,
  materialList: [{ id: 'R01', count: 2 }],
  template: [['R01', 'R01']]
};

function runSave(imagePath) {
  copyCalls.length = 0;
  pageObj.data.imagePath = imagePath;
  pageObj.data.beadType = 'square';
  pageObj.saveToHistory(templateData);
  return copyCalls;
}

console.log('saveToHistory 扩展名须与源真实格式一致:');

// 1) 相机直出 .jpg 小图（走"不压缩"分支，imagePath 即原 jpg 临时文件）
const jpg = runSave('wxfile://tmp/photo_12345.jpg');
ok('jpg 源 → 目标为 .jpg（不再写死 .png）', jpg.length === 1 && /\.jpg$/.test(jpg[0][1]));

// 2) 透明 PNG 源（压缩分支产物为 png）
const png = runSave('wxfile://tmp/logo_67890.png');
ok('png 源 → 目标为 .png', png.length === 1 && /\.png$/.test(png[0][1]));

// 3) WebP 源（validateImageFile 允许 webp）
const webp = runSave('wxfile://tmp/sticker_abc.webp');
ok('webp 源 → 目标为 .webp', webp.length === 1 && /\.webp$/.test(webp[0][1]));

// 4) 无扩展名源 → 回退默认 .png
const noext = runSave('wxfile://tmp/nakedfile');
ok('无扩展名源 → 回退 .png', noext.length === 1 && /\.png$/.test(noext[0][1]));

// 5) 远程图片（真实域名）→ 不复制，sourceImage 为 null（不泄漏/不存本地）
const remote = runSave('https://cdn.example.com/album/cover.jpg');
ok('远程图片 → 不复制本地文件', remote.length === 0);

// 6) 静态：源码不再硬编码 '.png' 作为 history_source 目标后缀
const jsSrc = require('fs').readFileSync(path.join(__dirname, '../pages/index/index.js'), 'utf8');
ok('源码未写死 history_source_xxx.png 后缀', !/history_source_' \+ Date\.now\(\) \+ '\.png'/.test(jsSrc));
ok('源码按源扩展名拼接目标（match 正则 + "." + ext）', /rawPath\.match\(\/\\\.\(\[a-z0-9\]\+\)\$\/i\)/.test(jsSrc));

console.log(`\nhistory_source_extension: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

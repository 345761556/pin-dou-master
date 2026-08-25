// 回归测试：压缩失败兜底不得导致预估区显示误导性的「0 颗」
// 原始 bug：chooseImage 中 compressImageIfNeeded reject 时 processed={width:0,height:0}
//          -> setData imageSize={0,0} -> updateEstimate 因 width=0 直接 return
//          -> 预估区保持初始值 0 -> 显示「预估约 0 颗拼豆」，但生成功能本身正常，误导用户。
// 修复：
//   1) 主修复：压缩失败 catch 分支用 wx.getImageInfo 补取真实尺寸（源图必可读，
//      validateImageFile / compressImageIfNeeded 内部已对同一路径成功 getImageInfo 过）；
//   2) 兜底：updateEstimate 在尺寸不可用时把预估区置为占位符 '-'（WXML 条件渲染为「尺寸未知」），
//      不再把 0 当成真实值展示。
const fs = require('fs');
const path = require('path');

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
const dims = {};                  // src -> {width,height}，供 getImageInfo 返回
let chooseMediaSuccess = null;    // 捕获 wx.chooseMedia 的 success 回调
let failGetImageInfo = false;     // 语义：模拟「补取尺寸（readImageSize 二次读取）失败」
let giCallSeq = 0;                // getImageInfo 调用序号，区分首读(validateImageFile)与二次读(readImageSize)
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  getStorageSync: () => null,
  getImageInfo({ src, success, fail }) {
    giCallSeq++;
    // M2 影响：validateImageFile 现已 fail-closed，getImageInfo 首读失败会被闸门直接拦截，
    // 压缩兜底场景（B/D）无法触达。故 failGetImageInfo 仅作用于「二次读取」(call #2 及之后，
    // 即 readImageSize 的补取)，首读(validateImageFile)必须成功放行进入压缩链路。
    if (failGetImageInfo && giCallSeq >= 2) {
      if (fail) fail({ errMsg: 'getImageInfo:fail mock' });
      return;
    }
    success(dims[src] || { width: 100, height: 100 });
  },
  createSelectorQuery() {
    const q = {
      select() { return q; },
      fields() { return q; },
      exec(cb) { cb([{}]); }
    };
    return q;
  },
  chooseMedia({ success }) { chooseMediaSuccess = success; },
  showToast() {}
};
global.App = () => {};
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });

// 捕获 Page 注册对象
let pageObj = null;
global.Page = (o) => { pageObj = o; };

// 注入 fake colorLibrary（避免 require 真实模块依赖链）
const colorLibPath = path.resolve(__dirname, '../utils/colorLibrary.js');
require.cache[colorLibPath] = {
  id: colorLibPath, filename: colorLibPath, loaded: true,
  exports: {
    getCurrentPaletteKey: () => 'artkal_c',
    getPaletteName: () => 'ArtKal C 系列',
    getPaletteList: () => [],
    getCurrentColors: () => [],
    switchPalette: () => []
  }
};

// 注入可控制的 compressImageIfNeeded：其余 util 导出保留真实实现（含 clampTemplateSize /
// validateImageFile / formatNumber / formatMm / CONSTANTS 等），仅替换压缩函数以模拟失败/成功。
const utilPath = path.resolve(__dirname, '../utils/util.js');
const realUtil = require(utilPath);
const { clampTemplateSize, CONSTANTS, formatNumber } = realUtil;
let compressMode = 'success'; // 'success' | 'fail'
require.cache[utilPath] = {
  id: utilPath, filename: utilPath, loaded: true,
  exports: Object.assign({}, realUtil, {
    compressImageIfNeeded(imagePath) {
      if (compressMode === 'fail') {
        return Promise.reject(new Error('image_compress_failed'));
      }
      const d = dims[imagePath] || { width: 100, height: 100 };
      return Promise.resolve({ tempFilePath: imagePath, width: d.width, height: d.height });
    }
  })
};

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const root = path.resolve(__dirname, '..');
const jsSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const wxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');

console.log('静态校验（修复存在性）:');
ok('压缩失败 catch 分支补取真实尺寸（调用 readImageSize）',
  /const size = await readImageSize\(tempFile\.tempFilePath\);/.test(jsSrc));
ok('index.js 定义 readImageSize 辅助函数',
  /function readImageSize\(src\)/.test(jsSrc));
ok('updateEstimate 尺寸不可用时置占位符（不 return 静默保留 0）',
  /'estimateInfo\.totalBeads': '-'/.test(jsSrc) && /'estimateInfo\.size': '-'/.test(jsSrc));
ok('updateEstimate 兜底同时校验 width 与 height',
  /if \(!imageSize \|\| !imageSize\.width \|\| !imageSize\.height\)/.test(jsSrc));
ok('WXML 对占位符做条件渲染（不显示「预估约 0 颗」）',
  /wx:elif="\{\{estimateInfo\.totalBeads !== '-'\}\}"/.test(wxml) &&
  /wx:else>预估 <text class="highlight">尺寸未知<\/text>/.test(wxml));
ok('正常路径 WXML 展示逻辑未变（预估约 + 尺寸约）',
  /预估约 <text class="highlight">\{\{estimateInfo\.totalBeads\}\}<\/text> 颗拼豆/.test(wxml) &&
  /尺寸约 <text class="highlight">\{\{estimateInfo\.size\}\}<\/text>/.test(wxml));
ok('clampTemplateSize 调用守卫（width>0 && height>0）未被改动',
  /if \(processed\.width > 0 && processed\.height > 0\)/.test(jsSrc));

// 加载页面（触发 Page 注册 -> pageObj）
delete require.cache[path.join(root, 'pages/index/index.js')];
require(path.join(root, 'pages/index/index.js'));
// 注入框架级 setData（真实小程序由框架提供，支持 'a.b' 路径语法，
// 使 chooseImage/updateEstimate 可正确写回 data 的嵌套字段）
pageObj.setData = function (obj) {
  for (const key of Object.keys(obj)) {
    if (key.indexOf('.') === -1) {
      this.data[key] = obj[key];
      continue;
    }
    const parts = key.split('.');
    let target = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') {
        target[parts[i]] = {};
      }
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = obj[key];
  }
};

function pickImage(src, width, height) {
  giCallSeq = 0;                 // 每次新选图重置调用序号，首读即 #1
  if (width != null) dims[src] = { width, height };
  pageObj.data.templateCols = 50;
  pageObj.data.imageSize = null;
  pageObj.data.estimateInfo = { totalBeads: 0, size: '' };
  pageObj.chooseImage();  // 触发 wx.chooseMedia，捕获 success 回调
  chooseMediaSuccess({ tempFiles: [{ tempFilePath: src, size: 100, fileType: 'image' }] });
  return new Promise(r => setTimeout(r, 80));
}

(async () => {
  // 场景 A：压缩失败（compressImageIfNeeded reject）→ 补取尺寸成功 → imageSize 为真实宽高
  // → updateEstimate 正常计算，不显示 0 颗
  console.log('\n场景 A：压缩失败 + 补取尺寸成功:');
  compressMode = 'fail';
  failGetImageInfo = false;
  await pickImage('wxfile://tmp_compress_fail_800x600.png', 800, 600);
  ok('imageSize 为真实宽高 800x600（非 0）',
    pageObj.data.imageSize && pageObj.data.imageSize.width === 800 && pageObj.data.imageSize.height === 600);
  ok('预估数量非 0 且非占位符（实际 ' + pageObj.data.estimateInfo.totalBeads + '）',
    pageObj.data.estimateInfo.totalBeads !== '0' && pageObj.data.estimateInfo.totalBeads !== '-');
  ok('预估尺寸非占位符（实际 ' + pageObj.data.estimateInfo.size + '）',
    pageObj.data.estimateInfo.size !== '-');
  ok('templateCols 仍在合法区间 [20,120]',
    pageObj.data.templateCols >= 20 && pageObj.data.templateCols <= 120);

  // 场景 B：压缩失败 + 补取尺寸也失败 → imageSize width=0 → updateEstimate 走占位分支
  // （不显示 0 颗，不崩溃）
  console.log('\n场景 B：压缩失败 + 补取尺寸也失败:');
  compressMode = 'fail';
  failGetImageInfo = true;
  await pickImage('wxfile://tmp_compress_fail_noinfo.png', null);
  ok('imageSize 保持 width=0（补取失败兜底）',
    pageObj.data.imageSize && pageObj.data.imageSize.width === 0 && pageObj.data.imageSize.height === 0);
  ok('预估数量为占位符 "-"（不显示 0 颗）', pageObj.data.estimateInfo.totalBeads === '-');
  ok('预估尺寸为占位符 "-"', pageObj.data.estimateInfo.size === '-');
  ok('流程不崩溃，imagePath 仍指向原图', pageObj.data.imagePath === 'wxfile://tmp_compress_fail_noinfo.png');

  // 场景 C：压缩成功（正常路径）→ 行为与修复前一致（回归）
  console.log('\n场景 C：压缩成功（正常路径回归）:');
  compressMode = 'success';
  failGetImageInfo = false;
  await pickImage('wxfile://tmp_compress_ok_1000x1000.png', 1000, 1000);
  ok('imageSize 为 1000x1000', pageObj.data.imageSize.width === 1000 && pageObj.data.imageSize.height === 1000);
  // L2 确认后：选择新图时列数默认取 min(该宽高比自然上限, DEFAULT_COLS=50)，
  // 1000x1000(aspect=1) 上限 89 列，但默认取 50 列 → 50×50 = 2500 颗（普通图保留适中默认，
  // 而非跳到接近上限的大模板）。极端竖图上限 < 50 时仍取真实上限，保持一致。
  const cCap = clampTemplateSize(CONSTANTS.MAX_COLS, CONSTANTS.MAX_COLS, CONSTANTS.MAX_PIXELS, CONSTANTS.MAX_ROWS, 1);
  const cCols = Math.min(cCap.cols, CONSTANTS.DEFAULT_COLS);
  const cExpected = formatNumber(cCols * cCols);
  ok('预估数量 = min(自然上限 ' + cCap.cols + ', DEFAULT_COLS ' + CONSTANTS.DEFAULT_COLS + ')=' + cCols + ' 列 → ' + cExpected + ' 颗', pageObj.data.estimateInfo.totalBeads === cExpected);
  ok('预估尺寸正常（实际 ' + pageObj.data.estimateInfo.size + '）', pageObj.data.estimateInfo.size !== '-' && pageObj.data.estimateInfo.size !== '');

  // 场景 D：占位符状态（场景 B 后）同一实例重新选图成功 → '-' 被真实值覆盖（边界 b）
  // pickImage 会重置状态，故此处手动驱动 chooseImage 全流程，保留 B 的占位状态再迁移。
  console.log('\n场景 D：占位后重新选图（同实例状态迁移）:');
  compressMode = 'fail';
  failGetImageInfo = true;
  giCallSeq = 0;                 // 手动驱动前重置，首读即 #1
  pageObj.data.templateCols = 50;
  pageObj.chooseImage();
  chooseMediaSuccess({ tempFiles: [{ tempFilePath: 'wxfile://tmp_placeholder_state.png', size: 100, fileType: 'image' }] });
  await new Promise(r => setTimeout(r, 80));
  ok('先进入占位状态（totalBeads="-"）', pageObj.data.estimateInfo.totalBeads === '-');

  compressMode = 'success';
  failGetImageInfo = false;
  giCallSeq = 0;                 // 重新选图重置，首读即 #1
  dims['wxfile://tmp_reselect_ok.png'] = { width: 500, height: 500 };
  pageObj.chooseImage();
  chooseMediaSuccess({ tempFiles: [{ tempFilePath: 'wxfile://tmp_reselect_ok.png', size: 100, fileType: 'image' }] });
  await new Promise(r => setTimeout(r, 80));
  ok('重新选图成功后占位符被真实值覆盖（实际 ' + pageObj.data.estimateInfo.totalBeads + '）',
    pageObj.data.estimateInfo.totalBeads === cExpected);
  ok('重新选图后预估尺寸恢复（非 "-"）', pageObj.data.estimateInfo.size !== '-' && pageObj.data.estimateInfo.size !== '');
  ok('重新选图后 imageSize 恢复真实尺寸 500x500',
    pageObj.data.imageSize.width === 500 && pageObj.data.imageSize.height === 500);

  // 场景 E：slider 拖动等其它入口直接调用 updateEstimate，且 imageSize 合法 → 与修复前行为一致（边界 c）
  console.log('\n场景 E：updateEstimate 直接调用（合法 imageSize）:');
  pageObj.setData({ imageSize: { width: 400, height: 300 }, templateCols: 50 });
  pageObj.updateEstimate();
  ok('合法 imageSize 直接 updateEstimate 正常计算（实际 ' + pageObj.data.estimateInfo.totalBeads + '）',
    pageObj.data.estimateInfo.totalBeads === '1,900' && pageObj.data.estimateInfo.size !== '-');
  pageObj.setData({ imageSize: { width: 0, height: 0 } });
  pageObj.updateEstimate();
  ok('非法 imageSize 直接 updateEstimate 走占位（totalBeads="-"）', pageObj.data.estimateInfo.totalBeads === '-');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

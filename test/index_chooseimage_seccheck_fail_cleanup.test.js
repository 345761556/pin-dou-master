// test/index_chooseimage_seccheck_fail_cleanup.test.js
// 回归测试：[4] index.js chooseImage 中 secCheck 失败时本地临时图未清理
// Bug：secCheck.checkImageByPath 失败（return）时未清理 processed.tempFilePath 对应的本地临时图，
//      云函数端已删云存储副本、但本地 wxfile://tmp_ 临时文件未回收；本会话反复
//      「选图→违规被拦」会累积临时文件（compressImageIfNeeded 压缩产物亦为系统临时文件）。
// 修复：secCheck 失败分支 return 前 removeFileIfExists(processed.tempFilePath)。成功路径
//      setData 后仍引用该路径供后续创作，故仅失败分支清理。
// 运行：node test/index_chooseimage_seccheck_fail_cleanup.test.js
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言：secCheck 失败分支 return 前先清理本地临时图 ----
const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
const failBlock = idxSrc.slice(idxSrc.indexOf('if (!secResult.pass) {'));
ok('secCheck 失败分支 return 前调用 removeFileIfExists(processed.tempFilePath)',
  /removeFileIfExists\(processed\.tempFilePath\)[\s\S]{0,80}return;/.test(failBlock));

// ---- 2) 功能驱动：选图→secCheck 失败，验证本地临时图被清理 ----
const SRC = 'wxfile://tmp_src_1.png';
let unlinked = [];
let toastCalled = false;
let toastTitle = null;

const fakeApp = { globalData: {} };
global.getApp = () => fakeApp;
global.App = () => {};   // app.js 顶层注册 App({})，测试环境需占位
global.wx = {
  showToast: (o) => { toastTitle = o && o.title; toastCalled = true; },
  // chooseMedia：成功回调返回一张合法图片（fileType=image, size<10MB）
  chooseMedia: ({ success }) => success({
    tempFiles: [{ tempFilePath: SRC, fileType: 'image', size: 100000, width: 100, height: 100 }]
  }),
  // getImageInfoWithTimeout 底层用 wx.getImageInfo：返回合法 png，最长边 100<=800 不压缩
  getImageInfo: ({ src, success, fail }) => success({ type: 'png', width: 100, height: 100 }),
  getFileSystemManager: () => ({
    unlinkSync: (p) => { unlinked.push(p); },                       // removeFileIfExists 记录
    getFileInfo: ({ filePath, success, fail }) => success({ size: 100000 }) // secCheck 内部取文件大小
  }),
  createSelectorQuery: () => ({ in() { return this; }, select() { return this; }, fields() { return this; }, exec(cb) { cb([null]); } }),
  // secCheck.checkImageByPath：uploadFile 成功→submit 返回 trace_id→query 返回 risky（pass=false）
  cloud: {
    uploadFile: ({ cloudPath, filePath, success }) => success({ fileID: 'cloud://env/t.png' }),
    callFunction: ({ data, success }) => {
      if (data && data.action === 'query') success({ result: { errcode: 0, errmsg: 'ok', status: 'done', suggest: 'risky' } });
      else success({ result: { errcode: 0, errmsg: 'ok', trace_id: 'trace-1', status: 'submitted' } });
    },
    deleteFile: ({ fileList, success }) => success({})
  }
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };
delete require.cache[path.join(__dirname, '..', 'pages', 'index', 'index.js')];
require(path.join(__dirname, '..', 'pages', 'index', 'index.js'));

const ctx = Object.assign({}, pageObj, {
  data: {},
  setData: (d) => Object.assign(ctx.data, d)
});

(async () => {
  ctx.chooseImage();
  // chooseImage 的 success 是 async 回调，chooseImage() 本体不 await 它；
  // 轮询等待 success 内链路（validateImageFile→compressImageIfNeeded→secCheck）完成
  for (let i = 0; i < 300 && unlinked.length === 0; i++) await new Promise(r => setImmediate(r));

  ok('secCheck 失败时给出违规提示 toast', toastCalled && typeof toastTitle === 'string' && toastTitle.length > 0);
  ok('secCheck 失败分支主动清理 processed.tempFilePath（本地临时图不再累积）', unlinked.includes(SRC));
  ok('仅清理当前检测图、未误删无关文件', unlinked.length === 1 && unlinked[0] === SRC);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

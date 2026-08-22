// test/sec_check_errcode_cleanup.test.js
// M1 回归（限频路径云存储文件泄漏修复）：验证前端在云函数返回 errcode≠0 时
// 主动回收自己已上传的云存储文件。
//
// 背景：云函数在 -1(非法fileID)/-5(路径校验)/-6(限频) 等 downloadFile 之前的早返回分支
// 不会进入 try/finally，因此不会触发 finally 的 deleteFile（见 cloudfunctions/secCheck/index.js，
// 其测试 sec_check_cloudfunction.test.js 已断言"限频不触发 deleteFile"为云函数侧正确行为）。
// 旧实现仅在 callFunction 抛异常(catch)时兜底删除，errcode≠0 的成功响应分支未清理，
// 导致限频(-6)等设计内常态路径每次都在 sec_check/ 留下一个上传文件，无上限累积。
//
// 本测试补齐"前端对 errcode≠0 响应是否回收自己上传的文件"这一缺失视角。
// 运行：node test/sec_check_errcode_cleanup.test.js
const secCheck = require('../utils/secCheck');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

let fileSize = 100 * 1024;     // getFileInfo 返回字节数（远小于 7MB 上限）
let fnResult = null;           // 云函数 submit 返回对象
let pollResult = null;         // 云函数 query 返回对象
let uploadCalls = [];          // uploadFile 入参
let deleteCalls = [];          // deleteFile 入参
let lastFileID = null;         // 最近一次上传返回的 fileID

function rebuildCloud() {
  delete global.wx.cloud;
  global.wx.cloud = {
    uploadFile({ cloudPath, filePath, success }) {
      uploadCalls.push({ cloudPath, filePath });
      lastFileID = 'cloud://env-test/' + cloudPath; // cloudPath 形如 sec_check/xxx.png
      success({ fileID: lastFileID });
    },
    callFunction({ data, success }) {
      if (data && data.action === 'query') {
        success({ result: pollResult || { errcode: 0, errmsg: 'ok', status: 'done', suggest: 'pass' } });
        return;
      }
      success({ result: fnResult || { errcode: 0, errmsg: 'ok', trace_id: 'trace-001', status: 'submitted' } });
    },
    deleteFile({ fileList, success }) {
      deleteCalls.push(fileList);
      success({});
    }
  };
}
global.wx = {
  getFileSystemManager() {
    return { getFileInfo: ({ success }) => success({ size: fileSize }) };
  }
};
rebuildCloud();

(async () => {
  // 1) 限频 errcode=-6（设计内常态路径）→ 回收已上传文件 + S2 改为 fail-closed 拦截
  uploadCalls = []; deleteCalls = []; lastFileID = null;
  fnResult = { errcode: -6, errmsg: 'rate limited' };
  let r = await secCheck.checkImageByPath('wxfile://tmp/big.png', { scene: 2 });
  ok('errcode -6 fail-closed 拦截(pass=false/skipped/blockType=rate)', r.pass === false && r.skipped === true && r.blockType === 'rate');
  ok('errcode -6 回收自己上传的文件(deleteFile 调用1次)', deleteCalls.length === 1);
  ok('errcode -6 删除的是本次上传的 fileID', deleteCalls.length === 1 && deleteCalls[0][0] === lastFileID);
  ok('errcode -6 上传文件落在 sec_check/ 前缀下(可清理)', lastFileID && lastFileID.indexOf('sec_check/') !== -1);

  // 2) 路径校验 errcode=-5 → 同样回收 + 拦截
  uploadCalls = []; deleteCalls = []; lastFileID = null;
  fnResult = { errcode: -5, errmsg: 'invalid fileID path' };
  r = await secCheck.checkImageByPath('wxfile://tmp/x.png', { scene: 2 });
  ok('errcode -5 回收自己上传的文件', deleteCalls.length === 1 && deleteCalls[0][0] === lastFileID);
  ok('errcode -5 fail-closed 拦截(pass=false)', r.pass === false);

  // 3) 通用非0 errcode（如 45009 配额）→ 同样回收 + 拦截
  uploadCalls = []; deleteCalls = []; lastFileID = null;
  fnResult = { errcode: 45009, errmsg: 'reach max api daily quota limit' };
  r = await secCheck.checkImageByPath('wxfile://tmp/y.png', { scene: 2 });
  ok('errcode 45009 回收自己上传的文件', deleteCalls.length === 1 && deleteCalls[0][0] === lastFileID);
  ok('errcode 45009 fail-closed 拦截(pass=false)', r.pass === false);

  // 4) 正常 pass(errcode=0) → 前端兜底删除 1 次（P2-6 修复：删除时机后移）
  // P2-6 背景：云函数 submit 成功路径不再在 finally 立即删文件（避免与 mediaCheckAsync
  // 异步下载 media_url 竞态致 -1008 误拦合法图），文件改由 mediaCheckResult 写入结果后
  // （云函数侧）+ 前端 pollSecCheckResult 结束后（本断言）双层兜底删除，隐私目标不变。
  uploadCalls = []; deleteCalls = []; lastFileID = null;
  // 必须显式把 fnResult 重置为成功对象（submit 返回 errcode 0 才算正常放行链路）；
  // 否则会沿用 case 3 的 45009，误走 errcode≠0 拦截分支，两条断言无意义失败（测试 setup 遗漏）。
  fnResult = { errcode: 0, errmsg: 'ok', trace_id: 'trace-001', status: 'submitted' };
  pollResult = { errcode: 0, errmsg: 'ok', status: 'done', suggest: 'pass' };
  r = await secCheck.checkImageByPath('wxfile://tmp/z.png', { scene: 2 });
  ok('errcode 0 正常放行(pass/skipped=false)', r.pass === true && r.skipped === false);
  ok('errcode 0 前端轮询结束后兜底删除 1 次（P2-6：云函数成功路径已不立即删）',
    deleteCalls.length === 1 && deleteCalls[0][0] === lastFileID);
  pollResult = null;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

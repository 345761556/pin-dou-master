// test/sec_check.test.js - 内容安全检测模块（utils/secCheck.js）单元测试
// 验证（S2 改造后：默认 fail-closed，仅 develop 环境 fail-open）：
//   1) 微信返回 pass → 放行（pass=true, skipped=false）
//   2) 微信返回 risky/review → 拦截（pass=false, blockType=violation）
//   3) 云开发通道不可用 → fail-closed 拦截（pass=false, blockType=unavailable）
//   4) 图片超过检测上限（>7MB）→ fail-closed 拦截（pass=false, blockType=size）
//   5) 上传/云函数调用异常 → fail-closed 拦截（pass=false, blockType=error）+ 兜底删除云存储文件
//   6) 云函数返回非 0 errcode（-6 限频 / 45009 配额）→ fail-closed 拦截 + 仍回收已上传文件
//   7) 非法路径 → fail-closed 拦截（pass=false, blockType=error）
//   8) develop 环境 → fail-open 放行（便于本地未部署云函数调试）
//   9) blockMessage 按 blockType 返回差异化提示文案
// 运行：node test/sec_check.test.js
const secCheck = require('../utils/secCheck');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name, '=> got', JSON.stringify(actual), 'expect', JSON.stringify(expected)); }
}
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

// ============ mock 微信环境 ============
let fileSize = 100 * 1024;          // getFileInfo 返回的字节数
let fnResult = null;                // 云函数 submit 返回对象（{ errcode, trace_id }）
let fnError = null;                 // 云函数调用失败注入
let pollResult = null;              // 云函数 query 返回对象（{ errcode, status, suggest }）
let pollError = null;               // 轮询 query 失败注入
let uploadFail = false;             // 上传失败注入
let uploadCalls = [];               // 记录 uploadFile 入参
let deleteCalls = [];               // 记录 deleteFile 入参
let callDataLog = [];               // 记录 callFunction 入参（断言 action 分发）
let accountInfo = null;             // 模拟 wx.getAccountInfoSync 返回（null = 不提供 → 默认 fail-closed）

// 默认 submit 成功返回 trace_id，query 直接返回 done（单轮命中）
function defaultSubmitResult() { return { errcode: 0, errmsg: 'ok', trace_id: 'trace-test-001', status: 'submitted' }; }
function defaultPollResult(suggest) { return { errcode: 0, errmsg: 'ok', status: 'done', suggest }; }

global.wx = {
  getAccountInfoSync() {
    return accountInfo;
  },
  getFileSystemManager() {
    return {
      getFileInfo({ success }) { success({ size: fileSize }); }
    };
  },
  cloud: {
    uploadFile({ cloudPath, filePath, success, fail }) {
      uploadCalls.push({ cloudPath, filePath });
      if (uploadFail) { fail({ errMsg: 'upload fail' }); return; }
      success({ fileID: 'cloud://env-test/xxx' });
    },
    callFunction({ data, success, fail }) {
      callDataLog.push(data);
      if (fnError) { fail(fnError); return; }
      const action = data && data.action;
      if (action === 'query') {
        if (pollError) { fail(pollError); return; }
        success({ result: pollResult || defaultPollResult('pass') });
        return;
      }
      // submit
      success({ result: fnResult || defaultSubmitResult() });
    },
    deleteFile({ fileList, success }) {
      deleteCalls.push(fileList);
      success({});
    }
  }
};

// 重建 cloud 对象（保证引用干净）
function rebuildCloud() {
  delete global.wx.cloud;
  global.wx.cloud = {
    uploadFile({ cloudPath, filePath, success, fail }) {
      uploadCalls.push({ cloudPath, filePath });
      if (uploadFail) { fail({ errMsg: 'upload fail' }); return; }
      success({ fileID: 'cloud://env-test/xxx' });
    },
    callFunction({ data, success, fail }) {
      callDataLog.push(data);
      if (fnError) { fail(fnError); return; }
      const action = data && data.action;
      if (action === 'query') {
        if (pollError) { fail(pollError); return; }
        success({ result: pollResult || defaultPollResult('pass') });
        return;
      }
      success({ result: fnResult || defaultSubmitResult() });
    },
    deleteFile({ fileList, success }) {
      deleteCalls.push(fileList);
      success({});
    }
  };
}
function resetMocks() {
  fileSize = 100 * 1024;
  fnResult = null;
  fnError = null;
  pollResult = null;
  pollError = null;
  uploadFail = false;
  uploadCalls = [];
  deleteCalls = [];
  callDataLog = [];
}
rebuildCloud();

// ============ 用例（默认 fail-closed：accountInfo=null 时 isFailClosedMode()=true） ============
(async () => {
  // 1) pass → 放行（submit → trace_id → 轮询 query → pass）
  pollResult = defaultPollResult('pass');
  let r = await secCheck.checkImageByPath('wxfile://tmp_abc.png', { scene: 4 });
  ok('pass 放行（pass=true）', r.pass === true);
  ok('pass 未被跳过（skipped=false）', r.skipped === false);
  eq('pass suggest 透传', r.suggest, 'pass');
  ok('先 submit 再 query（异步两段）',
    callDataLog.length >= 2 && callDataLog[0].action === 'submit' && callDataLog[1].action === 'query');
  ok('submit 携带 fileID 与 scene', callDataLog[0].fileID === 'cloud://env-test/xxx' && callDataLog[0].scene === 4);
  ok('query 携带 trace_id', callDataLog[1].traceId === 'trace-test-001');
  // P2-6 修复：submit 成功路径云函数不再立即删文件，前端轮询结束后兜底删除 1 次
  //（原「云函数 finally 统一删除」改为「mediaCheckResult 写结果后 + 前端轮询后」双层兜底）
  ok('pass 路径前端兜底删除云存储文件（P2-6 删除时机后移）',
    deleteCalls.length === 1 && deleteCalls[0][0] === 'cloud://env-test/xxx');

  // 2) risky → 拦截（违规）
  pollResult = defaultPollResult('risky');
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('risky 拦截（pass=false）', r.pass === false);
  eq('risky blockType=violation', r.blockType, 'violation');

  // 3) review → 拦截（疑似违规同样不放行，符合审核口径）
  pollResult = defaultPollResult('review');
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('review 拦截（pass=false）', r.pass === false);
  eq('review blockType=violation', r.blockType, 'violation');

  // 4) 云开发通道不可用 → fail-closed 拦截（S2 修复：不再放行）
  delete global.wx.cloud;
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('云不可用 fail-closed 拦截（pass=false）', r.pass === false);
  eq('云不可用 blockType=unavailable', r.blockType, 'unavailable');
  eq('云不可用 不去重 reason', r.reason, 'blocked_cloud_unavailable');
  rebuildCloud();

  // 5) 图片超过检测上限（7MB）→ fail-closed 拦截（S2 修复：不再放行兜底）
  fileSize = 8 * 1024 * 1024;
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('超限 fail-closed 拦截（pass=false）', r.pass === false);
  eq('超限 blockType=size', r.blockType, 'size');
  fileSize = 100 * 1024;

  // 6) 上传失败 → fail-closed 拦截 + 不触发删除（未上传成功无文件可删）
  uploadFail = true;
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('上传失败 fail-closed 拦截（pass=false）', r.pass === false);
  eq('上传失败 blockType=error', r.blockType, 'error');
  eq('上传失败 reason', r.reason, 'blocked_call_failed');
  uploadFail = false;

  // 7) 云函数调用失败 → fail-closed 拦截 + 兜底删除云存储文件
  fnError = { errMsg: 'FunctionName parameter could not be found' };
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('云函数失败 fail-closed 拦截（pass=false）', r.pass === false);
  eq('云函数失败 blockType=error', r.blockType, 'error');
  ok('云函数失败 兜底删除已上传文件', deleteCalls.length === 4 && deleteCalls[3][0] === 'cloud://env-test/xxx');
  // 注：P2-6 后前端在「轮询结束」统一兜底删除——累计 4 = 用例1(pass)/2(risky)/3(review)
  // 的轮询后兜底删 + 本用例 catch 兜底删；fileID 均为同一 mock 固定值
  fnError = null;

  // 8) 云函数 submit 返回非 0 errcode → fail-closed 拦截 + 仍回收已上传文件
  // 8a) 限频 -6 → blockType=rate（提示「操作过于频繁」而非「含违规」）
  fnResult = { errcode: -6, errmsg: 'rate limited' };
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('errcode -6 fail-closed 拦截（pass=false）', r.pass === false);
  eq('errcode -6 blockType=rate', r.blockType, 'rate');
  ok('errcode -6 仍回收已上传文件', deleteCalls.length === 5);
  // 注：累计 5 = 用例1/2/3（轮询后兜底）+ 用例7（catch 兜底）+ 本用例（errcode≠0 回收）
  // 8b) 配额 45009 → blockType=error
  fnResult = { errcode: 45009, errmsg: 'reach max api daily quota limit' };
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('errcode 45009 fail-closed 拦截（pass=false）', r.pass === false);
  eq('errcode 45009 blockType=error', r.blockType, 'error');
  ok('errcode 45009 仍回收已上传文件', deleteCalls.length === 6);
  // 注：累计 6 = 用例1/2/3 + 用例7 + 用例8a + 本用例（均为前端兜底/回收删除）
  fnResult = null;

  // 8c) 轮询超时（query 一直 pending）→ fail-closed 拦截
  //     注入：pollResult 返回 pending 状态，但轮询间隔 mock 为立即执行 → 15 次后超时
  pollResult = { errcode: 0, errmsg: 'ok', status: 'pending' };
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('轮询超时 fail-closed 拦截（pass=false）', r.pass === false);
  eq('轮询超时 blockType=error', r.blockType, 'error');
  pollResult = null;

  // 9) 非法路径 → fail-closed 拦截（pass=false）
  r = await secCheck.checkImageByPath('');
  ok('空路径 fail-closed 拦截（pass=false）', r.pass === false);
  eq('空路径 blockType=error', r.blockType, 'error');
  eq('空路径 reason', r.reason, 'blocked_invalid_path');

  // 10) scene 白名单：非法 scene 回落默认 2（不抛错）
  pollResult = defaultPollResult('pass');
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png', { scene: 99 });
  ok('非法 scene 不抛错并正常放行', r.pass === true);

  // 11) cloudPath 扩展名：按源文件后缀归一化（png/jpg），非法后缀回落 png
  pollResult = defaultPollResult('pass');
  await secCheck.checkImageByPath('wxfile://tmp_abc.JPG');
  ok('cloudPath 使用源文件小写扩展名', /\.jpg$/.test(uploadCalls[uploadCalls.length - 1].cloudPath));
  await secCheck.checkImageByPath('wxfile://tmp_abc.weird');
  ok('非法扩展名回落 png', /\.png$/.test(uploadCalls[uploadCalls.length - 1].cloudPath));

  // ---- develop 环境逃生测试（fail-open）----
  resetMocks();
  accountInfo = { miniProgram: { envVersion: 'develop' } };
  ok('develop 环境 isFailClosedMode()=false', secCheck.isFailClosedMode() === false);
  // 云不可用（develop）→ 放行
  delete global.wx.cloud;
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('develop 云不可用 fail-open 放行（pass=true）', r.pass === true);
  eq('develop 云不可用 reason 不变', r.reason, 'cloud_unavailable');
  rebuildCloud();
  // 超限（develop）→ 放行
  fileSize = 8 * 1024 * 1024;
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('develop 超限 fail-open 放行（pass=true）', r.pass === true);
  fileSize = 100 * 1024;
  // 调用失败（develop）→ 放行
  fnError = { errMsg: 'x' };
  r = await secCheck.checkImageByPath('wxfile://tmp_abc.png');
  ok('develop 调用失败 fail-open 放行（pass=true）', r.pass === true);
  fnError = null;
  // 还原默认环境（fail-closed），以免影响后续
  accountInfo = null;

  // ---- blockMessage 差异化文案 ----
  eq('blockMessage violation 用调用方文案',
    secCheck.blockMessage({ blockType: 'violation' }, '头像含违规信息，请更换后重试'),
    '头像含违规信息，请更换后重试');
  eq('blockMessage size', secCheck.blockMessage({ blockType: 'size' }), '图片过大，请压缩后再试');
  eq('blockMessage rate', secCheck.blockMessage({ blockType: 'rate' }), '操作过于频繁，请稍后再试');
  eq('blockMessage error/unavailable 默认', secCheck.blockMessage({ blockType: 'unavailable' }), '内容安全检测暂不可用，请稍后重试');
  eq('blockMessage 缺省 fallback', secCheck.blockMessage({}), '内容安全检测暂不可用，请稍后重试');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

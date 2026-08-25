/**
 * P2-2 回归：getFileSize 失败（返回 -1）与真实超大文件的错误分类
 *
 * 问题：原实现将 size<0（文件读取失败：临时文件被系统回收/权限不足）
 *       与 size>MAX_IMAGE_BYTES（真实超大文件）合并为同一条 image_too_large 分支，
 *       最终都提示"图片过大，请压缩后再试"。用户遇到文件被回收时按提示操作无效。
 * 修复后：size<0 → resolveFail('file_unreadable', BLOCK_TYPE.ERROR) → 提示"暂不可用，请稍后重试"
 *         size>MAX_IMAGE_BYTES → resolveFail('image_too_large', BLOCK_TYPE.SIZE) → 提示"图片过大，请压缩后再试"
 *
 * 测试环境：release（fail-closed），确保拦截后 blockType 正确
 */
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  const secCheck = require('../utils/secCheck');
  const { BLOCK_TYPE } = secCheck;

  // ① getFileSize 失败（-1）→ BLOCK_TYPE.ERROR
  {
    global.wx = {
      getFileSystemManager() {
        return {
          getFileInfo(opts) {
            setTimeout(() => opts.fail && opts.fail({errMsg: 'file_recovered'}), 0);
          }
        };
      },
      cloud: { uploadFile() {}, callFunction() {}, deleteFile() {} },
      getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; }
    };
    const result = await secCheck.checkImageByPath('/tmp/test.png');
    ok('getFileSize 失败 → pass=false（fail-closed）', result.pass === false);
    ok('getFileSize 失败 → blockType=ERROR（非 SIZE）', result.blockType === BLOCK_TYPE.ERROR);
    ok('getFileSize 失败 → reason=file_unreadable', result.reason === 'blocked_file_unreadable');
  }

  // ② size>MAX_IMAGE_BYTES → BLOCK_TYPE.SIZE
  {
    global.wx = {
      getFileSystemManager() {
        return {
          getFileInfo(opts) {
            setTimeout(() => opts.success && opts.success({size: 8 * 1024 * 1024}), 0);
          }
        };
      },
      cloud: { uploadFile() {}, callFunction() {}, deleteFile() {} },
      getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; }
    };
    const result = await secCheck.checkImageByPath('/tmp/large.png');
    ok('size>MAX → pass=false', result.pass === false);
    ok('size>MAX → blockType=SIZE', result.blockType === BLOCK_TYPE.SIZE);
    ok('size>MAX → reason=image_too_large', result.reason === 'blocked_image_too_large');
  }

  // ③ blockMessage 文案区分
  {
    const msgError = secCheck.blockMessage({blockType: BLOCK_TYPE.ERROR});
    const msgSize = secCheck.blockMessage({blockType: BLOCK_TYPE.SIZE});
    ok('ERROR 文案含"暂不可用"', msgError.indexOf('暂不可用') !== -1);
    ok('SIZE 文案含"压缩"', msgSize.indexOf('压缩') !== -1);
    ok('ERROR 与 SIZE 文案不同', msgError !== msgSize);
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

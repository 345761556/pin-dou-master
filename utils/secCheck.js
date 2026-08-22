// utils/secCheck.js - 内容安全检测模块（对接微信 security.mediaCheckAsync 异步检测）
//
// 背景：微信小程序审核要求「用户可发布/上传内容的场景必须接入内容安全 API」。
// security.mediaCheckAsync 是服务端接口（需 access_token），小程序端无法直接调用；
// 本项目无自建后端，故采用「微信云开发云函数 + 云调用」通道：
//
//   前端 readFile(体积估算) → wx.cloud.uploadFile(云存储) → callFunction('secCheck', {fileID, scene})
//   → 云函数 getTempFileURL 取临时 URL → cloud.openapi.security.mediaCheckAsync(version:2, media.media_url=url)
//   → 返回 trace_id，检测结果经 wxa_media_check 消息推送写入 sec_check_results，前端轮询读取 suggest(pass/review/risky)
//
// 说明：
//   1. wx.cloud.callFunction 的 data 有 100KB 上限，图片必须经云存储中转，不能直接塞 base64。
//   2. 检测结果语义（对用户统一提示「内容含违规信息」，符合审核口径）：
//        - pass    → 放行
//        - review  → 疑似违规，拦截（审核要求违规内容不可发布）
//        - risky   → 明确违规，拦截
//   3. 失败策略（fail-closed，安全优先）：本模块是微信审核要求的内容安全防线，
//      检测链路任何环节未完成（未开通云开发 / 网络异常 / 云函数异常 / 图片超大 / 限频 / 非法路径）
//      一律【默认拦截】而非放行——fail-open 等于没有防线，攻击者可断网、跳过压缩或触发限频
//      稳定绕过检测。仅「开发版 develop」回退 fail-open，便于本地未部署云函数时调试；
//      体验版(trial)/正式版(release)/无法判定环境时强制 fail-closed（真实用户环境防线必须生效）。
//      拦截时按失败类型给出区分提示，避免把「图片过大 / 限频 / 服务暂不可用」误提示成「含违规信息」。

const { log } = require('./security');

// 云函数名称（须与 cloudfunctions/ 目录名一致）
const SEC_CHECK_FN = 'secCheck';

// mediaCheckAsync 媒体上限 10MB（媒体 URL 方式同样受此约束）；
// 原始字节上限取 7MB，留足余量。
// index 与 profile 两条上传路径均已接入 compressImageIfNeeded(≤800px) 前置压缩，
// 正常远小于该值；仅当压缩失败回退原图且原图超大时才可能触发此上限，此时 fail-closed 拦截（提示用户压缩后重试）。
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

// 场景白名单（mediaCheckAsync v2 scene：1=资料 2=评论 3=论坛 4=社交日志）
const SCENE_WHITELIST = [1, 2, 3, 4];

// 图片扩展名白名单（决定云存储路径后缀，与 wx.canvasToTempFilePath 产物一致）
const EXT_WHITELIST = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

// 拦截类型枚举：用于向调用方返回区分化的用户提示文案
const BLOCK_TYPE = {
  VIOLATION: 'violation',     // 微信明确判定违规（review/risky）
  SIZE: 'size',               // 图片超过检测上限（无法送检）
  RATE: 'rate',               // 限频（云函数 errcode -6）
  UNAVAILABLE: 'unavailable', // 云开发通道不可用
  ERROR: 'error'              // 调用/内部异常、非 0 errcode、非法路径等
};

/**
 * 安全门默认 fail-closed（检测未完成即拦截）。
 * 仅「开发版 develop」回退 fail-open，便于本地未部署云函数时调试；
 * 体验版(trial)/正式版(release)/无法判定环境时一律 fail-closed（真实用户环境防线必须生效）。
 * @returns {boolean} true=应 fail-closed（拦截）；false=可 fail-open（放行，仅 develop）
 */
function isFailClosedMode() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getAccountInfoSync === 'function') {
      const info = wx.getAccountInfoSync();
      const env = info && info.miniProgram && info.miniProgram.envVersion;
      if (env === 'develop') return false;
    }
  } catch (e) {
    // 取不到环境信息 → 按最严格（fail-closed）处理
  }
  return true;
}

/**
 * 失败分支统一收敛：默认 fail-closed（拦截并记告警），开发版 fail-open（放行）。
 * @param {string} reason - 失败原因标识（如 cloud_unavailable / image_too_large / errcode_-6）
 * @param {string} blockType - BLOCK_TYPE 枚举值，决定用户提示文案
 * @param {string} [suggest='unknown']
 */
function resolveFail(reason, blockType, suggest = 'unknown') {
  const failClosed = isFailClosedMode();
  if (failClosed) {
    log.error('[secCheck][BLOCKED] 内容安全检测未完成被拦截 reason=' + reason + ' blockType=' + blockType);
    return { pass: false, suggest, skipped: true, reason: 'blocked_' + reason, blockType };
  }
  log.warn('[secCheck] 检测未完成，开发环境降级放行 reason=' + reason);
  return { pass: true, suggest, skipped: true, reason, blockType };
}

/**
 * 拦截时返回给用户的提示文案（按 blockType 区分，避免误导）。
 * @param {Object} result - checkImageByPath 的返回结果
 * @param {string} [violationFallback] - 违规场景的调用方定制文案（如「头像含违规信息」）
 */
function blockMessage(result, violationFallback) {
  const bt = result && result.blockType;
  if (bt === BLOCK_TYPE.VIOLATION) {
    return violationFallback || '内容含违规信息，请更换后重试';
  }
  switch (bt) {
    case BLOCK_TYPE.SIZE: return '图片过大，请压缩后再试';
    case BLOCK_TYPE.RATE: return '操作过于频繁，请稍后再试';
    case BLOCK_TYPE.UNAVAILABLE:
    case BLOCK_TYPE.ERROR:
    default: return '内容安全检测暂不可用，请稍后重试';
  }
}

/**
 * 判断云开发通道是否可用
 * @returns {boolean}
 */
function isCloudAvailable() {
  if (typeof wx === 'undefined' || !wx.cloud) return false;
  if (typeof wx.cloud.uploadFile !== 'function') return false;
  if (typeof wx.cloud.callFunction !== 'function') return false;
  return true;
}

/**
 * 从本地图片路径提取安全扩展名（用于云存储 cloudPath 后缀）
 * @param {string} filePath
 * @returns {string} 归一化小写扩展名，默认 'png'
 */
function extractExt(filePath) {
  const m = /\.([a-z0-9]+)$/i.exec(filePath || '');
  const ext = m ? m[1].toLowerCase() : '';
  return EXT_WHITELIST.indexOf(ext) !== -1 ? ext : 'png';
}

/**
 * 读取本地图片字节数（防御：读不到文件按 0 处理，走后续 base64 兜底）
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getFileSize(filePath) {
  return new Promise((resolve) => {
    try {
      const fs = wx.getFileSystemManager();
      fs.getFileInfo({
        filePath,
        success: (res) => resolve(res && typeof res.size === 'number' ? res.size : 0),
        fail: () => resolve(0)
      });
    } catch (e) {
      resolve(0);
    }
  });
}

/**
 * 上传图片到云存储，返回 fileID
 * @param {string} filePath - 本地图片路径（tempFilePath / USER_DATA_PATH 均可）
 * @returns {Promise<string>}
 */
function uploadToCloud(filePath) {
  const cloudPath = `sec_check/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${extractExt(filePath)}`;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      // 显式超时 30s（R2 教训）：客户端默认 20s，云存储上传在弱网/大图时可能触顶；
      // 超时走 fail → reject → checkImageByPath catch → fail-closed 拦截。
      timeout: 30000,
      success: (res) => {
        log.info('[secCheck] uploadFile 耗时 ' + (Date.now() - t0) + 'ms');
        if (res && res.fileID) resolve(res.fileID);
        else reject(new Error('upload_no_fileid'));
      },
      fail: (err) => reject(err)
    });
  });
}

/**
 * 调用云函数执行内容安全检测（mediaCheckAsync 异步提交，返回 trace_id）
 * @param {string} fileID - 云存储文件 ID
 * @param {number} scene - 场景（1资料 2评论 3论坛 4社交日志）
 * @returns {Promise<{trace_id?: string, errcode?: number, errmsg?: string}>}
 */
function callSecCheckFn(fileID, scene) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    wx.cloud.callFunction({
      name: SEC_CHECK_FN,
      data: { action: 'submit', type: 'image', scene, fileID },
      // 显式超时 30s（R2 教训）：客户端默认 20s，云函数冷启动 + 换临时 URL + 提交检测可能逼近/超过该值；
      // 超时走 fail → reject → checkImageByPath catch → fail-closed 拦截。
      timeout: 30000,
      success: (res) => {
        log.info('[secCheck] callFunction(submit) 耗时 ' + (Date.now() - t0) + 'ms');
        const result = res && res.result;
        if (!result || typeof result !== 'object') {
          reject(new Error('sec_check_no_result'));
          return;
        }
        resolve(result);
      },
      fail: (err) => reject(err)
    });
  });
}

/**
 * 轮询查询 mediaCheckAsync 异步检测结果（按 trace_id）
 * @param {string} traceId - 提交时返回的 trace_id
 * @param {number} [maxAttempts=20] - 最大轮询次数（每次间隔 1s，共约 20s；官方承诺 30 分钟内推送，
 *                                    实测 5-10s 出结果；缩短至 20s 可在推送异常（如未配置 mediaCheckResult）
 *                                    时更快 fail-closed 拦截，避免用户长时间卡死等待）
 * @param {number} [intervalMs=1000] - 轮询间隔
 * @returns {Promise<{suggest: string}>} resolve 出结果；超时 reject
 */
function pollSecCheckResult(traceId, maxAttempts = 20, intervalMs = 1000) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = () => {
      attempt += 1;
      wx.cloud.callFunction({
        name: SEC_CHECK_FN,
        data: { action: 'query', traceId },
        timeout: 10000,
        success: (res) => {
          const result = res && res.result;
          if (result && result.errcode === 0 && result.status === 'done' && result.suggest) {
            log.info('[secCheck] 轮询命中 attempt=' + attempt + ' suggest=' + result.suggest);
            resolve({ suggest: result.suggest });
            return;
          }
          if (attempt >= maxAttempts) {
            log.warn('[secCheck] 轮询超时（' + maxAttempts + ' 次）trace_id=' + traceId);
            reject(new Error('sec_check_poll_timeout'));
            return;
          }
          setTimeout(tick, intervalMs);
        },
        fail: (err) => {
          if (attempt >= maxAttempts) {
            reject(err || new Error('sec_check_poll_failed'));
            return;
          }
          setTimeout(tick, intervalMs);
        }
      });
    };
    tick();
  });
}

/**
 * 删除云存储文件（兜底清理：仅当云函数未能自删时调用）
 * @param {string} fileID
 * @returns {Promise<void>}
 */
function deleteCloudFile(fileID) {
  return new Promise((resolve) => {
    try {
      wx.cloud.deleteFile({
        fileList: [fileID],
        success: () => resolve(),
        fail: () => resolve()
      });
    } catch (e) {
      resolve();
    }
  });
}

/**
 * 图片内容安全检测主入口
 *
 * @param {string} filePath - 待检测的本地图片路径（建议传压缩后路径，体积小、检测快）
 * @param {Object} [options]
 * @param {number} [options.scene=2] - 内容场景（1资料 2评论 3论坛 4社交日志）
 * @returns {Promise<{pass: boolean, suggest: string, skipped: boolean, reason?: string, blockType?: string}>}
 *   - pass:    是否放行（true=可继续使用）
 *   - suggest: 微信返回的检测建议（pass/review/risky/unknown）
 *   - skipped: true 表示本次未实际完成检测（通道不可用/异常/超限/限频/非法路径）
 *   - blockType: 拦截类型（BLOCK_TYPE 枚举），供 blockMessage 生成差异化提示
 *   注：失败分支默认 fail-closed（pass=false，拦截），仅 develop 环境 fail-open。
 */
function checkImageByPath(filePath, options = {}) {
  const scene = SCENE_WHITELIST.indexOf(options.scene) !== -1 ? options.scene : 2;

  return new Promise((resolve) => {
    // 前置守卫：路径合法性 + 云通道可用性，任一不满足即按 fail-closed 拦截
    if (!filePath || typeof filePath !== 'string') {
      resolve(resolveFail('invalid_path', BLOCK_TYPE.ERROR));
      return;
    }
    if (!isCloudAvailable()) {
      resolve(resolveFail('cloud_unavailable', BLOCK_TYPE.UNAVAILABLE));
      return;
    }

    // 异步主流程抽离为独立函数，避免 async executor 反模式
    const run = async () => {
      let fileID = '';
      try {
        // 1) 体积守卫：超限图片无法送检（mediaCheckAsync 媒体上限 10MB，原始字节取 7MB 余量）。
        //    fail-closed 拦截（而非放行兜底）：>7MB 本就无法送审，放行等于跳过检测；
        //    前端 compressImageIfNeeded(≤800px) 已在前置压缩，正常远小于该值，
        //    触发此分支多为压缩失败回退原图且原图超大，应提示用户压缩后重试。
        const size = await getFileSize(filePath);
        if (size > MAX_IMAGE_BYTES) {
          return resolveFail('image_too_large', BLOCK_TYPE.SIZE);
        }

        // 2) 上传云存储 → 云函数提交检测（mediaCheckAsync 异步，返回 trace_id）
        fileID = await uploadToCloud(filePath);
        const result = await callSecCheckFn(fileID, scene);

        // 3) 解析提交结果：errcode 非 0 视为检测通道异常 → fail-closed 拦截。
        //    限频(-6)属设计内常态路径，单独标为 BLOCK_TYPE.RATE（提示「操作过于频繁」而非「含违规」）。
        if (result.errcode != null && result.errcode !== 0) {
          log.warn('[secCheck] 云函数提交异常 errcode=' + result.errcode + ' errmsg=' + (result.errmsg || ''), result);
          // 回收已上传的云存储文件（拦截后仍删，隐私 + 配额清理不变；deleteFile 幂等安全）。
          const blockType = (result.errcode === -6) ? BLOCK_TYPE.RATE : BLOCK_TYPE.ERROR;
          if (fileID) {
            await deleteCloudFile(fileID);
          }
          return resolveFail('errcode_' + result.errcode, blockType);
        }

        // 4) 提交成功：持有 trace_id 轮询异步检测结果（mediaCheckAsync 为异步接口，
        //    结果通过 wxa_media_check 推送写入 sec_check_results，本处轮询 secCheck(action=query) 读取）。
        const traceId = result.trace_id;
        if (!traceId) {
          log.error('[secCheck] 提交成功但无 trace_id，拦截（fail-closed）:', result);
          if (fileID) await deleteCloudFile(fileID);
          return resolveFail('no_trace_id', BLOCK_TYPE.ERROR);
        }

        let pollResult;
        try {
          pollResult = await pollSecCheckResult(traceId);
        } catch (pollErr) {
          // 5) 轮询超时/失败：检测未在预期窗口完成 → fail-closed 拦截（无法确认安全即拒绝）。
          log.warn('[secCheck] 异步检测结果轮询失败（fail-closed 拦截）:', pollErr);
          // P2-6 修复：轮询结束（无论成败）兜底删除云存储中转文件——submit 成功路径的
          // 云函数已不再立即删文件（避免与异步检测下载竞态），此处为前端第一层兜底；
          // mediaCheckResult 写入最终结果后另有云函数侧兜底删除，双层保证「图片不残留」。
          await deleteCloudFile(fileID);
          return resolveFail('poll_failed', BLOCK_TYPE.ERROR);
        }

        // P2-6 修复：检测已完成，统一在前端兜底删除云存储中转文件
        // （mediaCheckResult 侧删除失败时由此补删；deleteCloudFile 内部吞错、幂等安全）
        await deleteCloudFile(fileID);

        // fail-closed 口径：suggest 缺失/空 → 按无法确认安全处理（走 unknown → 拦截），
        // 绝不默认 'pass'（否则防御默认值方向与全模块 fail-closed 教义相悖，见 R1 教训）
        const suggest = (pollResult.suggest || '').toLowerCase();
        log.info('[secCheck] 检测完成 suggest=' + suggest + ' scene=' + scene);
        // pass 放行；review/risky 一律拦截（对用户仅提示「含违规信息」，不展示细节）
        return {
          pass: suggest === 'pass',
          suggest: ['pass', 'review', 'risky'].indexOf(suggest) !== -1 ? suggest : 'unknown',
          skipped: false,
          blockType: BLOCK_TYPE.VIOLATION
        };
      } catch (err) {
        // 6) 调用异常（网络/云环境未开通/云函数未部署）→ fail-closed 拦截，记告警便于排查
        log.error('[secCheck] 图片检测调用失败，拦截（fail-closed）:', err);
        if (fileID) {
          await deleteCloudFile(fileID); // 兜底清理已上传文件，避免云存储垃圾堆积
        }
        return resolveFail('call_failed', BLOCK_TYPE.ERROR);
      }
    };

    run().then(resolve, (e) => {
      // 极端兜底：run 自身抛错（理论上不会，防御性处理）
      log.error('[secCheck] 检测流程异常，拦截（fail-closed）:', e);
      resolve(resolveFail('internal_error', BLOCK_TYPE.ERROR));
    });
  });
}

/**
 * 文本内容安全检测云函数调用（msgSecCheck v2 同步接口，P1-1 昵称接入）
 * @param {string} content - 待检文本
 * @returns {Promise<{errcode?: number, suggest?: string, errmsg?: string}>}
 */
function callSecCheckText(content) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: SEC_CHECK_FN,
      data: { action: 'text', content },
      // 文本检测为同步接口（无需上传/轮询），15s 已远超正常耗时；
      // 超时走 fail → reject → checkText catch → fail-closed 拦截。
      timeout: 15000,
      success: (res) => {
        const result = res && res.result;
        if (!result || typeof result !== 'object') {
          reject(new Error('sec_check_no_result'));
          return;
        }
        resolve(result);
      },
      fail: (err) => reject(err)
    });
  });
}

// 文本长度上限（与云函数 text 分支一致：昵称保存前已截断到 20 字符，此处留余量到 50）
const MAX_TEXT_LENGTH = 50;

/**
 * 文本内容安全检测主入口（昵称等 UGC 文本，对接 msgSecCheck v2）。
 *
 * 失败策略与图片链路完全同口径：fail-closed（通道不可用/异常/非法入参一律拦截，
 * 仅 develop 环境 fail-open 放行），保证「文本防线」与「图片防线」强度一致，
 * 不给审核留下「文本可绕过、图片不可绕过」的口径不一致漏洞。
 *
 * @param {string} content - 待检文本
 * @returns {Promise<{pass: boolean, suggest: string, skipped: boolean, reason?: string, blockType?: string}>}
 *   返回结构与 checkImageByPath 一致，可直接复用 blockMessage 生成差异化提示。
 */
function checkText(content) {
  return new Promise((resolve) => {
    // 前置守卫：入参合法性 + 云通道可用性（与 checkImageByPath 同款守卫顺序）
    if (!content || typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_TEXT_LENGTH) {
      resolve(resolveFail('invalid_text', BLOCK_TYPE.ERROR));
      return;
    }
    if (!isCloudAvailable()) {
      resolve(resolveFail('cloud_unavailable', BLOCK_TYPE.UNAVAILABLE));
      return;
    }
    callSecCheckText(content).then((result) => {
      // 云函数返回非 0 errcode 视为检测通道异常 → fail-closed；限频(-6)单独标注差异化文案
      if (result.errcode != null && result.errcode !== 0) {
        log.warn('[secCheck] 文本检测云函数异常 errcode=' + result.errcode + ' errmsg=' + (result.errmsg || ''));
        const blockType = (result.errcode === -6) ? BLOCK_TYPE.RATE : BLOCK_TYPE.ERROR;
        resolve(resolveFail('text_errcode_' + result.errcode, blockType));
        return;
      }
      const suggest = (result.suggest || '').toLowerCase();
      // 仅 pass 放行；review/risky/未知建议一律拦截（与图片链路口径一致，不展示细节）
      if (suggest !== 'pass') {
        resolve({
          pass: false,
          suggest: ['pass', 'review', 'risky'].indexOf(suggest) !== -1 ? suggest : 'unknown',
          skipped: false,
          blockType: BLOCK_TYPE.VIOLATION
        });
        return;
      }
      resolve({ pass: true, suggest, skipped: false });
    }).catch((err) => {
      // 调用异常（网络/云环境未开通/云函数未部署）→ fail-closed 拦截
      log.error('[secCheck] 文本检测调用失败，拦截（fail-closed）:', err);
      resolve(resolveFail('text_call_failed', BLOCK_TYPE.ERROR));
    });
  });
}

module.exports = {
  checkImageByPath,
  checkText,
  isCloudAvailable,
  isFailClosedMode,
  blockMessage,
  BLOCK_TYPE,
  SEC_CHECK_FN,
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  SCENE_WHITELIST
};

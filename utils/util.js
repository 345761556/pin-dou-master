/**
 * 工具函数集合
 */

// 安全工具：路径合法性校验（防路径遍历等注入）+ 统一脱敏日志
const { isValidFilePath, log } = require('./security');

// ==================== 全局常量定义 ====================

/**
 * 常量配置
 * 统一管理 magic number，便于维护和修改
 */
const CONSTANTS = {
  // 存储限制
  MAX_HISTORY: 50,           // 历史记录最大条数
  MAX_STORAGE_TRY: 10,       // 存储失败重试次数

  // 模板生成限制
  MAX_PIXELS: 8000,          // 模板行列乘积上限
  MAX_ROWS: 120,             // 最大行数
  MAX_COLS: 120,             // 最大列数
  DEFAULT_COLS: 50,          // 默认列数
  MIN_COLS: 20,              // 最小列数（与 index.wxml 模板宽度 slider 的 min 保持一致）
  DEFAULT_BEAD_SIZE: 29,      // 默认拼豆尺寸(mm)
  DEFAULT_COLOR_COUNT: 30,    // 默认颜色数量
  MIN_COLOR_COUNT: 2,         // 最少颜色数量
  MAX_COLOR_COUNT: 50,        // 最多颜色数量

  // 图片处理
  DEFAULT_IMAGE_SIZE: 800,    // 默认图片最大边长
  COMPRESS_QUALITY: 0.9,     // 压缩质量
  SAMPLE_PIXELS: 5000,       // 颜色量化采样像素数

  // 图片上传校验
  MAX_IMAGE_FILE_SIZE: 10 * 1024 * 1024,  // 图片文件大小上限 10MB
  MAX_IMAGE_DIMENSION: 6000,               // 图片宽/高上限 6000px
  VALID_IMAGE_TYPES: ['jpg', 'jpeg', 'png', 'webp'],  // 允许的图片格式

  // 性能优化
  DEBOUNCE_DELAY: 300,       // 防抖延迟(ms)
  THROTTLE_INTERVAL: 300,     // 节流间隔(ms)

  // 路由限制
  MAX_PAGE_STACK: 9,          // 页面栈深度上限，超过则用 redirectTo

  // Canvas 导出
  EXPORT_QUALITY: 1.0        // 导出质量
  // 注：导出画布「维度上限」已迁至 pages/template/template.js 的 MAX_CANVAS_SIDE（=4096），
  // 与 utils/beadEngine.js 的 DIM_HARD=4096 同源。此处不再保留 EXPORT_MAX_SIDE，
  // 避免「死常量 2048」与真实上限 4096 数值矛盾导致改一处漏另一处的漂移。
};

// 兼容旧写法（导出为独立变量，便于直接引用）
const MAX_HISTORY = CONSTANTS.MAX_HISTORY;
const MAX_PIXELS = CONSTANTS.MAX_PIXELS;
const MAX_ROWS = CONSTANTS.MAX_ROWS;

/**
 * 格式化毫米为厘米，并保留合理精度
 */
function formatMm(mm) {
  // 防御：确保输入是有效数字
  if (typeof mm !== 'number' || isNaN(mm) || mm < 0) {
    return '-';
  }
  if (mm >= 1000) {
    return (mm / 10).toFixed(1) + ' cm';
  }
  return mm + ' mm';
}

/**
 * 格式化大数字（加逗号分隔）
 */
function formatNumber(num) {
  if (num == null || !isFinite(num)) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 展示用数值钳制：把可能由脏历史记录引入的异常大数/非法值收敛到 [0, max]，
 * 防止顶部信息栏/卡片显示 1e20 这类超长逗号串（属展示层脏数据防护，与业务逻辑无关）。
 * 非有限值/负数归零；超过上限截断为上限位——合法数据（≤上限）显示完全不受影响。
 * @param {number} value
 * @param {number} max 显示上限（取合法数据不可能超过的宽松值）
 * @returns {number}
 */
function clampDisplayNumber(value, max) {
  const n = Number(value);
  const m = Number(max);
  // max 自身必须是有限非负数，否则钳制失去意义：
  // - max=NaN 时 `n > max` 恒为 false，会原样返回未经钳制的 n（违背收敛目的）；
  // - max<0 时 `n > max` 恒为 true（n≥0），会返回负数上限（违背 [0,max] 契约）。
  // 与 value 非法同口径，统一归零，避免展示层出现负数/未收敛脏值。
  if (!isFinite(m) || m < 0) return 0;
  if (!isFinite(n) || n < 0) return 0;
  if (n > m) return m;
  return n;
}

/**
 * 防抖
 */
function debounce(fn, delay = 300) {
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, delay);
  };
  wrapped.cancel = cancel;
  return wrapped;
}

/**
 * 节流
 */
function throttle(fn, interval = 300) {
  let lastTime = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastTime >= interval) {
      lastTime = now;
      fn.apply(this, args);
    }
  };
}

/**
 * 保存图片到相册
 *
 * 完整流程：
 * 1. 参数 & 文件校验
 * 2. 隐私协议授权由 app.js 的 wx.onNeedPrivacyAuthorization 全局 handler 统一处理
 *    （wx.saveImageToPhotosAlbum 触发授权需求时微信自动回调，用户同意后自动重试保存）
 * 3. 检查相册权限（wx.getSetting scope.writePhotosAlbum）
 *    - 已拒绝 → 引导去设置页；其他 → 直接保存
 * 4. 执行 wx.saveImageToPhotosAlbum
 */
function saveImageToAlbum(filePath) {
  return new Promise(function(resolve, reject) {
    // 参数校验
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      reject(new Error('invalid_file_path'));
      return;
    }

    // 检查文件是否存在（防御性检查）
    try {
      const fs = wx.getFileSystemManager();
      try {
        fs.accessSync(filePath);
      } catch (accessErr) {
        log.error('[saveImageToAlbum] file not exist:', filePath, accessErr);
        reject(new Error('文件不存在或已失效'));
        return;
      }
    } catch (e) {
      log.warn('[saveImageToAlbum] accessSync check failed, proceed anyway:', e);
    }

    // 隐私协议授权统一由 app.js 的 wx.onNeedPrivacyAuthorization 全局 handler 处理：
    // 当 wx.saveImageToPhotosAlbum 需要隐私授权时，微信会自动回调该全局 handler，
    // 用户同意后微信自动重试保存。此处不再重复调用 requirePrivacyAuthorize，
    // 避免与全局 handler 冲突导致双重弹窗或 privacy api 报错。

    // Step 2: 检查相册权限
    function checkAlbumPermission() {
      wx.getSetting({
        success: function(settingRes) {
          const hasAuth = settingRes.authSetting['scope.writePhotosAlbum'];

          if (hasAuth === false) {
            // 用户曾明确拒绝过，引导去设置页
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中开启「保存图片到相册」权限',
              confirmText: '去设置',
              cancelText: '取消',
              success: function(modalRes) {
                if (modalRes.confirm) {
                  wx.openSetting({
                    success: function(openRes) {
                      if (openRes.authSetting['scope.writePhotosAlbum']) {
                        doSave();
                      } else {
                        reject(new Error('权限未开启'));
                      }
                    },
                    fail: function() { reject(new Error('无法打开设置')); }
                  });
                } else {
                  reject(new Error('user_cancel'));
                }
              }
            });
          } else {
            // 已授权或未决定，直接保存（系统会弹出权限框）
            doSave();
          }
        },
        fail: function() {
          // getSetting 失败，直接保存兜底
          log.warn('[saveImageToAlbum] getSetting failed, try direct save');
          doSave();
        }
      });
    }

    // Step 3: 执行保存
    function doSave() {
      wx.saveImageToPhotosAlbum({
        filePath: filePath,
        success: function() {
          log.info('[saveImageToAlbum] save success');
          resolve();
        },
        fail: function(err) {
          const errMsg = (err && (err.errMsg || '')) || '';
          const msgLower = errMsg.toLowerCase();

          log.error('[saveImageToAlbum] save failed:', errMsg);

          // 用户取消了权限对话框
          if (msgLower.indexOf('cancel') >= 0) {
            reject(new Error('user_cancel'));
            return;
          }

          // 权限被拒绝（包括正式版的隐私相关拒绝）
          if (msgLower.indexOf('auth deny') >= 0 ||
              msgLower.indexOf('authorize') >= 0 ||
              msgLower.indexOf('privacy') >= 0) {
            reject(new Error('auth_deny'));
            return;
          }

          // 文件路径无效
          if (msgLower.indexOf('invalid file') >= 0 || msgLower.indexOf('not found') >= 0) {
            reject(new Error('save_failed:文件路径无效'));
            return;
          }

          // 其他错误
          reject(new Error('save_failed:' + errMsg));
        }
      });
    }

    // 入口：直接进入相册权限检查（隐私授权由全局 handler 处理）
    checkAlbumPermission();
  });
}

/**
 * Canvas 导出为临时图片
 * @param {Object} canvas - canvas 节点
 * @param {number} x - 裁剪起点 x
 * @param {number} y - 裁剪起点 y
 * @param {number} width - 裁剪宽度
 * @param {number} height - 裁剪高度
 * @param {number} destWidth - 目标输出宽度（像素），用于高清导出
 * @param {number} destHeight - 目标输出高度（像素），用于高清导出
 */
function canvasToImage(canvas, x, y, width, height, destWidth, destHeight) {
  return new Promise((resolve, reject) => {
    // 防御：校验 canvas 尺寸，防止过大导致导出失败
    if (!width || !height || width < 1 || height < 1) {
      reject(new Error('canvas_size_invalid'));
      return;
    }
    if (!destWidth || !destHeight || destWidth < 1 || destHeight < 1) {
      reject(new Error('dest_size_invalid'));
      return;
    }

    wx.canvasToTempFilePath({
      canvas,
      x,
      y,
      width,
      height,
      destWidth,
      destHeight: destHeight || destWidth,
      fileType: 'png',
      quality: 1,
      success: res => {
        // 防御：检查返回的路径是否有效
        if (!res || !res.tempFilePath) {
          reject(new Error('canvas_export_empty'));
          return;
        }
        // 安全校验：导出路径需为合法来源（系统临时路径，正常必通过；此处为护栏）
        if (!isValidFilePath(res.tempFilePath)) {
          reject(new Error('canvas_export_path_invalid'));
          return;
        }
        resolve(res.tempFilePath);
      },
      fail: err => {
        // 将微信原生错误转换为可识别错误
        const errMsg = (err && (err.errMsg || '')) || '';
        log.error('[canvasToImage] canvasToTempFilePath failed:', errMsg, 'size:', width, 'x', height);
        // 统一转换为 canvas_export_failed，供调用方识别
        reject(new Error('canvas_export_failed:' + errMsg));
      }
    });
  });
}

/**
 * 获取拼豆规格预设
 */
function getBeadSizePresets() {
  return [
    { label: '5mm 迷你拼豆', value: 5, desc: '精细图案，材料需求大' },
    { label: '10mm 小拼豆', value: 10, desc: '儿童入门首选' },
    { label: '29mm 标准拼豆', value: 29, desc: '经典尺寸，最常用' },
    { label: '50mm 大拼豆', value: 50, desc: '简单图案，快速完成' }
  ];
}

/**
 * 图片压缩与尺寸限制
 * 防止大图导致算法卡顿或内存溢出
 * @param {string} imagePath - 图片临时路径
 * @param {number} maxSide - 最大边长（px），默认 800
 * @returns {Promise<{tempFilePath: string, width: number, height: number}>}
 *          成功时返回压缩后（或原图，当边长未超限）路径；
 *          当 Canvas 节点不可用时，resolve 原始路径（带真实 width/height）——此为有意设计：
 *          无 Canvas 则无法在端内缩放，调用方（index 的 readImageSize / profile 的 fallback）会读取
 *          真实尺寸，且 beadEngine.generateTemplate 有 6000px 硬上限兜底，不会静默传入错误维度；
 *          当图片解码(img.onerror)或 canvas 导出(wx.canvasToTempFilePath fail)失败时 reject
 *          （错误码 image_compress_failed），由调用方统一回退到原图路径。
 */
function compressImageIfNeeded(imagePath, maxSide = 800) {
  return new Promise((resolve, reject) => {
    // 安全校验：用户选择的图片路径需为合法来源（拦截路径遍历等注入）。
    // chooseMedia 返回的是系统临时路径（wxfile://），正常必通过；此处为防御性前置校验。
    if (!isValidFilePath(imagePath)) {
      reject(new Error('invalid_image_path'));
      return;
    }
    getImageInfoWithTimeout(imagePath).then((info) => {
      const { width, height } = info;
      const longestSide = Math.max(width, height);

      // 情况一：原图边长未超限，直接安全使用。
      // 此时 imagePath 刚经 getImageInfo 成功读取，必为存活路径，无需压缩。
      if (longestSide <= maxSide) {
        resolve({ tempFilePath: imagePath, width, height });
        return;
      }

      // 计算缩放比例
      const ratio = maxSide / longestSide;
      const newWidth = Math.round(width * ratio);
      const newHeight = Math.round(height * ratio);

      // 压缩后保存为临时文件
      const query = wx.createSelectorQuery();
      query.select('#__compress-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res[0] || !res[0].node) {
            // Canvas 不可用时，直接返回原始路径（保留 alpha，与未压缩分支一致）。
            // 注意：wx.compressImage 默认输出 JPG 会丢失 alpha、把透明区压成黑底，
            // 与「透明=空位」(BUG-6) 语义冲突，故此处不调用它，宁可不做尺寸压缩也不产出黑底。
            // 此分支 resolve 原始路径是有意设计（非"静默退化"）：调用方会读取真实 width/height
            // （index 经 readImageSize、profile 直接回退原图路径），且下游 beadEngine.generateTemplate
            // 有 6000px 硬上限兜底；正常流程中 #__compress-canvas 节点必存在（index.wxml/profile.wxml），
            // 此分支仅在节点未就绪/被卸载等异常时序触发，属极低概率回退。
            resolve({ tempFilePath: imagePath, width, height });
            return;
          }

          const canvas = res[0].node;
          canvas.width = newWidth;
          canvas.height = newHeight;
          const ctx = canvas.getContext('2d');

          const img = canvas.createImage();
          img.onload = () => {
            // 输出 PNG 而非 JPG：JPG 无 alpha 通道，会把透明区域压成黑色底，
            // 导致透明背景 LOGO/贴纸类图片出现黑块，且与「透明=空位」(BUG-6) 语义冲突；
            // 保留 alpha 后下游 generateTemplate 才能正确把透明区当作空位。
            ctx.drawImage(img, 0, 0, newWidth, newHeight);
            wx.canvasToTempFilePath({
              canvas,
              x: 0, y: 0,
              width: newWidth,
              height: newHeight,
              destWidth: newWidth,
              destHeight: newHeight,
              fileType: 'png',
              quality: 0.9,
              success: (r) => resolve({ tempFilePath: r.tempFilePath, width: newWidth, height: newHeight }),
              // 情况二：canvas 导出失败，同上，明确 reject 而非静默回退超限原图。
              fail: () => reject(new Error('image_compress_failed'))
            });
          };
          // 情况二：图片解码失败，同上，明确 reject 而非静默回退超限原图。
          img.onerror = () => reject(new Error('image_compress_failed'));
          img.src = imagePath;
        });
    }, () => reject(new Error('获取图片信息失败')));
  });
}

/**
 * 计算安全的最大模板行列数（单一钳制入口）
 * 同时限制「像素乘积上限」与「最大行数」，供 generateTemplate 与 updateEstimate 共用，
 * 避免两处各自维护同一套算法导致改上限时漏改。
 * @param {number} cols - 原始列数
 * @param {number} rows - 原始行数
 * @param {number} [maxPixels=8000] - 行列乘积上限
 * @param {number} [maxRows=0] - 最大行数；<=0 表示不限制（向后兼容旧调用）
 * @param {number} [aspect=0] - 宽高比 height/width；用于行数钳制后按宽高比重算列数
 * @returns {{cols:number, rows:number}}
 */
function clampTemplateSize(cols, rows, maxPixels = CONSTANTS.MAX_PIXELS, maxRows = 0, aspect = 0) {
  // 防御：确保输入是有效正整数
  cols = Math.max(1, Math.floor(cols) || 1);
  rows = Math.max(1, Math.floor(rows) || 1);
  maxPixels = Math.max(1, Math.floor(maxPixels) || 8000);
  if (maxRows > 0) maxRows = Math.max(1, Math.floor(maxRows));

  // 1) 像素乘积钳制（sqrt 缩放 + floor，与实际生成算法一致）
  if (cols * rows > maxPixels) {
    const ratio = rows / cols;
    if (ratio > 0) {
      cols = Math.max(1, Math.floor(Math.sqrt(maxPixels / ratio)));
      rows = Math.max(1, Math.floor(cols * ratio));
    } else {
      rows = 1;
      cols = Math.min(cols, Math.floor(maxPixels));
    }
  }

  // 2) 最大行数钳制（与实际生成算法一致：限制行数后按宽高比重算列数，并复查像素上限）
  if (maxRows > 0 && rows > maxRows) {
    rows = maxRows;
    if (aspect > 0) {
      cols = Math.max(1, Math.round(rows / aspect));
    } else {
      cols = 1;
    }
    // 再次校验像素上限：此时 rows 已被 maxRows 固定，乘积要 ≤ maxPixels 只能缩 cols。
    // 正确公式为 cols = floor(maxPixels / rows)（满足 cols*rows ≤ maxPixels 的最大整数列数）；
    // 触发时必有 cols*rows > maxPixels ⇒ cols > maxPixels/rows，故新 cols 必然 ≤ 当前 cols，不会放大列数。
    if (cols * rows > maxPixels) {
      cols = Math.max(1, Math.floor(maxPixels / rows));
      // 极端退化（maxPixels < rows）：cols 已到最小值 1 仍超限时，只能进一步缩 rows，
      // 保证「cols*rows ≤ maxPixels」的像素上限不变式始终成立（rows 仍 ≤ maxRows）。
      if (cols * rows > maxPixels) {
        rows = Math.max(1, Math.floor(maxPixels / cols));
      }
    }
  }

  return { cols, rows };
}

/**
 * 安全读取历史记录数组。
 * 模板历史存储若被脏数据（string/object）污染，getStorageSync 会返回非数组，
 * 直接 .map/.reduce/.unshift 会抛错导致页面白屏；用 Array.isArray 判空，
 * 避免单点脏数据拖垮整个页面。
 * @returns {Array}
 */
function getTemplateHistory() {
  try {
    const raw = wx.getStorageSync('template_history');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    // 存储损坏或基础库异常：返回空数组，避免 gallery/index/profile 等页面崩溃。
    log.warn('读取 template_history 失败，已降级为空数组:', e);
    return [];
  }
}

/**
 * 带超时的 wx.getImageInfo 封装（R2 教训延伸）：
 * wx.getImageInfo 没有 timeout 参数，在开发者工具 Windows 模拟器上对 wxfile:// / http://tmp/
 * 本地路径可能挂起且不触发 fail 回调 → 框架层裸报 "Error: timeout"，业务日志打不出来。
 * 用 Promise.race 兜底：超时按「读取失败」处理（fail-closed），调用方走既有失败分支（toast + 拒绝），
 * 而不是让框架层抛未处理 timeout。
 * @param {string} src 图片路径
 * @param {number} [timeoutMs=10000] 超时毫秒
 * @returns {Promise<Object>} getImageInfo 的 info
 */
function getImageInfoWithTimeout(src, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('image_info_timeout'));
    }, timeoutMs);
    wx.getImageInfo({
      src,
      success: (info) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(info);
      },
      fail: (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err || new Error('get_image_info_failed'));
      }
    });
  });
}

/**
 * 校验用户选择的图片文件
 * 同步校验：文件大小、格式
 * 异步校验：图片尺寸（需要 wx.getImageInfo）
 * @param {Object} tempFile - wx.chooseMedia 返回的文件对象 { tempFilePath, size, fileType }
 * @returns {Promise<boolean>} 校验是否通过
 */
function validateImageFile(tempFile) {
  // 同步校验：文件类型
  if (tempFile.fileType !== 'image') {
    wx.showToast({ title: '请选择图片文件', icon: 'none' });
    return Promise.resolve(false);
  }

  // 同步校验：文件大小
  if (tempFile.size > CONSTANTS.MAX_IMAGE_FILE_SIZE) {
    wx.showToast({ title: '图片不能超过10MB', icon: 'none' });
    return Promise.resolve(false);
  }

  // 说明：此处刻意不做「基于临时路径扩展名」的格式校验。
  // chooseMedia 在部分平台/基础库返回的临时路径不带扩展名（wxfile://tmp_xxx / http://tmp/xxx），
  // 若按 split('.') 取扩展名会把这类合法图片全部拒绝——与项目自身 BUG-20 兜底
  // （index.js:441 无扩展名回退 png）自相矛盾，且会导致核心选图流程在真机断裂。
  // 真实格式校验由下方 getImageInfo().type 白名单完成（已覆盖 GIF 伪装 .png 等场景），
  // 扩展名检查纯属冗余且脆弱，故移除。

  // 异步校验：图片尺寸 + 真实格式（带超时：模拟器上 getImageInfo 可能挂起不回调，
  // 超时按 fail-closed 拒绝，避免框架层裸 "Error: timeout"）
  return new Promise((resolve) => {
    getImageInfoWithTimeout(tempFile.tempFilePath).then((info) => {
      // 真实格式校验（防御 GIF 等重命名为 .png 的情况；基于文件内容而非路径扩展名）
      const realType = (info.type || '').toLowerCase();
      // 'unknown' 为微信无法判定图片格式（合法但库不识别，官方 type 有效值之一），按无法验证处理放行；
      // 仅当真实已知格式且不在白名单时才拒绝，避免误拒合法图片（见 L9 修复）。常量本身不动。
      if (realType && realType !== 'unknown' && !CONSTANTS.VALID_IMAGE_TYPES.includes(realType)) {
        wx.showToast({ title: '不支持 ' + realType.toUpperCase() + ' 格式', icon: 'none' });
        resolve(false);
        return;
      }
      if (info.width > CONSTANTS.MAX_IMAGE_DIMENSION || info.height > CONSTANTS.MAX_IMAGE_DIMENSION) {
        wx.showToast({ title: '图片尺寸不能超过6000px', icon: 'none' });
        resolve(false);
        return;
      }
      resolve(true);
    }, () => {
      // 读取失败或超时：校验闸门 fail-closed —— 无法验证即拒绝。
      wx.showToast({ title: '图片读取失败，请重试', icon: 'none' });
      resolve(false);
    });
  });
}

/**
 * 计算占比百分比（0-100），不存在除零风险
 * @param {number} part - 部分数量
 * @param {number} total - 总数
 * @param {number} digits - 保留小数位数（默认0，即整数百分比）
 * @returns {number} 百分比值（已舍入）
 */
function calcPercent(part, total, digits = 0) {
  const safeTotal = total || 1;
  const raw = (part / safeTotal) * 100;
  return Number(raw.toFixed(digits));
}

/**
 * 安全删除单个文件（不存在/删除失败均静默忽略）
 * @param {string} filePath - 要删除的文件完整路径
 */
function removeFileIfExists(filePath) {
  if (!filePath) return false;
  try {
    wx.getFileSystemManager().unlinkSync(filePath);
    return true;
  } catch (e) {
    // 文件可能已不存在，或路径不合法，忽略
    return false;
  }
}

/**
 * 清理 USER_DATA_PATH 下累积的拼豆中间产物，防止 10MB 本地配额被长期占用。
 * - bead_export_*.png：保存到相册后的临时副本，理论上每次导出后已即时删除，
 *   此处作为兜底，扫掉任何残留孤儿文件。
 * - bead_share_*.png：社交分享图（朋友圈要求永久路径），同一时刻仅 1 份活跃
 *   （globalData.shareImagePath 指向最新一份），其余旧文件在此删除。
 * - history_source_*.png/jpg/...：历史「对照原图」副本。仅清掉**未被任何历史记录引用**
 *   的孤儿（存储写入失败遗留 / 历史被清空后残留）；仍在使用的对照原图不删。
 * @param {object} [opts]
 * @param {string} [opts.keepSharePath] - 需保留的分享图路径（不删这一份）
 * @returns {number} 实际删除的文件数量
 */
function gcBeadTempFiles(opts) {
  // keepSharePath 契约（防御性收窄，行为不变）：
  //   - 非空字符串            → 作为白名单，GC 时保留该分享图（不删）
  //   - null / undefined / '' / 其他类型 → 不保留任何分享图（启动场景，全部清理）
  // 仅当其为「非空字符串」才进入白名单，避免把 '' / null / undefined 与「保留某路径」语义混淆，
  // 也防止后人直接把可能为 '' 的 shareImagePath 传入时意图不清（空串与「无保留」在此等价，但显式
  // 用 null 表达「无保留路径」更可读）。
  const keepSharePath =
    (opts && typeof opts.keepSharePath === 'string' && opts.keepSharePath) ? opts.keepSharePath : '';
  let removed = 0;
  try {
    const fs = wx.getFileSystemManager();
    const base = wx.env.USER_DATA_PATH;
    // 收集当前历史记录仍在引用的原图路径，避免误删仍在使用的 history_source_* 对照原图
    let liveHistoryImages = null;
    try {
      const hist = getTemplateHistory() || [];
      const set = new Set();
      for (const r of hist) {
        if (r && r.sourceImage) set.add(r.sourceImage);
      }
      liveHistoryImages = set;
    } catch (e) {
      // 读取历史失败：保守跳过 history_source_ 清理，避免误删被引用的原图
      liveHistoryImages = null;
    }
    const files = fs.readdirSync(base) || [];
    for (const name of files) {
      if (name.indexOf('bead_export_') === 0) {
        try { fs.unlinkSync(base + '/' + name); removed++; } catch (e) {}
      } else if (name.indexOf('bead_share_') === 0) {
        const full = base + '/' + name;
        if (full !== keepSharePath) {
          try { fs.unlinkSync(full); removed++; } catch (e) {}
        }
      } else if (name.indexOf('history_source_') === 0) {
        // 仅清掉未被任何历史记录引用的孤儿原图（存储写入失败遗留 / 历史被清空后残留），
        // 不删仍在使用的对照原图；读取历史失败时保守跳过本类清理。
        const full = base + '/' + name;
        if (liveHistoryImages && !liveHistoryImages.has(full)) {
          try { fs.unlinkSync(full); removed++; } catch (e) {}
        }
      }
    }
  } catch (e) {
    log.warn('[gc] 清理拼豆临时文件失败:', e);
  }
  return removed;
}

module.exports = {
  // 常量
  CONSTANTS,
  MAX_HISTORY,
  MAX_PIXELS,
  MAX_ROWS,

  // 函数
  formatMm,
  formatNumber,
  calcPercent,
  debounce,
  throttle,
  saveImageToAlbum,
  canvasToImage,
  getBeadSizePresets,
  compressImageIfNeeded,
  clampTemplateSize,
  clampDisplayNumber,
  getTemplateHistory,
  validateImageFile,
  getImageInfoWithTimeout,
  removeFileIfExists,
  gcBeadTempFiles
};

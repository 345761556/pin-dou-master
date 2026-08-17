/**
 * 工具函数集合
 */

// 安全工具：路径合法性校验（防路径遍历等注入）
const { isValidFilePath } = require('./security');

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
  EXPORT_MAX_SIDE: 2048,     // 导出图片最大边长
  EXPORT_QUALITY: 1.0        // 导出质量
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
  if (num == null || isNaN(num)) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 防抖
 */
function debounce(fn, delay = 300) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
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
 * 2. 检查隐私协议授权（wx.getPrivacySetting）
 *    - 未同意 → 弹隐私协议，用户同意后继续；拒绝则 reject
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
        console.error('[saveImageToAlbum] file not exist:', filePath, accessErr);
        reject(new Error('文件不存在或已失效'));
        return;
      }
    } catch (e) {
      console.warn('[saveImageToAlbum] accessSync check failed, proceed anyway:', e);
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
          console.warn('[saveImageToAlbum] getSetting failed, try direct save');
          doSave();
        }
      });
    }

    // Step 3: 执行保存
    function doSave() {
      wx.saveImageToPhotosAlbum({
        filePath: filePath,
        success: function() {
          console.log('[saveImageToAlbum] save success');
          resolve();
        },
        fail: function(err) {
          const errMsg = (err && (err.errMsg || '')) || '';
          const msgLower = errMsg.toLowerCase();

          console.error('[saveImageToAlbum] save failed:', errMsg);

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
        console.error('[canvasToImage] canvasToTempFilePath failed:', errMsg, 'size:', width, 'x', height);
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
 *          当图片超出 maxSide 且压缩失败时 reject（错误码 image_compress_failed），
 *          由调用方回退到原图路径，避免静默传入超限大图。
 */
function compressImageIfNeeded(imagePath, maxSide = 800) {
  return new Promise((resolve, reject) => {
    // 安全校验：用户选择的图片路径需为合法来源（拦截路径遍历等注入）。
    // chooseMedia 返回的是系统临时路径（wxfile://），正常必通过；此处为防御性前置校验。
    if (!isValidFilePath(imagePath)) {
      reject(new Error('invalid_image_path'));
      return;
    }
    wx.getImageInfo({
      src: imagePath,
      success: (info) => {
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
              // Canvas 不可用时，直接用压缩后的路径（wx.compressImage 质量较差但能降文件大小）
              wx.compressImage({
                quality: 80,
                src: imagePath,
                success: (compressRes) => {
                  resolve({ tempFilePath: compressRes.tempFilePath, width: newWidth, height: newHeight });
                },
                // 情况二：需要压缩但 wx.compressImage 失败（正式版隐私策略可能限制），
                // 不应回退到超限原图（会触发算法卡顿/内存溢出），明确 reject 交由调用方兜底。
                fail: () => reject(new Error('image_compress_failed'))
              });
              return;
            }

            const canvas = res[0].node;
            canvas.width = newWidth;
            canvas.height = newHeight;
            const ctx = canvas.getContext('2d');

            const img = canvas.createImage();
            img.onload = () => {
              ctx.drawImage(img, 0, 0, newWidth, newHeight);
              wx.canvasToTempFilePath({
                canvas,
                x: 0, y: 0,
                width: newWidth,
                height: newHeight,
                destWidth: newWidth,
                destHeight: newHeight,
                fileType: 'jpg',
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
      },
      fail: () => reject(new Error('获取图片信息失败'))
    });
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
    // 再次校验像素上限
    if (cols * rows > maxPixels) {
      const ratio = rows / cols;
      if (ratio > 0) {
        cols = Math.max(1, Math.floor(Math.sqrt(maxPixels / ratio)));
      } else {
        cols = Math.min(cols, Math.floor(maxPixels));
      }
    }
  }

  return { cols, rows };
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

  // 同步校验：文件格式
  const ext = tempFile.tempFilePath.split('.').pop().toLowerCase();
  if (!CONSTANTS.VALID_IMAGE_TYPES.includes(ext)) {
    wx.showToast({ title: '仅支持 JPG/PNG/WebP', icon: 'none' });
    return Promise.resolve(false);
  }

  // 异步校验：图片尺寸
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: tempFile.tempFilePath,
      success: (info) => {
        // 真实格式校验（防御 GIF 等重命名为 .png 的情况）
        const realType = (info.type || '').toLowerCase();
        if (realType && !CONSTANTS.VALID_IMAGE_TYPES.includes(realType)) {
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
      },
      fail: () => {
        // getImageInfo 失败时放行，后续流程会兜底处理
        resolve(true);
      }
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
  validateImageFile
};

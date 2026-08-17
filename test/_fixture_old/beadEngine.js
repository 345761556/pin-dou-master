/**
 * 拼豆核心算法引擎
 * 功能：图片颜色量化 + 模板生成 + 材料统计
 *
 * 工作流程：
 * 1. 将图片绘制到离屏 Canvas
 * 2. 读取像素数据
 * 3. 对每个"拼豆格子"区域取平均色
 * 4. 使用中位切分法（Median Cut）将颜色量化到色卡范围
 * 5. 生成模板矩阵和材料清单
 */

// ==================== 外部工具 ====================
// 复用 util.clampTemplateSize 作为「像素上限 + 最大行数」的单一钳制入口，
// 避免与 generateTemplate / updateEstimate 各自维护同一套算法（改上限时漏改一处）。
const { clampTemplateSize, CONSTANTS } = require('./util');

// 行列标号区域尺寸常量：导出 Canvas 与 renderTemplate 绘制必须共用同一组，
// 否则调整魔数时会漏改另一处，导致导出图与预览图同构性错位。
const DIGIT_WIDTH = 12;       // 行列标号数字估算宽度（避免 share 版标号裁切）
const LABEL_SPACE_MIN = 30;   // 行列标号区域最小宽度（避免标号裁切）

// 行列标号预留空间：导出尺寸(_calcExportParams)与绘制(renderTemplate)的唯一计算入口。
// 此前两处各自内联相同公式且魔数来源不同（renderTemplate 硬编码 12/30，_calcExportParams 用常量），
// 现已统一到此，修改尺寸规则只改这一处即可。
function calcLabelSpace(cols, rows, cellSize, showLabels) {
  const maxColDigits = (cols - 1).toString().length;
  const maxRowDigits = (rows - 1).toString().length;
  const digitWidth = Math.max(8, cellSize >= 10 ? DIGIT_WIDTH : 9);
  const labelSpaceX = showLabels ? Math.max(LABEL_SPACE_MIN, maxColDigits * digitWidth + 8) : 0;
  const labelSpaceY = showLabels ? Math.max(LABEL_SPACE_MIN, maxRowDigits * digitWidth + 8) : 0;
  return Math.max(labelSpaceX, labelSpaceY);
}

// ==================== 颜色空间工具 ====================

// 算法常量
const ALGO = {
  SAMPLE_PIXELS: CONSTANTS.SAMPLE_PIXELS,    // 颜色量化最大采样像素数（单一真源见 util.js CONSTANTS）
  MAX_PIXELS: CONSTANTS.MAX_PIXELS,          // 模板行列乘积上限（单一真源见 util.js CONSTANTS）
  MAX_ROWS: CONSTANTS.MAX_ROWS,              // 最大行数限制（单一真源见 util.js CONSTANTS）
  TRANSPARENCY_ALPHA: 128, // 透明度判定阈值（alpha < 该值视为透明/白色背景）；matchToPalette 与 generateTemplate 共用同一真源，避免改一处漏另一处
  PROGRESS: {
    INIT: 5,
    DRAWN: 15,
    PIXELS_READ: 25,
    QUANTIZED: 50,
    DITHER_START: 50,
    DITHER_END: 90,
    COMPLETE: 100
  }
};

/**
 * HEX 转 RGB
 */
function hexToRgb(hex) {
  // 防御：确保输入是有效字符串
  if (typeof hex !== 'string') {
    return { r: 0, g: 0, b: 0 };
  }
  hex = hex.replace('#', '');
  // 防御：确保长度至少为6位
  if (hex.length < 6) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(hex.substring(0, 2), 16) || 0,
    g: parseInt(hex.substring(2, 4), 16) || 0,
    b: parseInt(hex.substring(4, 6), 16) || 0
  };
}

/**
 * RGB 转 HEX
 */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => {
    const hex = Math.round(Math.max(0, Math.min(255, v))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * RGB 转 LAB（CIE Lab 色彩空间，用于感知均匀的颜色距离计算）
 */
function rgbToLab(r, g, b) {
  // RGB -> XYZ
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;
  rr *= 100; gg *= 100; bb *= 100;
  const x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 95.047;
  const y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 100.0;
  const z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 108.883;
  const fx = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + 16 / 116;
  const fy = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + 16 / 116;
  const fz = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + 16 / 116;
  return {
    l: (116 * fy) - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

/**
 * 计算两个 Lab 颜色之间的 CIE76 Delta E（感知距离）
 * 值越小表示颜色越接近，一般认为 < 2.3 人类无法区分 */
function labDistance(lab1, lab2) {
  const dL = lab1.l - lab2.l;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * 计算两组 RGB 颜色之间的 CIE76 Delta E
 * 供 profile.js 等外部模块直接调用
 */
function calcDeltaE(r1, g1, b1, r2, g2, b2) {
  const lab1 = rgbToLab(r1, g1, b1);
  const lab2 = rgbToLab(r2, g2, b2);
  return labDistance(lab1, lab2);
}


// ==================== 颜色量化（中位切分法 Median Cut）====================

/**
 * 中位切分法颜色量化
 * @param {Array} pixels - 像素数组 [{r, g, b}, ...]
 * @param {number} maxColors - 最大颜色数
 * @returns {Array} 调色板 [{r, g, b}, ...]
 */
function medianCutQuantize(pixels, maxColors) {
  if (pixels.length === 0) return [];
  if (maxColors <= 1) {
    return [getAverageColor(pixels)];
  }

  // 初始化：所有像素在一个桶中
  let buckets = [pixels];

  // 不断切分直到达到目标颜色数
  while (buckets.length < maxColors) {
    // 找到像素最多的桶进行切分
    let maxIdx = -1;
    let maxRange = -1;
    buckets.forEach((bucket, idx) => {
      if (bucket.length < 2) return;
      const range = getBucketRange(bucket);
      if (range.maxRange > maxRange) {
        maxRange = range.maxRange;
        maxIdx = idx;
      }
    });

    if (maxIdx === -1) break; // 所有桶都只有1个像素

    const bucket = buckets[maxIdx];
    const range = getBucketRange(bucket);
    const channel = range.channel;

    // 沿范围最大的通道排序并从中位切分
    bucket.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(bucket.length / 2);

    buckets.splice(maxIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  // 取每个桶的平均色作为调色板
  return buckets
    .filter(b => b.length > 0)
    .map(b => getAverageColor(b));
}

/**
 * 获取像素桶在 RGB 三通道上的范围
 */
function getBucketRange(pixels) {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const p of pixels) {
    if (p.r < rMin) rMin = p.r;
    if (p.r > rMax) rMax = p.r;
    if (p.g < gMin) gMin = p.g;
    if (p.g > gMax) gMax = p.g;
    if (p.b < bMin) bMin = p.b;
    if (p.b > bMax) bMax = p.b;
  }
  const rRange = rMax - rMin;
  const gRange = gMax - gMin;
  const bRange = bMax - bMin;
  const maxRange = Math.max(rRange, gRange, bRange);
  const channel = maxRange === rRange ? 'r' : (maxRange === gRange ? 'g' : 'b');
  return { rRange, gRange, bRange, maxRange, channel };
}

/**
 * 获取一组像素的平均颜色
 */
function getAverageColor(pixels) {
  // 防御：空数组返回黑色
  if (!pixels || pixels.length === 0) {
    return { r: 0, g: 0, b: 0 };
  }
  let rSum = 0, gSum = 0, bSum = 0;
  for (const p of pixels) {
    rSum += p.r || 0;
    gSum += p.g || 0;
    bSum += p.b || 0;
  }
  const len = pixels.length;
  return {
    r: Math.round(rSum / len),
    g: Math.round(gSum / len),
    b: Math.round(bSum / len)
  };
}


// ==================== 色卡匹配 ====================

/**
 * 在给定色卡中找到最接近白色的珠子（按 Lab 距离）
 * 用于透明/近白像素的兜底映射，确保使用色卡真实的白色色号与颜色
 * （避免不同色卡把白色写死成 'C01' 导致色号错乱、渲染成错误颜色）
 */
function findWhiteColor(palette) {
  if (!palette || palette.length === 0) {
    return { id: 'C01', name: '白色', hex: '#FFFFFF' };
  }
  const whiteLab = rgbToLab(255, 255, 255);
  let best = palette[0];
  let bestDist = labDistance(whiteLab, best.lab);
  for (let i = 1; i < palette.length; i++) {
    const d = labDistance(whiteLab, palette[i].lab);
    if (d < bestDist) {
      bestDist = d;
      best = palette[i];
    }
  }
  return best;
}

/**
 * 将任意 RGB 颜色匹配到最近的色卡颜色
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {Array} palette - 色卡 [{id, name, hex, lab}, ...]
 * @returns {Object} 匹配到的色卡颜色
 */
function matchToPalette(r, g, b, palette, alpha = 255) {
  if (!palette || palette.length === 0) {
    return { id: 'C01', name: '白色', hex: '#FFFFFF', distance: Infinity };
  }
  // 透明像素（alpha < ALGO.TRANSPARENCY_ALPHA）或接近白色的像素 → 映射到色卡中实际最接近白色的珠子
  // 修复：原先硬编码 id:'C01'，在 HAMA/Perler 等非 C01 色卡中会凭空造出色号并染错颜色
  if (alpha < ALGO.TRANSPARENCY_ALPHA || (r > 250 && g > 250 && b > 250)) {
    return { ...findWhiteColor(palette), distance: 0 };
  }
  const inputLab = rgbToLab(r, g, b);
  let minDist = Infinity;
  let matched = palette[0];

  for (const color of palette) {
    // 直接使用预计算的 lab，避免重复计算
    const dist = labDistance(inputLab, color.lab);
    if (dist < minDist) {
      minDist = dist;
      matched = color;
    }
  }

  return { ...matched, distance: minDist };
}


// ==================== 模板生成主流程 ====================

/**
 * 生成拼豆模板（主入口）
 * 算法复杂度：O(cols * rows * paletteSize)，其中 paletteSize 通常为 30-50
 * 对于最大 6000 像素的模板，计算量可接受（~30 万次颜色距离计算）
 * 使用中位切分法进行颜色量化，采样最多 5000 像素以平衡质量与性能
 * @param {Object} canvas - 离屏 Canvas 节点
 * @param {Object} image - 已加载的 Image 对象
 * @param {Object} options - 配置项
 * @param {number} options.beadSize - 拼豆物理尺寸（毫米），默认 29
 * @param {number} options.maxBeadWidth - 模板最大宽度（拼豆数），默认 60
 * @param {number} options.colorCount - 使用的颜色数量上限，默认 30
 * @param {Array} options.palette - 可用色卡（必须预计算 lab 值）
 * @param {boolean} options.useDithering - 是否使用 Floyd-Steinberg 抖动算法
 * @param {Function} onProgress - 进度回调 (0-100)
 * @returns {Object} 模板数据
 */
function generateTemplate(canvas, image, options, onProgress) {
  const {
    beadSize = 29,
    maxBeadWidth = 60,
    colorCount = 30,
    palette = [],
    useDithering = true
  } = options;

  if (!palette || palette.length === 0) {
    throw new Error('请先加载色卡数据');
  }

  // 1. 计算模板尺寸
  const imgW = image.width;
  const imgH = image.height;
  // 防御：图片尺寸必须有效
  if (imgW <= 0 || imgH <= 0) {
    throw new Error('图片尺寸无效，请选择其他图片');
  }
  const aspect = imgH / imgW;

  // 模板的拼豆列数和行数
  let cols = maxBeadWidth;
  let rows = Math.round(cols * aspect);
  // 确保至少一个拼豆
  if (cols < 1) cols = 1;
  if (rows < 1) rows = 1;

  // 安全限制：统一走 util.clampTemplateSize（像素上限 + 最大行数单一入口）
  const maxPixels = options.maxPixels || ALGO.MAX_PIXELS;
  const limited = clampTemplateSize(cols, rows, maxPixels, ALGO.MAX_ROWS, aspect);
  cols = limited.cols;
  rows = limited.rows;

  if (onProgress) onProgress(5);

  // 2. 将图片缩小到 cols x rows 的临时 Canvas
  const tempCanvas = canvas;
  tempCanvas.width = cols;
  tempCanvas.height = rows;
  const ctx = tempCanvas.getContext('2d');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(image, 0, 0, cols, rows);

  if (onProgress) onProgress(15);

  // 3. 读取像素数据
  const imageData = ctx.getImageData(0, 0, cols, rows);
  const data = imageData.data;

  // 构建像素数组
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    pixels.push({
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
      a: data[i + 3]
    });
  }

  if (onProgress) onProgress(25);

  // 4. 颜色量化 —— 提取图片的主要颜色
  // 采样：如果像素太多，先均匀采样，确保步长至少为 1
  let sampledPixels = pixels;
  if (pixels.length > ALGO.SAMPLE_PIXELS) {
    sampledPixels = [];
    const step = Math.max(1, Math.floor(pixels.length / ALGO.SAMPLE_PIXELS));
    // 确保采样数量不超过限制
    for (let i = 0; i < pixels.length; i += step) {
      sampledPixels.push(pixels[i]);
      if (sampledPixels.length >= ALGO.SAMPLE_PIXELS) break;
    }
  }

  const quantizedColors = medianCutQuantize(sampledPixels, colorCount);

  // 将量化后的颜色匹配到色卡
  const usedPalette = [];
  for (const color of quantizedColors) {
    const matched = matchToPalette(color.r, color.g, color.b, palette, 255);
    // 去重
    if (!usedPalette.find(c => c.id === matched.id)) {
      usedPalette.push(matched);
    }
  }

  // 用于实际像素匹配：限定到本次量化出的色卡子集
  // 修复 BUG-1：原先直接用完整 palette 匹配，导致 "颜色数量" 滑块完全无效
  const matchPalette = (usedPalette && usedPalette.length > 0) ? usedPalette : palette;

  if (onProgress) onProgress(50);

  // 5. 为每个像素匹配色卡颜色，生成模板矩阵
  const template = []; // template[row][col] = colorId
  const materialStats = {}; // { colorId: { count, color } }

  if (useDithering) {
    // Floyd-Steinberg 误差扩散抖动算法
    //
    // 目的：颜色量化（连续色调 → 有限色卡）后，将量化误差扩散到相邻像素，
    //       减少色阶断层，使渐变区域过渡更自然。
    //
    // 误差扩散权重矩阵（Floyd & Steinberg, 1976）：
    //        当前像素 (x, y)
    //         ↓
    //   [  ·  ][  ·  ][ 7/16]     · = 不扩散
    //   [ 3/16][ 5/16][ 1/16]     数字 = 该邻居获得的误差比例
    //
    // 扩散方向：右(7/16) → 左下(3/16) → 下(5/16) → 右下(1/16)
    // 扫描顺序：从左到右，从上到下（蛇形扫描可进一步减少伪影）
    for (let y = 0; y < rows; y++) {
      template[y] = [];
      for (let x = 0; x < cols; x++) {
        const idx = (y * cols + x) * 4;
        let r = data[idx];
        let g = data[idx + 1];
        let b = data[idx + 2];
        const a = data[idx + 3];

        // 透明像素（alpha < ALGO.TRANSPARENCY_ALPHA）视为白色背景，不参与误差扩散
        const isTransparent = a < ALGO.TRANSPARENCY_ALPHA;

        const oldPixel = { r, g, b };
        const matched = matchToPalette(r, g, b, matchPalette, a);

        template[y][x] = matched.id;

        // 统计材料（透明像素不统计）
        if (!isTransparent) {
          if (!materialStats[matched.id]) {
            materialStats[matched.id] = { count: 0, color: matched };
          }
          materialStats[matched.id].count++;
        }

        if (!isTransparent) {
          // 计算误差并扩散（仅不透明像素）
          const newPixel = { r: matched.r, g: matched.g, b: matched.b };
          const errR = oldPixel.r - newPixel.r;
          const errG = oldPixel.g - newPixel.g;
          const errB = oldPixel.b - newPixel.b;

          const diffuse = (px, py, factor) => {
            if (px >= 0 && px < cols && py >= 0 && py < rows) {
              const i = (py * cols + px) * 4;
              data[i] = Math.max(0, Math.min(255, data[i] + errR * factor));
              data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + errG * factor));
              data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + errB * factor));
            }
          };

          diffuse(x + 1, y, 7 / 16);
          diffuse(x - 1, y + 1, 3 / 16);
          diffuse(x, y + 1, 5 / 16);
          diffuse(x + 1, y + 1, 1 / 16);
        }
      }

      if (onProgress) {
        onProgress(50 + Math.round((y / rows) * 40));
      }
    }
  } else {
    // 简单模式：直接匹配
    for (let y = 0; y < rows; y++) {
      template[y] = [];
      for (let x = 0; x < cols; x++) {
        const idx = (y * cols + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];

        const isTransparent = a < ALGO.TRANSPARENCY_ALPHA;
        const matched = matchToPalette(r, g, b, matchPalette, a);
        template[y][x] = matched.id;

        if (!isTransparent) {
          if (!materialStats[matched.id]) {
            materialStats[matched.id] = { count: 0, color: matched };
          }
          materialStats[matched.id].count++;
        }
      }

      if (onProgress) {
        onProgress(50 + Math.round((y / rows) * 40));
      }
    }
  }

  if (onProgress) onProgress(95);

  // 6. 整理材料清单（按数量降序）
  const materialList = Object.values(materialStats)
    .sort((a, b) => b.count - a.count);

  const totalBeads = materialList.reduce((sum, item) => sum + item.count, 0);

  // 7. 计算物理尺寸
  const physicalWidth = cols * beadSize;  // 毫米
  const physicalHeight = rows * beadSize;  // 毫米

  if (onProgress) onProgress(100);

  return {
    template,           // 二维数组 [row][col] = colorId
    cols,
    rows,
    totalBeads,
    colorCount: materialList.length,
    materialList,       // [{count, color: {id, name, hex, r, g, b}}]
    physicalWidth,      // 毫米
    physicalHeight,     // 毫米
    beadSize,           // 毫米
    usedPalette         // 本次使用的色卡子集
  };
}


// ==================== 模板渲染（Canvas 绘制）====================

/**
 * 在 Canvas 上渲染拼豆模板
 * @param {Object} ctx - Canvas 2D 上下文
 * @param {Object} templateData - generateTemplate 返回的数据
 * @param {Object} options
 * @param {number} options.cellSize - 每个拼豆格子的像素大小
 * @param {number} options.showGrid - 是否显示网格线
 * @param {number} options.showLabels - 是否显示行列标号
 * @param {number} options.showColorLabels - 是否在每个格子标注颜色编号
 * @param {number} options.beadType - 'square' 或 'circle'
 * @returns {Object} { canvasWidth, canvasHeight }
 */
function renderTemplate(ctx, templateData, options = {}) {
  const {
    cellSize = 10,
    showGrid = true,
    showLabels = true,
    showColorLabels = true,
    beadType = 'square',
    offsetX = 0,
    offsetY = 0
  } = options;

  const { template, cols, rows, materialList } = templateData;

  // 构建颜色查找表
  const colorMap = {};
  for (const item of materialList) {
    colorMap[item.color.id] = item.color;
  }

  // 行列标号预留空间：统一走 calcLabelSpace，确保与导出 Canvas 尺寸严格一致
  const labelSpace = calcLabelSpace(cols, rows, cellSize, showLabels);
  const startX = offsetX + labelSpace;
  const startY = offsetY + labelSpace;

  // 计算颜色图例所需高度（当开启颜色标注时，根据颜色数量动态计算行数）
  let legendHeight = 0;
  if (showColorLabels && cellSize >= 5 && materialList.length > 0) {
    const availableWidth = (offsetX + labelSpace + cols * cellSize) - 20;
    const legendItemWidth = Math.max(36, Math.min(80, Math.floor(availableWidth / materialList.length)));
    const legendRowCount = Math.ceil((legendItemWidth * materialList.length) / availableWidth);
    legendHeight = legendRowCount * 50 + 10;
  }
  const totalWidth = startX + cols * cellSize;
  const totalHeight = startY + rows * cellSize + legendHeight;

  // 白色背景
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, totalWidth, totalHeight);

  // 绘制每个拼豆格子
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const colorId = template[y][x];
      const color = colorMap[colorId];
      if (!color) continue;

      const px = startX + x * cellSize;
      const py = startY + y * cellSize;

      ctx.fillStyle = color.hex;

      if (beadType === 'circle') {
        // 圆形拼豆
        const centerX = px + cellSize / 2;
        const centerY = py + cellSize / 2;
        const radius = cellSize / 2 - 0.5;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fill();
        // 中心小孔（如果有颜色标注则跳过，避免遮挡文字）
        if (!(showColorLabels && cellSize >= 5)) {
          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius * 0.2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // 方形拼豆
        ctx.fillRect(px + 0.5, py + 0.5, cellSize - 1, cellSize - 1);
        // 中心小孔（如果有颜色标注则跳过，避免遮挡文字）
        if (!(showColorLabels && cellSize >= 5)) {
          ctx.fillStyle = '#FFFFFF';
          const holeSize = cellSize * 0.15;
          ctx.fillRect(
            px + cellSize / 2 - holeSize / 2,
            py + cellSize / 2 - holeSize / 2,
            holeSize, holeSize
          );
        }
      }
    }
  }

  // 绘制网格线
  if (showGrid && cellSize >= 6) {
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(startX + x * cellSize, startY);
      ctx.lineTo(startX + x * cellSize, startY + rows * cellSize);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(startX, startY + y * cellSize);
      ctx.lineTo(startX + cols * cellSize, startY + y * cellSize);
      ctx.stroke();
    }
  }

  // 每 5 格画粗分隔线（方便数数）
  if (showGrid && cellSize >= 6) {
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x += 5) {
      ctx.beginPath();
      ctx.moveTo(startX + x * cellSize, startY);
      ctx.lineTo(startX + x * cellSize, startY + rows * cellSize);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y += 5) {
      ctx.beginPath();
      ctx.moveTo(startX, startY + y * cellSize);
      ctx.lineTo(startX + cols * cellSize, startY + y * cellSize);
      ctx.stroke();
    }
  }

  // 行列坐标轴（数字：0, 5, 10, 15...）
  if (showLabels && cellSize >= 5) {
    const labelFontSize = Math.max(8, Math.min(Math.floor(cellSize * 0.5), 20));
    ctx.fillStyle = '#555555';
    ctx.font = `bold ${labelFontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 顶部列坐标（从0开始，每5格标注）
    for (let x = 0; x < cols; x += 5) {
      ctx.fillText(
        x.toString(),
        startX + x * cellSize + cellSize / 2,
        startY - 15
      );
    }

    // 左侧行坐标（从0开始，每5格标注）
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < rows; y += 5) {
      ctx.fillText(
        y.toString(),
        startX - 8,
        startY + y * cellSize + cellSize / 2
      );
    }
  }

  // 每个格子内的颜色编号标注
  if (showColorLabels && cellSize >= 5) {
    // 导出时 cellSize 可能很大，编号放在格子右下角更清楚
    // 大格子（>= 20）用小字标注在右下角，不覆盖格子主体
    // 小格子居中显示带半透明背景
    const useCornerLabel = cellSize >= 15;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const colorId = template[y][x];
        const px = startX + x * cellSize;
        const py = startY + y * cellSize;

        if (useCornerLabel) {
          // 大格子：编号放在右下角，小号白底黑字
          const fontSize = Math.max(7, Math.min(Math.floor(cellSize * 0.3), 16));
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';

          const labelW = ctx.measureText(colorId).width + 4;
          const labelH = fontSize + 2;

          // 只画文字区域的半透明背景，不覆盖格子主体
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.fillRect(
            px + cellSize - labelW - 1,
            py + cellSize - labelH - 1,
            labelW, labelH
          );

          ctx.fillStyle = '#333333';
          ctx.fillText(
            colorId,
            px + cellSize - 2,
            py + cellSize - 1
          );
        } else {
          // 小格子：居中显示，带半透明背景
          const fontSize = Math.max(6, Math.min(Math.floor(cellSize * 0.5), 12));
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          const labelW = cellSize * 0.9;
          const labelH = cellSize * 0.65;
          ctx.fillRect(
            px + cellSize / 2 - labelW / 2,
            py + cellSize / 2 - labelH / 2,
            labelW, labelH
          );

          ctx.fillStyle = '#333333';
          ctx.fillText(
            colorId,
            px + cellSize / 2,
            py + cellSize / 2
          );
        }
      }
    }
  }

  // 底部颜色图例（格式：色块 + 编号(数量)，如 H7(1924)）
  if (showColorLabels && cellSize >= 5 && materialList.length > 0) {
    const legendY = startY + rows * cellSize + 10;

    // 计算每个图例项的宽度（根据颜色数量自适应，最小36px保证可读性）
    const availableWidth = totalWidth - 20;
    const legendItemWidth = Math.max(36, Math.min(80, Math.floor(availableWidth / materialList.length)));
    const legendRowCount = Math.ceil((legendItemWidth * materialList.length) / availableWidth);
    const itemsPerRow = Math.ceil(materialList.length / legendRowCount);
    const actualItemWidth = Math.max(36, Math.floor(availableWidth / itemsPerRow));
    const totalLegendWidth = actualItemWidth * itemsPerRow;
    const startLegendX = (totalWidth - totalLegendWidth) / 2;

    // 图例背景高度根据行数调整
    const legendRowHeight = 50;
    const legendBgHeight = legendRowCount * legendRowHeight + 10;

    // 图例背景
    ctx.fillStyle = '#F8F8F8';
    ctx.fillRect(0, legendY - 5, totalWidth, legendBgHeight);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    materialList.forEach((item, idx) => {
      const row = Math.floor(idx / itemsPerRow);
      const col = idx % itemsPerRow;
      const lx = startLegendX + col * actualItemWidth + actualItemWidth / 2;
      const ly = legendY + row * legendRowHeight;

      // 颜色方块
      const boxSize = Math.min(24, actualItemWidth * 0.5);
      ctx.fillStyle = item.color.hex;
      ctx.fillRect(lx - boxSize / 2, ly, boxSize, boxSize);

      // 边框
      ctx.strokeStyle = '#CCCCCC';
      ctx.lineWidth = 1;
      ctx.strokeRect(lx - boxSize / 2, ly, boxSize, boxSize);

      // 编号 + 数量文字
      const fontSize1 = Math.max(8, Math.min(Math.floor(actualItemWidth * 0.22), 18));
      const fontSize2 = Math.max(6, Math.min(Math.floor(actualItemWidth * 0.16), 14));
      ctx.fillStyle = '#333333';
      ctx.font = `bold ${fontSize1}px sans-serif`;
      ctx.fillText(`${item.color.id}`, lx, ly + boxSize + 3);

      ctx.font = `${fontSize2}px sans-serif`;
      ctx.fillStyle = '#666666';
      ctx.fillText(`(${item.count})`, lx, ly + boxSize + 3 + fontSize1 + 2);
    });
  }

  return { canvasWidth: totalWidth, canvasHeight: totalHeight };
}


// ==================== 导出工具 ====================

/**
 * 初始化色卡数据（预计算 LAB 值，避免重复计算）
 */
function initPalette(colorLibrary) {
  return colorLibrary.map(c => {
    const rgb = hexToRgb(c.hex);
    const lab = rgbToLab(rgb.r, rgb.g, rgb.b);
    return { ...c, r: rgb.r, g: rgb.g, b: rgb.b, lab };
  });
}


// ==================== RLE 压缩（用于历史记录存储）====================

/**
 * RLE 编码：将二维颜色矩阵压缩为紧凑字符串
 * 格式：每条记录 = colorId + ':' + count（连续相同颜色合并）
 * @param {Array} template - 二维数组 [row][col] = colorId
 * @returns {string} 压缩后的字符串
 */
function rleEncode(template) {
  const rows = template.length;
  if (rows === 0) return '';
  const cols = template[0].length;
  // 扁平化二维数组为一维数组，按行优先顺序
  const flat = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      flat.push(template[r][c]);
    }
  }
  // 游程编码
  const chunks = [];
  let i = 0;
  while (i < flat.length) {
    let j = i;
    while (j < flat.length && flat[j] === flat[i]) j++;
    chunks.push(flat[i] + ':' + (j - i));
    i = j;
  }
  return chunks.join(';');
}

/**
 * RLE 解码：从压缩字符串还原二维矩阵
 * @param {string} encoded - RLE 编码字符串
 * @param {number} cols - 列数
 * @param {number} rows - 行数
 * @param {Array} [palette] - 可用色卡（可选），用于兜底白色取当前色卡真实白色 id（不传则回退 'C01'）
 * @returns {Array} 二维数组 [row][col] = colorId
 */
function rleDecode(encoded, cols, rows, palette) {
  // 兜底白色用当前色卡的真实白色 id（palette 为空时回退 'C01'），
  // 避免在 HAMA/Perler 等非 C01 色卡里凭空造出 C01 导致渲染缺失/材料清单错乱
  const whiteId = findWhiteColor(palette).id;
  if (!encoded || encoded === '') {
    // 兜底用真实白色填充，避免显示全白/透明
    return Array.from({ length: rows }, () => Array(cols).fill(whiteId));
  }
  const chunks = encoded.split(';');
  const flat = [];
  for (const chunk of chunks) {
    const colonIdx = chunk.lastIndexOf(':');
    if (colonIdx === -1) continue;
    const colorId = chunk.substring(0, colonIdx);
    const countStr = chunk.substring(colonIdx + 1);
    const count = parseInt(countStr, 10);
    if (isNaN(count) || count <= 0) continue;
    // 跳过旧数据中的行分隔符（向后兼容）
    if (colorId === '__ROW__') continue;
    for (let i = 0; i < count; i++) flat.push(colorId);
  }

  const template = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(flat[idx] || whiteId);
      idx++;
    }
    template.push(row);
  }
  return template;
}


// ==================== 模块导出 ====================

module.exports = {
  // 工具函数
  hexToRgb,
  rgbToHex,
  rgbToLab,
  labDistance,
  calcDeltaE,

  // 核心算法
  generateTemplate,
  renderTemplate,
  calcLabelSpace,
  initPalette,
  matchToPalette,

  // 颜色量化
  medianCutQuantize,

  // RLE 压缩（历史记录存储优化）
  rleEncode,
  rleDecode
};

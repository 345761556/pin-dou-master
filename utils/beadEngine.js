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

// 空位哨兵：矩阵中用原生 null 表示"不放置珠子"的透明/镂空格。
// 关键约束：绝不能用真实色号（如 C01/H01/P01）表示空位，否则跨色卡会把"空"污染成白色，
// 这正是历史上 rleDecode 兜底硬编码 'C01' 的病根（见 BUG-4 修复记录）。
// 序列化（RLE）时使用独立令牌，与真实色号（均以字母开头，如 C01/H01）无冲突。
const EMPTY_CELL_TOKEN = '__E__';

// 行列标号预留空间：导出尺寸(_calcExportParams)与绘制(renderTemplate)的唯一计算入口。
// 此前两处各自内联相同公式且魔数来源不同（renderTemplate 硬编码 12/30，_calcExportParams 用常量），
// 现已统一到此，修改尺寸规则只改这一处即可。
function calcLabelSpace(cols, rows, cellSize, showLabels) {
  // 下限守卫：正常调用方已保证 cols/rows ≥ 1，但本函数是导出/渲染共用入口，
  // 需对 ≤0（含负数）做钳制，避免对 -1 取长度（如 cols=0 → "-1".length=2）造成语义错误。
  const safeCols = Math.max(1, cols);
  const safeRows = Math.max(1, rows);
  const maxColDigits = (safeCols - 1).toString().length;
  const maxRowDigits = (safeRows - 1).toString().length;
  const digitWidth = Math.max(8, cellSize >= 10 ? DIGIT_WIDTH : 9);
  const labelSpaceX = showLabels ? Math.max(LABEL_SPACE_MIN, maxColDigits * digitWidth + 8) : 0;
  const labelSpaceY = showLabels ? Math.max(LABEL_SPACE_MIN, maxRowDigits * digitWidth + 8) : 0;
  return Math.max(labelSpaceX, labelSpaceY);
}

/**
 * 底部颜色图例高度：导出尺寸(_calcExportParams)与绘制(renderTemplate)的唯一计算入口。
 * 此前两处公式不同——导出侧按固定 80px/项估算行数（多预留），绘制侧按 36-80px 自适应列宽
 * （少画行），导致每张导出图底部恒有多余白条（60-160px）。统一到此函数后两者严格一致。
 *
 * @param {number} availableWidth - 图例可用宽度（= labelSpace + cols*cellSize - 20，与绘制同口径）
 * @param {number} materialCount - 材料（颜色）数量；0 或非正数 → 不画图例，返回 0
 * @returns {number} 图例区域高度（px）
 */
function calcLegendHeight(availableWidth, materialCount) {
  if (!materialCount || materialCount <= 0) return 0;
  if (!availableWidth || availableWidth <= 0) return 0;
  // 与 renderTemplate 内联公式逐字一致：每项宽 36-80px 自适应，行数向上取整，底边距 10
  const legendItemWidth = Math.max(36, Math.min(80, Math.floor(availableWidth / materialCount)));
  const legendRowCount = Math.ceil((legendItemWidth * materialCount) / availableWidth);
  // 行高 70（与 _drawLegend 的 legendRowHeight 严格一致）：单行内容 = 色块(≤24) + 编号(≤18)
  // + 数量(≤14) + 间距 ≈ 61px，此前 50px 行高在多行图例时第二行会与第一行文字重叠。
  return legendRowCount * 70 + 10;
}

// ==================== 颜色空间工具 ====================

// 维度硬上限（模块级单一真源）：rleDecode（解码）与 renderTemplate（渲染）同源复用，
// 避免「解码侧钳制、渲染侧不钳制」的防御不对称（外部审查 #3）。
// 合法模板上限为 MAX_COLS(120) × MAX_ROWS(120) = 14400 格；此处取更宽松但仍安全的硬上限，
// 既不影响正常历史记录，又杜绝脏 cols/rows（如 1e6）撑爆渲染循环/画布（M2 同源决策）。
const DIM_HARD = 4096;     // 单维硬上限（与 iOS 画布 4096 维度限制同级）
const CELLS_HARD = 20000;  // 总格数硬上限（远高于正常 14400，远低于 OOM 量级）

// 算法常量
const ALGO = {
  SAMPLE_PIXELS: CONSTANTS.SAMPLE_PIXELS,    // 颜色量化最大采样像素数（单一真源见 util.js CONSTANTS）
  MAX_PIXELS: CONSTANTS.MAX_PIXELS,          // 模板行列乘积上限（单一真源见 util.js CONSTANTS）
  MAX_ROWS: CONSTANTS.MAX_ROWS,              // 最大行数限制（单一真源见 util.js CONSTANTS）
  TRANSPARENCY_ALPHA: 128, // 透明度判定阈值（alpha < 该值视为透明/白色背景）；matchToPalette 与 generateTemplate 共用同一真源，避免改一处漏另一处
  NEAR_WHITE_THRESHOLD: 250, // 近白像素阈值：r/g/b 均 > 此值视为近白 → 映射到色卡中实际最接近白色的珠子；matchToPalette 与 generateTemplate 三处共用同一真源，避免改一处漏另两处（P2-4 修复）
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
 * HEX 转 RGB（通用颜色工具，支持以下格式）
 *   - #RGB      （3 位，每位展开为两位，如 #F0A → #FF00AA）
 *   - #RRGGBB   （6 位，标准格式，当前色卡数据均为此格式）
 *   - #RRGGBBAA （8 位带 alpha，截断丢弃最后 2 位，仅返回 RGB）
 * 不支持的输入（非字符串 / 长度非 3·6·8 / 含非法 16 进制字符）一律返回黑色 {0,0,0} 兜底，
 * 与空位哨兵（EMPTY_CELL_TOKEN / null）约定无关——空位不走本函数。
 */
function hexToRgb(hex) {
  // 防御：确保输入是有效字符串
  if (typeof hex !== 'string') {
    return { r: 0, g: 0, b: 0 };
  }
  hex = hex.replace('#', '').trim();
  // 3 位短 hex：每位重复一次展开为 6 位（#F0A → FF00AA）
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  } else if (hex.length === 8) {
    // 8 位带 alpha：截断前 6 位，丢弃 alpha 通道（本函数只返回 RGB）
    hex = hex.substring(0, 6);
  } else if (hex.length !== 6) {
    // 仅支持 3/6/8 位，其余长度（如 2 位 '#FF'、4/5/7 位）视为非法 → 黑色兜底
    return { r: 0, g: 0, b: 0 };
  }
  // 非法字符兜底：6 位但含非 hex 字符（如 #1G2F3D）时 parseInt('1G',16) 会部分解析
  // 返回 1 而非黑色——与「非法输入→黑色兜底」的文档语义矛盾。用全串正则先校验，
  // 任一字符非法即返回黑色（与长度非法同处理，避免脏色号混入色卡）。
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
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
 *
 * ⚡ 性能：RGB→Lab 量化缓存（Medium-2）
 * matchToPalette 对每个不透明像素调用 rgbToLab（含 3 次 Math.pow 立方根），
 * 8000 像素级生成是单点最重路径（最多 ~24000 次 pow）。Lab 是 RGB 的纯函数，
 * 按精确 (r,g,b) 记忆化可零行为变更地削峰——白/黑/常见色与抖动后重复值在精确 key 下命中率极高。
 * 注：若可接受 ~1/8 每通道的极小 Lab 近似，可把 key 改为 (r>>3,g>>3,b>>3) 进一步提命中率；
 *     此处用精确 key 保证输出与改动前逐字节一致（现有等价测试即锁此不变性）。
 * 守卫：缓存上限 5 万条（交叉审查 #7 由 30 万下调：单次生成至多 ~8千 唯一色，5 万已覆盖
 *     约 6 次生成的热点集；峰值内存从 ~30MB 降至 ~5MB，低端机更友好），超限整体清空，
 *     避免跨多次生成无限增长。清空后重建成本低（Lab 是微秒级纯函数），无感知抖动。
 */
const _labCache = new Map();
function rgbToLab(r, g, b) {
  // 越界输入归一化（与下方缓存 key 的掩码语义一致）：key 用 & 0xff 但计算若用原始值，
  // 越界输入（256→0、-1→255）会「同 key 不同值」污染模块级 _labCache（跨多次生成持久），
  // 后续合法调用命中污染条目返回错误 Lab。归一化后 key 与计算值严格一致，合法输入 0-255 行为不变。
  r = r & 0xff; g = g & 0xff; b = b & 0xff;
  const key = (r << 16) | (g << 8) | b;
  const cached = _labCache.get(key);
  if (cached) return cached;
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
  const lab = {
    l: (116 * fy) - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
  if (_labCache.size > 50000) _labCache.clear();
  // Object.freeze 后再缓存（外部审查 #13）：缓存的 lab 对象若被调用方直接修改 l/a/b，
  // 会污染模块级 _labCache 跨多次生成持久（后续同 key 命中返回被污染的值）。冻结后
  // 严格模式写/普通模式赋值均失败（静默或抛错），杜绝共享可变引用。每次生成只读不写，
  // 冻结零行为变更，开销（每色一次 freeze）在 µs 级可忽略。
  Object.freeze(lab);
  _labCache.set(key, lab);
  return lab;
}

/**
 * 计算两个 Lab 颜色之间的 CIE76 Delta E（感知距离）
 * 值越小表示颜色越接近，一般认为 < 2.3 人类无法区分 */
function labDistance(lab1, lab2) {
  // 判空守卫（findWhiteColor:297 / matchToPalette:331 的色卡元素可能缺 lab，
  // 直接访问 undefined.l 会抛 TypeError 且无提示）。缺失的 lab 视为「距离无穷大」：
  // 在匹配循环中不会被选中，调用方拿到 Infinity 可判定该色不可用，永不崩溃。
  // 正常链路 initPalette 必算 lab，此守卫仅兜底外部手造色卡漏填 lab 的场景。
  if (!lab1 || !lab2 || typeof lab1.l !== 'number' || typeof lab2.l !== 'number') {
    return Infinity;
  }
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
  // 判空守卫（与同模块 hexToRgb/matchToPalette/rleDecode/getAverageColor 的判空口径一致）：
  // 导出 API 被外部以 undefined/null/非数组调用时，原实现直接访问 pixels.length 抛 TypeError。
  // 返回空数组（无像素 → 无色卡输出），调用方（generateTemplate）以此为「无量化色」安全降级。
  if (!Array.isArray(pixels)) return [];
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

    // L2 优化：maxRange 是「所有桶的最大通道范围」，若其为 0 说明每个桶都已单色
    // （同色像素）——继续切分只会把同色桶反复劈成重复颜色桶，白做全桶扫描+排序+slice，
    // 下游 usedPalette 去重后功能无任何变化。直接 break，避免纯色图/颜色数<colorCount 的
    // 极端场景下浪费约 maxColors 次全桶扫描。
    if (maxRange === 0) break;

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
    // 空色卡不伪造 C01 色号（跨色卡色号污染病根，见 289 行注释）：返回空 id 哨兵，
    // 调用方把空 id 视为「无白色可映射」，绝不凭空造出色号染错颜色。
    // 正常生成链路在 generateTemplate 顶部已有「色卡为空直接抛错」守卫，此分支仅
    // 兜底导出 API 被外部直接以空色卡调用（地雷拆除）。
    return { id: '', name: '', hex: '' };
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
    // 空色卡不伪造 C01 色号（同 findWhiteColor 289 行注释的跨色卡污染病根）：
    // 返回空 id + Infinity 距离哨兵，调用方拿到 distance=Infinity 可判定「无匹配」。
    // 正常链路 generateTemplate 顶部守卫已保证色卡非空，此分支仅兜底导出 API 误用。
    return { id: '', name: '', hex: '', distance: Infinity };
  }
  // 透明像素（alpha < ALGO.TRANSPARENCY_ALPHA）或接近白色的像素 → 映射到色卡中实际最接近白色的珠子
  // 修复：原先硬编码 id:'C01'，在 HAMA/Perler 等非 C01 色卡中会凭空造出色号并染错颜色
  if (alpha < ALGO.TRANSPARENCY_ALPHA || (r > ALGO.NEAR_WHITE_THRESHOLD && g > ALGO.NEAR_WHITE_THRESHOLD && b > ALGO.NEAR_WHITE_THRESHOLD)) {
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
 * 对于最大 8000 像素（cols×rows，单一真源见 ALGO.MAX_PIXELS = CONSTANTS.MAX_PIXELS）的模板，计算量可接受（~32 万次颜色距离计算）
 * 使用中位切分法进行颜色量化，采样最多 5000 像素以平衡质量与性能
 * @param {Object} canvas - 离屏 Canvas 节点
 * @param {Object} image - 已加载的 Image 对象
 * @param {Object} options - 配置项
 * @param {number} options.beadSize - 拼豆物理尺寸（毫米），默认 29
 * @param {number} options.maxBeadWidth - 模板最大宽度（拼豆数），默认见 CONSTANTS.DEFAULT_COLS(50)
 * @param {number} options.colorCount - 使用的颜色数量上限，默认 30
 * @param {Array} options.palette - 可用色卡（必须预计算 lab 值）
 * @param {boolean} options.useDithering - 是否使用 Floyd-Steinberg 抖动算法
 * @param {Function} onProgress - 进度回调 (0-100)
 * @returns {Object} 模板数据
 */
function generateTemplate(canvas, image, options, onProgress) {
  const {
    beadSize = 29,
    maxBeadWidth = CONSTANTS.DEFAULT_COLS,
    colorCount = 30,
    palette = [],
    useDithering = true,
    fillBackgroundWhite = false,
    shouldCancel = null
  } = options;

  if (!palette || palette.length === 0) {
    throw new Error('请先加载色卡数据');
  }

  // P3-2 修复：image 参数判空（与下方 canvas 判空同口径，消除防御不对称）。
  // 导出 API 被外部误用（传 null/undefined）时抛友好错误，而非 image.width 的 TypeError。
  if (!image || typeof image.width !== 'number' || typeof image.height !== 'number') {
    throw new Error('图片数据无效，请重新选择图片');
  }

  // 1. 计算模板尺寸
  const imgW = image.width;
  const imgH = image.height;
  // 防御：图片尺寸必须有效
  if (imgW <= 0 || imgH <= 0) {
    throw new Error('图片尺寸无效，请选择其他图片');
  }
  // 防御：图片尺寸上限校验（与 util.js 选择图片时的 6000px 校验保持单一真源 CONSTANTS.MAX_IMAGE_DIMENSION）。
  // compressImageIfNeeded 仅压缩边长（默认 maxSide=800），且上游 catch 回退可能把未压缩原图传入，
  // 此处显式断言，超大图直接失败交由调用方提示，而非静默进入算法。
  const MAX_IMAGE_DIMENSION = CONSTANTS.MAX_IMAGE_DIMENSION;
  if (imgW > MAX_IMAGE_DIMENSION || imgH > MAX_IMAGE_DIMENSION) {
    throw new Error('图片尺寸过大，请选择 6000px 以内的图片');
  }
  const aspect = imgH / imgW;

  // 模板的拼豆列数和行数
  // 列数钳制到 MAX_COLS：clampTemplateSize 只钳「像素乘积 + 最大行数」，不钳单维列数——
  // 若调用方传超大 maxBeadWidth（如 5000），cols 可超 MAX_COLS(120)，与 RLE 注释的
  // 「合法模板上限 120×120」契约不符（解码侧 DIM_HARD=4096 虽兜底，但编码契约应一致）。
  // 钳制后再走 clampTemplateSize 做像素/行数收敛（超宽场景 cols 可能被像素上限进一步缩小）。
  let cols = Math.min(maxBeadWidth, CONSTANTS.MAX_COLS);
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

  // 真正耗时的绘制/量化/匹配/抖动封装为异步 Promise，按行分块让出主线程，
  // 使 onProgress 的 setData 能真实 paint、UI 不长时间卡死（High-1 修复）。
  // 顶部尺寸/调色板校验保持同步抛错（快速失败，便于调用方立即捕获）。
  // canvas 判空也放在同步段：节点缺失属于调用方参数错误，应同步抛错而非在异步体
  // 内变成 Promise 拒绝（后者错误被吞成 unhandled rejection，调用方难以及时感知）。
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('Canvas 节点缺失或未初始化');
  }
  return (async () => {
  // 2. 将图片缩小到 cols x rows 的临时 Canvas
  // ⚠️ 共享 canvas 契约（对抗式审查）：本函数会改写调用方传入的 canvas（重设 width/height +
  // 绘制）。像素数据在【首个同步块】（async IIFE 开头至 getImageData，本函数首个 await 之前）
  // 即完整读取，后续分块计算不再触碰 canvas——因此「生成期间（秒级）复用同一 canvas」只会
  // 影响首个同步块窗口，不会在分块阶段产生像素错乱。调用方契约：
  //   - 应传入专用离屏 canvas（index.js 传 #offscreen-canvas，且生成入口有 generating 守卫
  //     + chooseImage 的 _measuring 互斥锁，杜绝与透明测量并发改写）；
  //   - 首个同步块期间不得并发复用该 canvas（JS 单线程 + 同步块原子性天然满足）。
  // 未做内部离屏改造的原因：wx.createOffscreenCanvas 在部分基础库/机型不可用，改造收益低、
  // 引入兼容面；现有调用方契约已覆盖全部生产路径。
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
  // 量化前先剔除透明像素（alpha < 阈值）：透明像素在产品模型里代表"空位"，
  // 其 RGB（常为 0,0,0,0 的透明黑）会占用颜色预算、产出纯黑量化色，污染色卡子集
  // （挤掉真实图像颜色、使 usedPalette 混入本不存在的黑色/深色）。透明像素不参与取色，
  // 下游透明处理由 isTransparent 分支负责（匹配完整色卡找白）。
  let sampledPixels = pixels.filter(p => p.a >= ALGO.TRANSPARENCY_ALPHA);
  if (sampledPixels.length > ALGO.SAMPLE_PIXELS) {
    const step = Math.max(1, Math.floor(sampledPixels.length / ALGO.SAMPLE_PIXELS));
    const capped = [];
    // 确保采样数量不超过限制：break 判断须在 push 【之前】——原实现在 push 后才检查
    // `capped.length >= SAMPLE_PIXELS`，当 length=10001、step=2 时会采到 5001 个
    // （第 5001 次 push 后才触发 break），超出上限 1 个。提前检查后恰好在达到上限时停。
    for (let i = 0; i < sampledPixels.length; i += step) {
      if (capped.length >= ALGO.SAMPLE_PIXELS) break;
      capped.push(sampledPixels[i]);
    }
    sampledPixels = capped;
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

  // —— High-1 / Medium-3 配套 ——
  // yieldToMain：让出主线程一个 macrotask，使 onProgress 的 setData 能真实 paint、UI 不长时间冻结。
  const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));
  // 分块行数：把整段匹配/抖动切成约 24 块，平衡「进度可见」与「让出开销」。
  const CHUNK_ROWS = Math.max(1, Math.ceil(rows / 24));
  // 取消检查：页面已卸载等场景下立即中止（避免对已死页面 setData）。调用方可传 shouldCancel。
  const checkCancel = () => {
    if (shouldCancel && shouldCancel()) {
      const e = new Error('generation cancelled');
      e.__cancel = true;
      throw e;
    }
  };

  // R3 修复：白色查找结果在循环外算一次（palette 固定），避免白底大图逐像素重算
  const paletteWhite = findWhiteColor(palette);

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
    //
    // ⚡ Medium-3 修复：diffuse 闭包提到循环外定义一次（仅捕获 data/cols/rows，误差分量作参数传入），
    //    避免原「每像素 new 一次箭头函数 + 闭包」的分配开销。
    // P2-3 修复：diffuse 内部增加 alpha 守卫——仅当目标像素不透明时才写入误差。
    //   原实现对透明区也写入误差（误差"困"在透明像素 RGB 中永不传播），导致半透明边缘（如 LOGO 边缘）
    //   在开启抖动时出现轻微色阶断层或边缘晕圈。标准 Floyd-Steinberg 要求误差沿不透明区域连续传播。
    const diffuse = (px, py, factor, eR, eG, eB) => {
      if (px >= 0 && px < cols && py >= 0 && py < rows) {
        const i = (py * cols + px) * 4;
        // P2-3：仅向不透明像素扩散误差（透明区不再"吸收"误差后断流）
        if (data[i + 3] >= ALGO.TRANSPARENCY_ALPHA) {
          data[i] = Math.max(0, Math.min(255, data[i] + eR * factor));
          data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + eG * factor));
          data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + eB * factor));
        }
      }
    };
    for (let y = 0; y < rows; y++) {
      template[y] = [];
      for (let x = 0; x < cols; x++) {
        const idx = (y * cols + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];

        // 透明像素处理（产品规则，见 EMPTY_CELL_TOKEN 注释）：
        //  - 默认：视为"空位"，矩阵存 null 哨兵，不计入材料、不参与误差扩散；
        //  - fillBackgroundWhite=true：映射为当前色卡真实白色并计入材料（用于需要完整矩形的场景）。
        const isTransparent = a < ALGO.TRANSPARENCY_ALPHA;
        if (isTransparent) {
          if (fillBackgroundWhite) {
            // 透明区必须用「完整色卡」找白，而非量化子集 usedPalette/matchPalette：
            // 当图片无近白色调时，子集里的"最接近白"是灰/米/红等，会把背景染错、
            // 并导致真实白色不进 materialList（白豆数量少计）。与 matchToPalette 的
            // 近白分支（同样用完整 palette 找白）保持一致。
            // R3 对齐：复用循环外已算的 paletteWhite（palette 固定、结果相同），
            // 避免白底大图每个透明像素重算一次 findWhiteColor（O(paletteSize) 全扫描）。
            const white = paletteWhite;
            template[y][x] = white.id;
            if (!materialStats[white.id]) {
              materialStats[white.id] = { count: 0, color: white };
            }
            materialStats[white.id].count++;
            // 背景白色不参与误差扩散（避免把背景噪点扩散到主体）
          } else {
            template[y][x] = null; // 空位哨兵
          }
          continue;
        }

        // P3-e 修复：近白像素显式用「完整色卡」找白（与 matchToPalette 近白判定同口径
        // r>250&&g>250&&b>250）。原实现近白像素经 matchToPalette(matchPalette) 在量化子集
        // 里找白，图无近白色调时子集里的"最接近白"是浅灰/米色，与下方透明/fillBackgroundWhite
        // 分支「用完整 palette 找白」的注释声明不一致。近白与背景白统一色号后不参与误差扩散
        // （与背景白同等待遇，避免把近白像素的量化误差扩散污染主体边缘）。
        // P2-4 修复：阈值统一走 ALGO.NEAR_WHITE_THRESHOLD，避免改此处漏改 matchToPalette/非抖动分支
        if (r > ALGO.NEAR_WHITE_THRESHOLD && g > ALGO.NEAR_WHITE_THRESHOLD && b > ALGO.NEAR_WHITE_THRESHOLD) {
          template[y][x] = paletteWhite.id;
          if (!materialStats[paletteWhite.id]) {
            materialStats[paletteWhite.id] = { count: 0, color: paletteWhite };
          }
          materialStats[paletteWhite.id].count++;
          continue;
        }

        const matched = matchToPalette(r, g, b, matchPalette);
        template[y][x] = matched.id;

        // 统计材料（空位已在上面 continue，此处只处理不透明像素）
        if (!materialStats[matched.id]) {
          materialStats[matched.id] = { count: 0, color: matched };
        }
        materialStats[matched.id].count++;

        // 计算误差并扩散（仅不透明像素）
        const errR = r - matched.r;
        const errG = g - matched.g;
        const errB = b - matched.b;

        diffuse(x + 1, y, 7 / 16, errR, errG, errB);
        diffuse(x - 1, y + 1, 3 / 16, errR, errG, errB);
        diffuse(x, y + 1, 5 / 16, errR, errG, errB);
        diffuse(x + 1, y + 1, 1 / 16, errR, errG, errB);
      }

      // 完成整行后才让出：保证本行内「右扩散」已完成、下行「下扩散」目标行尚未处理，
      // 跨块边界仍严格行序，Floyd-Steinberg 正确性不受影响。
      if ((y + 1) % CHUNK_ROWS === 0 || y === rows - 1) {
        checkCancel();
        if (onProgress) onProgress(50 + Math.round(((y + 1) / rows) * 40));
        await yieldToMain();
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
        if (isTransparent) {
          if (fillBackgroundWhite) {
            // 透明区必须用「完整色卡」找白（理由同上，与抖动分支保持一致）。
            // 复用循环外算好的 paletteWhite（547 行）：非抖动分支此前在循环内每透明像素
            // 重调 findWhiteColor（白底大图 + fillBackgroundWhite 场景性能回退，与抖动
            // 分支的 R3 优化自相矛盾）。findWhiteColor 是纯函数（palette 固定），结果不变。
            const white = paletteWhite;
            template[y][x] = white.id;
            if (!materialStats[white.id]) {
              materialStats[white.id] = { count: 0, color: white };
            }
            materialStats[white.id].count++;
          } else {
            template[y][x] = null; // 空位哨兵
          }
          continue;
        }

        // P3-e 修复：近白像素显式用「完整色卡」找白（口径与抖动分支一致，理由见上）
        // P2-4 修复：阈值统一走 ALGO.NEAR_WHITE_THRESHOLD
        if (r > ALGO.NEAR_WHITE_THRESHOLD && g > ALGO.NEAR_WHITE_THRESHOLD && b > ALGO.NEAR_WHITE_THRESHOLD) {
          template[y][x] = paletteWhite.id;
          if (!materialStats[paletteWhite.id]) {
            materialStats[paletteWhite.id] = { count: 0, color: paletteWhite };
          }
          materialStats[paletteWhite.id].count++;
          continue;
        }

        const matched = matchToPalette(r, g, b, matchPalette);
        template[y][x] = matched.id;

        if (!materialStats[matched.id]) {
          materialStats[matched.id] = { count: 0, color: matched };
        }
        materialStats[matched.id].count++;
      }

      if ((y + 1) % CHUNK_ROWS === 0 || y === rows - 1) {
        checkCancel();
        if (onProgress) onProgress(50 + Math.round(((y + 1) / rows) * 40));
        await yieldToMain();
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
    template,
    cols,
    rows,
    totalBeads,
    colorCount: materialList.length,
    materialList,
    physicalWidth,
    physicalHeight,
    beadSize,
    usedPalette
  };
  })();
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
    showGrid = true,
    showLabels = true,
    showColorLabels = true,
    beadType = 'square',
    offsetX = 0,
    offsetY = 0
  } = options;

  // 顶层结构防御（外部审查 #2/#3）：templateData/template 缺失或 cols/rows/cellSize 为脏值
  // 时，下方 _drawBeads 的 template[y]、totalWidth = cols*cellSize 等会抛 TypeError 或产生
  // 巨大画布长时间卡死（decode 侧有 DIM_HARD/CELLS_HARD 钳制，render 侧此前不对称）。
  // 与 materialList 的 Array.isArray 防御同教义：字段级脏数据一律收敛，不抛错、不卡死。
  if (!templateData || typeof templateData !== 'object') {
    return { canvasWidth: 0, canvasHeight: 0 };
  }
  const { template, cols: rawCols, rows: rawRows, materialList } = templateData;
  // template 顶层非数组（undefined/对象/字符串）→ 按空矩阵处理（_drawBeads 整行空位）
  const safeTemplate = Array.isArray(template) ? template : [];
  // 数值护栏：cols/rows 钳到 [1, DIM_HARD] 且乘积 ≤ CELLS_HARD（与 rleDecode 同源钳制）——
  // 脏 cols:1e6 不再撑爆循环/画布；cellSize 钳到 [1, 4096] 且有限（NaN/Infinity/0/负数收敛）
  const normDim = (v) => {
    const n = Math.floor(Number(v));
    if (!isFinite(n) || n < 1) return 1;
    if (n > DIM_HARD) return DIM_HARD;
    return n;
  };
  let cols = normDim(rawCols);
  let rows = normDim(rawRows);
  if (cols * rows > CELLS_HARD) rows = Math.max(1, Math.floor(CELLS_HARD / cols));
  const normCell = (v) => {
    const n = Number(v);
    if (!isFinite(n) || n < 1) return 10; // 回落默认 10（与 renderTemplate 默认值一致）
    return Math.min(n, DIM_HARD);
  };
  const cellSize = normCell(options.cellSize);
  // 防御字段级脏数据：materialList 可能缺失（非数组）或元素缺 color 字段，
  // 直接 item.color.id 会抛 TypeError 拖垮整个预览（L2 威胁模型未覆盖的渲染端）。
  const matList = Array.isArray(materialList) ? materialList : [];

  // 构建颜色查找表（缺失色号的元素跳过；_drawBeads 找不到颜色时按"空位"跳过绘制）
  const colorMap = {};
  for (const item of matList) {
    if (item && item.color && item.color.id != null) {
      colorMap[item.color.id] = item.color;
    }
  }

  // 行列标号预留空间：统一走 calcLabelSpace，确保与导出 Canvas 尺寸严格一致
  const labelSpace = calcLabelSpace(cols, rows, cellSize, showLabels);
  const startX = offsetX + labelSpace;
  const startY = offsetY + labelSpace;

  // 计算颜色图例所需高度（当开启颜色标注时，根据颜色数量动态计算行数）
  // 统一走 calcLegendHeight：与导出尺寸(_calcExportParams)同源，避免导出图底部白条
  let legendHeight = 0;
  if (showColorLabels && cellSize >= 5 && matList.length > 0) {
    const availableWidth = (offsetX + labelSpace + cols * cellSize) - 20;
    legendHeight = calcLegendHeight(availableWidth, matList.length);
  }
  const totalWidth = startX + cols * cellSize;
  const totalHeight = startY + rows * cellSize + legendHeight;

  // 白色背景
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, totalWidth, totalHeight);

  // 拆分绘制职责：拼豆 / 网格 / 标注(坐标数字 + 每格色号) / 图例。
  // 各子函数保持原绘制顺序与坐标、颜色、字号不变（见等价性测试 render_template_refactor.test.js）。
  // 统一用 safeTemplate（顶层防御后的数组），子函数内部的行级防御继续兜底。
  _drawBeads(ctx, { template: safeTemplate, colorMap, startX, startY, cellSize, beadType, showColorLabels, cols, rows });
  _drawGrid(ctx, { startX, startY, cols, rows, cellSize, showGrid });
  _drawLabels(ctx, { template: safeTemplate, startX, startY, cellSize, cols, rows, showLabels, showColorLabels });
  _drawLegend(ctx, { startX, startY, cellSize, cols, rows, totalWidth, showColorLabels, materialList: matList });

  return { canvasWidth: totalWidth, canvasHeight: totalHeight };
}

// 绘制拼豆格子（方形 / 圆形 + 中心小孔）。
// 与外部调用约定：colorMap 由 renderTemplate 预构建；px/py 基于 startX/startY 计算。
function _drawBeads(ctx, { template, colorMap, startX, startY, cellSize, beadType, showColorLabels, cols, rows }) {
  for (let y = 0; y < rows; y++) {
    // 结构校验（与 materialList 的 Array.isArray 防御同教义）：脏数据行数 < rows 时
    // template[y] 为 undefined → template[y][x] 抛 TypeError 拖垮整个预览/导出。
    // 行缺失/非数组按「整行空位」处理（与 rleDecode 的空位语义一致），不抛错。
    const row = template[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < cols; x++) {
      const colorId = row[x];
      // 空位哨兵：不放置珠子。用浅灰底 + 斜叉明确区别于"白色珠子"，
      // 避免用户把"空着"误读成"这里要拼白珠"。纯白渲染会误导，故必须 visibly distinct。
      if (colorId == null) {
        const px = startX + x * cellSize;
        const py = startY + y * cellSize;
        ctx.fillStyle = 'rgba(0,0,0,0.05)';
        ctx.fillRect(px, py, cellSize, cellSize);
        if (cellSize >= 6) {
          ctx.strokeStyle = 'rgba(0,0,0,0.22)';
          ctx.lineWidth = Math.max(0.5, cellSize * 0.08);
          ctx.beginPath();
          ctx.moveTo(px + cellSize * 0.25, py + cellSize * 0.25);
          ctx.lineTo(px + cellSize * 0.75, py + cellSize * 0.75);
          ctx.moveTo(px + cellSize * 0.75, py + cellSize * 0.25);
          ctx.lineTo(px + cellSize * 0.25, py + cellSize * 0.75);
          ctx.stroke();
        }
        continue;
      }
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
}

// 绘制网格线（细网格 + 每 5 格粗分隔线，方便数数）。
function _drawGrid(ctx, { startX, startY, cols, rows, cellSize, showGrid }) {
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
}

// 绘制标注：行列坐标轴数字 + 每个格子内的颜色编号。
function _drawLabels(ctx, { template, startX, startY, cellSize, cols, rows, showLabels, showColorLabels }) {
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
      // 结构校验（同 _drawBeads）：脏数据行数 < rows 时整行跳过，不抛 TypeError
      const row = template[y];
      if (!Array.isArray(row)) continue;
      for (let x = 0; x < cols; x++) {
        const colorId = row[x];
        // 空位不画颜色编号（避免把 null 渲染成文字）
        if (colorId == null) continue;
        const px = startX + x * cellSize;
        const py = startY + y * cellSize;

        if (useCornerLabel) {
          // 大格子：编号放在右下角，小号白底黑字
          const fontSize = Math.max(7, Math.min(Math.floor(cellSize * 0.3), 16));
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';

          let labelW = ctx.measureText(colorId).width + 4;
          const labelH = fontSize + 2;

          // P3-3 修复：cellSize=15 时 fontSize=7，"C01"(3字符) labelW≈16>cellSize，
          // fillRect 起点 px+cellSize-labelW-1 < px，向左溢出进入前一个格子（淡化相邻颜色）。
          // 钳制 labelW 到 cellSize-2（保留 2px 右边距），溢出时文字自动缩短或换行（measureText 不变，仅限制背景矩形）。
          labelW = Math.min(labelW, cellSize - 2);

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
}

// 底部颜色图例（格式：色块 + 编号(数量)，如 H7(1924)）。
function _drawLegend(ctx, { startX, startY, cellSize, cols, rows, totalWidth, showColorLabels, materialList }) {
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

    // 图例背景高度根据行数调整。
    // 高度预算对齐（交叉审查修复）：画布为图例预留 legendHeight=行数*70+10（calcLegendHeight），
    // 背景起点在 legendY-5（上留白 5px），故背景高度取 行数*70+5 时底边恰好与画布底边齐平：
    //   legendY - 5 + (行数*70 + 5) = startY + rows*cellSize + 行数*70 + 10 = totalHeight ✓
    // 行高 70 才能容纳单行「色块(≤24) + 编号(≤18) + 数量(≤14)」≈61px，50 会多行重叠。
    const legendRowHeight = 70;
    const legendBgHeight = legendRowCount * legendRowHeight + 5;

    // 图例背景
    ctx.fillStyle = '#F8F8F8';
    ctx.fillRect(0, legendY - 5, totalWidth, legendBgHeight);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    materialList.forEach((item, idx) => {
      // 防御：元素缺 color 字段时跳过该图例项（不抛错，避免整块图例绘制中断）
      if (!item || !item.color || item.color.id == null) return;
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
}


// ==================== 导出工具 ====================

/**
 * 初始化色卡数据（预计算 LAB 值，避免重复计算）
 */
function initPalette(colorLibrary) {
  // 保留命名空间防御（交叉审查 #10）：'__E__' 是 RLE 空位哨兵（EMPTY_CELL_TOKEN），
  // 真实色号若以 '__' 开头会与空位令牌产生编解码歧义。现有受控色卡库（C01/H7 等字母开头）
  // 不会命中；此处兜底拒绝 + 告警，杜绝未来新增色卡误用保留前缀。
  let safeLibrary = colorLibrary.filter(c => !(c && typeof c.id === 'string' && c.id.indexOf('__') === 0));
  if (safeLibrary.length !== colorLibrary.length) {
    console.warn('[beadEngine] initPalette 检测到保留前缀 "__" 的色号（与 RLE 空位哨兵冲突），已拒绝', colorLibrary.length - safeLibrary.length, '项');
  }
  // 重复 id 防御（外部审查 #14）：重复 id 会让 colorMap 后写覆盖先写、材料统计/渲染错位，
  // 且静默进入算法无任何提示（未来新增色卡误复制一行时极难排查）。按 id 去重保留首个 + 告警。
  const seenIds = new Set();
  const uniqueLibrary = [];
  for (const c of safeLibrary) {
    if (!c || typeof c.id !== 'string') continue;
    if (seenIds.has(c.id)) {
      console.warn('[beadEngine] initPalette 检测到重复色号 id=' + c.id + '，已跳过（保留首个）');
      continue;
    }
    seenIds.add(c.id);
    uniqueLibrary.push(c);
  }
  if (uniqueLibrary.length !== safeLibrary.length) {
    console.warn('[beadEngine] initPalette 共去重', safeLibrary.length - uniqueLibrary.length, '个重复色号');
  }
  safeLibrary = uniqueLibrary;
  return safeLibrary.map(c => {
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
  // —— 结构防御（M5）：历史上历史记录里出现过行缺失/列数不等/元素为 undefined 的脏矩阵，
  // 原实现对这类输入要么裸抛 TypeError（稀疏数组空洞行 template[r] 为 undefined →
  // template[r][c] 抛异常，中断 saveToHistory 链路丢用户作品），要么把 undefined 元素
  // 静默归一成空位、把长行按首行列数截断（真实色号被无声改判为空位），产出列数错位的脏
  // RLE 串并持久化。此处统一 sanitize，与 rleDecode 的「永不抛、脏数据归空位」防御哲学一致——
  // 不直接 throw（避免保存链路丢作品），但绝不产出 undefined/NaN 字面令牌。
  if (!Array.isArray(template) || template.length === 0) return '';
  // 首行可能为稀疏数组空洞/非数组行（如 [, ['A','B'] ] 中 template[0] 为 hole）——
  // 此处不直接 return ''（整份模板静默丢弃，与下方逐行容忍空洞补空位的逻辑自相矛盾，
  // 且会让历史记录静默丢失整份作品），统一交给下方按行遍历逻辑补空位。cols 计算循环
  // 只统计数组行，故全为空洞行时 cols===0 仍会正确 return ''。

  // 规范列数取「最大行宽」而非首行列数：规整矩阵下 maxWidth === row0.length，行为不变；
  // 脏矩阵下避免长行被首行列数截断为 undefined（静默丢色），只把较短行末尾补空位。
  let cols = 0;
  for (let r = 0; r < template.length; r++) {
    const row = template[r];
    if (Array.isArray(row) && row.length > cols) cols = row.length;
  }
  if (cols === 0) return '';

  const rows = template.length;
  // 扁平化二维数组为一维数组，按行优先顺序
  const flat = [];
  for (let r = 0; r < rows; r++) {
    const row = template[r];
    // 缺失/非数组行（稀疏数组空洞）→ 整行空位，不再因 template[r] 为 undefined 裸抛 TypeError
    if (!Array.isArray(row)) {
      for (let c = 0; c < cols; c++) flat.push(EMPTY_CELL_TOKEN);
      continue;
    }
    for (let c = 0; c < cols; c++) {
      const cell = row[c];
      // 元素必须是字符串色号或 null/空位；其余（undefined/number/object）一律归一为空位，
      // 杜绝把 undefined 编码进 RLE 串（M5：畸形历史矩阵不再持久化为脏数据）。
      // P3-5 修复：字符串色号还需排除含 RLE 分隔符 ':'/';' 的脏值——含冒号的异常色号会
      // 产出歧义 RLE 串，rleDecode 用 lastIndexOf(':') 解析会错位。
      if (cell == null) {
        flat.push(EMPTY_CELL_TOKEN);
      } else if (typeof cell === 'string' && cell.length > 0 && cell.indexOf(':') === -1 && cell.indexOf(';') === -1) {
        flat.push(cell);
      } else {
        flat.push(EMPTY_CELL_TOKEN);
      }
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
 * @returns {Array} 二维数组 [row][col] = colorId
 */
function rleDecode(encoded, cols, rows) {
  // —— 维度与总格数硬上限（防御脏数据 OOM / WebView 崩溃）——
  // 合法模板上限为 MAX_COLS(120) × MAX_ROWS(120) = 14400 格；这里用更宽松但仍安全的
  // 硬上限，既不影响任何正常历史记录，又杜绝 cols/rows 被篡改/截断为极大值后
  // Array.from({length: rows}) 与矩阵构建撑爆内存（M2：累计总长 + 维度双重防护）。
  // 注：DIM_HARD/CELLS_HARD 为模块级常量（renderTemplate 等渲染侧同源复用）。

  let safeCols = Math.floor(Number(cols));
  let safeRows = Math.floor(Number(rows));
  if (!isFinite(safeCols) || safeCols < 1) safeCols = 1;
  if (!isFinite(safeRows) || safeRows < 1) safeRows = 1;
  if (safeCols > DIM_HARD) safeCols = DIM_HARD;
  if (safeRows > DIM_HARD) safeRows = DIM_HARD;
  // 维度乘积超限则优先收缩行数（保留列结构），确保矩阵构建有界
  if (safeCols * safeRows > CELLS_HARD) {
    safeRows = Math.max(1, Math.floor(CELLS_HARD / safeCols));
  }
  const maxCells = safeCols * safeRows;

  // RLE 必须是字符串：旧数据/脏数据可能把数组/对象/null 写入 templateRLE，
  // 非字符串直接调用 .split(';') 会抛 TypeError，被 gallery.viewTemplate 误报"数据异常"。
  // 按"无数据"处理返回空矩阵，既防止崩溃，也不污染材料统计（RLE 类脏值无意义）。
  if (!encoded || typeof encoded !== 'string' || encoded === '') {
    // 无数据：视为"全空位"（不放置珠子），与 generateTemplate 的空位语义一致；
    // 不再兜底白色，避免把"没有数据"误当作"白色背景"（这正是旧版写死 C01 的病根）。
    return Array.from({ length: safeRows }, () => Array(safeCols).fill(null));
  }
  const chunks = encoded.split(';');
  const flat = [];
  // 脏串扫描上限：全是非法 chunk 的脏串（如 'x:0;y:0;z:0;...' 百万个）在 flat 不增长时
  // 也会完整遍历 chunks.length 次（纯 CPU 空转）。合法模板 chunk 数 ≤ 格子数(14400)，
  // 上限取 10 万（远高于合法值、足够容纳多段历史脏数据），超限视为数据损坏直接截断。
  const CHUNK_SCAN_LIMIT = 100000;
  for (let ci = 0; ci < chunks.length && ci < CHUNK_SCAN_LIMIT; ci++) {
    const chunk = chunks[ci];
    const colonIdx = chunk.lastIndexOf(':');
    if (colonIdx === -1) continue;
    const colorId = chunk.substring(0, colonIdx);
    const countStr = chunk.substring(colonIdx + 1);
    // 严格数字校验（外部审查）：parseInt('5abc', 10) = 5 会对脏串部分解析——'C01:5abc'
    // 会被当作 count=5 接受，脏数据静默进入算法。改用「纯数字」正则 + Number 精确解析，
    // 任何非纯数字（含尾随字符/前导空白/小数）一律跳过该 chunk。
    const parsed = /^\d+$/.test(countStr) ? Number(countStr) : NaN;
    // 异常数据防护：count 必须有限且为正；且不得超过本模板总格数
    // （maxCells 已随维度钳制而安全，不再受脏 cols 放大；无上限的极大 count 会卡死/内存暴涨）
    if (isNaN(parsed) || parsed <= 0 || parsed > maxCells) continue;
    const count = parsed;
    // 跳过旧数据中的行分隔符（向后兼容）
    if (colorId === '__ROW__') continue;
    // 空位令牌 → null 哨兵；其余按真实色号还原
    let value = colorId === EMPTY_CELL_TOKEN ? null : colorId;
    // M5 防御：历史上畸形矩阵可能把 undefined/NaN 编码为字面令牌（如 'undefined:5'），
    // 这类令牌非真实色号，归一为空位而非在渲染端因查不到颜色静默跳过（污染材料口径）
    if (value === 'undefined' || value === 'NaN') value = null;
    // L1 防御：空 colorId（:5 形态 chunk，lastIndexOf(':')===0 → colorId=''）非真实色号，
    // 若原样填进矩阵会在材料统计里留下无意义空串、且渲染端 colorMap[''] 查不到而被静默跳过。
    // 归一为空位（填 count 个格子，保持矩阵对齐），而非字面跳过整个 chunk（否则后续全部错位）。
    if (value === '') value = null;
    // 累计总长硬上限：超出部分视为越界/损坏直接丢弃，防止多段累计膨胀数十亿项
    const remaining = maxCells - flat.length;
    if (remaining <= 0) break;
    const take = Math.min(count, remaining);
    for (let i = 0; i < take; i++) flat.push(value);
  }

  const template = [];
  let idx = 0;
  for (let r = 0; r < safeRows; r++) {
    const row = [];
    for (let c = 0; c < safeCols; c++) {
      // 缺失格（越界/数据不足）同样视为空位，而非白色，避免污染材料清单
      row.push(flat[idx] != null ? flat[idx] : null);
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
  calcLegendHeight,
  initPalette,
  matchToPalette,

  // 算法常量（透明判定阈值：generateTemplate/matchToPalette 内部共用单一真源，
  // 导出供首页预估复用，保证"预估剔除透明"与"真实生成"口径一致）
  TRANSPARENCY_ALPHA: ALGO.TRANSPARENCY_ALPHA,

  // 颜色量化
  medianCutQuantize,

  // RLE 压缩（历史记录存储优化）
  rleEncode,
  rleDecode
};

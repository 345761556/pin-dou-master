// pages/index/index.js - 首页：图片上传与模板制作
const app = getApp();
const beadEngine = require('../../utils/beadEngine');
// 透明判定阈值（alpha < 该值视为透明/空位），与 beadEngine.generateTemplate 共用单一真源
const { TRANSPARENCY_ALPHA } = beadEngine;
const colorLib = require('../../utils/colorLibrary');
const { getBeadSizePresets, formatNumber, formatMm, compressImageIfNeeded, clampTemplateSize, validateImageFile, getTemplateHistory, getImageInfoWithTimeout, CONSTANTS, MAX_HISTORY, MAX_PIXELS, debounce, removeFileIfExists } = require('../../utils/util');
// 偏好读取 + 拼豆尺寸范围常量（BEAD_SIZE.MIN/MAX 定义在 app.js 的 CONSTANTS 中，
// util.js 的 CONSTANTS 不含该字段，故单独以 APP_CONSTANTS 导入以免与下方 util 的 CONSTANTS 混淆）
const { getBeadPrefs, CONSTANTS: APP_CONSTANTS } = require('../../app.js');
// 统一脱敏日志
const { log, isRemoteImageUrl, isManagedHistorySource } = require('../../utils/security');
// 内容安全检测（图片上传场景，对接微信 mediaCheckAsync）
const secCheck = require('../../utils/secCheck');

// 读取图片真实尺寸（Promise 化 wx.getImageInfo，带超时兜底：
// 模拟器上 getImageInfo 可能挂起不回调 → 框架层裸 "Error: timeout"，
// 用 getImageInfoWithTimeout 把超时收敛为 reject，走调用方失败分支）
// 用于压缩失败兜底：压缩环节可能因 Canvas 导出失败而 reject，但源图本身可读
// （validateImageFile / compressImageIfNeeded 内部均对同一路径成功调用过 getImageInfo），
// 因此尺寸可补取，避免预估区误显示「0 颗」；补取失败（极端场景）才保留 width/height=0。
function readImageSize(src) {
  return getImageInfoWithTimeout(src).then((info) => {
    const width = info && info.width;
    const height = info && info.height;
    // 防御：宽高必须为正整数才视为有效，否则走失败分支保持 0；
    // 顺带拦截字符串数字（理论上 getImageInfo 恒返 number，此处加固避免隐式转换污染后续计算）
    if (typeof width !== 'number' || typeof height !== 'number' || !width || !height || width <= 0 || height <= 0) {
      throw new Error('image_size_invalid');
    }
    return { width, height };
  });
}

// 历史存储瘦身：materialList 内颜色对象携带的 lab / r / g / b 仅是生成期的计算缓存，
// 图例、材料清单、对照原图等所有展示/渲染路径只用 id / name / hex。
// 持久化时剔除这些冗余字段可显著减小 setStorage 体积，缓解 10MB 配额压力（BUG-22）。
// 注意：保留 color 的其它字段（不含 lab/r/g/b），不破坏未来可能的扩展字段。
function slimMaterialList(materialList) {
  if (!Array.isArray(materialList)) return materialList;
  return materialList.map(function (item) {
    if (!item || typeof item !== 'object') return item;
    const c = item.color;
    let slimColor = c;
    if (c && typeof c === 'object') {
      const { lab, r, g, b, ...rest } = c; // 剔除生成期缓存
      slimColor = rest;
    }
    return Object.assign({}, item, { color: slimColor });
  });
}

Page({
  data: {
    imagePath: '',
    imageSize: null,       // { width, height }
    transparentRatio: 0,   // 图片透明像素占比 [0,1]；0=未统计/无透明，预估按格子总数上界

    // 设置参数
    currentSizeLabel: '29mm 标准拼豆',
    beadSize: 29,
    templateCols: 50,
    colMin: CONSTANTS.MIN_COLS,   // 与 slider 下限一致（单一来源，避免 WXML/JS 不一致）
    colMax: CONSTANTS.MAX_COLS,   // 与 slider 上限一致
    beadType: 'square',
    colorCount: 30,
    colorCountMax: 30,
    useDithering: true,
    fillBackgroundWhite: false, // 透明像素是否映射为当前色卡白色并计入材料；默认 false（透明=空位，不拼白珠）

    // 色卡相关
    showPaletteModal: false,
    paletteList: [],
    selectedPalette: 'artkal_c',
    selectedPaletteName: 'ArtKal C 系列',
    colorChart: [],
    colorChartPreview: [], // 色卡选择行仅展示前 6 个色点（WXML 不支持 .slice()）

    // 生成状态
    generating: false,
    progress: 0,

    // 预估信息
    estimateInfo: {
      totalBeads: 0,
      size: ''
    },

    // UI 状态
    isAdvancedOpen: false
  },

  onLoad() {
    // 页面存活标记：模板生成为长耗时同步计算（大图 + 中位切分 + 抖动），
    // 用户可能在图片加载/计算期间返回上一页或切换 tab，导致页面已卸载/隐藏。
    // img.onload 回调据此在入口判断页面是否仍存活，避免对已卸载页面 setData / 误跳转。
    // 见 generateTemplate 的 img.onload 守护，及 onShow/onHide/onUnload 的标记维护。
    this._pageAlive = true;

    // 加载用户偏好（统一走 app.js 的 getBeadPrefs，含类型校验，避免与 globalData 不一致）
    const prefs = getBeadPrefs();
    // 范围钳制：getBeadPrefs 仅做类型校验，不做范围约束。
    // 与 app.js _initPreferences（beadSize）及 colorCount slider 处理器（2-50）保持一致，
    // 防止本地存储中残留的越界值（如 beadSize=200 / colorCount=0）被直接写入 data 引发异常。
    this.setData({
      beadSize: Math.max(APP_CONSTANTS.BEAD_SIZE.MIN, Math.min(APP_CONSTANTS.BEAD_SIZE.MAX, prefs.beadSize)),
      beadType: prefs.beadType,
      colorCount: Math.max(2, Math.min(50, prefs.colorCount)),
      useDithering: prefs.useDithering,
      // 安全读取布尔偏好：wx.getStorageSync 在存储损坏/序列化异常时会抛错，
      // 包裹后失败回退默认 false，避免 onLoad 因裸调用抛错而中断（首页白屏）。
      fillBackgroundWhite: (() => { try { return wx.getStorageSync('pref_fillBackgroundWhite') === true; } catch (_e) { log.warn('读取 pref_fillBackgroundWhite 失败，回退默认 false:', _e); return false; } })()
    });
    // 更新标签
    const presets = getBeadSizePresets();
    const current = presets.find(p => p.value === this.data.beadSize);
    if (current) {
      this.setData({ currentSizeLabel: current.label });
    }

    // 初始化色卡列表
    this.loadPaletteList();

    // 启用分享：右上角「...」菜单显示「发送给朋友」与「分享到朋友圈」
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
  },

  // 页面重新可见（含从其它 tab 切回 / 从下级页 navigateBack 返回）：恢复存活标记，
  // 允许再次发起模板生成。与 onHide 配对——tab 切换只触发 onHide/onShow 不卸载页面，
  // 故需 onShow 重新置 true，否则切回 tab 后首次生成会被误判为「页面已死」直接丢弃。
  onShow() {
    this._pageAlive = true;
  },

  // 页面隐藏（切换 tab / 被下级页覆盖）：置 false，防止 img.onload 在用户已离开时
  // 仍执行 setData / wx.navigateTo（误跳转 + "页面已卸载 setData" 告警）。
  onHide() {
    this._pageAlive = false;
  },

  // 页面销毁（如 wx.navigateBack 真正卸载）：置 false，img.onload 入口据此提前退出；
  // 同时取消 pending debounce 定时器，避免 300ms 后回调在已销毁页面上调 this.setData。
  onUnload() {
    this._pageAlive = false;
    if (this.debouncedOnColsChange) this.debouncedOnColsChange.cancel();
    if (this.debouncedOnColorCountChange) this.debouncedOnColorCountChange.cancel();
  },

  // 加载色卡列表和当前色卡
  loadPaletteList() {
    const selectedPalette = colorLib.getCurrentPaletteKey();
    const colors = colorLib.getCurrentColors();
    const maxCount = colorLib.getPaletteColorCount(selectedPalette);
    // 加载色卡后同步：确保 slider 上限与色卡容量一致；若历史 colorCount 超出当前色卡，钳制到上限
    const clampedColorCount = Math.min(this.data.colorCount, maxCount);
    this.setData({
      paletteList: colorLib.getPaletteList(),
      selectedPalette: selectedPalette,
      selectedPaletteName: colorLib.getPaletteName(selectedPalette),
      colorChart: colors,
      colorChartPreview: colors.slice(0, 6),
      colorCountMax: maxCount,
      colorCount: clampedColorCount
    });
  },

  // 显示色卡弹窗
  showPaletteModal() {
    this.setData({ showPaletteModal: true });
  },

  // 关闭色卡弹窗
  hidePaletteModal() {
    this.setData({ showPaletteModal: false });
  },

  // 色卡切换（由 palette-selector 组件触发）
  onPaletteChange(e) {
    const key = e.detail.key;
    if (!key || key === this.data.selectedPalette) return;

    const colors = colorLib.switchPalette(key);
    const maxCount = colorLib.getPaletteColorCount(key);
    // 切换色卡后同步：若历史 colorCount 超出新色卡容量，钳制到上限
    const clampedColorCount = Math.min(this.data.colorCount, maxCount);
    this.setData({
      selectedPalette: key,
      selectedPaletteName: colorLib.getPaletteName(key),
      colorChart: colors,
      colorChartPreview: colors.slice(0, 6),
      colorCountMax: maxCount,
      colorCount: clampedColorCount
    });
    wx.showToast({ title: '已切换', icon: 'success' });
  },

  // 选择图片
  async chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        try {
        const tempFiles = res.tempFiles || [];
        const tempFile = tempFiles[0];

        // 防御：用户未选择任何文件
        if (!tempFile) {
          wx.showToast({ title: '请选择图片', icon: 'none' });
          return;
        }

        // 校验图片（大小、格式、尺寸）
        const valid = await validateImageFile(tempFile);
        if (!valid) return;

        // 大图压缩，防止算法卡顿
        let processed;
        try {
          processed = await compressImageIfNeeded(tempFile.tempFilePath, CONSTANTS.DEFAULT_IMAGE_SIZE);
        } catch (err) {
          // 压缩失败兜底：源图本身可读（validateImageFile / compressImageIfNeeded 内部已对
          // 同一路径成功 getImageInfo 过），此处补取真实尺寸填入 processed，
          // 避免 setData 后 updateEstimate 因 width=0 直接 return、预估区显示误导性的「0 颗」。
          // 补取仍失败（极端场景）则保持 width/height=0，生成功能仍可正常使用。
          processed = { tempFilePath: tempFile.tempFilePath, width: 0, height: 0 };
          try {
            const size = await readImageSize(tempFile.tempFilePath);
            processed = { tempFilePath: tempFile.tempFilePath, width: size.width, height: size.height };
          } catch (sizeErr) {
            log.warn('[chooseImage] 压缩失败后补取图片尺寸失败，走占位预估:', sizeErr);
          }
        }

        // 内容安全检测（微信审核要求：用户可上传图片的场景必须接入内容安全检测 mediaCheckAsync，
        // 检测不通过时提示「所发布内容含违规信息」即可）。
        // 场景 scene=4（社交日志，用户创作内容）；通道不可用时内部降级放行。
        const secResult = await secCheck.checkImageByPath(processed.tempFilePath, { scene: 4 });
        if (!secResult.pass) {
          // 仅提示违规，不向用户暴露检测细节（与 P2-1 错误信息收敛原则一致）。
          // 拦截原因非违规（过大/限频/服务暂不可用）时由 blockMessage 给出差异化文案。
          wx.showToast({ title: secCheck.blockMessage(secResult, '图片内容含违规信息，请更换后重试'), icon: 'none' });
          // 检测未通过：主动回收本次检测产生的本地临时图（压缩产物为微信系统临时文件
          // wxfile://tmp_，本会话反复「选图→违规被拦」会累积；此处回收避免 USER_DATA_PATH
          // 配额压力，与 BUG-10 持久化失败治理目标一致）。成功路径 setData 后仍引用该路径
          // 供后续创作，故仅失败分支清理。
          removeFileIfExists(processed.tempFilePath);
          return;
        }

        this.setData({
          imagePath: processed.tempFilePath,
          imageSize: { width: processed.width, height: processed.height }
        });

        // 列数范围随图片宽高比动态解耦（修复 L1：极端竖图 slider 显示值与实际生成不符）：
        // 不把 templateCols 死钳到 MIN_COLS，而是取「当前宽高比下 clampTemplateSize 能给出的最大
        // 分辨率列数」作为该图的默认列数与 slider 上限；slider 下限取 (MIN_COLS, 上限) 的小者。
        // 这样竖图(aspect>20)时上限会低于 MIN_COLS，slider 收拢到真实列数（如 3），显示值、预估、
        // 生成三者完全一致；普通图仍保留 MIN_COLS(20) 下限，slider 在 [20, 上限] 内可自由调节。
        let capCols = CONSTANTS.MAX_COLS;
        let capRows = 1;
        if (processed.width > 0 && processed.height > 0) {
          const aspect = processed.height / processed.width;
          const cap = clampTemplateSize(CONSTANTS.MAX_COLS, Math.round(CONSTANTS.MAX_COLS * aspect), MAX_PIXELS, CONSTANTS.MAX_ROWS, aspect);
          capCols = cap.cols;
          capRows = cap.rows;
        }
        const colMin = Math.max(1, Math.min(CONSTANTS.MIN_COLS, capCols));
        const colMax = Math.max(colMin, capCols);

        // 默认列数取 min(该图上限, DEFAULT_COLS)：普通图保留 50 的适中默认（避免每次选图都跳到
        // 接近上限的大模板，生成更慢、材料清单更长）；极端竖图(aspect>20)上限本身 < 50，则取真实
        // 上限，保证「slider 显示值 == 实际生成」始终一致（修复 L1 的显示/生成不符）。
        this.setData({
          templateCols: Math.min(capCols, CONSTANTS.DEFAULT_COLS),
          colMin,
          colMax
        });

        // 一次性统计透明像素占比，使首页预估"总珠数"与实际生成一致（剔除透明空格）
        const ratio = await this._measureTransparency(processed.tempFilePath);
        this.setData({ transparentRatio: ratio });

        this.updateEstimate();
        } catch (err) {
          // H1 修复：async success 回调内多个 await（validateImageFile / secCheck.checkImageByPath /
          // setData / updateEstimate 等）若抛异常，会被吞成「未处理的 Promise 拒绝」——wx.chooseMedia 的
          // fail 回调只捕获 chooseMedia 自身失败，拦不到 success 内的异步异常，导致用户无任何提示、操作静默失败。
          // 顶层包 try-catch：异常时记日志 + 通用 toast，fail-closed 兜底（绝不静默吞错）。
          log.error('[chooseImage] 异步处理异常（兜底未处理拒绝）:', err);
          wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
        }
      },
      fail: (err) => {
        // 失败回调：避免隐私未授权等异常静默（用户点"选择图片"无反应）
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') !== -1) return; // 用户主动取消，不打扰
        if (msg.indexOf('privacy') !== -1 || msg.indexOf('scope is not declared') !== -1) {
          wx.showToast({ title: '请先同意隐私授权后重试', icon: 'none' });
          return;
        }
        wx.showToast({ title: '选择图片失败，请重试', icon: 'none' });
      }
    });
  },

  // 更新预估信息
  updateEstimate() {
    const { imageSize, beadSize, templateCols } = this.data;
    // 兜底：图片尺寸不可用（压缩失败且补取尺寸也失败的极端场景）时，
    // 不展示误导性的「0 颗」，改为占位符，避免用户误判生成结果为空。
    // WXML 侧对 '-' 做条件渲染为「尺寸未知」。
    if (!imageSize || !imageSize.width || !imageSize.height) {
      this.setData({
        'estimateInfo.totalBeads': '-',
        'estimateInfo.size': '-'
      });
      return;
    }

    const aspect = imageSize.height / imageSize.width;
    let cols = templateCols;
    let rows = Math.round(templateCols * aspect);

    // 与实际生成逻辑保持一致：统一走 clampTemplateSize（像素上限 + 最大行数单一入口），
    // 避免极端比例（超长竖图）下预估尺寸/数量远大于实际生成结果
    const clamped = clampTemplateSize(cols, rows, MAX_PIXELS, CONSTANTS.MAX_ROWS, aspect);
    cols = clamped.cols;
    rows = clamped.rows;

    // 透明背景图（fillBackgroundWhite=false）实际珠数 = 格子数 × (1 - 透明占比)，
    // 与 beadEngine.generateTemplate 的 totalBeads 口径一致（透明空格不计入材料）。
    // 开启"背景填充白色"时透明区映射为白色珠子，仍按格子总数计；transparentRatio=0（未统计）时退回上界。
    const gridTotal = cols * rows;
    const total = (!this.data.fillBackgroundWhite && this.data.transparentRatio > 0)
      ? Math.round(gridTotal * (1 - this.data.transparentRatio))
      : gridTotal;
    const width = cols * beadSize;
    const height = rows * beadSize;

    this.setData({
      'estimateInfo.totalBeads': formatNumber(total),
      'estimateInfo.size': `${formatMm(width)} × ${formatMm(height)}`
    });
  },

  // 一次性统计图片透明像素占比（供首页预估剔除透明空格，与实际生成 totalBeads 口径一致）
  // 透明阈值复用 beadEngine.TRANSPARENCY_ALPHA（128），保证预估/生成两处判定一致。
  // 返回 [0,1]；任何失败（canvas 不可用/图片加载失败/页面已卸载/超时）一律返回 0，
  // 使预估退回"格子总数"上界——安全、不崩溃、不影响功能完整。
  // timeoutMs：兜底超时。WeChat 运行时偶发 canvas 节点销毁/图片解码卡死会导致
  // query.exec 与 img.onload/onerror 都永不触发，使本 Promise 永不 settle，进而让
  // chooseImage 里 await 永久挂起、updateEstimate 永不执行（静默功能缺失）。超时即退回上界预估。
  _measureTransparency(imagePath, timeoutMs = 1500) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      timer = setTimeout(() => done(0), timeoutMs);

      if (this._pageAlive === false) { done(0); return; }
      const query = wx.createSelectorQuery();
      query.select('#offscreen-canvas').fields({ node: true, size: true }).exec((res) => {
        if (this._pageAlive === false) { done(0); return; }
        if (!res[0] || !res[0].node) { done(0); return; }
        try {
          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          const img = canvas.createImage();
          img.onload = () => {
            if (this._pageAlive === false) { done(0); return; }
            try {
              // 透明占比是图像内容属性，与最终网格分辨率近似无关；
              // 直接按图片自然尺寸绘制统计，无需按 templateCols 重采样。
              canvas.width = img.width;
              canvas.height = img.height;
              ctx.clearRect(0, 0, img.width, img.height);
              ctx.drawImage(img, 0, 0, img.width, img.height);
              const { data } = ctx.getImageData(0, 0, img.width, img.height);
              const total = data.length / 4;
              let transparent = 0;
              for (let i = 3; i < data.length; i += 4) {
                if (data[i] < TRANSPARENCY_ALPHA) transparent++;
              }
              done(total > 0 ? transparent / total : 0);
            } catch (e) {
              log.warn('[_measureTransparency] getImageData 失败，退回上界预估:', e);
              done(0);
            }
          };
          img.onerror = () => { done(0); };
          img.src = imagePath;
        } catch (e) {
          log.warn('[_measureTransparency] canvas 初始化失败，退回上界预估:', e);
          done(0);
        }
      });
    });
  },

  // 显示规格选择器
  showSizePicker() {
    const presets = getBeadSizePresets();
    const items = presets.map(p => p.label);

    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const selected = presets[res.tapIndex];
        this.setData({
          beadSize: selected.value,
          currentSizeLabel: selected.label
        });
        this.updateEstimate();
        this.savePrefs();
      }
    });
  },

  // 列数滑动防抖版（避免拖动时频繁 setData 导致性能问题）
  debouncedOnColsChange: debounce(function(e) {
    let value = parseInt(e.detail.value, 10);
    if (isNaN(value)) return;
    // 与 slider 的动态 min/max（随图片宽高比解耦）保持一致，防止越界值写入
    value = Math.max(this.data.colMin, Math.min(this.data.colMax, value));
    this.setData({ templateCols: value });
    this.updateEstimate();
  }, CONSTANTS.DEBOUNCE_DELAY),

  // 拼豆形状选择
  selectShape(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ beadType: type });
    this.savePrefs();
  },

  // 颜色数量滑动防抖版
  debouncedOnColorCountChange: debounce(function(e) {
    let value = parseInt(e.detail.value, 10);
    if (isNaN(value)) value = 30;
    // 钳制到 [2, colorCountMax]：colorCountMax 是当前色卡实际颜色数，避免 UI 显示超出容量
    value = Math.max(2, Math.min(this.data.colorCountMax, value));
    this.setData({ colorCount: value });
    this.savePrefs();
  }, CONSTANTS.DEBOUNCE_DELAY),

  // 抖动开关
  onDitheringChange(e) {
    this.setData({ useDithering: e.detail.value });
    this.savePrefs();
  },

  // 背景填充白色开关：透明像素是否映射为当前色卡白色并计入材料
  // 默认关闭（透明=空位，符合拼豆"背景不用拼"的直觉）；开启后透明区拼成白色背景
  onFillBackgroundChange(e) {
    const value = e.detail.value;
    this.setData({ fillBackgroundWhite: value });
    // 透明语义变化影响预估口径（false=剔除透明空格 / true=透明拼白珠），切换后刷新预估
    this.updateEstimate();
    try {
      wx.setStorageSync('pref_fillBackgroundWhite', value);
    } catch (err) {
      log.warn('保存背景填充偏好失败（配额满）:', err);
    }
  },

  // 保存偏好
  savePrefs() {
    try {
      wx.setStorageSync('bead_prefs', {
        beadSize: this.data.beadSize,
        beadType: this.data.beadType,
        colorCount: this.data.colorCount,
        useDithering: this.data.useDithering
      });
    } catch (err) {
      log.warn('保存偏好失败（配额满）:', err);
    }
  },

  // 切换高级选项展开/折叠
  toggleAdvanced() {
    this.setData({ isAdvancedOpen: !this.data.isAdvancedOpen });
  },

  // ===== 核心：生成拼豆模板 =====
  generateTemplate() {
    if (this.data.generating || !this.data.imagePath) return;

    this.setData({
      generating: true,
      progress: 0
    });

    wx.showLoading({ title: '正在处理模板...', mask: true });

    // 使用离屏 Canvas 处理图片
    const query = wx.createSelectorQuery();
    query.select('#offscreen-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        // 页面存活守护（与下方 img.onload / img.onerror 同源）：exec 回调为异步，
        // 可能晚于 onUnload / onHide 才执行。页面已卸载或隐藏时直接清理全局遮罩、
        // 复位 generating 并返回，避免对可能已销毁的页面 setData / 误跳转，
        // 也避免给一个即将被丢弃的图片赋值 img.src。
        if (this._pageAlive === false) {
          wx.hideLoading();
          return;
        }
        if (!res[0] || !res[0].node) {
          wx.hideLoading();
          wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
          this.setData({ generating: false });
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');

        // 初始化色卡（使用用户选择的色卡）
        const selectedPalette = app.globalData.selectedPalette || 'artkal_c';
        const colorLibraries = app.globalData.colorLibraries || {};
        // 注意：此处是「色卡数据数组」，区别于模块级 colorLib（colorLibrary 模块对象），
        // 命名 paletteData 避免遮蔽模块引用导致后续误调用 colorLib.xxx() 抛 TypeError。
        const paletteData = colorLibraries[selectedPalette] || colorLibraries.artkal_c || [];
        const palette = beadEngine.initPalette(paletteData);

        // 加载图片
        const img = canvas.createImage();
        img.onload = async () => {
          // 页面存活守护：模板生成为长耗时同步计算（大图 + 中位切分 + 抖动），
          // 用户可能在图片异步加载/计算期间返回上一页或切换 tab，此时页面已卸载或隐藏。
          // 若仍执行 this.setData / wx.navigateTo / this.saveToHistory，会触发
          // "页面已卸载 setData" 告警或误跳转（把 template 页推到用户已离开的页面栈上）。
          // 入口先判页面存活：已死则仅 hideLoading 清理全局遮罩并直接返回，跳过一切页面操作。
          if (this._pageAlive === false) {
            wx.hideLoading();
            return;
          }
          try {
            // 调用核心算法生成模板（异步：按行分块让出主线程，进度条真实可见，UI 不长时间冻结）
            const templateData = await beadEngine.generateTemplate(
              canvas, img,
              {
                beadSize: this.data.beadSize,
                maxBeadWidth: this.data.templateCols,
                colorCount: this.data.colorCount,
                palette: palette,
                useDithering: this.data.useDithering,
                beadType: this.data.beadType,
                fillBackgroundWhite: this.data.fillBackgroundWhite, // 透明像素语义：false=空位 / true=当前色卡白色
                maxPixels: MAX_PIXELS,  // 行列乘积上限，防止存储溢出
                shouldCancel: () => this._pageAlive === false  // 长生成期间页面若被卸载，立即中止
              },
              (progress) => {
                this.setData({ progress });
              }
            );

            wx.hideLoading();
            this.setData({ generating: false });

            // 保存模板数据到全局，跳转到预览页
            app.globalData.currentTemplate = templateData;
            // 将原始图片路径写入模板数据，供模板页"对照原图"功能使用
            app.globalData.currentTemplate.sourceImagePath = this.data.imagePath;
            app.globalData.sourceImagePath = this.data.imagePath;
            app.globalData.beadType = this.data.beadType;

            // 保存到历史记录
            this.saveToHistory(templateData);

            // 检查页面栈深度，超过上限用 redirectTo 避免路由错误
            const pages = getCurrentPages();
            if (pages.length >= CONSTANTS.MAX_PAGE_STACK) {
              wx.redirectTo({
                url: `/pages/template/template?cols=${templateData.cols}&rows=${templateData.rows}&total=${templateData.totalBeads}`
              });
            } else {
              wx.navigateTo({
                url: `/pages/template/template?cols=${templateData.cols}&rows=${templateData.rows}&total=${templateData.totalBeads}`
              });
            }
          } catch (err) {
            wx.hideLoading();
            this.setData({ generating: false });
            // 长生成期间页面已卸载/隐藏：静默放弃，不再对已死页面跳转或提示
            if (err && err.__cancel) return;
            // 安全加固：不向用户展示内部错误详情（与 template.js P2-1 一致），仅记录到控制台
            log.error('[generateTemplate] 模板生成失败:', err);
            wx.showToast({ title: '处理失败，请重试', icon: 'none' });
          }
        };

        img.onerror = () => {
          // 同 img.onload：页面已卸载/隐藏时不再对已死页面 setData，仅清理全局遮罩 + 提示。
          if (this._pageAlive === false) {
            wx.hideLoading();
            return;
          }
          wx.hideLoading();
          this.setData({ generating: false });
          wx.showToast({ title: '图片加载失败', icon: 'none' });
        };

        img.src = this.data.imagePath;
      });
  },

  // 保存到历史记录（矩阵 RLE 压缩存储，防止本地存储溢出）
  saveToHistory(templateData) {
    const history = getTemplateHistory();

    // 持久化原图，避免 chooseMedia/压缩产生的临时路径（wxfile://tmp_...）跨会话失效，
    // 导致历史页"对照原图"打不开。复制到 USER_DATA_PATH 下的稳定路径。
    let sourceImage = null;
    const rawPath = this.data.imagePath;
    // 仅跳过真正的远程网络图片（http(s):// 真实域名）；其余本地临时路径（wxfile://tmp_、http://tmp/、USER_DATA_PATH 下的 http://store/ 等）一律复制
    if (rawPath && typeof rawPath === 'string' && !isRemoteImageUrl(rawPath)) {
      try {
        const fs = wx.getFileSystemManager();
        // 以源文件真实扩展名命名，避免"扩展名与内容不符"
        // （如相机直出的 .jpg 字节被存成 .png → 后续按扩展名处理的工具会误判格式）。
        // 源文件本身已是经 chooseMedia/压缩后的产物，扩展名与其真实格式一致。
        const extMatch = rawPath.match(/\.([a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
        const dest = wx.env.USER_DATA_PATH + '/history_source_' + Date.now() + '.' + ext;
        fs.copyFileSync(rawPath, dest);
        fs.accessSync(dest); // 确认复制成功
        sourceImage = dest;
      } catch (e) {
        // 复制失败（如配额超限）不阻断主流程，仅丢失对照原图能力
        log.warn('[saveToHistory] 持久化原图失败，将不保存原图引用:', e);
        sourceImage = null;
      }
    }

    const record = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      date: new Date().toISOString(),
      cols: templateData.cols,
      rows: templateData.rows,
      totalBeads: templateData.totalBeads,
      colorCount: templateData.colorCount,
      beadSize: templateData.beadSize,
      beadType: this.data.beadType,
      // 记录生成时使用的色卡 key，供历史查看时按"当时的色卡"还原（尤其 RLE 解码失败兜底白色用真实白色 id，避免 HAMA/Perler 错填 C01）
      paletteKey: app.globalData.selectedPalette || 'artkal_c',
      physicalWidth: templateData.physicalWidth,
      physicalHeight: templateData.physicalHeight,
      materialList: slimMaterialList(templateData.materialList),
      // RLE 压缩矩阵（替代完整二维数组，大幅减少存储体积）
      templateRLE: beadEngine.rleEncode(templateData.template),
      // 仅记录图片路径，查看时从缓存重建（无需重新请求）
      // 防御：确保路径有效，避免空字符串占位
      sourceImage: sourceImage
    };

    history.unshift(record);
    // 收集因超 MAX_HISTORY 或降级清理而需删除原图的记录（先不删，等写入成功再删，
    // 避免写入失败留下悬空引用：存储仍含该记录却已删除其原图文件）。
    const toUnlink = [];
    if (history.length > MAX_HISTORY) {
      const popped = history.pop();
      if (isManagedHistorySource(popped && popped.sourceImage)) toUnlink.push(popped.sourceImage);
    }

    // 仅在真实写入成功后才自增 historyVersion（gallery 依据版本号决定是否 reload）：
    // 若存储失败且降级清理后仍写不进，数据未变化，不能发失效信号，否则 gallery reload 读到的是旧数据。
    let saved = false;
    try {
      wx.setStorageSync('template_history', history);
      saved = true;
    } catch (e) {
      // 存储超限（10MB）时，逐步删除最旧记录直到写入成功
      log.warn('历史记录存储失败，尝试清理旧记录', e);
      while (history.length > 1) {
        const popped = history.pop();
        if (isManagedHistorySource(popped && popped.sourceImage)) toUnlink.push(popped.sourceImage);
        try {
          wx.setStorageSync('template_history', history);
          saved = true;
          break;
        } catch (e2) {
          continue;
        }
      }
      // 降级循环退出时 history 只剩 1 条：若仍从未写入成功，做最后一次写入尝试（更彻底的降级）
      if (!saved && history.length <= 1) {
        try {
          wx.setStorageSync('template_history', history);
          saved = true;
        } catch (e3) {
          log.error('历史记录存储失败：降级清理后仍无法写入', e3);
        }
      }
    }
    // 仅在写入成功后才清理被挤出记录的原图文件：写入失败则保留文件，避免悬空引用
    if (saved) {
      toUnlink.forEach((path) => {
        try { wx.getFileSystemManager().unlinkSync(path); } catch (e) {}
      });
      if (app && app.globalData) {
        app.globalData.historyVersion = (app.globalData.historyVersion || 0) + 1;
      }
    } else {
      // ⚠️ 存储写入彻底失败（配额满等）：本应写入的新记录未落盘，其 sourceImage
      // （刚复制到 USER_DATA_PATH 的 history_source_* 原图）已成孤儿——既无历史引用、
      // 又不在旧记录里，clearHistory 也删不到。必须在此立即回收，否则持续失败场景下
      // 每次生成模板都线性累积数百 KB 孤儿原图。仅回收当前记录的原图；toUnlink 中的
      // 旧记录原图保留（因旧记录仍存于存储，删了会变悬空引用）。
      if (sourceImage && isManagedHistorySource(sourceImage)) {
        try { wx.getFileSystemManager().unlinkSync(sourceImage); } catch (e) {}
      }
    }
  },

  // 页面跳转
  goToGallery() {
    wx.switchTab({ url: '/pages/gallery/gallery' });
  },
  goToProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  // 分享给朋友
  onShareAppMessage() {
    return {
      title: '拼豆大师 - 上传图片一键转换拼豆模板',
      path: '/pages/index/index'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '拼豆大师 - 上传图片一键转换拼豆模板',
      query: 'from=timeline'
    };
  }
});

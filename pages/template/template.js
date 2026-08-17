// pages/template/template.js - 模板预览与材料清单页
const app = getApp();
const beadEngine = require('../../utils/beadEngine');
const { formatNumber, formatMm, calcPercent, saveImageToAlbum, canvasToImage, debounce, removeFileIfExists, clampDisplayNumber } = require('../../utils/util');
// 安全工具：路径合法性校验（防路径遍历等注入）+ 统一脱敏日志
const { isValidFilePath, log } = require('../../utils/security');

// 缩放参数
const CELL_SIZE_STEP = 2;
const CELL_SIZE_MIN = 3;
const CELL_SIZE_MAX = 20;
// 预览默认格子尺寸（px）：data.cellSize=0 表示「未确定」，首次渲染按模板尺寸自适应。
// 自适应下限取该默认值——小模板放大、大模板保持 10（避免缩到 3 使行列号/网格/颜色编号全部消失）。
// 同时 DEFAULT_CELL_SIZE 也是 zoomPercent 的 100% 基准（Math.round(cellSize / DEFAULT_CELL_SIZE * 100)）。
const DEFAULT_CELL_SIZE = 10;

// 导出位图内存预算（约 33MB）：仅做 4096 维度限制不足以防低端机 OOM。
// 估算位图字节数（宽×高×4）超过预算则跳过该候选、直接降级到更小 cellSize，
// 避免先在低端机尝试 50MB+ 大位图导致不可恢复的 WebView 崩溃。
// 实测：120×120 @cellSize=30 → 3644×3764 ≈ 52MB（首候选即触发），@cellSize=20 → 2444×2564 ≈ 24MB（安全）。
const MAX_EXPORT_BITMAP_BYTES = 33 * 1024 * 1024;

// Canvas 单维硬上限（px）：微信/iOS Canvas 单维最大 4096px。
// 与 utils/beadEngine.js 的 DIM_HARD = 4096 同源——模板解码网格已被 rleDecode 钳制到 ≤4096，
// 故导出画布与预览画布维度上限必须与之相等；改动需三处同步（template 导出/预览 + beadEngine DIM_HARD）。
// 注：单靠 4096 维度限制仍不足以防低端机 OOM（4096×4096×4 ≈ 64MB > 33MB 预算），故叠加上面的位图内存预算。
const MAX_CANVAS_SIDE = 4096;

Page({
  data: {
    cols: 0,
    rows: 0,
    totalBeads: 0,
    colorCount: 0,
    physicalSize: '',
    materialList: [],
    sourceImagePath: '',

    // 画布参数
    // cellSize: 0 = 未确定 → renderCanvas 首次渲染时按模板尺寸自适应（小模板放大、大模板保持默认）。
    // 用户手动 zoomIn/zoomOut 后写入正数，此后不再被自适应覆盖。
    cellSize: 0,
    zoomPercent: 100,
    // 预览缩放低于导出最低清晰度（cellSize<8 ⇔ zoomPercent<80%）时给用户的澄清提示：
    // 导出候选最低即 cellSize=8（见 _generateExportImage 候选数组），导出图始终保留行列标号，
    // 不会出现"预览有标号、导出丢失"的情况。此标记仅用于消除用户困惑，不影响任何绘制逻辑。
    exportLabelHint: false,
    canvasDisplayWidth: 0,
    canvasDisplayHeight: 0,
    canvasMinX: 0,
    canvasMinY: 0,

    // 对比原图
    showCompare: false,

    // 模板数据（内部使用）
    _templateData: null,

    // 缩放防抖定时器
    _zoomTimer: null
  },

  onLoad(options) {
    // 启用分享：右上角「...」菜单显示「发送给朋友」与「分享到朋友圈」
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });

    // 重置跨页临时态：进入模板页时清掉上次会话遗留的分享图/原图路径，
    // 防止用户未重新生成分享图就直接「分享到朋友圈」，导致分享错图。
    // 集中清理逻辑统一收敛到 app.js resetTemplateState（保留 currentTemplate，待下方读取）。
    app.resetTemplateState({ clearCurrentTemplate: false });

    const templateData = app.globalData.currentTemplate;
    // 双重防御：即使 globalData 被意外写入非法值，也能在此兜住
    const template = templateData && templateData.template;
    if (!templateData || !Array.isArray(template) || !template.length || !Array.isArray(template[0])) {
      wx.showToast({ title: '模板数据无效', icon: 'none' });
      // 定时器须跟踪并在 onUnload 清理（route 竞态修复）：若用户 1.5s 内手动返回，
      // 未清理的定时器会对已卸载页面再发 navigateBack → "routeDone webviewId not found"。
      this._invalidDataTimer = setTimeout(() => {
        this._invalidDataTimer = null;
        wx.navigateBack();
      }, 1500);
      return;
    }

    // 浅拷贝：避免直接修改 app.globalData.currentTemplate（全局副作用）。
    // gallery.viewTemplate 已写入正确维度，此处仅作防御性覆盖，不污染共享状态。
    this._templateData = { ...templateData };

    // 维度闭环（修复 M2 渲染端维度与解码端不一致）：
    // rleDecode 已对 cols/rows 做硬上限钳制（safeCols×safeRows，见 beadEngine），但 stored 的
    // 声明值 item.cols 可能是脏大值（如 99999999）。若渲染端沿用声明的脏 cols 驱动 _drawBeads/
    // _drawLabels 双重循环，会跑满数亿格（越界 x 命中 undefined==null 按空位画、不抛错），
    // 预览卡死数十秒且 try/catch 兜不住（非异常，仅耗时）。故以「解码后矩阵的实际维度」为准
    // 覆盖声明值，使显示 / 预估 / 生成三者一致，循环维度始终有界。
    const realRows = template.length;
    const realCols = Array.isArray(template[0]) ? template[0].length : 0;
    if (realCols > 0 && realRows > 0) {
      this._templateData.cols = realCols;
      this._templateData.rows = realRows;
    }

    // 计算材料百分比（防御：校验 materialList 和 totalBeads；元素级 count 脏值先钳制，
    // 避免脏 count=1e20 算出 percentText="500000000000000000%" 超长串与异常占比）
    const safeMaterialList = Array.isArray(templateData.materialList) ? templateData.materialList : [];
    const materialList = safeMaterialList.map(item => {
      const safeCount = clampDisplayNumber(item.count, 20000);
      return {
        ...item,
        count: safeCount,
        percent: calcPercent(safeCount, templateData.totalBeads),
        percentText: calcPercent(safeCount, templateData.totalBeads, 1) + '%'
      };
    });

    // 计算物理尺寸
    const physicalSize = `${formatMm(templateData.physicalWidth)} × ${formatMm(templateData.physicalHeight)}`;

    this.setData({
      cols: this._templateData.cols,
      rows: this._templateData.rows,
      totalBeads: formatNumber(templateData.totalBeads),
      colorCount: templateData.colorCount,
      physicalSize,
      materialList,
      // 从当前模板数据读取图片路径，兼容 gallery 来源
      sourceImagePath: (templateData.sourceImagePath && typeof templateData.sourceImagePath === 'string' && templateData.sourceImagePath.trim() !== '')
        ? templateData.sourceImagePath : '',
      beadType: app.globalData.beadType || 'square'
    });

    wx.setNavigationBarTitle({
      // 防御：大尺寸模板标题过长时截断，如 120×100 → "模板 120×100"
      title: `模板 ${this._templateData.cols}×${this._templateData.rows}`
    });
  },

  onReady() {
    if (!this._templateData) return;
    this.renderCanvas();
  },

  onUnload() {
    if (this._zoomTimer) {
      clearTimeout(this._zoomTimer);
      this._zoomTimer = null;
    }
    if (this._invalidDataTimer) {
      clearTimeout(this._invalidDataTimer);
      this._invalidDataTimer = null;
    }
    // B30 修复：清除可能仍显示的全局 loading 遮罩。
    // saveTemplate(:518)/shareTemplate(:632) 在异步导出期间调用 wx.showLoading（全局、非页面级、
    // 不会随路由自动消失）；若用户在中途切 tab / 返回本页上一页，onUnload 触发、异步链被 _destroyed
    // 守卫提前中止，其成功/失败分支的 wx.hideLoading 不再执行 → 遮罩残留到下一页（"透明遮罩"）。
    // 故在页面销毁时显式 hideLoading 兜底，确保无残留（无 loading 时调用为无害空操作）。
    // 防御性判型：异常环境（wx 缺失/被覆盖）下不抛错，避免 onUnload 自身异常掩盖真实卸载逻辑。
    if (typeof wx !== 'undefined' && typeof wx.hideLoading === 'function') {
      wx.hideLoading();
    }
    this._templateData = null;
    this._destroyed = true;   // 标记页面已销毁，异步导出链（_generateExportImage）据此提前中止
    // 清除跨页模板态，明确 lifecycle，避免下次进入时误读上次的 currentTemplate
    // （仅清 currentTemplate；share/source 由下次 onLoad 的 resetTemplateState 统一清理）
    app.resetTemplateState({ clearCurrentTemplate: true, clearShareFile: false, clearSource: false });
  },

  // 渲染 Canvas 模板（压缩安全版本）
  renderCanvas() {
    const templateData = this._templateData;
    if (!templateData) return;

    wx.createSelectorQuery()
      .select('#template-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res[0] || !res[0].node) { log.warn('[template] renderCanvas canvas node not found'); return; }
        try {
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        let cellSize = this.data.cellSize;

        if (!cellSize || cellSize <= 0) {
          // 自适应计算的上限（非用户缩放上限）：小模板放大、大模板保持默认。
          const maxWidth = 375 - 96;
          const maxHeight = 600;
          const cellByWidth = Math.floor(maxWidth / templateData.cols);
          const cellByHeight = Math.floor(maxHeight / templateData.rows);
          const fitted = Math.max(3, Math.min(cellByWidth, cellByHeight, 15));
          // 下限取默认 10：大模板（如 120×120 算得 3）不缩小，保持行列号/网格/颜色编号可读；
          // 小模板（如 20×20 算得 13）放大。自适应仅在 cellSize 未确定（≤0）时执行，
          // 用户 zoomIn/zoomOut 写入正数后不再进入本分支（手动值不被覆盖）。
          cellSize = Math.max(DEFAULT_CELL_SIZE, fitted);
        }

        // 行列标号预留空间必须与 renderTemplate 实际绘制起点严格一致（统一走 calcLabelSpace）。
        // 此前硬编码 `cellSize >= 6 ? 30 : 0`，而引擎侧对 3 位行列数（≥100 列）在 cellSize≥10
        // 时算得 44 → 画布按 30 算、绘制却从 44 起 → 最后一行/一列画在画布外被裁（BUG-3-5 修复遗漏预览路径）。
        // showLabels 条件需与下方 renderTemplate 传入值一致（预览阈值 cellSize>=6）。
        const showLabels = cellSize >= 6;
        const labelSpace = beadEngine.calcLabelSpace(templateData.cols, templateData.rows, cellSize, showLabels);
        const canvasWidth = labelSpace + templateData.cols * cellSize;

        // 预览 canvas 必须并入底部颜色图例高度：与 beadEngine.renderTemplate 绘制公式严格同源
        // （此前预览 canvas.height 缺图例 → 整块图例被裁；导出侧 _calcExportParams 已正确并入，见 L8 修复）。
        // 条件与 renderTemplate 对齐：showColorLabels(cellSize>=5) && cellSize>=5 && 材料非空；
        // availableWidth = canvasWidth - 20（offsetX=0），与 renderTemplate 内联口径一致。
        const matCount = (templateData.materialList || []).length;
        const showColorLabels = cellSize >= 5; // 与下方 renderTemplate 传入值一致
        // 注：showColorLabels 已编码 cellSize>=5 阈值，此处 `&& cellSize >= 5` 看似冗余，但刻意与
        // beadEngine.renderTemplate(L654)/_drawLegend(L880) 的图例条件 1:1 对齐，使「预留高度=绘制高度」
        // 不变量在源码层面可肉眼校验（防 BUG-3-5 类导出/预览不一致回归），故保留而非删。
        const legendHeight = (showColorLabels && cellSize >= 5 && matCount > 0)
          ? beadEngine.calcLegendHeight(canvasWidth - 20, matCount)
          : 0;
        const canvasHeight = labelSpace + templateData.rows * cellSize + legendHeight;

        // 预览 canvas 直接赋值（不要用 defineProperty，微信内部会管理它的描述符）
        // 高 DPI 适配：backing store = CSS 像素 × devicePixelRatio（DPR），再对 ctx 做
        // scale(effDpr, effDpr)，使 renderTemplate 的全部绘制坐标仍按 CSS 像素（labelSpace/cellSize
        // 不变），输出在 DPR 2-3 真机上像素点 1:1，网格线/色号文字不再被拉伸发虚。
        // WXML 侧 CSS 尺寸（canvasDisplayWidth/Height）保持 CSS 像素，布局不受影响。
        // ⚠️ 背板尺寸钳制（修复盲区）：高 DPR 真机放大后 backing store 可能突破 iOS Safari
        // 画布硬限制（约 16.7MP / 4096 维度）→ 预览空白/黑块。导出路径已有 4096 维度 + 33MB 位图
        // 双预算（_generateExportImage:308-325），预览路径此前零防护。这里动态降 effDpr：取物理
        // dpr 与「维度上限 / CSS 尺寸」的较小值，确保任一维度 ≤ MAX_PREVIEW_SIDE；四舍五入若各超
        // 1px，按维度硬截断兜底（保证绝不越界，宁可微糊也不要空白）。
        const MAX_PREVIEW_SIDE = MAX_CANVAS_SIDE;
        const dpr = this._getDevicePixelRatio();
        let effDpr = Math.min(dpr, MAX_PREVIEW_SIDE / canvasWidth, MAX_PREVIEW_SIDE / canvasHeight);
        if (!isFinite(effDpr) || effDpr <= 0) effDpr = 1;
        let backingW = Math.round(canvasWidth * effDpr);
        let backingH = Math.round(canvasHeight * effDpr);
        if (backingW > MAX_PREVIEW_SIDE) backingW = MAX_PREVIEW_SIDE;
        if (backingH > MAX_PREVIEW_SIDE) backingH = MAX_PREVIEW_SIDE;
        canvas.width = backingW;
        canvas.height = backingH;
        // scale 用实际背板/CSS 比，与背板严格同源（含四舍五入误差），避免绘制错位
        ctx.scale(backingW / canvasWidth, backingH / canvasHeight);

        beadEngine.renderTemplate(ctx, templateData, {
          cellSize: cellSize,
          showGrid: cellSize >= 5,
          showLabels: showLabels,
          showColorLabels: cellSize >= 5,
          beadType: this.data.beadType
        });

        this.setData({
          cellSize: cellSize,
          zoomPercent: Math.round(cellSize / DEFAULT_CELL_SIZE * 100),
          exportLabelHint: cellSize < 8,   // 预览缩放低于导出最低清晰度时提示导出始终保留标号
          canvasDisplayWidth: canvasWidth,
          canvasDisplayHeight: canvasHeight
        });
        } catch (err) {
          // 渲染异常（如历史记录字段级损坏导致 renderTemplate 抛错）不应静默空白：
          // 给出明确提示，避免用户以为"预览正常但为空"。
          log.error('[template] renderCanvas 渲染异常（数据可能已损坏）:', err);
          wx.showToast({ title: '模板预览渲染失败，数据可能已损坏', icon: 'none' });
        }
      });
  },

  // 缩放（带防抖，避免快速连续触发重绘）
  // 防御：cellSize 尚未自适应（≤0，如画布未就绪时用户抢先缩放）时以默认 10 为基准，
  // 避免算出 2（低于 CELL_SIZE_MIN）等越界值；自适应/手动正数值一旦写入即按实际值缩放。
  zoomIn() {
    const base = this.data.cellSize > 0 ? this.data.cellSize : DEFAULT_CELL_SIZE;
    const newSize = Math.min(base + CELL_SIZE_STEP, CELL_SIZE_MAX);
    this.setData({ cellSize: newSize, zoomPercent: Math.round(newSize / DEFAULT_CELL_SIZE * 100), exportLabelHint: newSize < 8 });
    this._debouncedRender();
  },

  zoomOut() {
    const base = this.data.cellSize > 0 ? this.data.cellSize : DEFAULT_CELL_SIZE;
    const newSize = Math.max(base - CELL_SIZE_STEP, CELL_SIZE_MIN);
    this.setData({ cellSize: newSize, zoomPercent: Math.round(newSize / DEFAULT_CELL_SIZE * 100), exportLabelHint: newSize < 8 });
    this._debouncedRender();
  },

  // 防抖重绘（内部方法）
  _debouncedRender() {
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      this.renderCanvas();
    }, 16);
  },

  // 获取设备像素比（预览画布高 DPI 适配）
  // 优先 wx.getWindowInfo().pixelRatio（基础库 2.20.1+ 受维护 API），兼容回退
  // wx.getSystemInfoSync().pixelRatio（极旧基础库），最终兜底 1；数值非法
  // （NaN/非有限/≤0）时一律回退 1，避免 canvas backing store 尺寸异常。
  _getDevicePixelRatio() {
    try {
      let ratio = null;
      if (typeof wx.getWindowInfo === 'function') {
        ratio = wx.getWindowInfo().pixelRatio;
      } else if (typeof wx.getSystemInfoSync === 'function') {
        ratio = wx.getSystemInfoSync().pixelRatio;
      }
      return (typeof ratio === 'number' && isFinite(ratio) && ratio > 0) ? ratio : 1;
    } catch (e) {
      return 1;
    }
  },

  // 对照原图
  toggleCompare() {
    if (!this.data.sourceImagePath) {
      wx.showToast({ title: '当前模板无原图可对比', icon: 'none', duration: 2000 });
      return;
    }
    this.setData({ showCompare: !this.data.showCompare });
  },

  // ========== 导出图片公共方法 ==========

  // 计算导出 Canvas 尺寸参数（统一参数，修复与 renderTemplate 的一致性问题）
  _calcExportParams(cellSize) {
    const templateData = this._templateData;
    // 统一走 beadEngine.calcLabelSpace，确保与 renderTemplate 绘制时的标号预留空间严格一致
    // （此前 BUG-3-5 的"导出/预览 labelSpace 不一致"已随单入口彻底消除）
    // ⚠️ 导出阈值约定：导出候选数组（见 _generateExportImage）最小即 cellSize=8，故此处 `>= 8` 在
    // 实际导出路径上恒为真——导出图始终带行列标号。若未来将候选下探到 <8，标号会随之消失，
    // 需同步调低此处阈值或显式处理；不要孤立修改其中一个而忽略另一个。
    const showLabels = cellSize >= 8; // 与 _drawExportCanvas 传给 renderTemplate 的 showLabels 条件一致
    const labelSpace = beadEngine.calcLabelSpace(templateData.cols, templateData.rows, cellSize, showLabels);

    const canvasWidth = labelSpace + templateData.cols * cellSize;
    const canvasHeight = labelSpace + templateData.rows * cellSize;

    // 加上底部颜色图例的高度：统一走 beadEngine.calcLegendHeight，与 renderTemplate 绘制公式
    // 严格同源（36-80px 自适应列宽）。此前此处按固定 80px/项估算行数（多预留），而绘制侧
    // 自适应更窄 → 每张保存/分享图底部恒有 60-160px 多余白条。现二者一致，白条消除。
    // 图例条件与 renderTemplate 对齐：showColorLabels(cellSize>=8) && cellSize>=5 && 材料非空
    // （导出候选 cellSize 最小 8，恒命中；此处写全条件保证任何 cellSize 下预留=绘制）。
    const matCount = (templateData.materialList || []).length;
    const showColorLabels = cellSize >= 8; // 与 _drawExportCanvas 传入 renderTemplate 的 showColorLabels 一致
    // 注：showColorLabels 已编码 cellSize>=8 阈值（导出候选最小即 8，恒命中），此处 `&& cellSize >= 5` 看似冗余，
    // 但刻意与 beadEngine.renderTemplate(L654)/_drawLegend(L880) 的图例条件 1:1 对齐，保证「预留高度=绘制高度」
    // 不变量可肉眼校验（防 BUG-3-5 类不一致回归），故保留而非删。
    const legendHeight = (showColorLabels && cellSize >= 5 && matCount > 0)
      ? beadEngine.calcLegendHeight(canvasWidth - 20, matCount)
      : 0;

    return {
      width: canvasWidth,
      height: canvasHeight + legendHeight,
      cellSize,
      labelSpace  // 导出与绘制的标号预留空间（供参考）
    };
  },

  // 在导出 Canvas 上执行绘制
  _drawExportCanvas(canvas, params) {
    const templateData = this._templateData;
    const ctx = canvas.getContext('2d');

    // 白色背景（防透明导出成黑色）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, params.width, params.height);

    beadEngine.renderTemplate(ctx, templateData, {
      cellSize: params.cellSize,
      showGrid: true,
      // 与 _calcExportParams 同口径：因导出候选最小 cellSize=8，此处恒为真（导出始终带标号）
      showLabels: params.cellSize >= 8,
      showColorLabels: params.cellSize >= 8,
      beadType: this.data.beadType
    });
  },

  // 统一导出：逐级尝试不同 cellSize，返回 Promise<tempFilePath>
  // 注意：cellSize 越小 → 每个格子像素越少 → Canvas 尺寸越小
  // 所以 candidates 从小到大尝试是正确的（大模板从 cellSize=5 开始）
  // 扁平化：for-of 遍历候选 + try/catch 捕获单个候选失败，首个成功即返回
  async _generateExportImage({ candidates, logPrefix, failMsg }) {
    // 页面已销毁（onUnload 置 _destroyed）则立即中止：避免对已 detach 的 canvas node
    // 执行绘制 / canvasToTempFilePath（部分基础库版本会打印无法预期的告警，且 _saveBusy/_shareBusy
    // 互斥锁无法阻止「用户退出后异步链仍在跑」）。错误向上抛，由调用方 catch 收敛（无害：用户已离开页面）。
    if (this._destroyed) throw new Error('page destroyed');
    const maxSide = MAX_CANVAS_SIDE;
    for (const cellSize of candidates) {
      if (this._destroyed) throw new Error('page destroyed');   // 已销毁则不再尝试后续候选，避免重复触碰 canvas
      const params = this._calcExportParams(cellSize);

      // 超出最大限制则跳过
      if (params.width > maxSide || params.height > maxSide) {
        log.warn(logPrefix + ' size exceed limit, skip: ' + params.width + 'x' + params.height);
        continue;
      }

      // 位图内存预算：低端机对大位图敏感，仅做维度限制不足以防 OOM。
      // 估算位图字节数（宽×高×4）超过预算则跳过该候选，直接降到更小 cellSize，
      // 避免先在低端机尝试 50MB+ 大位图导致不可恢复的 WebView 崩溃。
      const estBitmapBytes = params.width * params.height * 4;
      if (estBitmapBytes > MAX_EXPORT_BITMAP_BYTES) {
        log.warn(logPrefix + ' bitmap memory exceed budget, skip: ' + params.width + 'x' + params.height + ' (' + Math.round(estBitmapBytes / 1048576) + 'MB)');
        continue;
      }

      // 过小则跳过
      if (params.width < 50 || params.height < 50) {
        log.warn(logPrefix + ' size too small, skip: ' + params.width + 'x' + params.height);
        continue;
      }

      log.info(logPrefix + ' try cellSize=' + cellSize + ' size=' + params.width + 'x' + params.height);

      try {
        const exportCanvas = await this._getExportCanvas(params, logPrefix);
        // 取得 canvas node 后再次确认页面存活（覆盖「await 期间用户退出」的竞态）
        if (this._destroyed) throw new Error('page destroyed');
        // 重置画布（设置实际像素尺寸）
        exportCanvas.width = params.width;
        exportCanvas.height = params.height;
        // 执行绘制
        this._drawExportCanvas(exportCanvas, params);
        // 导出图片（含重试）
        const path = await this._exportCanvasToImage(exportCanvas, params, logPrefix);
        if (this._destroyed) throw new Error('page destroyed');
        return path; // 首个成功候选即返回
      } catch (err) {
        log.warn(logPrefix + ' cellSize=' + cellSize + ' failed, try next: ' + (err && err.message));
      }
    }
    throw new Error(failMsg || (logPrefix + ' all candidates failed'));
  },

  // 带重试机制的获取导出 Canvas（Promise 化，消除回调嵌套）
  _getExportCanvas(params, logPrefix) {
    return new Promise((resolve, reject) => {
      const maxRetries = 3;
      const attempt = (retryCount) => {
        wx.createSelectorQuery()
          .in(this)
          .select('#export-canvas')
          .fields({ node: true, size: true })
          .exec((res) => {
            if (res && res[0] && res[0].node) {
              resolve(res[0].node);
              return;
            }
            if (retryCount < maxRetries) {
              log.warn(logPrefix + ' canvas not found, retry ' + (retryCount + 1) + '/' + maxRetries);
              // 指数退避：50ms -> 100ms -> 200ms。低端设备 canvas 初始化慢，逐次加长等待更易在第 2-3 次命中，
              // 避免固定 50ms 在慢设备上不够、在快设备上又无谓空等。
              const backoff = Math.min(50 * Math.pow(2, retryCount), 400);
              setTimeout(() => attempt(retryCount + 1), backoff);
            } else {
              log.warn(logPrefix + ' canvas not found after ' + maxRetries + ' retries');
              reject(new Error('canvas_not_found'));
            }
          });
      };
      attempt(0);
    });
  },

  // 导出 Canvas 到图片（async/await 扁平化，含 rAF fallback 与失败重试）
  async _exportCanvasToImage(exportCanvas, params, logPrefix) {
    const maxExportRetries = 3;

    for (let retry = 0; retry <= maxExportRetries; retry++) {
      try {
        // 等待绘制完成：优先 requestAnimationFrame 同步到下一帧，不可用则 setTimeout 兜底。
        // ⚠️ 安全兜底（B17）：部分基础库下 canvas.requestAnimationFrame 可能「存在但回调永不触发」
        // （离屏/异常画布状态）；若仅依赖 rAF，内层 Promise 将永久挂起 → _generateExportImage 候选循环卡死
        // → 上层 wx.showLoading({mask:true}) 永不 hideLoading，用户被永久阻塞无法恢复。
        // 故统一加安全定时器，无论如何必然 resolve（finish 幂等，正常 rAF/setTimeout 路径先到则安全定时器为 no-op）。
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          if (exportCanvas.requestAnimationFrame) {
            try {
              exportCanvas.requestAnimationFrame(() => setTimeout(finish, 100));
            } catch (e) {
              // rAF 调用同步抛错：降级走 setTimeout 兜底，避免外层 await 被 reject 触发无谓重试
              setTimeout(finish, 150);
            }
          } else {
            setTimeout(finish, 150);
          }
          // 安全兜底：rAF 存在但回调永不触发（极端场景）时，避免 await 永久挂起
          setTimeout(finish, 400);
        });

        const res = await new Promise((resolve, reject) => {
          log.info(logPrefix + ' canvas ready, calling canvasToTempFilePath...');
          wx.canvasToTempFilePath({
            canvas: exportCanvas,
            x: 0, y: 0,
            width: params.width,
            height: params.height,
            destWidth: params.width,
            destHeight: params.height,
            fileType: 'png',
            quality: 1,
            success: (r) => resolve(r),
            fail: (err) => reject(err || new Error('canvas_to_temp_failed'))
          });
        });

        // 安全校验：导出路径需为合法来源（系统临时路径，正常必通过；此处为护栏）
        if (res && res.tempFilePath && isValidFilePath(res.tempFilePath)) {
          log.info(logPrefix + ' export ok, path:', res.tempFilePath.substring(0, 60));
          return res.tempFilePath;
        }
        // success 但路径非法：原逻辑不重试，直接抛出交由候选循环切换下个候选
        log.warn(logPrefix + ' tempFilePath empty or invalid');
        throw new Error('temp_path_invalid');
      } catch (err) {
        // 路径非法不重试，立即交由候选循环接管
        if (err.message === 'temp_path_invalid') throw err;
        const msg = (err && err.errMsg) || err.message || String(err);
        if (retry < maxExportRetries) {
          log.warn(logPrefix + ' retry export ' + (retry + 1) + '/' + maxExportRetries + ': ' + msg);
          await new Promise((resolve) => setTimeout(resolve, 200));
        } else {
          throw new Error('canvas_to_temp_failed: ' + msg);
        }
      }
    }
    // 循环体在最后一次重试（retry === maxExportRetries）必走 else 分支 throw，
    // 或中途 success return；不会自然走完循环，故无需收尾 throw（旧版死代码已删除）。
  },

  // ========== 上层业务方法 ==========

  // 保存模板图片
  async saveTemplate() {
    // 互斥守卫：保存与分享共用同一 #export-canvas node，并发执行会交替改写
    // canvas.width/height 与绘制 → 导出图损坏 / canvas 状态错乱。故任一方进行中都要拦截
    // （修复 H1：原仅各自守卫、互不拦截，先点保存再点分享会并发竞态）
    if (this._saveBusy || this._shareBusy) {
      log.warn('[saveTemplate] 忽略重复点击（保存或分享操作进行中，共用 canvas 互斥）');
      return;
    }
    this._saveBusy = true;
    let tempPath = null;
    let stablePath = null;

    try {
      wx.showLoading({ title: '处理图片中...', mask: true });

      const templateData = this._templateData;
      if (!templateData) {
        wx.hideLoading();
        wx.showToast({ title: '模板数据无效', icon: 'none' });
        return;
      }

      log.info('[saveTemplate] start generating export image...');
      tempPath = await this._generateExportImage({
        candidates: [50, 40, 30, 25, 20, 18, 15, 12, 10, 8],
        logPrefix: '[saveTemplate]',
        failMsg: '图片处理失败，请重试'
      });

      log.info('[saveTemplate] image generated, tempPath:', tempPath.substring(0, 60));

      // 立即持久化临时文件，防止失效
      try {
        const fs = wx.getFileSystemManager();
        const savedPath = wx.env.USER_DATA_PATH + '/bead_export_' + Date.now() + '.png';
        await new Promise((resolve, reject) => {
          fs.saveFile({
            tempFilePath: tempPath,
            filePath: savedPath,
            success: () => {
              log.info('[saveTemplate] file persisted:', savedPath);
              stablePath = savedPath;
              resolve();
            },
            fail: (err) => {
              log.error('[saveTemplate] persist failed:', err);
              // 正式版不再 fallback 到临时路径，直接报错
              reject(new Error('图片持久化失败，无法保存到相册'));
            }
          });
        });
      } catch (e) {
        log.error('[saveTemplate] persist exception:', e);
        throw new Error('图片持久化失败，请重试');
      }

      log.info('[saveTemplate] start saving to album, final path:', stablePath.substring(0, 60));

      await saveImageToAlbum(stablePath);

      // 导出图已存入相册，本地中间副本（bead_export_*.png）即可删除，避免 USER_DATA_PATH 配额累积
      removeFileIfExists(stablePath);

      wx.hideLoading();
      wx.showToast({ title: '已保存到相册', icon: 'success' });
      log.info('[saveTemplate] save success');

    } catch (e) {
      wx.hideLoading();
      // ⚠️ 失败清理：若已持久化导出副本（stablePath 已赋值）但后续保存相册失败，
      // 必须回收该 1-4MB 中间副本（bead_export_*.png），否则权限被拒/用户取消导致
      // 同会话反复重试都重新生成并累积，直到重启才被 gcBeadTempFiles 兜底清掉，
      // 期间可能触发持久化失败，与「持久化失败治理（BUG-10）」目标冲突。
      // 仅清 stablePath；tempPath 是系统临时文件，由微信自行回收，无需处理。
      if (stablePath) removeFileIfExists(stablePath);
      const errMsg = (e && (e.errMsg || e.message || String(e))) || '';
      const errStr = String(e);
      log.error('[saveTemplate] failed, full error:', e);
      log.error('[saveTemplate] error message:', errMsg);
      log.error('[saveTemplate] error string:', errStr);

      // 根据错误类型给出不同提示
      if (errStr.indexOf('user_cancel') >= 0 || errMsg.indexOf('user_cancel') >= 0) {
        wx.showToast({ title: '请允许保存到相册', icon: 'none', duration: 2500 });
      } else if (errStr.indexOf('auth_deny') >= 0 || errMsg.indexOf('auth_deny') >= 0) {
        wx.showToast({ title: '请允许保存到相册', icon: 'none', duration: 2500 });
      } else if (errStr.indexOf('图片持久化失败') >= 0 || errMsg.indexOf('图片持久化失败') >= 0) {
        wx.showToast({ title: '图片保存失败，请重试', icon: 'none', duration: 2500 });
      } else if (errStr.indexOf('无法打开设置') >= 0 || errMsg.indexOf('无法打开设置') >= 0) {
        wx.showToast({ title: '无法打开设置页，请手动开启权限', icon: 'none', duration: 2500 });
      } else if (errStr.indexOf('invalid_file_path') >= 0 || errMsg.indexOf('invalid_file_path') >= 0) {
        wx.showToast({ title: '图片路径无效，请重试', icon: 'none', duration: 2500 });
      } else if (errStr.indexOf('all candidates failed') >= 0 || errStr.indexOf('图片处理失败') >= 0) {
        wx.showToast({ title: '图片处理失败，请重试', icon: 'none', duration: 2500 });
      } else if (errStr.indexOf('save_failed') >= 0 || errMsg.indexOf('save_failed') >= 0) {
        // 保存到相册失败，隐藏具体错误信息（安全加固：不暴露系统错误详情）
        wx.showModal({
          title: '保存失败',
          content: '无法保存到相册，请检查相册权限设置后重试。',
          showCancel: false,
          confirmText: '我知道了'
        });
      } else {
        // 所有其他错误：统一提示（安全加固：不暴露具体错误堆栈）
        wx.showModal({
          title: '保存失败',
          content: '保存过程中出现异常，请重试。如问题持续，请联系客服。',
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } finally {
      this._saveBusy = false;
    }
  },

  // 分享：制作分享图并启用分享菜单
  async shareTemplate() {
    // 互斥守卫：保存与分享共用同一 #export-canvas node，并发执行会交替改写
    // canvas.width/height 与绘制 → 导出图损坏 / canvas 状态错乱。故任一方进行中都要拦截
    // （修复 H1：原仅各自守卫、互不拦截，先点分享再点保存会并发竞态）
    if (this._saveBusy || this._shareBusy) {
      log.warn('[shareTemplate] 忽略重复点击（保存或分享操作进行中，共用 canvas 互斥）');
      return;
    }
    this._shareBusy = true;
    try {
      wx.showLoading({ title: '制作分享图...', mask: true });

      const templateData = this._templateData;
      if (!templateData) {
        wx.hideLoading();
        wx.showToast({ title: '制作分享图失败', icon: 'none' });
        return;
      }

      const tempPath = await this._generateExportImage({
        candidates: [40, 30, 25, 20, 15, 12, 10, 8],
        logPrefix: '[shareTemplate]',
        failMsg: '制作分享图失败，请重试'
      });

      // 先记下旧分享图路径，待新图写入成功后再删（先删后写会留下悬空引用）
      const oldSharePath = (app.globalData.shareImagePath && app.globalData.shareImagePath.indexOf('bead_share_') !== -1 && isValidFilePath(app.globalData.shareImagePath)) ? app.globalData.shareImagePath : null;
      let newSharePath = '';
      let stablePath = '';
      try {
        const fs = wx.getFileSystemManager();
        stablePath = wx.env.USER_DATA_PATH + '/bead_share_' + Date.now() + '.png';
        await new Promise((resolve, reject) => {
          fs.saveFile({
            tempFilePath: tempPath,
            filePath: stablePath,
            success: () => { newSharePath = stablePath; resolve(); },
            fail: (err) => { reject(new Error('分享图保存失败，请重试')); }
          });
        });
      } catch (e) {
        // 持久化失败清理分两步：
        // ① 刚尝试写入的 stablePath 可能已留下半成品/0字节文件（磁盘异常、部分写入、WX_WRITE 模式），
        //    必须显式删除，否则 bead_share_*.png 会在反复重试中累积逼近 USER_DATA_PATH 配额
        //    （与 saveTemplate 的「持久化失败治理（BUG-10）」目标一致）。
        // ② 旧分享图 oldSharePath 由 resetTemplateState 的 clearShareFile 分支统一删除
        //    （app.js:173-178 以 g.shareImagePath 此刻仍指向的 oldSharePath 为入参），写前旧图不残留。
        if (stablePath) removeFileIfExists(stablePath);
        // 集中清理：删除旧分享图 + 清空指针（保留 source/currentTemplate），让微信回退当前页默认截图
        // （_validShareImage 遇空串返回 {}），避免指向已被删除的旧文件导致朋友圈 imageUrl 失效。
        app.resetTemplateState({ clearCurrentTemplate: false, clearSource: false });
        log.error('[shareTemplate] persist failed:', e);
        throw new Error('分享图保存失败，请重试');
      }
      // 新图写入成功后再删除旧图（避免写入失败留下悬空引用）
      if (oldSharePath) removeFileIfExists(oldSharePath);
      app.globalData.shareImagePath = newSharePath;

      wx.hideLoading();
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
      wx.showModal({
        title: '分享模板',
        content: '分享图已就绪，点击右上角「...」→「发送给朋友」或「分享到朋友圈」即可分享',
        showCancel: false,
        confirmText: '我知道了'
      });

    } catch (e) {
      wx.hideLoading();
      log.warn('[shareTemplate] failed:', e);
      wx.showToast({ title: '制作分享图失败，请重试', icon: 'none' });
      // 修复 #7 根因：原先仅弹 toast 而不 re-throw，导致 shareTemplate 永远是 resolve，
      // 调用方无法经 .catch() 感知失败（如配额不足时文件未写入却误判成功）。
      // 此处 re-throw，让 Promise 在失败时正确 reject；toast 仍保留作为用户侧提示。
      throw e;
    } finally {
      this._shareBusy = false;
    }
  },

  // 按钮点击入口：包裹 shareTemplate，消费其 reject，避免 bindtap 触发未处理的
  // promise rejection 告警；错误已在 shareTemplate 内以 toast 告知用户。
  // 注意：若需以编程方式调用并自行处理失败，请直接 await this.shareTemplate().catch(...)，
  // 不要经由本包裹层（它刻意吞掉异常仅做告警兜底）。
  onShareTap() {
    this.shareTemplate().catch(() => {});
  },

  // 仅在存在有效分享图时才设置 imageUrl；空串/未生成时移除该字段，
  // 让微信回退到当前页默认截图（imageUrl: '' 在部分基础库版本会渲染空图而非回退截图）。
  _validShareImage() {
    const p = app.globalData.shareImagePath;
    return (p && typeof p === 'string' && p.trim() !== '') ? { imageUrl: p } : {};
  },

  // 分享给朋友
  onShareAppMessage() {
    const cols = this.data.cols;
    const rows = this.data.rows;
    return Object.assign({
      title: '我用拼豆大师制作了一个 ' + cols + '×' + rows + ' 的模板！',
      path: '/pages/index/index'
    }, this._validShareImage());
  },

  // 分享到朋友圈（注意：朋友圈分享图需要使用永久路径，不支持临时路径）
  onShareTimeline() {
    const cols = this.data.cols;
    const rows = this.data.rows;
    // 朋友圈分享图使用稳定的本地路径（已在 shareTemplate 中持久化）
    // 如果路径为空，微信会使用默认截图
    return Object.assign({
      title: '我用拼豆大师制作了一个 ' + cols + '×' + rows + ' 的模板！',
      query: ''
    }, this._validShareImage());
  }
});

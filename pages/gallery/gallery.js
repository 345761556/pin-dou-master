// pages/gallery/gallery.js - 作品展示页
const app = getApp();
const beadEngine = require('../../utils/beadEngine');
const colorLib = require('../../utils/colorLibrary');
const { formatMm, calcPercent, getTemplateHistory, clampDisplayNumber } = require('../../utils/util');
// 统一脱敏日志
const { log, isManagedHistorySource } = require('../../utils/security');

// 展示层脏数据钳制上限：合法模板 ≤120×120=14400 珠（留宽松余量）；
// 物理尺寸 ≤100m 远超正常成品（如 120 列×5mm≈0.6m），脏记录 1e20 将被截断到该上限，
// 避免顶部信息栏/卡片显示超长串（属展示防护，不影响业务逻辑与存储）。
const DISPLAY_MAX_BEADS = 20000;
const DISPLAY_MAX_MM = 100000;
// 维度上限与 rleDecode 硬上限（DIM_HARD=4096）一致：合法解码模板 cols/rows 均 ≤4096，
// 脏声明值（如 99999999）钳到该上限，避免卡片角标显示超长串（纯展示防护）。
const DISPLAY_MAX_DIM = 4096;

Page({
  data: {
    historyList: []
  },

  onLoad() {
    // 启用分享：右上角「...」菜单显示「发送给朋友」与「分享到朋友圈」
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
  },

  // ⚠️ 契约（第十六轮审查 R5 固化）：onShow 的 changed 判断依赖 historyVersion
  // 「每次变更必然改变值」——三处写入点（本页 deleteTemplate / index saveToHistory /
  // profile clearHistory）均为 (v||0)+1 严格自增。勿改为取模/随机值等可能撞值的方案，
  // 否则 !== 判断会漏报变更、5s 防抖窗口内读到陈旧列表。
  onShow() {
    // 5 秒内不重复加载，避免从 template 页返回时频繁读 Storage；
    // 但若历史数据已变更（生成新模板 / 清空历史 / 删除记录），版本号自增，必须立即刷新，
    // 否则 5s 内切回会显示陈旧列表。
    const now = Date.now();
    const changed = app && app.globalData && app.globalData.historyVersion !== this._lastHistoryVersion;
    if (changed || !this._lastLoadTime || now - this._lastLoadTime > 5000) {
      this.loadHistory();
      this._lastLoadTime = now;
      this._lastHistoryVersion = app && app.globalData ? app.globalData.historyVersion : undefined;
    }
    // 从 template 页返回（navigateBack → 本页 onShow）：复位导航守卫，允许再次点击查看
    this._viewNavBusy = false;
  },

  // 加载历史记录
  loadHistory() {
    const history = getTemplateHistory();

    // 格式化数据
    const formattedList = history.map(item => {
      // 构建颜色预览条（防御：totalBeads为0时报除零；materialList 可能为脏数据对象而非数组，
      // 仅 || [] 无法兜住对象，需 Array.isArray 判型，否则 .slice 抛错拖垮页面）
      const materialList = Array.isArray(item.materialList) ? item.materialList : [];
      // 色条占比：与同 map 的 totalBeads/colorCount 等一致走钳制值，避免脏 count/totalBeads 拖出
      // width: 500000000000000000% 布局异常（脏 count 大）或塌缩 0%（脏 totalBeads 大）；
      // 占比语义恒 ≤100%，即便数据正常也封顶（与 calcPercent 除零兜底同级兜底）。
      const safeTotal = clampDisplayNumber(item.totalBeads, DISPLAY_MAX_BEADS);
      const colorPreview = materialList.slice(0, 10).map(m => ({
        color: (m && m.color && m.color.hex) || '#CCCCCC',
        percent: Math.min(100, calcPercent(clampDisplayNumber(m && m.count, DISPLAY_MAX_BEADS), safeTotal))
      }));

      // 格式化日期（防御：无效日期显示为 '-'）
      const date = new Date(item.date);
      const isValidDate = !isNaN(date.getTime());
      const dateLabel = isValidDate
        ? `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : '-';

      // 格式化尺寸（与下方 totalBeads/colorCount 一致走钳制值：
      // 脏 physicalWidth/Height 先收敛到 DISPLAY_MAX_MM 再 formatMm，避免超长串）
      const sizeLabel = `${formatMm(clampDisplayNumber(item.physicalWidth, DISPLAY_MAX_MM))} × ${formatMm(clampDisplayNumber(item.physicalHeight, DISPLAY_MAX_MM))}`;

      // 仅显式挑选展示所需字段，避免 ...item 把 templateRLE（RLE 压缩矩阵，可达数 KB）、
      // 完整 template 数组、materialList、sourceImage 等重字段一并塞进 data.historyList。
      // 历史列表只用于卡片展示（id/cols/rows/totalBeads/colorCount/dateLabel/colorPreview/sizeLabel）；
      // 查看/删除均按 id 或 index 直接从 storage 重读完整记录（见 viewTemplate/deleteTemplate），
      // 不依赖此处的展开，故安全剔除重字段（m5：省去约 50 条 × 数 KB 的无用驻留）。
      return {
        id: item.id,
        // 展示字段钳制：脏记录（如 totalBeads=1e20）收敛到上限，卡片不再显示超长串
        totalBeads: clampDisplayNumber(item.totalBeads, DISPLAY_MAX_BEADS),
        colorCount: clampDisplayNumber(item.colorCount, DISPLAY_MAX_BEADS),
        // 卡片角标维度钳制（L4）：脏声明 cols/rows（如 99999999×4）收敛到 DIM 上限，覆盖原始展开值
        cols: clampDisplayNumber(item.cols, DISPLAY_MAX_DIM),
        rows: clampDisplayNumber(item.rows, DISPLAY_MAX_DIM),
        colorPreview,
        dateLabel,
        sizeLabel
      };
    });

    this.setData({ historyList: formattedList });
  },

  // 查看模板（从 RLE 压缩数据还原矩阵）
  viewTemplate(e) {
    // 防快速连点触发重复 navigateTo（route 竞态：routeDone webviewId not found）
    if (this._viewNavBusy) return;
    const dataset = e.currentTarget.dataset || {};
    const history = getTemplateHistory();
    // 按 id 定位（与 deleteTemplate 口径统一）：列表渲染与 storage 数据在极小窗口下可能错位
    // （如 onShow 刷新前删除/其它页面改写过 history），按 id 取记录不受索引位移影响。
    // 兼容兜底：无 dataset.id（旧调用方/测试直调）时回落按 index 取。
    let item;
    if (dataset.id != null) {
      const idStr = String(dataset.id);
      item = history.find(h => String(h.id) === idStr);
    } else if (dataset.index != null) {
      item = history[Number(dataset.index)];
    }

    if (!item) return;

    try {
      // 从 RLE 还原完整矩阵（空位哨兵还原为 null，缺失格同样视为空位，不误填白色）
      const template = item.templateRLE
        ? beadEngine.rleDecode(item.templateRLE, item.cols, item.rows)
        : (item.template || []); // 兼容旧记录

      // 维度以解码后矩阵为准（修复 M2 渲染端维度与解码端不一致）：
      // rleDecode 已钳制维度（safeCols×safeRows），但声明值 item.cols/rows 可能为脏大值（如 99999999）。
      // 回写真实维度，避免下游（template 页渲染/导出）按脏维度跑满循环卡死预览。
      const realRows = template.length;
      const realCols = (realRows > 0 && Array.isArray(template[0])) ? template[0].length : (item.cols || 0);

      // 用独立 key 存储历史记录的图片路径，避免与当前模板的 sourceImagePath 冲突
      app.globalData.currentTemplate = {
        template,
        cols: realCols,
        rows: realRows,
        // 展示/消费字段钳制：脏记录（如 totalBeads=1e20、physicalWidth=1e20）收敛到上限，
        // 避免 template 页顶部信息栏显示异常大数/非法尺寸
        totalBeads: clampDisplayNumber(item.totalBeads, DISPLAY_MAX_BEADS),
        colorCount: clampDisplayNumber(item.colorCount, DISPLAY_MAX_BEADS),
        // 其余展示字段都钳制了，materialList 漏了 Array.isArray：脏记录若是对象/字符串，
        // template 页 `(materialList || []).length` 会拿字符串长度/对象 length 参与图例
        // 高度计算（异常大图例）。统一收敛为数组，与其它字段同口径。
        materialList: Array.isArray(item.materialList) ? item.materialList : [],
        physicalWidth: clampDisplayNumber(item.physicalWidth, DISPLAY_MAX_MM),
        physicalHeight: clampDisplayNumber(item.physicalHeight, DISPLAY_MAX_MM),
        beadSize: clampDisplayNumber(item.beadSize, DISPLAY_MAX_MM),
        sourceImagePath: (item.sourceImage && typeof item.sourceImage === 'string' && item.sourceImage.trim() !== '')
          ? item.sourceImage : ''
      };
      app.globalData.beadType = item.beadType || 'square';

      // safeTotal 仅作 URL 传参的展示/消费值，必须本地定义（不可引用 loadHistory 的 map 局部变量）；
      // 与写入 globalData.currentTemplate.totalBeads 一致走钳制，避免脏记录大数拖入 template 页
      const safeTotal = clampDisplayNumber(item.totalBeads, DISPLAY_MAX_BEADS);

      // 防快速连点：两次 navigateTo 竞态会使第二次路由找不到 webview
      // （"routeDone webviewId not found"）。守卫在 onShow（返回本页）时复位。
      this._viewNavBusy = true;
      wx.navigateTo({
        url: `/pages/template/template?cols=${realCols}&rows=${realRows}&total=${safeTotal}`,
        // 导航失败（页面栈满 / 重复跳转 / 权限被拒等）立即复位守卫：异步 fail 不会进入上方 catch，
        // 且此刻仍停留本页、不会触发 onShow 复位，若不复位则后续所有点击查看都被入口守卫拦截。
        fail: () => {
          this._viewNavBusy = false;
          wx.showToast({ title: '打开失败，请重试', icon: 'none' });
        }
      });
    } catch (e) {
      this._viewNavBusy = false; // 解码失败未发生跳转，立即复位允许重试
      log.warn('RLE 解码失败，已跳过该记录:', item.id, e);
      wx.showToast({ title: '数据异常，无法查看', icon: 'none' });
    }
  },

  // 删除模板
  deleteTemplate(e) {
    const id = e.currentTarget.dataset.id;
    // dataset.id 在部分真机/基础库版本下会被转为字符串，而存储的 item.id 为 Date.now() 数字；
    // 双向统一转 String 比较，否则 item.id(数字) === id(字符串) 恒 false → 静默删除失败却仍提示“已删除”
    const idStr = String(id);

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个模板吗？',
      success: (res) => {
        if (res.confirm) {
          const history = getTemplateHistory();
          // 找出所有 id 匹配的记录（防御存量同 id 数据：id 曾为 Date.now() 毫秒值，同毫秒可产生多条同 id 记录）
          const matches = history.filter(item => String(item.id) === idStr);
          if (matches.length === 0) {
            // 未匹配到任何记录（id 不一致或数据异常），不应误报“已删除”
            wx.showToast({ title: '未找到该模板', icon: 'none' });
            return;
          }
          const newHistory = history.filter(item => String(item.id) !== idStr);
          try {
            wx.setStorageSync('template_history', newHistory);
          } catch (e) {
            // 配额满等写入失败：存储未变化，不自增版本号、不刷新、不误报“已删除”
            log.warn('删除模板存储写入失败（配额满）:', e);
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
            return;
          }
          // 写入成功后再清理原图文件，避免写入失败留下悬空引用（存储残留记录指向已删文件）
          matches.forEach((item) => {
            if (isManagedHistorySource(item && item.sourceImage)) {
              try { wx.getFileSystemManager().unlinkSync(item.sourceImage); } catch (e) {}
            }
          });
          // 通知自身（及其它页面）数据已变更：历史版本号自增，避免 onShow 的 5s 防抖读到陈旧列表
          if (app && app.globalData) {
            app.globalData.historyVersion = (app.globalData.historyVersion || 0) + 1;
          }
          // P2-1 修复：loadHistory 内部 getTemplateHistory/setData 在存储损坏/页面已销毁时可能抛错；
          // showModal success 回调的异步上下文无外层 try-catch，须在此显式兜底，
          // 否则未捕获异常 → 用户无反馈、版本号已自增、列表陈旧。
          try {
            this.loadHistory();
          } catch (e) {
            log.warn('删除后刷新历史记录失败:', e);
            wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none' });
            return;
          }
          wx.showToast({ title: '已删除', icon: 'success' });
        }
      }
    });
  },

  // 跳转到创作页
  goCreate() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 分享给朋友
  onShareAppMessage() {
    return {
      title: '拼豆格子 - 上传图片一键转换拼豆模板',
      path: '/pages/index/index'
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '拼豆格子 - 上传图片一键转换拼豆模板',
      query: 'from=gallery'
    };
  }
});

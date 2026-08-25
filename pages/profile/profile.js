// pages/profile/profile.js - 个人中心页
const app = getApp();
const beadEngine = require('../../utils/beadEngine');
const colorLib = require('../../utils/colorLibrary');
const { validateImageFile, getTemplateHistory, compressImageIfNeeded, getImageInfoWithTimeout, CONSTANTS, clampDisplayNumber, removeFileIfExists, safeShowLoading, safeHideLoading } = require('../../utils/util');
const { isManagedHistorySource, log } = require('../../utils/security');
// 内容安全检测（色号识别图 / 头像上传场景，对接微信 mediaCheckAsync）
const secCheck = require('../../utils/secCheck');

Page({
  data: {
    hasUserInfo: false,
    userInfo: null,
    totalTemplates: 0,
    totalBeads: 0,
    totalColors: 0,
    colorChart: [],
    showColorPicker: false,
    paletteList: [],
    selectedPalette: 'artkal_c',
    pickerImagePath: '',
    pickerImageInfo: null,
    pickedColor: null,
    pickerHistory: [],
    showProfileEdit: false,
    editAvatarUrl: '',
    editNickName: ''
  },

  onLoad() {
    // 检查登录状态（仅读取存储的必要字段，不暴露完整 userInfo 对象）
    // 优先读取新格式，向后兼容旧版 userInfo 键名
    let storedInfo = null;
    // 安全读取登录态：wx.getStorageSync 在存储损坏/序列化异常时会抛错，包裹后
    // 失败回退未登录（不影响其余 onLoad 逻辑），避免整页 onLoad 因裸调用抛错而白屏。
    try { storedInfo = wx.getStorageSync('userInfo_safe'); } catch (e) { log.warn('读取 userInfo_safe 失败，回退未登录:', e); }
    if (storedInfo && storedInfo.nickName) {
      this.setData({ hasUserInfo: true, userInfo: storedInfo });
    } else {
      // 向后兼容：尝试读取旧版 userInfo 键，迁移数据后删除
      let oldInfo = null;
      // 安全读取旧版 userInfo 键（向后兼容迁移）：同样包裹，存储异常不影响新格式已登录用户
      try { oldInfo = wx.getStorageSync('userInfo'); } catch (e) { log.warn('读取 userInfo 失败:', e); }
      if (oldInfo && oldInfo.nickName) {
        const safeInfo = { nickName: oldInfo.nickName, avatarUrl: oldInfo.avatarUrl || '' };
        // 唯一副本保护：仅在新键 userInfo_safe 写成功后才删旧键。写失败时保留旧键 userInfo，
        // 用户资料唯一副本不丢失，下次启动 onLoad 重试迁移；本次会话以内存登录态（safeInfo）运行。
        let migrated = false;
        try { wx.setStorageSync('userInfo_safe', safeInfo); migrated = true; } catch (e) { log.warn('迁移 userInfo 持久化失败，保留旧键待下次重试:', e); }
        // 删除同样包裹：removeStorageSync 抛错不应中断 onLoad（否则 loadPaletteList 等后续逻辑无法执行）
        if (migrated) {
          try { wx.removeStorageSync('userInfo'); } catch (e) { log.warn('清理旧版 userInfo 失败（不影响使用）:', e); }
        }
        this.setData({ hasUserInfo: true, userInfo: safeInfo });
      }
    }

    // 加载色卡列表和当前色卡
    this.loadPaletteList();
  },

  onShow() {
    this._pageAlive = true;   // 标记页面存活，供异步链路（取色 pickColorAtPoint）判断是否需要提前中止
    this.loadStats();
  },

  onHide() {
    // tab 页切换走 onHide（非 onUnload）；切走期间若取色异步链仍在跑，
    // 后续 query.exec / img.onload 回调据此提前 return，避免在隐藏页 setData 触发告警。
    this._pageAlive = false;
  },

  // 加载色卡列表和当前色卡颜色
  loadPaletteList() {
    const palette = colorLib.getCurrentPaletteKey();
    this.setData({
      paletteList: colorLib.getPaletteList(),
      selectedPalette: palette,
      colorChart: colorLib.getCurrentColors()
    });
  },

  // 加载统计数据
  loadStats() {
    const history = getTemplateHistory();
    const totalTemplates = history.length;
    // 展示字段钳制（与 gallery 同款）：脏记录 totalBeads=1e20 先收敛到上限再累加，
    // 避免单条脏记录污染总数统计、显示 "10000000000000000.0万" 超长串；合法数据不受影响。
    const totalBeads = history.reduce((sum, item) => sum + clampDisplayNumber(item.totalBeads, 20000), 0);
    const allColors = new Set();
    history.forEach(item => {
      // 防御字段级脏数据：materialList 可能是对象/字符串（脏数据）而非数组，
      // 仅 || [] 无法兜住 truthy 的非数组，需 Array.isArray 判型；元素可能缺 color 字段，判空避免 m.color.id 抛错拖垮页面
      const mats = Array.isArray(item.materialList) ? item.materialList : [];
      mats.forEach(m => {
        if (m && m.color && m.color.id != null) allColors.add(m.color.id);
      });
    });

    this.setData({
      totalTemplates,
      totalBeads: totalBeads > 9999 ? (totalBeads / 10000).toFixed(1) + '万' : totalBeads,
      totalColors: allColors.size
    });
  },

  // 显示资料编辑弹窗（改用 chooseAvatar + nickname 输入，替代已废弃的 getUserInfo）
  showProfileEdit() {
    const info = this.data.userInfo || {};
    this.setData({
      showProfileEdit: true,
      editAvatarUrl: info.avatarUrl || '',
      editNickName: info.nickName || ''
    });
  },

  hideProfileEdit() {
    this.setData({ showProfileEdit: false });
  },

  // 选择头像：chooseAvatar 返回临时路径，需持久化保存以免重启后失效
  // 接入内容安全检测（scene=1 资料/头像），违规图片不保存
  async onChooseAvatar(e) {
    // 防止连点头像按钮触发多个异步链并发：首个链处理中（压缩 + secCheck + 写固定 avatar.png）
    // 时忽略后续触发，避免对同一 USER_DATA_PATH/avatar.png 并发 copyFileSync 竞态覆盖。
    // 与 template.js _saveBusy/_shareBusy 互斥守卫同款机制。finally 保证所有 return 路径复位。
    if (this._avatarBusy) return;
    // 反向竞态守卫（F1）：保存链进行中（_savingBusy=true，正 await 昵称检测 1~3s，弹窗未关、
    // 无遮罩）时点「头像」，头像链会在保存链捕获 avatarUrl（saveProfile 中 const 捕获后不再重读）
    // 之后才 setData editAvatarUrl → 新头像只写进已关闭弹窗、从未持久化，静默丢失。
    // 此窗口仅数秒，入口阻断比反向挂起简单且无循环续存风险，故直接拒绝并提示稍候再换。
    if (this._savingBusy) {
      wx.showToast({ title: '保存中，请稍候再更换头像', icon: 'none' });
      return;
    }
    this._avatarBusy = true;
    try {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;

    // P3-5 修复：存活守卫——在每个 await 之后检查 _pageAlive，
    // 头像链耗时约 2-5s，期间用户切走 tab 时 onHide 置 _pageAlive=false，
    // 后续 setData 到隐藏页面会触发微信告警。
    const _aliveCheck = () => {
      if (this._pageAlive === false) {
        return true; // 页面已隐藏，应中止
      }
      return false;
    };

    // M2 修复：送检前压缩前置（与 index.chooseImage 对齐）。
    // chooseAvatar 返回的缩略图通常较小，但极端情况下原图可能 >7MB，
    // 不压缩会触发 secCheck 体积守卫跳过检测（可复现的违规图绕过路径）。
    // P1-2 修复：_compressForSecCheck 压缩失败时直接抛错（fail-closed），
    // 此处捕获后提示用户重试，不持久化、不展示；外层 finally 保证 _avatarBusy 复位。
    let checkPath;
    try {
      checkPath = await this._compressForSecCheck(tempPath);
    } catch (e) {
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
      return;
    }
    if (_aliveCheck()) {
      // P3-1 修复：存活守卫早退时清理临时文件（与 index.js:296-298 的 _pageAlive 清理口径一致）。
      // 压缩产物 checkPath 与原图 tempPath 已产生却未被清理，否则成孤儿临时文件。
      if (checkPath !== tempPath) removeFileIfExists(checkPath);
      removeFileIfExists(tempPath);
      return;
    }

    // 内容安全检测（通道不可用时内部降级放行）
    // P2-3 修复：检测链路含云存储上传 + 异步轮询，耗时数秒，加 loading 遮罩防止用户
    // 误以为无响应而重复操作；show/hide 紧贴 secCheck 调用对，保证拦截 return 路径也已关闭遮罩。
    // F3：统一走 utils/util 的 safeShowLoading/safeHideLoading（测试桩兼容守卫）。
    safeShowLoading({ title: '安全检测中...', mask: true });
    // R2 修复：检测意外 reject 时也必须关闭遮罩（mask:true 卡死防护）
    let secResult;
    try {
      secResult = await secCheck.checkImageByPath(checkPath, { scene: 1 });
    } finally {
      safeHideLoading();
    }
    if (_aliveCheck()) {
      // P3-1 修复：检测后存活守卫早退同样清理临时文件（与 :163 早退分支同口径）。
      if (checkPath !== tempPath) removeFileIfExists(checkPath);
      removeFileIfExists(tempPath);
      return;
    }
    if (!secResult.pass) {
      // 拦截原因非违规（过大/限频/服务暂不可用）时由 blockMessage 给出差异化文案
      wx.showToast({ title: secCheck.blockMessage(secResult, '头像含违规信息，请更换后重试'), icon: 'none' });
      // B15 修复：送检产生的压缩临时文件（checkPath）与原始头像临时文件（tempPath）在拦截分支一并清理。
      // 被拒头像不会被保存（下方 return 前未 copyFileSync），tempPath 是本次被拒的新图、非当前展示头像，
      // 不清理会随高频换违规头像累积临时文件（压缩失败回退原图时 checkPath===tempPath，两者为同一文件，幂等删除无副作用）。
      if (checkPath !== tempPath) removeFileIfExists(checkPath);
      removeFileIfExists(tempPath);
      return;
    }

    // 持久化到 USER_DATA_PATH 固定路径 avatar.png：每次覆盖同一文件。
    // 旧实现 fs.saveFile 不带 filePath 会不断在 saved-file 区新增孤儿文件且无法覆盖，
    // saved-file 配额（10MB）耗尽后 saveFile 失败回退临时路径 → 重启后临时路径失效，
    // 头像静默变回默认图（头像"消失"）。固定路径覆盖写不增长占用、重启依然有效。
    const fs = wx.getFileSystemManager();
    const dest = wx.env.USER_DATA_PATH + '/avatar.png';
    try {
      fs.copyFileSync(checkPath, dest);
      fs.accessSync(dest); // 确认写入成功
      this.setData({ editAvatarUrl: dest });
      // B15 修复：持久化成功后清理全部临时文件（压缩件 checkPath + 原始头像 tempPath），
      // 避免高频换头像时临时文件累积；复制失败的回退分支(catch)以 tempPath 作为当前头像，绝不清理。
      // 微信系统会自动回收临时文件，但显式清理更健壮。
      if (checkPath !== tempPath) {
        try { removeFileIfExists(checkPath); } catch (e) { /* 清理失败忽略 */ }
      }
      try { removeFileIfExists(tempPath); } catch (e) { /* 清理失败忽略 */ }
    } catch (err) {
      // 复制失败（罕见，如配额异常）：回退临时路径，本次会话可用，重启后可能失效
      this.setData({ editAvatarUrl: tempPath });
      // 压缩件 checkPath 非当前展示头像，必须清理，否则高频换头像时孤儿临时文件累积
      if (checkPath !== tempPath) {
        try { removeFileIfExists(checkPath); } catch (e) { /* 清理失败忽略 */ }
      }
      // 提示用户头像可能未持久化（重启后失效），避免「静默成功」假象
      wx.showToast({ title: '头像保存失败，请重试', icon: 'none' });
    }
    } finally {
      this._avatarBusy = false;
      // 头像链完成后，若保存期间用户点过「保存」（头像处理中），续存最新头像
      if (this._saveAfterAvatar) {
        this._saveAfterAvatar = false;
        this.saveProfile();
      }
    }
  },

  // 内容安全检测前置压缩：与 index.chooseImage 对齐，确保送检图片 ≤ DEFAULT_IMAGE_SIZE，
  // 避免 >7MB 原图触发 secCheck 体积守卫跳过检测（M2 修复：关闭 profile 的稳定检测绕过路径）。
  // P1-2 修复（fail-closed）：压缩失败不再回退原图路径——原实现把"压缩失败"（canvas 节点异常时序/
  // 解码卡死，可复现）与"图片过大"混为一谈，正式版被 secCheck 拦截但提示"图片过大请压缩"，
  // 用户按提示操作无效，两类根因的语义被旁路混淆。改为直接抛错，上层捕获后走"检测失败"提示并 return。
  async _compressForSecCheck(tempPath) {
    try {
      const processed = await compressImageIfNeeded(tempPath, CONSTANTS.DEFAULT_IMAGE_SIZE);
      return (processed && typeof processed.tempFilePath === 'string' && processed.tempFilePath) || tempPath;
    } catch (err) {
      log.error('[profile] 送检图压缩前置失败（fail-closed，不降级）:', err);
      throw new Error('image_compress_for_sec_failed');
    }
  },

  // 昵称输入
  onNicknameInput(e) {
    this.setData({ editNickName: e.detail.value });
  },

  // 昵称失焦
  onNicknameBlur(e) {
    if (e.detail.value) this.setData({ editNickName: e.detail.value });
  },

  // 微信昵称快速填充（type=nickname 的审核回调）
  // bindnicknamereview 返回 e.detail.value（真实微信昵称）；nickName 为兼容旧结构兜底
  onNicknameReview(e) {
    const v = e.detail && (e.detail.value || e.detail.nickName);
    if (v) this.setData({ editNickName: v });
  },

  // 保存资料（仅存储必要字段，避免完整 userInfo 对象泄露）
  // P1-1 修复：改为 async——昵称属用户可编辑文本（UGC），保存前须过内容安全检测
  // （msgSecCheck）。bindtap 支持 async 函数，异步化不影响 wxml 调用。
  async saveProfile() {
    // R5 修复：防重入守卫——检测/保存耗时期间重复点「保存」会并发触发多次 secCheck 与写 storage，
    // 用 _savingBusy 标志 + finally 统一复位（含 secResult 不通过等 return 路径）。
    if (this._savingBusy) return;
    // 头像异步链（压缩+检测+写盘）进行中：editAvatarUrl 仍是旧头像，立即保存会持久化旧头像并丢失新头像。
    // 挂起待 onChooseAvatar 完成后由其续存（以最新 editAvatarUrl 为准），避免并发竞态。
    if (this._avatarBusy) { this._saveAfterAvatar = true; return; }
    this._savingBusy = true;
    try {
      // L2 修复：nickName 截断到 20 字符，避免脏数据写入；默认兜底保持原语义
      const nickName = ((this.data.editNickName || '').trim() || '拼豆爱好者').slice(0, 20);
      const avatarUrl = this.data.editAvatarUrl || '';
      // P1-1 修复：昵称内容安全检测（fail-closed 与图片链路同口径）。
      // 不通过则仅提示并 return：不写 storage、不关弹窗，用户可直接修改后重试。
      const secResult = await secCheck.checkText(nickName);
      if (!secResult.pass) {
        wx.showToast({ title: secCheck.blockMessage(secResult, '昵称含违规信息，请修改'), icon: 'none' });
        return;
      }
      // 说明：nickName 经 ((editNickName||'').trim() || '拼豆爱好者').slice(0,20) 计算，恒为 truthy
      // （最小也为默认昵称）。原「!nickName && !avatarUrl」守卫的 !nickName 永为假、该守卫永不可达，
      // 属死代码——已移除，避免「写了不生效」的误导。默认昵称即「至少含昵称」语义，保存始终可继续。
      const safeInfo = { nickName, avatarUrl };
      this.setData({
        hasUserInfo: true,
        userInfo: safeInfo,
        showProfileEdit: false
      });
      try { wx.setStorageSync('userInfo_safe', safeInfo); } catch (e) { log.warn('保存 userInfo 持久化失败:', e); }
      // 清理旧版完整数据（如有）
      try { wx.removeStorageSync('userInfo'); } catch (err) {}
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      // 检测/保存链路异常兜底（fail-closed 与图片链路同口径）：不写 storage、不关弹窗、
      // 不静默——模块意外抛错（如 secCheck 封装异常）时若放任不管，用户会看到「弹窗未关、
      // 无任何提示」的静默失败。统一提示重试，用户可直接修改后再次保存。
      log.error('[saveProfile] 保存资料异常（昵称未保存，弹窗保持打开）:', err);
      wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' });
    } finally {
      this._savingBusy = false;
    }
  },

  // 跳转作品页
  goToGallery() {
    wx.switchTab({ url: '/pages/gallery/gallery' });
  },

  // 清除历史
  clearHistory() {
    wx.showModal({
      title: '确认清除',
      content: '将清除所有历史记录，此操作不可恢复',
      confirmColor: '#FF6B6B',
      success: (res) => {
        if (res.confirm) {
          const history = getTemplateHistory();
          // 先删除存储记录（最关键的一步），并包 try/catch 防止 removeStorageSync 抛错中断后续逻辑。
          // 遵循「存储删除成功后再删文件」原则（与 L4/#4 修复一致）：若存储删除失败则保留文件，
          // 避免「存储残留但文件已删」导致历史记录悬空引用（gallery 里记录仍在、对照原图全失效）。
          let storeCleared = false;
          try {
            wx.removeStorageSync('template_history');
            storeCleared = true;
          } catch (e) {
            wx.showToast({ title: '清除失败，请重试', icon: 'none' });
            return;
          }
          // 存储删除成功后，再清理已持久化到 USER_DATA_PATH 的原图文件（history_source_*.png），
          // 避免只删存储键导致原图文件残留、反复使用持续占用小程序存储配额。
          // 复用与 gallery.js 单条删除一致的 isManagedHistorySource 守卫，仅清理我们自己管理的 history_source_* 本地副本、跳过远程图与异常路径。
          if (storeCleared) {
            const fs = wx.getFileSystemManager();
            history.forEach((item) => {
              if (isManagedHistorySource(item && item.sourceImage)) {
                try { fs.unlinkSync(item.sourceImage); } catch (e) { /* 文件可能已不存在，忽略 */ }
              }
            });
          }
          // 通知 gallery 数据已变更：历史版本号自增，避免其 5s 防抖读到陈旧列表
          if (app && app.globalData) {
            app.globalData.historyVersion = (app.globalData.historyVersion || 0) + 1;
          }
          this.loadStats();
          wx.showToast({ title: '已清除', icon: 'success' });
        }
      }
    });
  },

  // ========== 色号查询 ==========

  // 显示色号查询弹窗
  showColorPicker() {
    // 复位「弹窗已关闭」标记：新一轮取色（imgEl.src 加载）应正常响应回调。
    // 该标记由 hideColorPicker 置位，用于拦截「删文件 → 迟到的 onload/onerror/超时」竞态 toast。
    this._colorPickerClosed = false;
    // 弹窗会话号递增（外部审查 #2）：关闭后立刻重开时 _colorPickerClosed 已复位 false，
    // 上一轮迟到的 onload/onerror/超时若只看该标记会在新会话弹错位 toast——
    // 回调捕获启动时的会话号，与本值不一致即「旧会话回调」，静默失效。
    this._pickerSession = (this._pickerSession || 0) + 1;
    this.setData({
      showColorPicker: true,
      pickedColor: null,
      pickerHistory: []
    });
  },

  // 关闭色号查询弹窗
  hideColorPicker() {
    const oldPath = this.data.pickerImagePath;
    // 置位「弹窗已关闭」标记：若有进行中的 imgEl.src 异步加载（取色图刚选/刚点），
    // 其 onload/onerror/超时回调据此静默放弃——下方删除取色图文件与加载存在竞态，
    // 删文件后迟到的 onerror 不应在已关闭的弹窗上弹「加载失败」。
    this._colorPickerClosed = true;
    this.setData({
      showColorPicker: false,
      pickerImagePath: '',
      pickerImageInfo: null,
      pickedColor: null
    });
    // 关闭弹窗时清理展示用取色图（checkPath 临时文件），避免每次查询遗留孤儿文件
    if (oldPath) {
      try { removeFileIfExists(oldPath); } catch (e) { /* 忽略 */ }
    }
  },

  // 上传查询图片
  uploadPickerImage() {
    // 防连点前置（与 index.chooseImage #12 同款修复）：_pickerBusy 原在 success 回调内才置位，
    // 但 wx.chooseMedia 是同步调用、success 是异步回调——快速连点会在第一个 success 到达前
    // 并发拉起两个原生选择器（重复弹窗 + 浪费 secCheck 配额）。改为入口先检查+置位，
    // success/fail 双路径复位（fail 里也必须复位，否则用户取消后 _pickerBusy 卡死）。
    if (this._pickerBusy) return;
    this._pickerBusy = true;
    const releaseBusy = () => { this._pickerBusy = false; };
    // P3-4 修复：低版本基础库（<2.10.0）无 wx.chooseMedia 时优雅降级——提示升级而非抛 TypeError。
    // 完整 chooseImage 回退需重构 120 行回调且收益极低（<2.10.0 已绝迹），故仅做友好提示兜底，
    // 与 index.js 的完整回退形成「主入口完整、次入口兜底」分层。
    if (typeof wx.chooseMedia !== 'function') {
      wx.showToast({ title: '当前微信版本过低，请升级后使用', icon: 'none' });
      releaseBusy();
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        try {
        // P2-1 修复：会话失效判定。upload 异步链（压缩+secCheck+getImageInfo，2-5s）期间
        // 弹窗可能被关闭(_colorPickerClosed)、页面切走(onHide 置 _pageAlive=false)、或关后立刻重开
        // (showColorPicker 递增 _pickerSession)。任一发生即中止本次链并静默清理，避免迟到 setData
        // 写脏隐藏页/新会话（与 pickColorAtPoint 的 _pickerSession、onChooseAvatar 的 _aliveCheck 同口径）。
        const pickerSession = this._pickerSession;
        const stale = () => this._colorPickerClosed || this._pageAlive === false || this._pickerSession !== pickerSession;
        const tempFiles = res.tempFiles || [];
        if (!tempFiles[0]) {
          wx.showToast({ title: '请选择图片', icon: 'none' });
          return;
        }

        // 校验图片（大小、格式、尺寸）
        const valid = await validateImageFile(tempFiles[0]);
        if (!valid) return;
        if (stale()) return;

        const tempFilePath = tempFiles[0].tempFilePath;

        // M2 修复：送检前压缩前置（与 index.chooseImage 对齐）。
        // 色号查询场景用户常选手机原图（3-8MB），>7MB 原图会触发 secCheck 体积守卫
        // 跳过检测，构成可复现的违规图绕过路径。压缩后 ≤800px 远小于 7MB 上限，稳定送检。
        const checkPath = await this._compressForSecCheck(tempFilePath);
        if (stale()) {
          if (checkPath !== tempFilePath) removeFileIfExists(checkPath);
          return;
        }

        // 内容安全检测（scene=2 评论/互动；通道不可用时内部降级放行）
        // P2-3 修复：加 loading 遮罩（同 onChooseAvatar 口径），show/hide 紧贴检测调用对
    // F3：统一走 utils/util 的 safeShowLoading/safeHideLoading（测试桩兼容守卫）。
    safeShowLoading({ title: '安全检测中...', mask: true });
    // R2 修复：检测意外 reject 时也必须关闭遮罩（mask:true 卡死防护）
    let secResult;
    try {
      secResult = await secCheck.checkImageByPath(checkPath, { scene: 2 });
    } finally {
      safeHideLoading();
    }
        if (!secResult.pass) {
          // 弹窗已关闭（hideColorPicker 置 _colorPickerClosed）时拦截分支静默返回：
          // 用户已放弃本次取色，toast 拦截信息无意义（弹窗已关）；文件照常清理防孤儿。
          if (stale()) {
            if (checkPath !== tempFilePath) removeFileIfExists(checkPath);
            if (tempFilePath !== checkPath) {
              try { removeFileIfExists(tempFilePath); } catch (e) { /* 忽略 */ }
            }
            return;
          }
          // 拦截原因非违规（过大/限频/服务暂不可用）时由 blockMessage 给出差异化文案
          wx.showToast({ title: secCheck.blockMessage(secResult, '图片内容含违规信息，请更换后重试'), icon: 'none' });
          // L3/[4] 对齐：送检产生的压缩临时文件在拦截分支也清理（成功分支因 checkPath 用于展示而保留）
          if (checkPath !== tempFilePath) removeFileIfExists(checkPath);
          // 原始 chooseMedia 临时文件同样不再需要（本图被拒、非当前展示），立即清理避免孤儿累积
          if (tempFilePath !== checkPath) {
            try { removeFileIfExists(tempFilePath); } catch (e) { /* 忽略 */ }
          }
          return;
        }

        // 会话失效守卫（中危 #2 + P2-1）：上传/检测（压缩+secCheck 数秒）途中弹窗关闭、
        // 页面切走(onHide 置 _pageAlive=false)、或关后立刻重开(_pickerSession 递增)任一发生，
        // 迟到回调都不应再 setData 写脏状态；checkPath 与原图 tempFilePath 一并清理——否则反复
        // 「选图途中秒关」会让 checkPath 累积成孤儿（hideColorPicker 只清理旧 pickerImagePath，新 checkPath 从未被记录）。
        if (stale()) {
          if (checkPath !== tempFilePath) removeFileIfExists(checkPath);
          if (tempFilePath !== checkPath) {
            try { removeFileIfExists(tempFilePath); } catch (e) { /* 忽略 */ }
          }
          return;
        }

        // 读取图片信息用于展示与取色（带超时：模拟器上 getImageInfo 可能挂起不回调，
        // 超时按「读取失败」提示，避免静默无响应）。await 使 chooseMedia 的 success
        // 异步链路完整等待（H1 原则：async success 内所有 await 被顶层 try-catch 覆盖）。
        try {
          const info = await getImageInfoWithTimeout(checkPath);
          const prevPath = this.data.pickerImagePath;
          this.setData({
            pickerImagePath: checkPath,
            pickerImageInfo: info
          });
          // 换图时清理上一张已展示的取色图（旧 checkPath 残留孤儿文件）
          if (prevPath && prevPath !== checkPath) {
            try { removeFileIfExists(prevPath); } catch (e) { /* 忽略 */ }
          }
          // 原始 chooseMedia 临时文件不再需要（展示/取色均用 checkPath），立即清理
          if (tempFilePath !== checkPath) {
            try { removeFileIfExists(tempFilePath); } catch (e) { /* 忽略 */ }
          }
        } catch (readErr) {
          // 弹窗已关闭：读取失败分支静默清理返回（不 toast 不 setData——弹窗已关，反馈无意义）
          if (stale()) {
            if (checkPath !== tempFilePath) removeFileIfExists(checkPath);
            if (tempFilePath !== checkPath) {
              try { removeFileIfExists(tempFilePath); } catch (e) { /* 忽略 */ }
            }
            return;
          }
          // validateImageFile 已成功读取一次，此处二次读取极罕见失败/超时需有反馈，避免点图后静默无响应
          log.warn('[profile] 展示图读取失败:', readErr);
          wx.showToast({ title: '图片读取失败，请重试', icon: 'none' });
          // 读取失败：清空展示态，避免「旧图残留 + 读取失败提示」自相矛盾让用户困惑（B10）；
          // 压缩临时图 checkPath 不再用于展示，顺手清理防累积（与 :301 拦截分支同口径）。
          this.setData({ pickerImagePath: '', pickerImageInfo: null });
          if (checkPath !== tempFilePath) removeFileIfExists(checkPath);
          // 原始 chooseMedia 临时文件同样清理（本次读取失败，不再需要）
          if (tempFilePath !== checkPath) {
            try { removeFileIfExists(tempFilePath); } catch (e) { /* 忽略 */ }
          }
        }
        } catch (err) {
          // H1 修复：async success 回调内多个 await（validateImageFile / _compressForSecCheck /
          // secCheck.checkImageByPath 等）若抛异常，会被吞成「未处理的 Promise 拒绝」——wx.chooseMedia 的
          // fail 回调只捕获 chooseMedia 自身失败，拦不到 success 内的异步异常，导致用户无任何提示、操作静默失败。
          // 顶层包 try-catch：异常时记日志 + 通用 toast，fail-closed 兜底（绝不静默吞错）。
          log.error('[uploadPickerImage] 异步处理异常（兜底未处理拒绝）:', err);
          wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
        } finally {
          releaseBusy();
        }
      },
      fail: (err) => {
        // 失败回调：避免隐私未授权等异常静默。
        // 复位 _pickerBusy：入口已前置置位，fail 路径必须复位，否则取消后卡死。
        releaseBusy();
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

  // 图片点击取色
  onPickerImageTap(e) {
    if (!this.data.pickerImagePath || !this.data.pickerImageInfo) return;

    // 统一使用 clientX/Y（屏幕坐标），与 imgRect.left/top（视口坐标）坐标系一致。
    // 注意：坐标 0 是合法值（点击落在屏幕最左/上边缘），只能做存在性判断，
    // 不能写 !tapX / !tapY（会把 0 误判为“坐标获取失败”）。
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    const tapX = touch ? touch.clientX : undefined;
    const tapY = touch ? touch.clientY : undefined;

    if (typeof tapX !== 'number' || typeof tapY !== 'number') {
      wx.showToast({ title: '坐标获取失败', icon: 'none' });
      return;
    }

    this.pickColorAtPoint(tapX, tapY);
  },

  // 在指定坐标取色
  pickColorAtPoint(tapX, tapY) {
    const { pickerImagePath, pickerImageInfo } = this.data;
    if (!pickerImagePath || !pickerImageInfo) return;

    // 获取图片的 boundingClientRect
    const query = wx.createSelectorQuery();
    query.select('.picker-image').boundingClientRect();
    query.select('#picker-canvas').fields({ node: true });
    query.exec((res) => {
      // 页面已隐藏/销毁（onHide 置 _pageAlive=false）则提前返回：避免在隐藏页 setData 触发告警。
      if (this._pageAlive === false) return;
      const imgRect = res[0];
      const canvasRes = res[1];

      if (!imgRect) {
        wx.showToast({ title: '取色失败', icon: 'none' });
        return;
      }

      // P2-7 修复：canvasRes 空值检查提前到此处（紧随 imgRect 之后），避免后续约 70 行
      // 坐标计算在 canvas 缺失时全部白执行（不依赖 canvas 的计算无意义浪费 CPU）；
      // 若 #picker-canvas 节点缺失（异常时序），用户立即看到"取色失败"提示。
      if (!canvasRes || !canvasRes.node) {
        wx.showToast({ title: '取色失败', icon: 'none' });
        return;
      }

      const imgWidth = pickerImageInfo.width;
      const imgHeight = pickerImageInfo.height;
      const viewWidth = imgRect.width;
      const viewHeight = imgRect.height;
      const viewLeft = imgRect.left;
      const viewTop = imgRect.top;

      // M1 修复：取色维度守护。脏数据（pickerImageInfo 异常）或图片元素隐藏时
      // boundingClientRect 返回 0 尺寸，会导致后续 viewRatio=viewWidth/viewHeight 除零得
      // NaN、dispW/dispH 失真、canvasW/canvasH=0 时 canvas.width 与 getImageData 越界抛异常、
      // 进而中断整个 query.exec 回调（该回调无 try/catch 包裹）。
      // 任一为 0/NaN/非正有限数即属非法，直接提示返回，不让错误继续向下传播。
      const isPositiveFinite = (n) => typeof n === 'number' && isFinite(n) && n > 0;
      if (!isPositiveFinite(imgWidth) || !isPositiveFinite(imgHeight) ||
          !isPositiveFinite(viewWidth) || !isPositiveFinite(viewHeight)) {
        wx.showToast({ title: '取色失败，请重新选择图片', icon: 'none' });
        return;
      }

      // 取色画布缩放：直接按原图尺寸建画布，在 validateImageFile 允许的最大
      // 6000px 下需约 6000×6000×4B ≈ 144MB，低端机极易 OOM 崩溃。
      // 而取色只需采样「单点」像素，故将画布缩放到 ≤1024px，再按比例换算
      // 点击坐标即可，既保证取色颜色正确又避免内存爆炸。
      const PICKER_MAX_SIDE = 1024;
      let canvasW = imgWidth;
      let canvasH = imgHeight;
      if (canvasW > PICKER_MAX_SIDE || canvasH > PICKER_MAX_SIDE) {
        const s = Math.min(PICKER_MAX_SIDE / canvasW, PICKER_MAX_SIDE / canvasH);
        canvasW = Math.max(1, Math.round(canvasW * s));
        canvasH = Math.max(1, Math.round(canvasH * s));
      } else {
        // 钳到至少 1：已被上方 isPositiveFinite 保证 >0，此处仅防御浮点取整后为 0
        canvasW = Math.max(1, Math.round(canvasW));
        canvasH = Math.max(1, Math.round(canvasH));
      }

      // 计算图片在容器中的显示尺寸（aspectFit）
      const imgRatio = imgWidth / imgHeight;
      const viewRatio = viewWidth / viewHeight;
      let dispW, dispH;
      if (imgRatio > viewRatio) {
        dispW = viewWidth;
        dispH = dispW / imgRatio;
      } else {
        dispH = viewHeight;
        dispW = dispH * imgRatio;
      }

      // 点击位置相对于图片元素的坐标
      const relX = tapX - viewLeft;
      const relY = tapY - viewTop;

      // 计算图片在 view 中的偏移
      const offsetX = (viewWidth - dispW) / 2;
      const offsetY = (viewHeight - dispH) / 2;

      // 相对图片的坐标
      const imgX = relX - offsetX;
      const imgY = relY - offsetY;

      if (imgX < 0 || imgY < 0 || imgX >= dispW || imgY >= dispH) {
        wx.showToast({ title: '请点击图片区域', icon: 'none' });
        return;
      }

      // 转换为画布像素坐标（画布已缩放到 canvasW × canvasH）
      let pixelX = Math.floor(imgX * canvasW / dispW);
      let pixelY = Math.floor(imgY * canvasH / dispH);
      // 边界安全钳制，防止浮点误差越界
      pixelX = Math.min(Math.max(0, pixelX), canvasW - 1);
      pixelY = Math.min(Math.max(0, pixelY), canvasH - 1);

      const canvas = canvasRes.node;
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext('2d');

      // 加载图片到 Canvas
      const imgEl = canvas.createImage();
      // 会话号快照：本次取色所属的弹窗会话。若回调执行前弹窗已被关闭并重开
      // （_pickerSession 递增），本回调即「旧会话迟到回调」——静默失效，不弹 toast/setData
      //（外部审查 #2：仅看 _colorPickerClosed 会被「关后立刻重开」的复位绕过）。
      const pickerSession = this._pickerSession;
      // 看门狗（与 index.js _measureTransparency 同源）：WeChat 偶发 canvas 节点销毁 / 图片解码卡死
      // 会使 onload/onerror 都永不触发，若不兜底则本次取色静默无响应（不 setData、不 toast），
      // 比崩溃更隐蔽。1.5s 超时退回提示，避免永久挂起；settled 守卫防超时与真实回调重复触发。
      let pickerSettled = false;
      const pickerTimer = setTimeout(() => {
        if (pickerSettled) return;
        pickerSettled = true;
        // 页面已隐藏/销毁（onHide/onUnload 置 _pageAlive=false）则静默退出：
        // toast 为全局 API，会在用户当前所在的其它页面上弹「取色超时」，造成跨页困惑
        // （第十轮审查 BUG-2：与下方 img.onload 的存活守卫口径对齐）。
        if (this._pageAlive === false) return;
        // 弹窗已关闭（hideColorPicker 已删取色图文件）：文件删除后图片既不会 onload 也不会
        // onerror，只能等本超时兜底——此时弹窗已关，静默退出避免误导性 toast。
        if (this._colorPickerClosed) return;
        // 会话已切换（关后重开）：旧会话的超时不在新会话弹 toast
        if (this._pickerSession !== pickerSession) return;
        wx.showToast({ title: '取色超时，请重试', icon: 'none' });
      }, 1500);

      imgEl.onerror = () => {
        if (pickerSettled) return;
        pickerSettled = true;
        clearTimeout(pickerTimer);
        // 与 img.onload / 超时分支的存活守卫口径对齐（外部审查：此前注释自称对齐实际漏了本分支）：
        // 页面已隐藏/销毁（onHide/onUnload 置 _pageAlive=false）时静默退出，避免在其它 tab 弹 toast。
        if (this._pageAlive === false) return;
        // 弹窗已关闭（hideColorPicker 清理了取色图文件）时迟到的 onerror：文件被删是预期行为，
        // 不再在已关闭的弹窗上弹「加载失败」（弹窗关闭与 imgEl.src 异步加载的竞态守卫）。
        if (this._colorPickerClosed) return;
        // 会话已切换（关后重开）：旧会话的 onerror 不在新会话弹 toast
        if (this._pickerSession !== pickerSession) return;
        wx.showToast({ title: '取色图片加载失败，请重试', icon: 'none' });
      };

      imgEl.onload = () => {
        if (pickerSettled) return;
        pickerSettled = true;
        clearTimeout(pickerTimer);
        // 图片加载完成已是异步，期间用户可能已切走页面；再次确认存活，避免在隐藏页 setData。
        if (this._pageAlive === false) return;
        // 弹窗已关闭（hideColorPicker）时晚到的 onload：取色图文件已清理、结果无处展示，
        // 直接放弃本次取色，不再对已关闭弹窗做 setData。
        if (this._colorPickerClosed) return;
        // 会话已切换（关后重开）：旧会话的 onload 不写新会话状态
        if (this._pickerSession !== pickerSession) return;
        try {
          ctx.drawImage(imgEl, 0, 0, canvasW, canvasH);

          // 获取像素颜色
          const pixel = ctx.getImageData(pixelX, pixelY, 1, 1).data;
          const r = pixel[0];
          const g = pixel[1];
          const b = pixel[2];

          // 匹配色卡
          const currentColors = colorLib.getCurrentColors();
          if (currentColors.length === 0) {
            wx.showToast({ title: '色卡为空', icon: 'none' });
            return;
          }
          const palette = beadEngine.initPalette(currentColors);
          const matched = beadEngine.matchToPalette(r, g, b, palette);
          const deltaE = this.calcDeltaEFromRGB(r, g, b, matched.r, matched.g, matched.b);
          const originalHex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

          const pickedColor = {
            originalHex,
            r, g, b,
            matchedHex: matched.hex,
            name: matched.name,
            id: matched.id,
            deltaE: deltaE.toFixed(1)
          };

          // 添加到历史（保留 r/g/b 供切换色卡时重匹配，见 onPaletteChange 的 guard）
          // ⚠️ 反模式修正：不可直接 mutate this.data，须先拷贝再 setData
          // （否则绕过 diff 机制，极端时序下引发不可预期渲染）
          const history = (this.data.pickerHistory || []).slice();
          history.unshift({
            originalHex,
            r, g, b,
            matchedHex: matched.hex,
            name: matched.name,
            id: matched.id
          });
          if (history.length > 10) history.pop();

          this.setData({ pickedColor, pickerHistory: history });
        } catch (err) {
          // 弹窗中途关闭使画布节点销毁时，drawImage / getImageData 会抛未捕获异常；
          // 同处一个 try 兜底，避免中断 onload 回调（该回调无外层 try/catch）。
          log.warn('[profile] 取色绘制/读取失败（画布可能已销毁）:', err);
          wx.showToast({ title: '取色失败，请重试', icon: 'none' });
        }
      };
      imgEl.src = pickerImagePath;
    });
  },

  // 计算 CIE76 色差（包装 beadEngine.calcDeltaE，避免与 beadEngine 导出重名）
  calcDeltaEFromRGB(r1, g1, b1, r2, g2, b2) {
    return beadEngine.calcDeltaE(r1, g1, b1, r2, g2, b2);
  },

  // 显示历史记录中的某一项
  showHistoryItem(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.pickerHistory[index];
    if (item) {
      this.setData({
        pickedColor: {
          originalHex: item.originalHex,
          // 写入 r/g/b：使 onPaletteChange 的「已查询结果重匹配」guard（pickedColor.r !== undefined）成立
          r: item.r,
          g: item.g,
          b: item.b,
          matchedHex: item.matchedHex,
          name: item.name,
          id: item.id,
          deltaE: '-'
        }
      });
    }
  },

  // 色卡切换（由 palette-selector 组件触发）
  onPaletteChange(e) {
    const key = e.detail.key;
    if (!key || key === this.data.selectedPalette) return;

    const colors = colorLib.switchPalette(key);
    // P2-1 修复：switchPalette 存储失败（配额满）时回退全局色卡并 return []，
    // 此处必须拦截——否则 UI 显示新色卡名但列表为空、globalData 仍旧值（与 index.js 同口径）。
    if (!colors || colors.length === 0) {
      wx.showToast({ title: '切换失败，请重试', icon: 'none' });
      return;
    }
    const updates = {
      selectedPalette: key,
      colorChart: colors
    };

    // 如果已有查询结果，重新匹配
    if (this.data.pickedColor && this.data.pickedColor.r !== undefined) {
      const { r, g, b } = this.data.pickedColor;
      if (colors.length > 0) {
        const palette = beadEngine.initPalette(colors);
        const matched = beadEngine.matchToPalette(r, g, b, palette);
          const deltaE = this.calcDeltaEFromRGB(r, g, b, matched.r, matched.g, matched.b);

        updates.pickedColor = {
          ...this.data.pickedColor,
          matchedHex: matched.hex,
          name: matched.name,
          id: matched.id,
          deltaE: deltaE.toFixed(1)
        };
      }
    }

    this.setData(updates);
    wx.showToast({ title: '已切换', icon: 'success' });
  },

  // 使用教程
  showTutorial() {
    wx.showModal({
      title: '使用教程',
      content: '1. 在「创作」页点击上传图片\n2. 选择拼豆规格、模板大小、颜色数量\n3. 点击「开始制作模板」\n4. 查看模板预览和材料清单\n5. 保存图片或复制材料清单\n6. 按模板拼豆，完成作品！',
      showCancel: false,
      confirmText: '我知道了'
    });
  },

  // 关于
  showAbout() {
    wx.showModal({
      title: '关于拼豆格子',
      content: '拼豆格子是一款图片转拼豆模板的工具小程序。\n\n上传任意图片，自动转换拼豆模板图、材料清单和成品尺寸。\n\n支持多种拼豆规格和颜色数量自定义，让拼豆创作更简单！\n\n版本: v1.0.0',
      // P2-5 修复：左侧按钮作为《隐私协议》查看入口（showModal 的 cancelText ≤4 字符，
      // 「隐私协议」恰好合规；无需改动 wxml/wxss，最小侵入）。确认按钮保持原「好的」。
      cancelText: '隐私协议',
      confirmText: '好的',
      success: (res) => {
        if (res.cancel) this.showPrivacyContract();
      }
    });
  },

  // 查看《隐私协议》
  // P2-5 修复：全项目原先无 wx.openPrivacyContract 调用，用户在同意前无协议阅读途径。
  // 该 API 需基础库 ≥ 2.32.3，低版本无此方法，typeof 守卫后给出升级引导而非抛错。
  showPrivacyContract() {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '当前微信版本过低，请升级微信后查看', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({
      // 打开失败（协议未配置/网络异常等）时给出反馈，避免点击后静默无响应
      fail: () => {
        wx.showToast({ title: '隐私协议打开失败，请稍后重试', icon: 'none' });
      }
    });
  }
});

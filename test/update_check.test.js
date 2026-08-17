/**
 * checkUpdate 更新弹窗体验单测（app.js）
 *
 * 覆盖场景：
 *   1. 单次注册：checkUpdate() 调用两次 → 假 manager 的 onCheckForUpdate/onUpdateReady/onUpdateFailed
 *      各只被注册一次（监听不叠加，第二次调用直接 return）
 *   2. 重复事件防抖：连续触发两次 onUpdateFailed → 只弹一个弹窗（第二次被 busy 挡掉）；
 *      弹窗关闭后 busy 复位，可再次弹出
 *   3. 失败重试流程：onUpdateFailed → 弹 [重试/取消]，点重试 → showToast 记录 + 计数递减；
 *      连续失败重试至计数耗尽 → 弹"请稍后重试"纯提示弹窗（showCancel:false，无重试按钮）
 *   4. 重试后可再弹：点重试后（busy 复位）再次 onUpdateFailed → 能再弹重试弹窗（直到耗尽）
 *   5. onUpdateReady 确认 → applyUpdate 被调用；且 busy 期间 onUpdateReady 也被防抖挡掉
 */
const path = require('path');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} => ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}
function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}`);
  cond ? pass++ : fail++;
}

// ---- mock 微信运行时 ----
let fakeManager = null;
let showModalCalls = [];
let toastCalls = [];
let modalAutoClose = true;   // true：showModal 同步回调 success/complete（模拟立即关闭）
let modalResult = { confirm: true };  // showModal success 回调的入参

function setupWx() {
  const counts = { check: 0, ready: 0, failed: 0 };
  fakeManager = {
    counts,
    handlers: {},
    applyUpdateCalls: 0,
    onCheckForUpdate(cb) { counts.check++; this.handlers.check = cb; },
    onUpdateReady(cb) { counts.ready++; this.handlers.ready = cb; },
    onUpdateFailed(cb) { counts.failed++; this.handlers.failed = cb; },
    applyUpdate() { this.applyUpdateCalls += 1; },
  };
  global.wx = {
    canIUse: (api) => api === 'getUpdateManager',
    getUpdateManager: () => fakeManager,
    showModal: (opts) => {
      showModalCalls.push(opts);
      if (modalAutoClose) {
        if (opts.success) opts.success(modalResult);
        if (opts.complete) opts.complete();
      }
    },
    showToast: (opts) => { toastCalls.push(opts); },
    // 以下仅供 app.js 其他初始化路径兜底（本测试不调用 onLaunch）
    getStorageSync: () => null,
    getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 375, windowHeight: 812, safeArea: { top: 44, bottom: 778, left: 0, right: 375 } }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, width: 87, right: 288, bottom: 80, left: 278 }),
    getFileSystemManager: () => ({ readdirSync: () => [], unlinkSync: () => {} }),
    env: { USER_DATA_PATH: '/mock/user_data' },
  };
}

let appConfig = null;
global.App = (cfg) => { appConfig = cfg; };

// 每次重新 require app.js，拿到全新 App 配置实例（避免场景间标志/计数串扰）
function loadApp() {
  appConfig = null;
  showModalCalls = [];
  toastCalls = [];
  modalAutoClose = true;
  modalResult = { confirm: true };
  setupWx();
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');
  return appConfig;
}

// 手动关闭最近一次弹窗（模拟用户点击，modalAutoClose=false 时用）
function closeLastModal(confirm) {
  const opts = showModalCalls[showModalCalls.length - 1];
  if (opts.success) opts.success({ confirm: confirm === undefined ? true : confirm });
  if (opts.complete) opts.complete();
}

// ---- 场景 1：单次注册（checkUpdate 调用两次，监听不叠加） ----
{
  const app = loadApp();
  app.checkUpdate();
  app.checkUpdate();  // 第二次应直接 return
  eq('checkUpdate 两次调用 onCheckForUpdate 只注册 1 次', fakeManager.counts.check, 1);
  eq('checkUpdate 两次调用 onUpdateReady 只注册 1 次', fakeManager.counts.ready, 1);
  eq('checkUpdate 两次调用 onUpdateFailed 只注册 1 次', fakeManager.counts.failed, 1);
}

// ---- 场景 2：重复事件防抖（连续两次 onUpdateFailed 只弹一个） ----
{
  const app = loadApp();
  app.checkUpdate();
  modalAutoClose = false;  // 模拟第一个弹窗保持打开状态
  fakeManager.handlers.failed();
  fakeManager.handlers.failed();  // busy 未复位，应被挡掉
  eq('连续两次 onUpdateFailed 只弹一个弹窗', showModalCalls.length, 1);
  // busy 期间 onUpdateReady 也被挡掉
  fakeManager.handlers.ready();
  eq('busy 期间 onUpdateReady 被防抖挡掉', showModalCalls.length, 1);
  // 关闭弹窗（取消）→ busy 复位 → 再次 failed 可再弹
  closeLastModal(false);
  fakeManager.handlers.failed();
  eq('弹窗关闭后 busy 复位可再弹', showModalCalls.length, 2);
}

// ---- 场景 3：失败重试流程（含计数耗尽） ----
{
  const app = loadApp();
  app.checkUpdate();
  modalAutoClose = false;

  // 第 1 次失败：弹 [重试/取消]
  fakeManager.handlers.failed();
  eq('首次失败弹重试弹窗', showModalCalls.length, 1);
  ok('重试弹窗含确认按钮"重试"', showModalCalls[0].confirmText === '重试');
  ok('重试弹窗含取消按钮"取消"', showModalCalls[0].cancelText === '取消');
  closeLastModal(true);  // 点重试
  eq('点重试后 showToast 记录"已重新检查"', toastCalls.length, 1);
  eq('toast 标题为"已重新检查"', toastCalls[0] && toastCalls[0].title, '已重新检查');
  eq('重试后计数递减为 1', app._updateRetryLeft, 1);

  // 第 2 次失败：仍可再弹重试弹窗（场景 4 覆盖点：重试后 busy 复位可再弹）
  fakeManager.handlers.failed();
  eq('重试后再失败仍弹重试弹窗', showModalCalls.length, 2);
  ok('第二次重试弹窗仍有"重试"按钮', showModalCalls[1].confirmText === '重试');
  closeLastModal(true);  // 点重试
  eq('第二次重试后 toast 再记录', toastCalls.length, 2);
  eq('重试后计数递减为 0', app._updateRetryLeft, 0);

  // 第 3 次失败：计数耗尽 → 纯提示弹窗（无重试按钮）
  fakeManager.handlers.failed();
  eq('计数耗尽后弹纯提示弹窗', showModalCalls.length, 3);
  ok('耗尽弹窗 showCancel === false', showModalCalls[2].showCancel === false);
  eq('耗尽弹窗文案为"请稍后重试"', showModalCalls[2].content, '新版本下载失败，请稍后重试。');
  ok('耗尽弹窗无重试按钮（confirmText 未定义）', showModalCalls[2].confirmText === undefined);
  eq('耗尽后不再弹重试弹窗', showModalCalls[2].confirmText === '重试' ? 1 : 0, 0);
}

// ---- 场景 4：重试后可再弹（独立验证 busy 复位） ----
{
  const app = loadApp();
  app.checkUpdate();
  modalAutoClose = false;

  fakeManager.handlers.failed();
  eq('初始失败弹重试弹窗', showModalCalls.length, 1);
  closeLastModal(true);  // 点重试 → busy 复位
  eq('重试后 toast 记录', toastCalls.length, 1);
  eq('重试后计数递减为 1', app._updateRetryLeft, 1);

  fakeManager.handlers.failed();
  eq('重试后再失败能再弹重试弹窗', showModalCalls.length, 2);
  ok('再弹弹窗仍为重试弹窗', showModalCalls[1].confirmText === '重试');
  closeLastModal(true);
  eq('第二次重试后计数递减为 0', app._updateRetryLeft, 0);
}

// ---- 场景 5：onUpdateReady 确认 → applyUpdate ----
{
  const app = loadApp();
  app.checkUpdate();
  modalAutoClose = true;  // 立即关闭并确认
  modalResult = { confirm: true };
  fakeManager.handlers.ready();
  eq('ready 触发弹"重启应用"弹窗', showModalCalls.length, 1);
  eq('弹窗文案为"是否重启应用"', showModalCalls[0].content, '新版本已准备好，是否重启应用？');
  eq('确认后 applyUpdate 被调用', fakeManager.applyUpdateCalls, 1);
  // busy 已复位：再触发 ready 可再次弹窗并再次确认
  fakeManager.handlers.ready();
  eq('busy 复位后 ready 可再弹', showModalCalls.length, 2);
  eq('再次确认 applyUpdate 再被调用', fakeManager.applyUpdateCalls, 2);
}

// ---- 附加：canIUse 不支持时静默返回 ----
{
  global.wx = {
    canIUse: () => false,
    getUpdateManager: () => { throw new Error('不应调用'); },
  };
  appConfig = null;
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');
  let noCrash = true;
  try { appConfig.checkUpdate(); } catch (e) { noCrash = false; }
  ok('canIUse 不支持时静默返回不抛错', noCrash === true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

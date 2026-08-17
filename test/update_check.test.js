/**
 * checkUpdate 更新弹窗体验单测（app.js）
 *
 * 覆盖场景：
 *   1. 单次注册：checkUpdate() 调用两次 → 假 manager 的 onCheckForUpdate/onUpdateReady/onUpdateFailed
 *      各只被注册一次（监听不叠加，第二次调用直接 return）
 *   2. 重复事件防抖：连续触发两次 onUpdateFailed → 只弹一个弹窗（第二次被 busy 挡掉）；
 *      弹窗关闭后 busy 复位，可再次弹出
 *   3. 失败诚实提示：onUpdateFailed → 弹纯提示弹窗（showCancel:false，确认按钮"我知道了"，
 *      文案说明检查网络并重新进入），且不调用 showToast（无假"重试"动作）
 *   4. 失败可再次提示：弹窗关闭（busy 复位）后再次 onUpdateFailed → 能再弹诚实提示弹窗，
 *      且全程不调用 showToast
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

// ---- 场景 3：失败诚实提示（无假重试动作） ----
{
  const app = loadApp();
  app.checkUpdate();
  modalAutoClose = false;

  // 失败时弹诚实提示弹窗，不提供"重试"按钮、不弹 toast
  fakeManager.handlers.failed();
  eq('失败时弹诚实提示弹窗', showModalCalls.length, 1);
  ok('提示弹窗 showCancel === false', showModalCalls[0].showCancel === false);
  ok('提示弹窗确认按钮为"我知道了"', showModalCalls[0].confirmText === '我知道了');
  eq('提示弹窗文案引导检查网络并重新进入',
    showModalCalls[0].content,
    '新版本下载失败，请检查网络后退出小程序重新进入以完成更新。');
  eq('失败提示不调用 showToast（无假重试动作）', toastCalls.length, 0);

  // 关闭弹窗（确认）→ busy 复位
  closeLastModal(true);
  eq('弹窗关闭后 busy 复位', app._updateDialogBusy, false);
}

// ---- 场景 4：失败可再次提示（冷启动重新触发 onUpdateFailed） ----
{
  const app = loadApp();
  app.checkUpdate();
  modalAutoClose = false;

  fakeManager.handlers.failed();
  eq('首次失败弹诚实提示弹窗', showModalCalls.length, 1);
  closeLastModal(true);  // 确认关闭 → busy 复位

  // 模拟冷启动后微信再次触发下载失败 → 应再次弹诚实提示，且仍无 toast
  fakeManager.handlers.failed();
  eq('再次失败能再弹诚实提示弹窗', showModalCalls.length, 2);
  ok('再弹弹窗仍为诚实提示（无重试按钮）', showModalCalls[1].confirmText === '我知道了');
  eq('全程不调用 showToast', toastCalls.length, 0);

  closeLastModal(true);
  eq('第二次关闭后 busy 复位', app._updateDialogBusy, false);
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

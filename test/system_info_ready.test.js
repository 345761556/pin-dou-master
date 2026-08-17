/**
 * systemInfoReady 订阅机制单测（app.js 防御性加固）
 *
 * 覆盖场景：
 *   1. 正常路径：onLaunch 后 statusBarHeight/navBarHeight 为真实值，systemInfoReady===true
 *   2. 已就绪后订阅：getSystemInfoReady(cb) 立即同步收到真实 globalData
 *   3. 先订阅后就绪：onLaunch 前排队，onLaunch 后回调被触发并拿到真实值
 *   4. 异常兜底路径：wx.getWindowInfo 抛异常 → 兜底值 + systemInfoReady 仍为 true + 排队回调仍触发
 *   5. 回调抛错隔离：排队回调中第一个抛错，第二个仍执行
 *   附加：非 function 入参被忽略
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
// normal=true：getWindowInfo 正常返回；normal=false：getWindowInfo 抛异常（异常兜底路径）
// menuButtonRect：自定义 getMenuButtonBoundingClientRect 返回值；缺省为正常胶囊矩形
function setupWx(normal, menuButtonRect) {
  global.wx = {
    getWindowInfo: normal
      ? () => ({ statusBarHeight: 44, windowWidth: 375, windowHeight: 812, safeArea: { top: 44, bottom: 778, left: 0, right: 375 } })
      : () => { throw new Error('mock getWindowInfo fail'); },
    getMenuButtonBoundingClientRect: () => (menuButtonRect !== undefined
      ? menuButtonRect
      : { top: 48, height: 32, width: 87, right: 288, bottom: 80, left: 278 }),
    getStorageSync: () => null,
    canIUse: () => false,
    getFileSystemManager: () => ({ readdirSync: () => [], unlinkSync: () => {} }),
    env: { USER_DATA_PATH: '/mock/user_data' },
  };
}

let appConfig = null;
global.App = (cfg) => { appConfig = cfg; };

// 每次重新 require app.js，拿到全新 App 配置实例（避免场景间 globalData/等待队列串扰）
function loadApp() {
  appConfig = null;
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');
  return appConfig;
}

// ---- 场景 1：正常路径 ----
setupWx(true);
const app1 = loadApp();
app1.onLaunch();
eq('正常路径 statusBarHeight===44', app1.globalData.statusBarHeight, 44);
eq('正常路径 navBarHeight===84', app1.globalData.navBarHeight, 84);
eq('正常路径 systemInfoReady===true', app1.globalData.systemInfoReady, true);

// ---- 场景 2：已就绪后订阅，立即同步回调 ----
setupWx(true);
const app2 = loadApp();
app2.onLaunch();
let sync2 = false;
let got2 = null;
app2.getSystemInfoReady((gd) => { sync2 = true; got2 = gd; });
ok('已就绪后订阅为立即同步回调', sync2 === true);
eq('回调收到真实 statusBarHeight(44)', got2 && got2.statusBarHeight, 44);

// ---- 场景 3：先订阅后就绪 ----
setupWx(true);
const app3 = loadApp();
let called3 = 0;
let gd3 = null;
app3.getSystemInfoReady((gd) => { called3++; gd3 = gd; });
ok('onLaunch 前订阅已入队（尚未触发）', called3 === 0);
app3.onLaunch();
eq('onLaunch 后排队回调被触发', called3, 1);
eq('排队回调拿到真实 statusBarHeight(44)', gd3 && gd3.statusBarHeight, 44);

// ---- 场景 4：异常兜底路径 ----
setupWx(false); // getWindowInfo 抛异常
const app4 = loadApp();
let called4 = 0;
app4.getSystemInfoReady(() => { called4++; });
app4.onLaunch();
eq('异常路径 statusBarHeight===20（兜底）', app4.globalData.statusBarHeight, 20);
eq('异常路径 navBarHeight===64（兜底）', app4.globalData.navBarHeight, 64);
eq('异常路径 systemInfoReady 仍为 true', app4.globalData.systemInfoReady, true);
eq('异常路径排队回调仍被触发', called4, 1);

// ---- 场景 5：回调抛错隔离 ----
setupWx(true);
const app5 = loadApp();
const order5 = [];
app5.getSystemInfoReady(() => { order5.push('first'); throw new Error('mock callback boom'); });
app5.getSystemInfoReady(() => { order5.push('second'); });
let threw5 = false;
try { app5.onLaunch(); } catch (e) { threw5 = true; }
ok('回调抛错不向外传播', threw5 === false);
eq('第一个回调抛错后第二个仍执行', order5.join(','), 'first,second');

// ---- 附加：非 function 入参被忽略 ----
setupWx(true);
const app6 = loadApp();
let noCrash = true;
try {
  app6.getSystemInfoReady(null);
  app6.getSystemInfoReady(undefined);
  app6.getSystemInfoReady('not a function');
  app6.getSystemInfoReady(42);
} catch (e) {
  noCrash = false;
}
ok('非 function 入参被忽略且不抛错', noCrash === true);

// ---- 场景 6：胶囊被隐藏返回全零对象（真实缺陷回归） ----
// 自定义组件/插件环境/隐藏胶囊时，getMenuButtonBoundingClientRect 可能返回全零对象；
// 旧判断 typeof top==='number' 对 0 通过，公式会算出负数导航栏高度（(0-44)*2+0+44=-44）。
// 修复后应走兜底 statusBarHeight + NAV_BAR_FALLBACK（44+44=88）且不为负数。
setupWx(true, { top: 0, height: 0, left: 0, right: 0, bottom: 0, width: 0 });
const app7 = loadApp();
app7.onLaunch();
eq('隐藏胶囊全零 statusBarHeight===44', app7.globalData.statusBarHeight, 44);
eq('隐藏胶囊全零 navBarHeight===88（兜底）', app7.globalData.navBarHeight, 88);
ok('隐藏胶囊全零 navBarHeight 不为负数', app7.globalData.navBarHeight > 0);

// ---- 场景 7：正常胶囊矩形（回归） ----
setupWx(true, { top: 48, height: 32 });
const app8 = loadApp();
app8.onLaunch();
eq('正常胶囊 navBarHeight===84（回归）', app8.globalData.navBarHeight, 84);

// ---- 场景 8：top 为 NaN（typeof 挡不住，需 >0 判断兜底） ----
// typeof NaN === 'number' 为 true，仅 typeof 校验会通过并算出 NaN；
// >0 判断可一并挡掉 NaN，应走兜底 88。
setupWx(true, { top: NaN, height: 32 });
const app9 = loadApp();
app9.onLaunch();
eq('top=NaN navBarHeight===88（兜底）', app9.globalData.navBarHeight, 88);
ok('top=NaN navBarHeight 不为负数', app9.globalData.navBarHeight > 0);

// ---- 场景 9：top/height 为 Infinity（极端环境/异常基础库，回应 #15）----
// Infinity > 0 为 true，旧判断会放过并算出 Infinity 导航栏高度致布局崩溃；
// 修复后加 isFinite 兜底，应走兜底 88 且为有限正数（非 Infinity）。
setupWx(true, { top: Infinity, height: Infinity });
const app10 = loadApp();
app10.onLaunch();
eq('top=Infinity navBarHeight===88（兜底）', app10.globalData.navBarHeight, 88);
ok('top=Infinity navBarHeight 为有限正数（非 Infinity）',
  Number.isFinite(app10.globalData.navBarHeight) && app10.globalData.navBarHeight > 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

/**
 * _initPreferences 色卡 key 合法性校验 + 初始化顺序单测（app.js）
 *
 * 背景缺陷：
 *   1. 旧实现仅校验 selectedPalette "是字符串且非空"，未校验 key 是否真实存在于
 *      colorLibraries；本地存储被污染为废弃 key/脏数据时，消费端
 *      colorLibraries[selectedPalette] 会得到 undefined → 渲染/取色报错。
 *   2. 旧 onLaunch 顺序为先 _initPreferences 后 _initColorLibraries，即使加了
 *      key 校验，读取偏好时 colorLibraries 还是 {}，校验必然失败。
 *   3. （QA 第 2 轮）key 校验用 `in` 会命中 Object.prototype 原型链，
 *      '__proto__'/'constructor'/'toString' 等会误判为存在，改用 hasOwnProperty。
 *
 * 覆盖场景：
 *   1. 存储 'hama'（合法 key）→ selectedPalette === 'hama'
 *      （同时证明初始化顺序正确：若 colorLibraries 未先建好，'hama' in {} 为 false
 *        会回落默认，此用例会 FAIL）
 *   2. 存储 'bogus_key'（非法 key，模拟脏数据）→ 回落 'artkal_c'
 *   3. 存储 ''（空串）→ 回落 'artkal_c'
 *   4. 存储 123（非字符串）→ 回落 'artkal_c'
 *   4b. 存储 '__proto__'（原型链 key）→ 回落 'artkal_c'
 *   4c. 存储 'artkal_c '（尾随空格，非真实 key）→ 回落 'artkal_c'
 *   5. 回归：onLaunch 后 colorLibraries 含全部 5 个 key 且被冻结
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
// paletteValue：getStorageSync('selectedPalette') 返回的被测值；
// 'bead_prefs' 恒返回 null（走默认偏好），其余 key 返回 null。
function setupWx(paletteValue) {
  global.wx = {
    getStorageSync: (key) => {
      if (key === 'selectedPalette') return paletteValue;
      if (key === 'bead_prefs') return null;
      return null;
    },
    getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 375, windowHeight: 812, safeArea: { top: 44, bottom: 778, left: 0, right: 375 } }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, width: 87, right: 288, bottom: 80, left: 278 }),
    canIUse: () => false,
    getFileSystemManager: () => ({ readdirSync: () => [], unlinkSync: () => {} }),
    env: { USER_DATA_PATH: '/mock/user_data' },
  };
}

let appConfig = null;
global.App = (cfg) => { appConfig = cfg; };

// 每次重新 require app.js，拿到全新 App 配置实例（避免场景间 globalData 串扰）
function loadApp() {
  appConfig = null;
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');
  return appConfig;
}

// ---- 场景 1：合法 key 'hama' → 采用；同时验证初始化顺序 ----
// 若 _initColorLibraries 未先于 _initPreferences 执行，'hama' in {} 为 false，
// 会回落 'artkal_c'，本用例 FAIL
setupWx('hama');
const app1 = loadApp();
app1.onLaunch();
eq('存储 hama（合法 key）→ selectedPalette===hama', app1.globalData.selectedPalette, 'hama');

// ---- 场景 2：非法 key 'bogus_key'（脏数据）→ 回落 artkal_c ----
setupWx('bogus_key');
const app2 = loadApp();
app2.onLaunch();
eq('存储 bogus_key（非法 key）→ 回落 artkal_c', app2.globalData.selectedPalette, 'artkal_c');

// ---- 场景 3：空串 '' → 回落 artkal_c ----
setupWx('');
const app3 = loadApp();
app3.onLaunch();
eq('存储 空串 → 回落 artkal_c', app3.globalData.selectedPalette, 'artkal_c');

// ---- 场景 4：非字符串 123 → 回落 artkal_c ----
setupWx(123);
const app4 = loadApp();
app4.onLaunch();
eq('存储 123（非字符串）→ 回落 artkal_c', app4.globalData.selectedPalette, 'artkal_c');

// ---- 场景 4b：原型链 key '__proto__'（脏数据）→ 回落 artkal_c ----
// 旧实现用 `in` 判断，'__proto__' in {} 为 true（命中 Object.prototype 原型链），
// 会被误采纳；改用 hasOwnProperty 后应正确回落
setupWx('__proto__');
const app4b = loadApp();
app4b.onLaunch();
eq('存储 __proto__（原型链 key）→ 回落 artkal_c', app4b.globalData.selectedPalette, 'artkal_c');

// ---- 场景 4c：尾随空格 'artkal_c '（非真实 key）→ 回落 artkal_c ----
// 字符串严格匹配，尾随空格不属于任何真实色卡 key，应回落默认
setupWx('artkal_c ');
const app4c = loadApp();
app4c.onLaunch();
eq('存储 artkal_c 尾随空格 → 回落 artkal_c', app4c.globalData.selectedPalette, 'artkal_c');

// ---- 场景 5：回归：colorLibraries 含全部 5 个 key 且被冻结 ----
setupWx(null);
const app5 = loadApp();
app5.onLaunch();
const libs5 = app5.globalData.colorLibraries;
const expectedKeys = ['artkal_c', 'hama', 'perler', 'photoPearl', 'neko'];
eq('colorLibraries 含全部 5 个 key', Object.keys(libs5).sort().join(','), expectedKeys.slice().sort().join(','));
ok('colorLibraries 被冻结（Object.isFrozen）', Object.isFrozen(libs5));
ok('colorLibraries 各子色卡被冻结', expectedKeys.every((k) => Object.isFrozen(libs5[k])));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

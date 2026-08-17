// 回归测试：B12 色卡 key 白名单单一真源
// 原问题：colorLibrary.js 在 getColorsByKey / switchPalette 两处 hardcode 同一份 validKeys 数组，
// 与 colorData.colorLibraryMeta 不同源——未来新增色卡需多处同步，漏改即静默回退默认。
// 修复：colorData.js 由 colorLibraryMeta 派生并导出 COLOR_LIBRARY_KEYS（唯一真源），
// colorLibrary.js 两处统一引用该常量，白名单从此自动同步、零副本。
// 运行：node test/color_library_keys_single_source.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const root = path.resolve(__dirname, '..');

// ---- 静态断言：白名单不再 hardcode 重复 ----
const clSrc = fs.readFileSync(path.join(root, 'utils', 'colorLibrary.js'), 'utf8');
ok('colorLibrary.js 不再 hardcode validKeys 数组（应为 0 处）',
  !/const validKeys\s*=\s*\[/.test(clSrc));
ok('colorLibrary.js 从 colorData 引入 COLOR_LIBRARY_KEYS',
  /const\s*\{\s*[^}]*COLOR_LIBRARY_KEYS[^}]*\}\s*=\s*require\('\.\/colorData'\)/.test(clSrc));

const cdSrc = fs.readFileSync(path.join(root, 'utils', 'colorData.js'), 'utf8');
ok('colorData.js 由 colorLibraryMeta 派生 COLOR_LIBRARY_KEYS',
  /COLOR_LIBRARY_KEYS\s*=\s*colorLibraryMeta\.map/.test(cdSrc));
ok('colorData.js 导出 COLOR_LIBRARY_KEYS',
  /module\.exports[\s\S]*COLOR_LIBRARY_KEYS/.test(cdSrc));

// ---- 运行时：加载真实模块 ----
let storage = {};
const _app = { globalData: { colorLibraries: {}, selectedPalette: 'artkal_c' } };
global.getApp = () => _app;
global.wx = { setStorageSync: (k, v) => { storage[k] = v; } };
const colorLib = require(path.join(root, 'utils', 'colorLibrary'));
const colorData = require(path.join(root, 'utils', 'colorData'));

// 预置色卡（与 colorData 对齐）
_app.globalData.colorLibraries = {
  artkal_c: Array(30).fill(0),
  hama: Array(50).fill(0),
  perler: Array(40).fill(0),
  photoPearl: Array(50).fill(0),
  neko: Array(35).fill(0)
};

// 单一真源：白名单必须等于 colorData 派生的 keys
ok('COLOR_LIBRARY_KEYS 导出为 5 个 key',
  JSON.stringify(colorData.COLOR_LIBRARY_KEYS) ===
  JSON.stringify(['artkal_c', 'hama', 'perler', 'photoPearl', 'neko']));

// 合法 key 被接受
ok("getColorsByKey('artkal_c') 返回数组（长度 30）",
  Array.isArray(colorLib.getColorsByKey('artkal_c')) &&
  colorLib.getColorsByKey('artkal_c').length === 30);
ok("switchPalette('hama') 接受并返回色卡（长度 50）",
  Array.isArray(colorLib.switchPalette('hama')) &&
  colorLib.switchPalette('hama').length === 50);
ok("switchPalette 后持久化 selectedPalette='hama'",
  storage['selectedPalette'] === 'hama');

// 非法 key 被拒绝（不静默回退到某色卡，返回空数组）
ok("getColorsByKey('bogus') 返回空数组（不回退）",
  colorLib.getColorsByKey('bogus').length === 0);
ok("switchPalette('bogus') 返回空数组（不回退）",
  colorLib.switchPalette('bogus').length === 0);

// 单一真源一致性：colorLibrary 接受的 key 集合 == colorData.COLOR_LIBRARY_KEYS
const accepted = colorData.COLOR_LIBRARY_KEYS
  .filter(k => colorLib.getColorsByKey(k).length > 0);
ok('colorLibrary 接受的 key 集合与 COLOR_LIBRARY_KEYS 完全一致',
  JSON.stringify(accepted) === JSON.stringify(colorData.COLOR_LIBRARY_KEYS));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

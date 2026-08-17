// 回归测试：saveToHistory 持久化 materialList 时，须剔除颜色对象中仅生成期使用、
// 展示/渲染从不读取的冗余字段 lab / r / g / b，仅保留 id / name / hex 及可能的扩展字段。
// 对应 BUG-22（用户报告 "materialList 冗余：每条历史存含 lab 的颜色对象…"）。
// 目的：减小 setStorage 体积，缓解 10MB 配额压力，避免靠降级删除缓解的被动局面。

const path = require('path');

// ---- 微信运行时全局 mock（须在 require index.js 前就位）----
global.App = () => {};
global.getApp = () => ({ globalData: { selectedPalette: 'artkal_c' } });

let capturedHistory = null;
global.wx = {
  env: { USER_DATA_PATH: '/usr' },
  getStorageSync: () => [],
  setStorageSync: (k, v) => { capturedHistory = v; },
  showToast: () => {},
  getLogManager: () => ({ warn() {}, info() {}, error() {}, log() {} }),
  getFileSystemManager: () => ({
    copyFileSync: () => {},
    accessSync: () => {}
  })
};

let pageObj = null;
global.Page = (o) => { pageObj = o; };

delete require.cache[path.join(__dirname, '../pages/index/index.js')];
require(path.join(__dirname, '../pages/index/index.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 一份真实结构的 templateData：materialList 颜色对象含 lab/r/g/b + 扩展字段 category
const templateData = {
  cols: 3, rows: 2, totalBeads: 6, colorCount: 2, beadSize: 5,
  materialList: [
    { count: 4, color: { id: 'R01', name: '红', hex: '#FF0000', r: 255, g: 0, b: 0, lab: { l: 54, a: 80, b: 69 }, category: 'warm' } },
    { count: 2, color: { id: 'W01', name: '白', hex: '#FFFFFF', r: 255, g: 255, b: 255, lab: { l: 100, a: 0, b: 0 } } }
  ],
  template: [['R01', 'R01', 'W01'], ['R01', 'W01', 'R01']]
};

pageObj.data.imagePath = 'https://cdn.example.com/album/cover.jpg'; // 远程图：不复制本地文件
pageObj.data.beadType = 'square';
pageObj.saveToHistory(templateData);

const record = capturedHistory && capturedHistory[0];
const storedList = record && record.materialList;

console.log('saveToHistory 应剔除 materialList 颜色对象的生成期冗余字段:');

ok('已写入一条历史记录', Array.isArray(capturedHistory) && capturedHistory.length === 1);
ok('materialList 已存储', Array.isArray(storedList) && storedList.length === 2);

// 1) lab 被剔除
ok('color.lab 已剔除（R01）', storedList[0].color.lab === undefined);
ok('color.lab 已剔除（W01）', storedList[1].color.lab === undefined);

// 2) r/g/b 被剔除（仅生成期使用，展示/渲染从不读）
ok('color.r 已剔除（R01）', storedList[0].color.r === undefined);
ok('color.g 已剔除（R01）', storedList[0].color.g === undefined);
ok('color.b 已剔除（R01）', storedList[0].color.b === undefined);
ok('color.r/g/b 已剔除（W01）', storedList[1].color.r === undefined && storedList[1].color.g === undefined && storedList[1].color.b === undefined);

// 3) 展示必需字段保留
ok('color.id 保留', storedList[0].color.id === 'R01' && storedList[1].color.id === 'W01');
ok('color.name 保留', storedList[0].color.name === '红' && storedList[1].color.name === '白');
ok('color.hex 保留', storedList[0].color.hex === '#FF0000' && storedList[1].color.hex === '#FFFFFF');

// 4) 扩展字段不被误删（未来可能新增的字段应保留）
ok('color.category 等扩展字段保留', storedList[0].color.category === 'warm');

// 5) 数量字段保留
ok('count 字段保留', storedList[0].count === 4 && storedList[1].count === 2);

// 6) 体积确实减小
const originalJsonLen = JSON.stringify(templateData.materialList).length;
const storedJsonLen = JSON.stringify(storedList).length;
ok('持久化 materialList JSON 体积减小', storedJsonLen < originalJsonLen);
console.log(`    (原始 ${originalJsonLen}B → 瘦身 ${storedJsonLen}B，单条节省 ${originalJsonLen - storedJsonLen}B)`);

// 7) 健壮性：颜色对象缺失/畸形时不应抛错、应原样保留
const malformed = {
  cols: 1, rows: 1, totalBeads: 1, colorCount: 1, beadSize: 5,
  materialList: [{ id: 'X', count: 1 }], // 无 .color
  template: [['X']]
};
let threw = false;
try {
  pageObj.saveToHistory(malformed);
} catch (e) { threw = true; }
ok('畸形 materialList（无 .color）不抛错', !threw);
ok('畸形条目原样保留', capturedHistory[0].materialList[0] && capturedHistory[0].materialList[0].id === 'X');

console.log(`\nmaterial_list_slim: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

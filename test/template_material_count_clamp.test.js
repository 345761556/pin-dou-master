// 回归测试：L3（part1）—— template 页 onLoad 计算材料百分比时，元素级 count 脏值必须钳制
// 原 bug：percent/percentText 直接用原始 item.count，脏 count=1e20 → percentText="500000000000000000%" 超长串。
// 修复：percent 计算前 count = clampDisplayNumber(item.count, 20000)，并同步覆盖透传给 material-list 的 count。

const path = require('path');
const Module = require('module');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

const root = path.resolve(__dirname, '..');

const appSingleton = { globalData: {} };
global.getApp = () => appSingleton;
global.App = () => {};
attachResetTemplateState(appSingleton);

let renderCalls = [];
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  showShareMenu() {},
  showToast() {},
  showModal() {},
  setNavigationBarTitle() {},
  getFileSystemManager: () => ({ saveFile: (o) => o.success && o.success(), copyFileSync() {} }),
  createSelectorQuery() {
    return {
      select() {
        return {
          fields() {
            return {
              exec(cb) {
                const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
                cb([{ node: { getContext: () => ctx, width: 0, height: 0 } }]);
              }
            };
          }
        };
      }
    };
  }
};

let captured = null;
global.Page = (o) => { captured = o; };

const FAKE_IDS = {
  '../../utils/beadEngine': {
    calcLabelSpace: () => 40,
    calcLegendHeight: () => 10,
    renderTemplate(ctx, td) { renderCalls.push(td); return { canvasWidth: 100, canvasHeight: 100 }; }
  },
  '../../utils/security': { log: { info() {}, warn() {}, error() {} }, isValidFilePath: () => true }
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (FAKE_IDS[id]) return FAKE_IDS[id];
  return origRequire.apply(this, arguments);
};

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// currentTemplate：totalBeads 已钳制为 20000；materialList 含脏 count=1e20 与合法 count=5
appSingleton.globalData.currentTemplate = {
  template: [[{ color: { id: 'C01', name: '红', hex: '#F00' }, id: 'C01' }]],
  cols: 1, rows: 1,
  totalBeads: 20000,
  colorCount: 2,
  materialList: [
    { count: 1e20, color: { id: 'C01', name: '红', hex: '#F00' } },
    { count: 5, color: { id: 'C02', name: '蓝', hex: '#00F' } }
  ],
  physicalWidth: 10, physicalHeight: 10, beadSize: 5, sourceImagePath: ''
};

require(path.join(root, 'pages/template/template.js'));
const tpl = captured;
tpl.setData = function (obj) { Object.assign(this.data, obj); };
tpl.onLoad({});
tpl.onReady();

const ml = tpl.data.materialList;

console.log('L3 template 材料 count 钳制:');
ok('脏 count=1e20 被 clampDisplayNumber 收敛到 20000（非原值）', ml[0].count === 20000);
ok('合法 count=5 不变', ml[1].count === 5);
ok('脏记录 percentText 为有限值（不含科学计数/超长串，=100%）',
  typeof ml[0].percentText === 'string' && !/e\+?/i.test(ml[0].percentText) && ml[0].percentText === '100%');
ok('合法记录 percentText == 0%（5/20000*100≈0.025→round 0）', ml[1].percentText === '0%');
ok('renderCanvas 未被脏 count 拖崩（renderTemplate 被正常调用）', renderCalls.length > 0);

console.log(`\ntemplate_material_count_clamp: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

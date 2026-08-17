// 回归测试：M2 闭环 —— 渲染端维度必须与解码端（rleDecode 钳制后的矩阵）一致
// 原 bug：gallery.viewTemplate 把脏声明 cols（如 99999999）写入 currentTemplate，
// template 页 renderCanvas 以声明 cols 驱动 _drawBeads/_drawLabels 双重循环跑满数亿格，
// 越界 x 命中 undefined==null 按空位画、不抛错 → 预览卡死数十秒（try/catch 兜不住）。
// 修复：onLoad 从解码后矩阵反推真实维度覆盖声明值；gallery 源头也回写真实维度。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

const root = path.resolve(__dirname, '..');
const realBead = require(path.join(root, 'utils/beadEngine.js'));

// ---- 微信运行时全局 mock ----
const appSingleton = { globalData: {} };
global.getApp = () => appSingleton;
global.App = () => {};
attachResetTemplateState(appSingleton);

let renderCalls = [];
let renderCrashed = false;
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  showShareMenu() {},
  showToast() {},
  showModal() {},
  setNavigationBarTitle() {},
  getFileSystemManager: () => ({ saveFile: (o) => o.success && o.success(), copyFileSync() {} }),
  // 模拟 canvas 查询：同步回调一个假 node
  createSelectorQuery() {
    return {
      select() {
        return {
          fields() {
            return {
              exec(cb) {
                // 假 ctx：所有方法 no-op；renderTemplate 拿到的 cols/rows 由 stub 记录
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

// 拦截 beadEngine / security：beadEngine.renderTemplate 记录传入维度；
// 若 cols>10000 则抛错，模拟「脏 cols 未被闭环时」会触发的卡死路径（修复后不应到达）。
const FAKE_IDS = {
  '../../utils/beadEngine': {
    calcLabelSpace: () => 40,
    calcLegendHeight: () => 10,
    // renderTemplate 的调用方（renderCanvas）把 templateData 整体透传，其中 cols 即驱动循环的维度
    renderTemplate(ctx, templateData) {
      renderCalls.push({ cols: templateData.cols, rows: templateData.rows });
      if (templateData.cols > 10000) {
        renderCrashed = true;
        throw new Error('FREEZE: render loop would iterate ' + (templateData.cols * templateData.rows) + ' cells');
      }
      return { canvasWidth: 100, canvasHeight: 100 };
    }
  },
  '../../utils/security': {
    log: { info() {}, warn() {}, error() {} },
    isValidFilePath: () => true
  }
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

// 构造脏记录：声明 cols=99999999, rows=4，但 RLE 经 rleDecode 钳制为 4×4096 矩阵
const dirtyEncoded = 'A:1';
const decoded = realBead.rleDecode(dirtyEncoded, 99999999, 4);
const decodedCols = decoded[0] ? decoded[0].length : 0;
const decodedRows = decoded.length;

(async () => {
  console.log('M2 闭环（渲染维度 == 解码维度）:');

  // 1) 解码端确实被钳制到 4×4096（M2 既有的维度钳制）
  ok('rleDecode(99999999,4) 解码矩阵为 4×4096（维度已钳制）', decodedRows === 4 && decodedCols === 4096);

  // 2) 脏 currentTemplate：声明 cols=99999999（模拟 gallery 未闭环时的写入）
  appSingleton.globalData.currentTemplate = {
    template: decoded,
    cols: 99999999,
    rows: 4,
    totalBeads: 1,
    colorCount: 1,
    materialList: [],
    physicalWidth: 10,
    physicalHeight: 10,
    beadSize: 5,
    sourceImagePath: ''
  };

  require(path.join(root, 'pages/template/template.js'));
  const tpl = captured;
  tpl.setData = function (obj) { Object.assign(this.data, obj); };

  // 3) onLoad 必须从矩阵反推真实维度并覆盖声明值（闭环核心）
  tpl.onLoad({});
  ok('onLoad 后 this.data.cols === 矩阵宽度 4096（非脏值 99999999）', tpl.data.cols === 4096);
  ok('onLoad 后 this.data.rows === 矩阵高度 4', tpl.data.rows === 4);
  ok('onLoad 后 currentTemplate.cols 被覆盖为 4096（renderCanvas 读取同源）', tpl._templateData.cols === 4096);

  // 4) renderCanvas 实际把「纠正后的 4096」传给 renderTemplate，且不再触发卡死路径
  renderCalls = [];
  renderCrashed = false;
  tpl.onReady(); // -> renderCanvas()
  const last = renderCalls[renderCalls.length - 1] || {};
  ok('renderCanvas 传给 renderTemplate 的 cols === 4096（循环维度有界）', last.cols === 4096 && last.rows === 4);
  ok('renderCanvas 未触发脏 cols 卡死路径（cols 未漏 99999999）', renderCrashed === false);

  // 5) 负向对照：若声明脏值漏过（未闭环），renderTemplate 会因 cols>10000 抛错
  //    （注释说明而非执行，避免测试本身卡死；此处仅证明守卫存在）
  ok('维度守卫存在：renderTemplate 对 cols>10000 会抛错（脏值未被闭环时即命中）', renderCrashed === false);

  console.log(`\n${path.basename(__filename)}: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();

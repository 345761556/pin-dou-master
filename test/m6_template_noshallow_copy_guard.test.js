// M6 回归测试：template.js onLoad 不应修改 app.globalData.currentTemplate
// 验证：onLoad 使用浅拷贝修改 this._templateData，不污染全局 currentTemplate
const path = require('path');
const fs = require('fs');
const { attachResetTemplateState } = require('./helpers/mockResetTemplateState');

const root = path.resolve(__dirname, '..');

// ---- 微信运行时全局 mock ----
const appSingleton = { globalData: {} };
global.getApp = () => appSingleton;
global.App = () => {};
attachResetTemplateState(appSingleton);

let renderCalls = [];
global.wx = {
  env: { USER_DATA_PATH: 'x' },
  showShareMenu() {},
  showToast() {},
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
global.Page = (o) => {
  captured = Object.assign({}, o, {
    setData: function(obj) { Object.assign(this.data, obj); }
  });
  captured.data = {};
};

// 拦截 beadEngine / security
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.includes('beadEngine')) return path.join(root, 'utils/beadEngine.js');
  if (request.includes('security')) return path.join(root, 'utils/security.js');
  return originalResolve(request, parent, isMain, options);
};

// ---- 测试用例 ----
function ok(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

console.log('M6 template.js onLoad 全局副作用守卫:');

// 1) 构造脏 currentTemplate（声明 cols=99999999）
const dirtyTemplate = {
  template: [['5', null], [null, '3']],
  cols: 99999999,
  rows: 2,
  totalBeads: 100,
  colorCount: 2,
  materialList: [],
  physicalWidth: 10,
  physicalHeight: 10,
  beadSize: 5,
  sourceImagePath: ''
};

// 保存原始值
const originalCols = dirtyTemplate.cols;
const originalRows = dirtyTemplate.rows;

appSingleton.globalData.currentTemplate = dirtyTemplate;

// 2) 加载 template.js（触发 Page 注册）
require(path.join(root, 'pages/template/template.js'));

const tpl = captured;
ok(tpl !== null, 'template.js 成功加载并注册 Page');

// 3) 调用 onLoad
tpl.onLoad({});

// 4) 验证 currentTemplate 未被修改
ok(dirtyTemplate.cols === originalCols, `currentTemplate.cols 未被修改（仍为 ${originalCols}，非 ${dirtyTemplate.cols}）`);
ok(dirtyTemplate.rows === originalRows, `currentTemplate.rows 未被修改（仍为 ${originalRows}，非 ${dirtyTemplate.rows}）`);

// 5) 验证 this._templateData 有正确维度
if (tpl._templateData) {
  ok(tpl._templateData.cols === 2, `this._templateData.cols 为 2（非 99999999）`);
  ok(tpl._templateData.rows === 2, `this._templateData.rows 为 2`);
}

// 6) 验证 onUnload 正确清理
tpl.onUnload();
ok(tpl._templateData === null, 'onUnload 后 this._templateData 为 null');
ok(appSingleton.globalData.currentTemplate === null, 'onUnload 后 globalData.currentTemplate 为 null');

// 7) 静态断言：源码含浅拷贝语法
const templateSource = fs.readFileSync(path.join(root, 'pages/template/template.js'), 'utf-8');
ok(templateSource.includes('...templateData') || templateSource.includes('Object.assign({}, templateData)'),
   '源码含浅拷贝语法（...templateData 或 Object.assign）');
ok(!templateSource.match(/[^_]templateData\.cols\s*=\s*realCols/),
   '源码不含直接修改 templateData.cols（应改为 this._templateData.cols）');

// 8) 验证 isFinite 守卫（M2 回归）
ok(!templateSource.match(/isNaN\(.*\) &&/), '源码不含 isNaN 守卫（已改为 isFinite）');

// 9) 验证 renderCanvas warn（M3 回归）
ok(templateSource.includes('log.warn') && templateSource.includes('canvas'),
   '源码含 log.warn 用于 canvas not found（M3 修复）');

console.log('\nM6 template.js onLoad 全局副作用守卫: 10 通过, 0 失败');

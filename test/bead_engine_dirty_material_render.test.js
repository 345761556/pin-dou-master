// 回归测试：renderTemplate 必须对字段级脏数据健壮（M1）
// 场景：历史记录 materialList 元素缺 color 字段 / materialList 缺失（非数组），
// 直接 item.color.id 会抛 TypeError 拖垮整个预览（正是 L2 威胁模型未覆盖的渲染端）。
const path = require('path');
const beadEngine = require(path.join(__dirname, '../utils/beadEngine.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 构造 no-op 的 2D ctx（renderTemplate 仅调用绘制方法，无需真实画布）
function makeCtx() {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; }
  });
}

// 脏 materialList：第二个元素缺 color 字段（同类于 L2 修复的脏数据）
const dirtyTemplate = {
  template: [[null, 'C01'], ['C02', null]],
  cols: 2,
  rows: 2,
  materialList: [
    { count: 1, color: { id: 'C01', name: '红', hex: '#F00' } },
    { count: 1 } // 缺 color
  ]
};

let threw = false;
let result = null;
try {
  result = beadEngine.renderTemplate(makeCtx(), dirtyTemplate, { cellSize: 10 });
} catch (e) {
  threw = true;
  console.log('  [异常]', e.message);
}
ok('renderTemplate 遇缺 color 的 materialList 不抛 TypeError', !threw);
ok('renderTemplate 正常返回画布尺寸', result && result.canvasWidth > 0 && result.canvasHeight > 0);

// materialList 缺失（非数组）也应健壮
let threw2 = false;
try {
  beadEngine.renderTemplate(makeCtx(), { template: [[null]], cols: 1, rows: 1 }, { cellSize: 10 });
} catch (e) {
  threw2 = true;
  console.log('  [异常2]', e.message);
}
ok('renderTemplate 遇 materialList 缺失（非数组）不抛错', !threw2);

console.log(`\nbead_engine_dirty_material_render: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

// 回归测试：material-list 组件 onCopy 必须对字段级脏数据健壮（M1）
// 场景：materials 元素缺 color 字段，直接 item.color.name/id/hex 会抛 TypeError。
// 用小程序运行时全局桩捕获组件配置，直接调用 onCopy 验证逻辑不崩且给出占位符。
const path = require('path');

let captured = null;
global.Component = (cfg) => { captured = cfg; };
let clipboardData = null;
global.wx = {
  setClipboardData: (o) => { clipboardData = o.data; if (o.success) o.success(); },
  showToast: () => {}
};

require(path.join(__dirname, '../components/material-list/material-list.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const onCopy = captured.methods.onCopy;

// 脏数据：第一个元素缺 color
const dirty = {
  data: {
    materials: [
      { count: 4 }, // 缺 color
      { count: 2, color: { id: 'C01', name: '红', hex: '#F00' } }
    ],
    totalBeads: '6',
    physicalSize: '',
    cols: 2,
    rows: 2,
    colorCount: 2
  }
};

let threw = false;
try {
  onCopy.call(dirty);
} catch (e) {
  threw = true;
  console.log('  [异常]', e.message);
}
ok('onCopy 遇缺 color 元素不抛 TypeError', !threw);
ok('onCopy 生成了剪贴板文本', typeof clipboardData === 'string' && clipboardData.length > 0);
ok('onCopy 对缺失色号使用占位符（含"未知颜色"或"?"）', /未知颜色|\?/.test(clipboardData));

// ---- L3 扩展：元素级 count 脏值（如 1e20）经 clampDisplayNumber 收敛，清单不显示超长串 ----
let threw2 = false, clip2 = null;
global.wx.setClipboardData = (o) => { clip2 = o.data; if (o.success) o.success(); };
const dirtyCount = {
  data: {
    materials: [
      { count: 1e20, color: { id: 'C01', name: '红', hex: '#F00' } }
    ],
    totalBeads: '6',
    physicalSize: '',
    cols: 2,
    rows: 2,
    colorCount: 2
  }
};
try {
  onCopy.call(dirtyCount);
} catch (e) {
  threw2 = true;
  console.log('  [异常]', e.message);
}
ok('L3: onCopy 遇脏 count=1e20 不抛异常', !threw2);
ok('L3: 脏 count 被钳制为 20000（清单显示 "20000颗"，非 1e20 超长串）',
  typeof clip2 === 'string' && /20000颗/.test(clip2) && !/1e\+?20/.test(clip2));

console.log(`\nmaterial_list_oncopy_dirty: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

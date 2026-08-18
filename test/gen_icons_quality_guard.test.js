// test/gen_icons_quality_guard.test.js
// 审计项 #16/#17/#18 回归：
//   #16 app.js deepFreeze 的 seen 参数 JSDoc 说明（WeakSet 防循环引用）
//   #17 _gen_icons.py 循环内常量计算外提（dot_r/cell/gap/corner，避免每轮重复乘法）
//   #18 _gen_icons.py 图标颜色与 app.json tabBar 同源读取（防主题色漂移），保留兜底
const path = require('path');
const fs = require('fs');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const pySrc = fs.readFileSync(path.join(__dirname, '..', '_gen_icons.py'), 'utf8');
const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('#16 deepFreeze JSDoc：');
ok('JSDoc 含 seen 参数说明（WeakSet 防循环引用）',
  /@param\s*\{WeakSet\}\s*\[seen\]\s*-/.test(appSrc));

console.log('#17 循环内常量外提：');
ok('draw_create 端点圆半径 dot_r 提到循环外',
  /dot_r\s*=\s*4\s*\*\s*unit[\s\S]{0,300}for\s+dx,\s*dy\s+in\s*\[\(\s*-14/.test(pySrc));
ok('draw_gallery cell/gap/corner 提到循环外',
  /cell\s*=\s*14\s*\*\s*unit[\s\S]*?gap\s*=\s*20\s*\*\s*unit[\s\S]*?corner\s*=\s*3\s*\*\s*unit/.test(pySrc));
ok('draw_gallery 循环内不再重算 14*unit / 3*unit',
  !/x\s*=\s*\(24\s*\+\s*col\s*\*\s*20\)/.test(pySrc));

console.log('#18 颜色同源：');
const tab = appJson.tabBar || {};
ok('app.json tabBar 声明 color/selectedColor',
  !!tab.color && !!tab.selectedColor);
ok('脚本含 _load_tabbar_colors 从 app.json 读取',
  /_load_tabbar_colors[\s\S]{0,300}app\.json/.test(pySrc));
ok('脚本保留硬编码兜底（app.json 缺失时仍可生成）',
  /return\s*'#999999',\s*'#FF6B6B'/.test(pySrc));
ok('COLORS 不再硬编码字面量（改由 app.json 注入）',
  !/COLORS\s*=\s*\{\s*['"]inactive['"]:\s*'#999999'/.test(pySrc));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

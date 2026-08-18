// test/app_icons_integrity.test.js
// 审计项 13（图标资源无回退）：tabBar 图标缺失/损坏时微信原生渲染直接 404 显示异常，
// 小程序端 JS 无运行时兜底通道（tabBar 图标由微信原生加载，无 onerror 钩子）。
// 因此唯一的防御是「防回归」：app.json 引用的每个图标路径必须真实存在、非空、且为 PNG。
// 本测试锁定该不变量，防止未来误删/改错路径导致线上 tabBar 破图。

const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('tabBar 图标完整性校验：');

// 1. tabBar 存在且含 list
const tabBar = appJson.tabBar || {};
const list = tabBar.list || [];
ok('app.json 声明了 tabBar.list（3 个页面）', list.length >= 3);

// 2. 每个 tab 项的 iconPath / selectedIconPath 都必须存在、非空、是 PNG
let referenced = 0;
const missing = [];
const empty = [];
const notPng = [];
list.forEach((item, idx) => {
  ['iconPath', 'selectedIconPath'].forEach((key) => {
    const rel = item[key];
    if (!rel) { missing.push('tab[' + idx + '].' + key + ' 未配置'); return; }
    referenced++;
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); return; }
    const stat = fs.statSync(abs);
    if (stat.size === 0) { empty.push(rel); return; }
    const head = fs.readFileSync(abs).slice(0, 8);
    // PNG 魔数 89 50 4E 47 0D 0A 1A 0A
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E &&
                  head[3] === 0x47 && head[4] === 0x0D && head[5] === 0x0A &&
                  head[6] === 0x1A && head[7] === 0x0A;
    if (!isPng) notPng.push(rel);
  });
});
ok('所有 tabBar 图标路径均已配置（6 个引用）', referenced === list.length * 2);
ok('引用的图标文件全部存在（无 404 路径）', missing.length === 0);
missing.forEach(m => console.log('    ✗ 缺失: ' + m));
ok('图标文件均非空（无 0 字节损坏）', empty.length === 0);
empty.forEach(m => console.log('    ✗ 空文件: ' + m));
ok('图标均为有效 PNG（魔数校验）', notPng.length === 0);
notPng.forEach(m => console.log('    ✗ 非 PNG: ' + m));

// 3. 常规态/选中态成对存在（防只配了其中一个）
list.forEach((item, idx) => {
  ok('tab[' + idx + '] iconPath 与 selectedIconPath 成对',
    !!item.iconPath && !!item.selectedIconPath);
});

// 4. 页面路径与 pages 声明一致（防 tabBar 指向不存在页面）
const pages = appJson.pages || [];
list.forEach((item, idx) => {
  ok('tab[' + idx + '] pagePath 已在 pages 声明: ' + item.pagePath,
    pages.includes(item.pagePath));
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

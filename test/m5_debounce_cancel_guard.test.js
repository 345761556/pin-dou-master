// M5 回归测试：debounce 返回包装器含 cancel() 方法，onUnload 调用 cancel 防止
// 已销毁页面实例被 300ms 后触发的 debounce 回调 setData。
// 修复：utils/util.js debounce 返回 { fn, cancel }，index.js onUnload 调用 cancel。

const fs = require('fs');
const path = require('path');

const utilJs = fs.readFileSync(path.resolve(__dirname, '../utils/util.js'), 'utf8');
const indexJs = fs.readFileSync(path.resolve(__dirname, '../pages/index/index.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('M5 debounce cancel 守卫:');

// 1) 静态：debounce 返回包装器含 cancel 方法
ok('debounce 返回包装器含 cancel 方法',
  /wrapped\.cancel\s*=\s*cancel/.test(utilJs) ||
  /cancel\s*=\s*\(\)\s*=>/.test(utilJs));
ok('debounce 返回带 cancel 的 wrapped 函数（而非裸函数）',
  /return\s+wrapped/.test(utilJs));

// 2) 静态：index.js onUnload 调用 cancel
ok('index.js onUnload 取消 debouncedOnColsChange',
  /onUnload\(\)[\s\S]{0,200}?debouncedOnColsChange\.cancel\(\)/.test(indexJs));
ok('index.js onUnload 取消 debouncedOnColorCountChange',
  /onUnload\(\)[\s\S]{0,200}?debouncedOnColorCountChange\.cancel\(\)/.test(indexJs));

// 3) 静态：onUnload 仍保留 _pageAlive=false
ok('onUnload 仍置 this._pageAlive=false（img.onload 守护不变）',
  /onUnload\(\)[\s\S]{0,200}?this\._pageAlive\s*=\s*false/.test(indexJs));

// 4) 静态：其他页面（template.js）的 _zoomTimer 清除逻辑不受影响
ok('template.js 的 _zoomTimer 清除逻辑仍保留（无回归）',
  /this\._zoomTimer\s*=\s*null/.test(fs.readFileSync(path.resolve(__dirname, '../pages/template/template.js'), 'utf8')));

// 5) 运行时：debounce cancel 实际生效
const { debounce } = require('../utils/util.js');
ok('debounce 返回函数含 cancel 方法', typeof debounce(() => {}).cancel === 'function');

let called = false;
const wrapped = debounce(() => { called = true; }, 50);
wrapped();
ok('调用后未立即触发（防抖生效）', called === false);
wrapped.cancel();
setTimeout(() => {
  ok('cancel 后回调未触发', called === false);
  // 新调用应正常触发
  called = false;
  const wrapped2 = debounce(() => { called = true; }, 50);
  wrapped2.cancel();
  wrapped2();
  setTimeout(() => {
    ok('cancel 后再调用正常触发', called === true);
    console.log(`\nM5 debounce cancel 守卫: ${pass} 通过, ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
  }, 80);
}, 80);

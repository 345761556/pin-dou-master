// test/template_loading_onunload_guard.test.js
// B30 回归：pages/template/template.js 的 saveTemplate(:518) / shareTemplate(:632)
// 在异步导出期间调用 wx.showLoading（全局遮罩、非页面级、不会随路由自动消失）。
// 若用户在导出中途切 tab / 返回上一页，onUnload 触发、异步链被 _destroyed 守卫提前中止，
// 其成功/失败分支的 wx.hideLoading 不再执行 → 遮罩残留到下一页（"透明遮罩"）。
// 修复：onUnload 显式 wx.hideLoading() 兜底，确保页面销毁时无残留。
// 锁定不变量（防回退）：
//   1) onUnload 方法体内必须含 wx.hideLoading() 兜底（页面销毁时清除可能残留的全局 loading 遮罩）；
//   2) saveTemplate 方法体内同时含 wx.showLoading（开启）与 wx.hideLoading（关闭），不依赖 onUnload 兜底作为唯一清理；
//   3) shareTemplate 同样须 wx.showLoading + wx.hideLoading 配对。
// 运行：node test/template_loading_onunload_guard.test.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(msg, cond) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const src = fs.readFileSync(path.join(root, 'pages/template/template.js'), 'utf-8');

// 按「方法名() { ... \n  },」提取方法体（方法以 2 空格缩进的 }, 结束），与方法长度无关，稳定。
function methodBody(name) {
  const re = new RegExp(name + '\\(\\)\\s*\\{[\\s\\S]*?\\n  \\},');
  const m = re.exec(src);
  return m ? m[0] : '';
}

const onUnload = methodBody('onUnload');
const saveTemplate = methodBody('saveTemplate');
const shareTemplate = methodBody('shareTemplate');

console.log('方法体提取:');
ok('onUnload 方法体可提取', onUnload.length > 0);
ok('saveTemplate 方法体可提取', saveTemplate.length > 0);
ok('shareTemplate 方法体可提取', shareTemplate.length > 0);

console.log('静态校验（B30: onUnload 兜底清除 loading 遮罩）:');
ok('onUnload 方法体内含 wx.hideLoading() 兜底（页面销毁时清除可能残留的全局 loading 遮罩）',
  /wx\.hideLoading\(\)/.test(onUnload));
ok('onUnload 的 wx.hideLoading() 出现在定时器清理段（clearTimeout 之后、_templateData 置空前）',
  /clearTimeout\(this\._invalidDataTimer\);[\s\S]*?wx\.hideLoading\(\);[\s\S]*?this\._templateData\s*=\s*null/.test(onUnload));

console.log('静态校验（saveTemplate / shareTemplate 仍各自配对 loading）:');
ok('saveTemplate 方法体含 wx.showLoading（开启遮罩）', /wx\.showLoading\(/.test(saveTemplate));
ok('saveTemplate 方法体含 wx.hideLoading（关闭遮罩，成功/失败分支）', /wx\.hideLoading\(\)/.test(saveTemplate));
ok('shareTemplate 方法体含 wx.showLoading（开启遮罩）', /wx\.showLoading\(/.test(shareTemplate));
ok('shareTemplate 方法体含 wx.hideLoading（关闭遮罩，成功/失败分支）', /wx\.hideLoading\(\)/.test(shareTemplate));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

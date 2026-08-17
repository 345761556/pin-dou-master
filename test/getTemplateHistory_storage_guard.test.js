// 回归测试：getTemplateHistory 对 wx.getStorageSync 异常的容错
// 现象：util.js:getTemplateHistory 直接裸读 storage，若基础库抛错或被损坏，
//       会在调用方（gallery/index/profile 等）抛未捕获异常。
// 修复：用 try/catch 包裹，异常时降级返回 [] 并脱敏日志。

const Module = require('module');
const origRequire = Module.prototype.require;

let storageThrow = false;
const fakeWx = {
  getStorageSync(key) {
    if (storageThrow) throw new Error('storage corrupted');
    if (key === 'template_history') return [{ id: 1, cols: 2, rows: 2, templateRLE: 'C01:4' }];
    return undefined;
  }
};

const fakeSec = { log: { warn() {}, error() {}, info() {} }, isValidFilePath: () => true };

Module.prototype.require = function (id) {
  const f = this.filename ? this.filename.replace(/\\/g, '/') : '';
  if (id.indexOf('./security') !== -1 && f.indexOf('utils/util.js') !== -1) return fakeSec;
  return origRequire.apply(this, arguments);
};

global.wx = fakeWx;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('getTemplateHistory storage 异常容错回归:');

// 正常读取
storageThrow = false;
const util = require('../utils/util.js');
ok('正常路径返回数组', Array.isArray(util.getTemplateHistory()) && util.getTemplateHistory().length === 1);

// 异常降级
storageThrow = true;
let hist = null;
let threw = false;
try {
  hist = util.getTemplateHistory();
} catch (e) {
  threw = true;
}
ok('storage 异常时不抛错', !threw);
ok('storage 异常时降级为空数组', Array.isArray(hist) && hist.length === 0);

console.log(`\ngetTemplateHistory storage 异常容错回归: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

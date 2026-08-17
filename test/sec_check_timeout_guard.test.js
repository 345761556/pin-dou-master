// 回归测试：secCheck 云函数 timeout 配置守卫
// 背景：云函数未配置 timeout 时微信默认执行超时 3 秒，secCheck 链路
// （下载云存储图 → base64 → msgSecCheck 云调用 → 删文件）极易超 3 秒被强制终止，
// 前端 callFunction 收到 "Error: timeout"（2026-08-16 实测复现）。
// 修复：config.json 显式配置 "timeout": 20。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(msg, cond) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('secCheck 云函数 timeout 配置守卫:');

const cfgPath = path.join(root, 'cloudfunctions/secCheck/config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

ok('config.json 可解析（JSON 合法）', cfg && typeof cfg === 'object');

ok('已配置 timeout 字段（云函数执行超时）', typeof cfg.timeout === 'number' && cfg.timeout > 0);

ok('timeout ≥ 15 秒（链路：下载+msgSecCheck 云调用需余量）', cfg.timeout >= 15);

ok('timeout ≤ 60 秒（微信云函数上限）', cfg.timeout <= 60);

ok('openapi 声明 mediaCheckAsync（云调用权限未被破坏）',
   Array.isArray(cfg.permissions && cfg.permissions.openapi) &&
   cfg.permissions.openapi.indexOf('security.mediaCheckAsync') !== -1);

ok('前端 callFunction 有 fail 兜底（timeout 落到 catch → fail-closed 拦截）',
   (() => {
     const src = fs.readFileSync(path.join(root, 'utils/secCheck.js'), 'utf-8');
     return /callFunction\([\s\S]{0,900}fail:\s*\(err\)\s*=>\s*reject\(err\)/.test(src) &&
            /图片检测调用失败，拦截（fail-closed）/.test(src);
   })());

console.log(`\nsec_check_timeout_guard.test.js: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

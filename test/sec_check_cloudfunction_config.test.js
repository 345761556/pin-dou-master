// test/sec_check_cloudfunction_config.test.js
// B28 回归：cloudfunctions/secCheck/config.json 的云函数服务端 timeout 必须
// 覆盖客户端 secCheck.js 中 submit 调用 wx.cloud.callFunction 的 timeout（30000ms=30s），
// 否则服务端会在客户端放弃之前（20s<30s）就静默杀掉云函数，导致检测链路在冷启动 +
// getTempFileURL + mediaCheckAsync 三步叠加时延下被截断、前端误走 fail-closed 拦截。
//
// 不变量（防回退）：
//   1) config.timeout(秒) * 1000 >= 客户端 callFunction(submit) timeout(ms)
//      —— 服务端不能成为比客户端等待更早触发的上限（否则客户端 30s 形同虚设）。
//   2) config.timeout(秒) <= 60 —— 微信云函数最大超时 60s（文档上限），越界部署会被拒。
//   3) config.timeout(秒) 为 20~60 之间的合理整数（ sanity ）。
// 运行：node test/sec_check_cloudfunction_config.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 读取云函数 config.json ----
const configPath = path.join(__dirname, '..', 'cloudfunctions', 'secCheck', 'config.json');
ok('config.json 存在', fs.existsSync(configPath));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const serverTimeoutSec = config.timeout;
ok('config.timeout 为数字', typeof serverTimeoutSec === 'number');

// ---- 2) 从客户端源码提取 submit 调用 wx.cloud.callFunction 的 timeout（毫秒）----
// 仅匹配 action: 'submit' 分支内的 timeout: N，避开 uploadFile(30000) 与轮询(10000)。
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'secCheck.js'), 'utf8');
const m = /action:\s*'submit'[\s\S]*?timeout:\s*(\d+)/.exec(clientSrc);
ok("客户端含 submit 调用的 callFunction timeout 提取成功", !!m);
const clientSubmitTimeoutMs = m ? parseInt(m[1], 10) : NaN;
ok('客户端 submit timeout 为 30000ms(30s)', clientSubmitTimeoutMs === 30000);
const clientSubmitTimeoutSec = clientSubmitTimeoutMs / 1000;

// ---- 3) 不变量断言 ----
ok('服务端 timeout(秒) 必须为 20~60 之间的合理整数',
  Number.isInteger(serverTimeoutSec) && serverTimeoutSec >= 20 && serverTimeoutSec <= 60);

ok('服务端 timeout(秒) <= 60（微信云函数文档上限，越界部署被拒）',
  serverTimeoutSec <= 60);

ok('服务端 timeout 必须覆盖客户端 submit 等待（server*1000 >= client 30000ms，杜绝 20s<30s 静默截断）',
  serverTimeoutSec * 1000 >= clientSubmitTimeoutMs);

ok('B28 修复生效：服务端 timeout 已从原 20s 提升至覆盖 30s 客户端等待（>=30s）',
  serverTimeoutSec >= 30);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

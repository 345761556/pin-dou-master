// 回归测试：L3 闭环 —— hexToRgb 对 3 位短 hex（#FFF）与 8 位带 alpha hex（#RRGGBBAA）
// 的处理补全，避免作为通用颜色工具被未来数据格式扩展坑到。
// 修复前：#FFF（长度3）因 `hex.length < 6` 被当成非法返回黑色；#RRGGBBAA 静默丢弃 alpha 但
// 仅靠 substring(0,6) 侥幸正确，缺乏对 8 位的显式分支。
// 修复后：3 位每位展开为两位；8 位截断前 6 位丢弃 alpha；其余长度（非 3/6/8）仍黑色兜底。

const path = require('path');
const fs = require('fs');
const beadEngine = require(path.join(__dirname, '..', 'utils', 'beadEngine.js'));

let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function log(t) { console.log(t); }

const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');

log('=== L3 hexToRgb 短 hex / 带 alpha hex 处理补全 ===');

// —— 静态：源码已补全 3 位展开与 8 位截断分支（防止回归回 `length < 6` 旧逻辑）——
assert(/hex\.length\s*===\s*3/.test(src),
  '静态：存在 3 位短 hex 展开分支');
assert(/hex\.length\s*===\s*8/.test(src),
  '静态：存在 8 位带 alpha 截断分支');
assert(!/if\s*\(\s*hex\.length\s*<\s*6\s*\)/.test(src),
  '静态：不再用 `hex.length < 6` 一刀切（该逻辑令 #FFF 误判非法）');

// ============ 3 位短 hex 展开 ============
const fff = beadEngine.hexToRgb('#FFF');
log('   #FFF => (' + fff.r + ',' + fff.g + ',' + fff.b + ')  期望 (255,255,255)');
assert(fff.r === 255 && fff.g === 255 && fff.b === 255,
  '#FFF（3位）展开为 (255,255,255) 而非黑色');

const f0a = beadEngine.hexToRgb('#F0A');
log('   #F0A => (' + f0a.r + ',' + f0a.g + ',' + f0a.b + ')  期望 (255,0,170)');
assert(f0a.r === 255 && f0a.g === 0 && f0a.b === 170,
  '#F0A（3位）展开为 (255,0,170)');

const lowerShort = beadEngine.hexToRgb('#abc');
assert(lowerShort.r === 170 && lowerShort.g === 187 && lowerShort.b === 204,
  '#abc（小写3位）展开为 (170,187,204)');

const noHashShort = beadEngine.hexToRgb('F00');
assert(noHashShort.r === 255 && noHashShort.g === 0 && noHashShort.b === 0,
  'F00（无#的3位）展开为 (255,0,0)');

// ============ 8 位带 alpha hex 截断 ============
const rgba = beadEngine.hexToRgb('#FF0000FF');
log('   #FF0000FF => (' + rgba.r + ',' + rgba.g + ',' + rgba.b + ')  期望 (255,0,0)，alpha 丢弃');
assert(rgba.r === 255 && rgba.g === 0 && rgba.b === 0,
  '#FF0000FF（8位，alpha=FF）截断为 RGB (255,0,0)');

const rgba2 = beadEngine.hexToRgb('#00FF0080');
assert(rgba2.r === 0 && rgba2.g === 255 && rgba2.b === 0,
  '#00FF0080（8位，alpha=80）截断为 (0,255,0)');

const lower8 = beadEngine.hexToRgb('#ff00ffaa');
assert(lower8.r === 255 && lower8.g === 0 && lower8.b === 255,
  '#ff00ffaa（小写8位）截断为 (255,0,255)');

// ============ 原有 6 位行为不变（回归基线）============
const six = beadEngine.hexToRgb('#FF0000');
assert(six.r === 255 && six.g === 0 && six.b === 0, '#FF0000（6位）=> (255,0,0)');

const sixLow = beadEngine.hexToRgb('#ff00ff');
assert(sixLow.r === 255 && sixLow.g === 0 && sixLow.b === 255, '#ff00ff（小写6位）=> (255,0,255)');

const sixNoHash = beadEngine.hexToRgb('00FF00');
assert(sixNoHash.r === 0 && sixNoHash.g === 255 && sixNoHash.b === 0, '00FF00（无#6位）=> (0,255,0)');

// ============ 非法输入仍黑色兜底（fail-closed 防御）============
const bad2 = beadEngine.hexToRgb('#FF');        // 长度 2
assert(bad2.r === 0 && bad2.g === 0 && bad2.b === 0, '#FF（长度2）=> 黑色兜底');

const bad7 = beadEngine.hexToRgb('#1234567');    // 长度 7
assert(bad7.r === 0 && bad7.g === 0 && bad7.b === 0, '#1234567（长度7）=> 黑色兜底');

const badEmpty = beadEngine.hexToRgb('');
assert(badEmpty.r === 0 && badEmpty.g === 0 && badEmpty.b === 0, '空串 => 黑色兜底');

const badNull = beadEngine.hexToRgb(null);
assert(badNull.r === 0 && badNull.g === 0 && badNull.b === 0, 'null => 黑色兜底');

const badNum = beadEngine.hexToRgb(123456);
assert(badNum.r === 0 && badNum.g === 0 && badNum.b === 0, '数字 => 黑色兜底');

log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
} else {
  log('L3 hexToRgb 短 hex / 带 alpha hex 处理补全：全部通过 ✅');
  process.exit(0);
}

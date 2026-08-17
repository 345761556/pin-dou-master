// 回归测试：L2 闭环 —— medianCutQuantize 在桶内 maxRange===0（全同色）时，
// 必须提前 break，避免把同色桶反复劈成重复颜色桶（浪费约 maxColors 次全桶扫描+排序+slice）。
// 功能零变化：下游 usedPalette 去重，同色桶等价；本测试用「返回数组长度」作为确定性证据——
// medianCutQuantize 自身不对结果去重（返回 buckets.length 个平均色），
// 故未修复时单色图 + colorCount=50 会返回长度 50，修复后应只返回长度 1。

const path = require('path');
const fs = require('fs');
const beadEngine = require(path.join(__dirname, '..', 'utils', 'beadEngine.js'));

let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  ✗ ' + msg); }
}
function ok(msg, cond) { assert(cond, msg); }
function log(t) { console.log(t); }

const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'beadEngine.js'), 'utf8');

log('=== L2 medianCutQuantize 同色桶提前 break ===');

// 静态：源码在 maxRange===0 时提前 break（防止回归）
ok('静态：medianCutQuantize 在 maxRange===0 时提前 break',
  /if\s*\(\s*maxRange\s*===\s*0\s*\)\s*break/.test(src));

// 构造像素工具
function solidPixels(r, g, b, n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ r, g, b });
  return arr;
}

// —— 单色图 + colorCount=50：冗余切分会让返回数组长度=50，修复后应=1 ——
const single = solidPixels(200, 0, 0, 100);
const singleRes = beadEngine.medianCutQuantize(single, 50);
log('   单色图(红,100px) medianCut 返回桶数 = ' + singleRes.length + '（期望 1，未修复时为 50）');
ok('单色图 + colorCount=50 仅返回 1 个桶（冗余同色切分被跳过）', singleRes.length === 1);
ok('单色图返回的平均色正确（200,0,0）',
  singleRes.length === 1 && singleRes[0].r === 200 && singleRes[0].g === 0 && singleRes[0].b === 0);

// —— 极端性能面：纯色图 + colorCount=200，未修复会做 ~199 次全桶扫描，修复后 1 次即停 ——
const bigSingle = solidPixels(10, 20, 30, 50);
const bigRes = beadEngine.medianCutQuantize(bigSingle, 200);
ok('纯色图 + colorCount=200 仅返回 1 个桶（而非 200）', bigRes.length === 1);

// —— 混合图：3 种清晰可分的颜色，colorCount=50（远大于 3）——
// 未修复会切到 50 个桶（3 真色 + 47 重复）；修复后在 3 桶全单色时 break，返回恰好 3 桶。
const mixed = [].concat(
  solidPixels(200, 0, 0, 30),   // 红
  solidPixels(0, 200, 0, 30),   // 绿
  solidPixels(0, 0, 200, 30)    // 蓝
);
const mixedRes = beadEngine.medianCutQuantize(mixed, 50);
log('   混合图(红/绿/蓝各30px) medianCut 返回桶数 = ' + mixedRes.length + '（期望 <50，未修复时逼到 50）');
// 关键证据：未修复时 while(buckets.length < 50) 会把同色桶反复切到 50 个才停；
// 修复后在「所有桶均已单色（maxRange===0）」时提前 break，故返回桶数远小于 50。
ok('混合图(3 种颜色) 返回桶数 < colorCount(50)（证明提前 break，而非跑到上限）', mixedRes.length < 50);
// 三种目标颜色都应在结果中（颜色值精确等于原色，因单色桶平均即为原色，无混合色）
const hasColor = (r, g, b) => mixedRes.some(c => c.r === r && c.g === g && c.b === b);
ok('混合图结果含红色(200,0,0)', hasColor(200, 0, 0));
ok('混合图结果含绿色(0,200,0)', hasColor(0, 200, 0));
ok('混合图结果含蓝色(0,0,200)', hasColor(0, 0, 200));
// 不得出现原图不存在的杂色（平均色必须精确等于三种目标色之一）
const isTarget = c => (c.r === 200 && c.g === 0 && c.b === 0) ||
                     (c.r === 0 && c.g === 200 && c.b === 0) ||
                     (c.r === 0 && c.g === 0 && c.b === 200);
ok('混合图结果无杂色（每个平均色精确等于三种目标色之一）', mixedRes.every(isTarget));

// —— 功能等价性：混合图结果桶数 ≤ colorCount（原行为上限不变，仅下限收紧）——
ok('返回桶数不超过 colorCount', mixedRes.length <= 50);

// —— 多色且 colorCount 恰好等于颜色数：行为与原版一致（无冗余可跳）——
const exact = [].concat(
  solidPixels(255, 0, 0, 10),
  solidPixels(0, 255, 0, 10),
  solidPixels(0, 0, 255, 10),
  solidPixels(255, 255, 0, 10)
);
const exactRes = beadEngine.medianCutQuantize(exact, 4);
ok('colorCount===颜色数(4) 时返回 4 桶（与未修复行为一致）', exactRes.length === 4);

log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  log('失败项：\n - ' + fails.join('\n - '));
  process.exit(1);
} else {
  log('L2 medianCutQuantize 同色桶提前 break：全部通过 ✅');
  process.exit(0);
}

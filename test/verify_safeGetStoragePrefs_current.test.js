// 直接加载当前 app.js（mock wx/App），验证 safeGetStoragePrefs 是否已修复字符串偏好误判
const path = require('path');

// mock 微信运行时
const store = {};
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : null),
};
global.App = () => {};

const app = require('../app.js');
const { safeGetStoragePrefs } = app;

const SCHEMA = { beadSize: 'number', beadType: 'string', colorCount: 'number', useDithering: 'boolean' };
const DEFAULTS = { beadSize: 29, beadType: 'square', colorCount: 30, useDithering: true };

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} => ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}

// 用户报告的用例
store['t1'] = { beadSize: 29, beadType: 'circle' };
eq('用户用例 {beadSize:29, beadType:"circle"}', safeGetStoragePrefs('t1', SCHEMA, DEFAULTS).beadType, 'circle');

// 反向用例
store['t2'] = { beadSize: 29, beadType: 'square' };
eq('{beadSize:29, beadType:"square"}', safeGetStoragePrefs('t2', SCHEMA, DEFAULTS).beadType, 'square');

// 数字字段仍须排除 NaN
store['t3'] = { beadSize: NaN, beadType: 'circle' };
eq('beadSize=NaN 应回落默认 29', safeGetStoragePrefs('t3', SCHEMA, DEFAULTS).beadSize, 29);

// 完全非数字字符串数字（数字字段传入字符串）应回落
store['t4'] = { beadSize: 'abc', beadType: 'circle' };
eq('beadSize="abc" 非法应回落 29', safeGetStoragePrefs('t4', SCHEMA, DEFAULTS).beadSize, 29);

// 混合：全部合法
store['t5'] = { beadSize: 31, beadType: 'circle', colorCount: 12, useDithering: false };
const r5 = safeGetStoragePrefs('t5', SCHEMA, DEFAULTS);
eq('全量合法 beadType', r5.beadType, 'circle');
eq('全量合法 beadSize', r5.beadSize, 31);
eq('全量合法 colorCount', r5.colorCount, 12);
eq('全量合法 useDithering', r5.useDithering, false);

// 额外字符串字段也应被正确接纳（用户担心的"后续新增字符串偏好"场景）
const S2 = { beadSize: 'number', beadType: 'string', presetName: 'string' };
const D2 = { beadSize: 29, beadType: 'square', presetName: '' };
store['t6'] = { beadSize: 29, beadType: 'circle', presetName: 'sunset' };
eq('新增字符串字段 presetName 应被接纳', safeGetStoragePrefs('t6', S2, D2).presetName, 'sunset');

// —— 非有限数拦截回归（!isFinite 同时覆盖 NaN/Infinity/-Infinity）——
// Infinity 应回落默认 29（防止未来消费方直接用于循环/渲染导致卡死）
store['t7'] = { beadSize: Infinity, beadType: 'circle' };
eq('beadSize=Infinity 应回落默认 29', safeGetStoragePrefs('t7', SCHEMA, DEFAULTS).beadSize, 29);

// -Infinity 应回落默认 29
store['t8'] = { beadSize: -Infinity, beadType: 'circle' };
eq('beadSize=-Infinity 应回落默认 29', safeGetStoragePrefs('t8', SCHEMA, DEFAULTS).beadSize, 29);

// 回归：正常有限数值仍被接纳
store['t9'] = { beadSize: 31, beadType: 'circle' };
eq('beadSize=31 正常值仍被接纳', safeGetStoragePrefs('t9', SCHEMA, DEFAULTS).beadSize, 31);

// 回归：NaN 仍回落 29（确认 !isFinite 兼容原 NaN 语义）
store['t10'] = { beadSize: NaN, beadType: 'circle' };
eq('beadSize=NaN 仍回落默认 29', safeGetStoragePrefs('t10', SCHEMA, DEFAULTS).beadSize, 29);

// 字符串字段不受影响（确认 isFinite 改造未误伤 string）
store['t11'] = { beadSize: 29, beadType: 'circle' };
eq('beadType="circle" 字符串仍被接纳', safeGetStoragePrefs('t11', SCHEMA, DEFAULTS).beadType, 'circle');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

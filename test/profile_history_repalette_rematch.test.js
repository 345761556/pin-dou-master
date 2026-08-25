// test/profile_history_repalette_rematch.test.js
// 回归测试：B1 —— 色号查询点历史项后，切换色卡不重匹配（matchedHex/name/id 残留旧色卡结果）
// 问题根因：
//   1) pickerHistory 历史项未保存 r/g/b；
//   2) showHistoryItem 仅 setData 了 originalHex/matchedHex/name/id，缺 r/g/b；
//   3) onPaletteChange 的「已查询结果重匹配」guard 用 pickedColor.r !== undefined 判断，
//      历史项缺 r/g/b → guard 跳过 → 切色卡后 matchedHex/name/id 仍是旧色卡结果，误导用户。
// 修复：历史项保存 r/g/b；showHistoryItem 一并写入 pickedColor；onPaletteChange 据此重匹配。
// 运行：node test/profile_history_repalette_rematch.test.js,
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROFILE_MARK = 'pages/profile/profile.js';

const fakeUtil = {
  validateImageFile: async () => true,
  getTemplateHistory: () => [],
  compressImageIfNeeded: async (p, max) => ({ tempFilePath: p, width: 100, height: 100 }),
  getImageInfoWithTimeout: (src) => Promise.resolve({ width: 100, height: 100, type: 'png' }),
  removeFileIfExists: () => {},
  CONSTANTS: { DEFAULT_IMAGE_SIZE: 800 }
};
const fakeSecCheck = {
  checkImageByPath: async () => ({ pass: true, suggest: 'pass', skipped: false }),
  blockMessage: (r, def) => def
};
// 两个色卡：P1（旧卡）/ P2（新卡），各自一个代表色，便于验证重匹配是否真的跑了,
const fakeColorLib = {
  getCurrentColors: () => ([{ id: 'P1C', name: 'P1色', hex: '#AABBCC', r: 170, g: 187, b: 204 }]),
  switchPalette: (key) => {
    if (key === 'P2') return ([{ id: 'P2C', name: 'P2色', hex: '#112233', r: 17, g: 34, b: 51 }]);
    return ([{ id: 'P1C', name: 'P1色', hex: '#AABBCC', r: 170, g: 187, b: 204 }]);
  }
};
const fakeBeadEngine = {
  initPalette: (colors) => colors,
  // 命中逻辑：永远返回当前色卡的「第一个色」——这样切卡后若重匹配发生，matchedHex 必变为该卡色,
  matchToPalette: (r, g, b, palette) => (palette && palette[0])
    ? { hex: palette[0].hex, name: palette[0].name, id: palette[0].id, r, g, b }
    : { hex: '#000000', name: '无', id: 'NONE', r, g, b },
  calcDeltaE: () => 2.3,
  renderTemplate: () => {}
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.indexOf('utils/util') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeUtil;
  if (id.indexOf('utils/secCheck') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeSecCheck;
  if (id.indexOf('utils/colorLibrary') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeColorLib;
  if (id.indexOf('utils/beadEngine') !== -1 && this.filename && this.filename.replace(/\\/g, '/').indexOf(PROFILE_MARK) !== -1) return fakeBeadEngine;
  return origRequire.apply(this, arguments);
};

global.getApp = () => ({ globalData: {} });
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({}), fields: () => ({}) }), exec: () => {} }),
  showToast: () => {}, showModal: () => {},
  getFileSystemManager: () => ({ copyFileSync: () => {}, accessSync: () => {} })
};
let pageObj = null;
global.Page = (o) => { pageObj = o; };
require('../pages/profile/profile.js');

const profSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 静态断言：guard 与数据写入就位 ----
ok('history 项录入时保存了 r/g/b',
  /history\.unshift\(\{\s*originalHex,[\s\S]*?r,\s*g,\s*b,/.test(profSrc));
ok('showHistoryItem 将 r/g/b 写入 pickedColor',
  /pickedColor:\s*\{[\s\S]*?originalHex:\s*item\.originalHex,[\s\S]*?r:\s*item\.r,[\s\S]*?g:\s*item\.g,[\s\S]*?b:\s*item\.b,/.test(profSrc));

function makeCtx(init) {
  return Object.assign({}, pageObj, {
    data: Object.assign({ selectedPalette: 'P1', pickerHistory: [], pickedColor: undefined }, init || {}),
    setData: function (d) { Object.assign(this.data, d); }
  });
}

// 模拟「取色后存入历史」的一次性数据（等价于 pickColorAtPoint 成功路径写入的 history 项）,
const historyItem = {
  originalHex: '#0A141E',
  r: 10, g: 20, b: 30,          // 真实 RGB,
  matchedHex: '#AABBCC',        // 旧卡 P1 的匹配结果,
  name: 'P1色',
  id: 'P1C'
};

// ---- 场景 A：点历史项 → 切到新色卡 P2，应重匹配为 P2 的色号 ----
{
  const ctx = makeCtx({ pickerHistory: [historyItem] });
  // 1) 用户点击历史区某一项,
  ctx.showHistoryItem({ currentTarget: { dataset: { index: 0 } } });
  ok('场景A：showHistoryItem 后 pickedColor.r 已写入（非 undefined）', ctx.data.pickedColor.r === 10);
  ok('场景A：showHistoryItem 后 pickedColor.g/b 正确', ctx.data.pickedColor.g === 20 && ctx.data.pickedColor.b === 30);
  ok('场景A：初始显示仍是旧卡匹配（P1色 / #AABBCC）', ctx.data.pickedColor.matchedHex === '#AABBCC' && ctx.data.pickedColor.name === 'P1色');

  // 2) 用户切换色卡到 P2,
  ctx.onPaletteChange({ detail: { key: 'P2' } });
  ok('场景A：切卡后触发重匹配 → matchedHex 更新为新卡 P2 色号（#112233）', ctx.data.pickedColor.matchedHex === '#112233');
  ok('场景A：切卡后 name/id 同步更新为 P2色 / P2C', ctx.data.pickedColor.name === 'P2色' && ctx.data.pickedColor.id === 'P2C');
  ok('场景A：切卡后 originalHex 不变（仍为取到的原色 #0A141E）', ctx.data.pickedColor.originalHex === '#0A141E');
  ok('场景A：切卡后 r/g/b 保留（用于后续再切卡仍可重匹配）', ctx.data.pickedColor.r === 10 && ctx.data.pickedColor.g === 20 && ctx.data.pickedColor.b === 30);
}

// ---- 场景 B：边界 —— pickedColor 无 r/g/b（异常态）切卡不应崩溃，也不应误改 ----
{
  const ctx = makeCtx({ pickedColor: { originalHex: '#FFFFFF', matchedHex: '#AABBCC', name: 'P1色', id: 'P1C' } });
  let threw = null;
  try { ctx.onPaletteChange({ detail: { key: 'P2' } }); } catch (e) { threw = e; }
  ok('场景B：pickedColor 缺 r/g/b 时切卡不抛错', threw === null);
  ok('场景B：缺 r/g/b 时跳过重匹配（matchedHex 保持原值）', ctx.data.pickedColor.matchedHex === '#AABBCC');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);


(async () => {
const fs = require('fs');
const path = require('path');
const beadEngine = require('../utils/beadEngine.js');

let passed = 0;
let failed = 0;
const lines = [];

function log(msg) {
  lines.push(msg);
  // 同时尝试 stdout（某些环境能捕获）
  try { process.stdout.write(msg + '\n'); } catch(e) {}
}

function assert(condition, msg) {
  if (condition) {
    passed++;
    log('  PASS: ' + msg);
  } else {
    failed++;
    log('  FAIL: ' + msg);
  }
}

function assertClose(actual, expected, tolerance, msg) {
  assert(Math.abs(actual - expected) <= tolerance,
    msg + ' (got ' + actual.toFixed(2) + ', expected ' + expected + ' +/- ' + tolerance + ')');
}

log('=== beadEngine 单元测试 ===');
log('Node version: ' + process.version);
log('');

// 1. hexToRgb
log('--- hexToRgb ---');
const white = beadEngine.hexToRgb('#FFFFFF');
assert(white.r === 255 && white.g === 255 && white.b === 255, '#FFFFFF => (255,255,255)');

const black = beadEngine.hexToRgb('#000000');
assert(black.r === 0 && black.g === 0 && black.b === 0, '#000000 => (0,0,0)');

const red = beadEngine.hexToRgb('#FF0000');
assert(red.r === 255 && red.g === 0 && red.b === 0, '#FF0000 => (255,0,0)');

const lower = beadEngine.hexToRgb('#ff00ff');
assert(lower.r === 255 && lower.g === 0 && lower.b === 255, '#ff00ff => (255,0,255)');

const noHash = beadEngine.hexToRgb('00FF00');
assert(noHash.r === 0 && noHash.g === 255 && noHash.b === 0, '00FF00 => (0,255,0)');

const bad1 = beadEngine.hexToRgb('');
assert(bad1.r === 0 && bad1.g === 0 && bad1.b === 0, 'empty string => (0,0,0)');

const bad2 = beadEngine.hexToRgb(null);
assert(bad2.r === 0 && bad2.g === 0 && bad2.b === 0, 'null => (0,0,0)');

const bad3 = beadEngine.hexToRgb('FF');
assert(bad3.r === 0 && bad3.g === 0 && bad3.b === 0, 'short hex => (0,0,0)');

// 2. rgbToHex
log('--- rgbToHex ---');
assert(beadEngine.rgbToHex(255, 255, 255) === '#ffffff', '(255,255,255) => #ffffff');
assert(beadEngine.rgbToHex(0, 0, 0) === '#000000', '(0,0,0) => #000000');
assert(beadEngine.rgbToHex(255, 0, 0) === '#ff0000', '(255,0,0) => #ff0000');
assert(beadEngine.rgbToHex(16, 32, 48) === '#102030', '(16,32,48) => #102030');
assert(beadEngine.rgbToHex(-10, 300, 128) === '#00ff80', '(-10,300,128) clamped => #00ff80');

// 3. rgbToLab
log('--- rgbToLab ---');
const whiteLab = beadEngine.rgbToLab(255, 255, 255);
assertClose(whiteLab.l, 100, 0.1, 'white L* ~100');
assertClose(whiteLab.a, 0, 0.1, 'white a* ~0');
assertClose(whiteLab.b, 0, 0.1, 'white b* ~0');

const blackLab = beadEngine.rgbToLab(0, 0, 0);
assertClose(blackLab.l, 0, 0.1, 'black L* ~0');

const redLab = beadEngine.rgbToLab(255, 0, 0);
assert(redLab.a > 0, 'red a* > 0');

const greenLab = beadEngine.rgbToLab(0, 128, 0);
assert(greenLab.a < 0, 'green a* < 0');

const blueLab = beadEngine.rgbToLab(0, 0, 255);
assert(blueLab.b < 0, 'blue b* < 0');

const yellowLab = beadEngine.rgbToLab(255, 255, 0);
assert(yellowLab.b > 0, 'yellow b* > 0');

const grayLab = beadEngine.rgbToLab(128, 128, 128);
assertClose(grayLab.a, 0, 1, 'gray a* ~0');
assertClose(grayLab.b, 0, 1, 'gray b* ~0');

// 4. colorDistance
log('--- colorDistance ---');
const same = beadEngine.calcDeltaE(255, 0, 0, 255, 0, 0);
assertClose(same, 0, 0.01, 'same color distance = 0');

const bwDist = beadEngine.calcDeltaE(255, 255, 255, 0, 0, 0);
assert(bwDist > 50, 'white vs black distance > 50 (got ' + bwDist.toFixed(1) + ')');

const simDist = beadEngine.calcDeltaE(255, 0, 0, 250, 0, 0);
assert(simDist < 5, 'similar reds distance < 5 (got ' + simDist.toFixed(1) + ')');

const d1 = beadEngine.calcDeltaE(100, 50, 200, 10, 20, 30);
const d2 = beadEngine.calcDeltaE(10, 20, 30, 100, 50, 200);
assertClose(d1, d2, 0.01, 'distance is symmetric');

// 5. RLE（实际 colorId 均为字符串类型，如 'C01'）
log('--- RLE encode/decode ---');
const original = [ ['1','1','1'], ['2','2','3'], ['3','3','3'] ];
const encoded = beadEngine.rleEncode(original);
const decoded = beadEngine.rleDecode(encoded, 3, 3);
assert(JSON.stringify(original) === JSON.stringify(decoded), '3x3 round-trip');

const emptyEnc = beadEngine.rleEncode([]);
assert(emptyEnc === '', 'empty => empty string');

const uniform = [ ['C01','C01'], ['C01','C01'] ];
const uniDec = beadEngine.rleDecode(beadEngine.rleEncode(uniform), 2, 2);
assert(JSON.stringify(uniform) === JSON.stringify(uniDec), '2x2 uniform round-trip');

const colorMat = [ ['C01','C01','C02','C03','C03','C03'] ];
const colorDec = beadEngine.rleDecode(beadEngine.rleEncode(colorMat), 6, 1);
assert(JSON.stringify(colorMat) === JSON.stringify(colorDec), '1x6 colorId round-trip');

// 空编码兜底：透明/无数据统一还原为空位 null（不再误填白色，规避旧版 C01 写死病根）
const fakeHama = [{ id: 'H01', name: '白', hex: '#FFFFFF', lab: beadEngine.rgbToLab(255, 255, 255) }];
const nullMatPalette = beadEngine.rleDecode('', 3, 2);
assert(nullMatPalette.length === 2 && nullMatPalette[0].length === 3, 'decode empty => correct dims');
assert(nullMatPalette[0][0] === null, "decode empty + HAMA 色卡 => 空位哨兵 null（不再误填 H01/C01）");

// 退化情形：无 palette 时同样还原为空位 null（不再回退字面量 'C01'）
const nullMatNoPalette = beadEngine.rleDecode('', 3, 2);
assert(nullMatNoPalette[0][0] === null, "decode empty + 无 palette => 仍为空位 null");

const simple = [ ['1','1','2','2','2'] ];
const simpleEnc = beadEngine.rleEncode(simple);
assert(simpleEnc.indexOf(':') >= 0, 'encoded has ":"');
assert(simpleEnc.indexOf(';') >= 0, 'encoded has ";"');

// 6. 透明像素 → 空位哨兵（产品规则：透明 = 不放置珠子）
log('--- 透明像素空位语义 ---');
const mkPalette = (defs) => defs.map(d => ({ id: d.id, name: d.name, hex: d.hex, lab: beadEngine.rgbToLab(d.r, d.g, d.b) }));
const testPalette = mkPalette([
  { id: 'R01', name: '红', hex: '#FF0000', r: 255, g: 0, b: 0 },
  { id: 'W01', name: '白', hex: '#FFFFFF', r: 255, g: 255, b: 255 },
  { id: 'B01', name: '蓝', hex: '#0000FF', r: 0, g: 0, b: 255 },
]);
function makeMockCanvas(buf) {
  return {
    width: 0, height: 0,
    getContext: () => ({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
      drawImage: () => {},
      getImageData: () => ({ data: buf }),
    }),
  };
}
const TCOLS = 2, TROWS = 2;
// 像素顺序 row-major, 每像素 4 通道：[红(不透明), 透明, 白(不透明), 透明]
const pixelBuf = [ 255,0,0,255,  0,0,0,0,  255,255,255,255,  0,0,0,0 ];
const mockImage = { width: TCOLS, height: TROWS };

const tplEmpty = await beadEngine.generateTemplate(
  makeMockCanvas(pixelBuf), mockImage,
  { beadSize: 29, maxBeadWidth: TCOLS, colorCount: 3, palette: testPalette, useDithering: false }
);
assert(tplEmpty.template[0][1] === null, '透明像素 (0,1) → 空位 null');
assert(tplEmpty.template[1][1] === null, '透明像素 (1,1) → 空位 null');
assert(tplEmpty.template[0][0] === 'R01', '(0,0) 红 → R01');
assert(tplEmpty.template[1][0] === 'W01', '(1,0) 白 → W01');
const emptyIds = tplEmpty.materialList.map(m => m.color.id).sort();
assert(emptyIds.indexOf('R01') >= 0 && emptyIds.indexOf('W01') >= 0, '材料清单含红与白');
assert(emptyIds.indexOf(null) === -1, '材料清单不含空位');
assert(tplEmpty.totalBeads === 2, 'totalBeads = 2（仅两个不透明像素）');

const tplFilled = await beadEngine.generateTemplate(
  makeMockCanvas(pixelBuf), mockImage,
  { beadSize: 29, maxBeadWidth: TCOLS, colorCount: 3, palette: testPalette, useDithering: false, fillBackgroundWhite: true }
);
assert(tplFilled.template[0][1] === 'W01', 'fillBackgroundWhite: 透明 (0,1) → 真实白色 W01');
assert(tplFilled.template[1][1] === 'W01', 'fillBackgroundWhite: 透明 (1,1) → 真实白色 W01');
const whiteItem = tplFilled.materialList.find(m => m.color.id === 'W01');
assert(whiteItem && whiteItem.count === 3, 'fillBackgroundWhite: 白色计入材料（2 透明 + 1 不透明白 = 3）');
assert(tplFilled.totalBeads === 4, 'fillBackgroundWhite: totalBeads = 4');

// 空位哨兵经 RLE 往返不变
const encEmpty = beadEngine.rleEncode(tplEmpty.template);
const decEmpty = beadEngine.rleDecode(encEmpty, TCOLS, TROWS);
assert(JSON.stringify(decEmpty) === JSON.stringify(tplEmpty.template), '空位 null 经 RLE 往返不变');
assert(encEmpty.indexOf('__E__') >= 0, 'RLE 编码包含空位令牌 __E__');

// 总结
log('');
log('============================');
log('Total: ' + (passed + failed) + ', Passed: ' + passed + ', Failed: ' + failed);
if (failed === 0) {
  log('All tests passed!');
} else {
  log(failed + ' test(s) FAILED');
}

// 写文件
const outPath = path.join(__dirname, 'test_result.txt');
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
})();

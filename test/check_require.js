try {
  const beadEngine = require('./utils/beadEngine.js');
  console.log('require OK, keys:', Object.keys(beadEngine).join(', '));
  // 简单调用一个函数
  const r = beadEngine.hexToRgb('#FF0000');
  console.log('hexToRgb result:', JSON.stringify(r));
} catch (e) {
  console.error('require failed:', e.message);
  console.error(e.stack);
}

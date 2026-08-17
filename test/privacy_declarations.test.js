/**
 * privacy.json 隐私接口声明完整性测试
 * 复现 BUG：代码调用 wx.chooseMedia / 使用 chooseAvatar，但 privacy.json 仅声明
 *          chooseImage + saveImageToPhotosAlbum；chooseImage 不覆盖 chooseMedia，
 *          且 chooseAvatar 同样为独立隐私接口。2023-10-17 起隐私检查强制开启，
 *          未声明会导致调用 fail: api scope is not declared in the privacy agreement。
 * 验证：项目源码中实际使用的隐私接口，均必须在 privacy.json 的 rules[].action 中声明。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// 收集项目源码（排除备份、测试夹具、隐藏目录、node_modules）
function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '_backup_before_ui_redesign' || name === 'node_modules' || name.startsWith('.')) continue;
    if (name === 'test') continue; // 测试目录自身不计入“被测源码”
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|wxml|wxss|json)$/.test(name)) out.push(full);
  }
}
const files = [];
walk(root, files);
let src = '';
for (const f of files) src += '\n' + fs.readFileSync(f, 'utf8');

// 代码中实际调用的隐私接口（与微信隐私强制声明清单对应）
const used = {
  chooseMedia: /wx\.chooseMedia\s*\(/.test(src),
  chooseAvatar: /chooseAvatar/.test(src),            // open-type / bindchooseavatar / wx.chooseAvatar
  chooseImage: /wx\.chooseImage\s*\(/.test(src),
  saveImageToPhotosAlbum: /wx\.saveImageToPhotosAlbum\s*\(/.test(src),
};

const privacy = JSON.parse(fs.readFileSync(path.join(root, 'privacy.json'), 'utf8'));
const declared = new Set((privacy.rules || []).map(r => r.action));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

for (const [action, isUsed] of Object.entries(used)) {
  if (!isUsed) {
    test(`未使用的隐私接口 ${action} 不需声明（跳过）`, () => {});
    continue;
  }
  test(`已使用的隐私接口 ${action} 必须在 privacy.json 声明`, () => {
    assert.ok(declared.has(action),
      `privacy.json 缺少对 ${action} 的声明，调用将 fail: api scope is not declared in the privacy agreement`);
  });
}

test('privacy.json 必须开启 __usePrivacyCheck__ 以激活隐私弹窗系统', () => {
  assert.strictEqual(privacy['__usePrivacyCheck__'], true,
    'privacy.json 缺少 __usePrivacyCheck__: true，微信不会激活隐私授权弹窗机制（libVersion 3.15.2 必须开启，否则 app.js 的 onNeedPrivacyAuthorization handler 不触发、隐私接口调用被拒）');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

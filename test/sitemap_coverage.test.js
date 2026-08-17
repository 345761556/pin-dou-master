/**
 * sitemap.json 收录覆盖守卫测试
 *
 * 背景（已用微信官方文档核验）：
 *   微信 sitemap 规则“先匹配生效”；当 sitemap.json 存在、且某页面未命中任何规则时，
 *   该页面**默认不被微信索引（disallow）**（官方原文：不在 sitemap 中的页面默认不允许被搜索）。
 *   当前 sitemap 仅对 3 个 tab 页显式 allow、对 template 显式 disallow，无通配兜底。
 *   若后续新增页面却忘记补 sitemap 规则 → 该页将静默进入“不收录”状态，造成收录异常。
 *
 * 验证：
 *   1) app.json 中声明的每一个 page，都必须在 sitemap.json 的 rules 中存在可命中的规则
 *      （allow 或 disallow 均可，重点是“显式覆盖”，避免静默漏配）。
 *   2) 锁定既有刻意设计：template 页必须显式 disallow（跨页数据页，不收录）。
 *
 * 说明：本测试不改变“deny-by-default（显式 allow 才收录）”的既有策略，仅在新增页面漏配
 *       sitemap 规则时于 CI/本地测试阶段 FAIL，把“遗漏配置”提前暴露，而非线上静默不收录。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const sitemap = JSON.parse(fs.readFileSync(path.join(root, 'sitemap.json'), 'utf8'));

const pages = app.pages || [];
const rules = sitemap.rules || [];

// 判断某条规则是否能命中给定页面路径（支持精确匹配与 `*` / `path/*` 通配）
function ruleMatches(rule, page) {
  const p = rule.page || '';
  if (p === '*') return true;
  if (p === page) return true;
  if (p.endsWith('/*')) {
    const prefix = p.slice(0, -1); // 去掉末尾 '*'，得到 "path/to/"
    return page === prefix.slice(0, -1) || page.startsWith(prefix);
  }
  return false;
}

function pageCovered(page) {
  return rules.some(r => ruleMatches(r, page));
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS | ' + name); passed++; }
  catch (e) { console.log('FAIL | ' + name + ' :: ' + e.message); failed++; }
}

// 1) 每个 app.json 页面都必须被 sitemap 规则显式覆盖（避免漏配导致静默不收录）
for (const page of pages) {
  test(`页面 ${page} 必须在 sitemap.json 中有显式收录规则`, () => {
    assert.ok(pageCovered(page),
      `sitemap.json 未覆盖页面 ${page}：新增页面若未补规则，微信默认不收录该页（静默漏配风险）`);
  });
}

// 2) 锁定既有刻意设计：template 页必须显式 disallow
test('pages/template/template 必须显式 disallow（跨页数据页不收录，既有设计）', () => {
  const disallowed = rules.some(r =>
    r.action === 'disallow' && ruleMatches(r, 'pages/template/template'));
  assert.ok(disallowed, 'template 页未显式 disallow，可能意外被微信收录');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

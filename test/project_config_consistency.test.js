// test/project_config_consistency.test.js
// 配置一致性回归（审计项 7/8）：
//  7. 两份项目配置（project.config.json 公共 / project.private.config.json 私有）差异——
//     私有配置是微信开发者工具按目录自动生成、本地覆盖、不提交版本库的官方机制
//     （.gitignore 已忽略）。不同开发者各自工具生成自己的私有配置，互不影响；
//     真正需防护的是「私有配置被误提交」，故断言 .gitignore 忽略 + 未被 git 跟踪。
//  8. project.config.json 的 setting 曾同时含 swc:false 与 disableSWC:true（语义重复，
//     swc 为历史遗留字段，disableSWC 为现行主控）——已清理 swc 遗留，断言不再冗余。

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const publicCfgPath = path.join(projectRoot, 'project.config.json');
const privateCfgPath = path.join(projectRoot, 'project.private.config.json');
const gitignorePath = path.join(projectRoot, '.gitignore');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ============ 7. 双配置分层机制 ============
console.log('7. 双配置分层（公共/私有）校验：');
const publicCfg = JSON.parse(fs.readFileSync(publicCfgPath, 'utf8'));
const privateCfg = JSON.parse(fs.readFileSync(privateCfgPath, 'utf8'));
const gitignore = fs.readFileSync(gitignorePath, 'utf8');

ok('project.config.json 与 project.private.config.json 均为合法 JSON', !!(publicCfg && privateCfg));

// 私有配置须被 .gitignore 忽略（官方机制：个人本地覆盖，不共享、不提交）
ok('.gitignore 忽略 project.private.config.json',
  /project\.private\.config\.json/.test(gitignore));

// 私有配置必须真的未被 git 跟踪（防止历史误提交残留或未来误 add）
let tracked = '';
try {
  tracked = execSync('git ls-files project.private.config.json', { cwd: projectRoot })
    .toString().trim();
} catch (e) { /* 非 git 环境跳过 */ }
ok('project.private.config.json 未被 git 跟踪（git ls-files 为空）', tracked === '');

// 公共配置关键字段齐全（编译类型 / 云函数根 / appid 都是团队共享的骨架字段）
ok('公共配置含 compileType=miniprogram', publicCfg.compileType === 'miniprogram');
ok('公共配置含 cloudfunctionRoot=cloudfunctions/', publicCfg.cloudfunctionRoot === 'cloudfunctions/');
ok('公共配置含 appid', typeof publicCfg.appid === 'string' && publicCfg.appid.length > 0);

// 私有配置只应包含本地偏好字段（urlCheck/compileHotReLoad 等工具偏好），
// 不应包含 packOptions（上传打包白名单是公共决策，团队必须一致）
ok('私有配置不含 packOptions（打包白名单为公共配置专属）',
  !('packOptions' in privateCfg));
ok('私有配置不含 cloudfunctionRoot（云函数部署路径为公共决策）',
  !('cloudfunctionRoot' in privateCfg));

// ============ 8. swc 遗留字段清理 ============
console.log('8. SWC 配置清理校验：');
const setting = publicCfg.setting || {};
// disableSWC 是现行主控字段，必须存在且为 true（禁用 SWC 编译器）
ok('setting 含 disableSWC:true（现行主控）', setting.disableSWC === true);
// swc 是历史遗留字段，清理后不应再冗余出现（与 disableSWC 语义重复）
ok('setting 不再含冗余 swc 遗留字段', !('swc' in setting));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

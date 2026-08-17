// test/profile_avatar_orphan.test.js
// 回归测试：头像存档文件无限累积导致"头像消失"
// 根因：onChooseAvatar 用 fs.saveFile 不带 filePath → 每次在 saved-file 区新增孤儿文件且无法覆盖；
//       saved-file 配额(10MB)耗尽后 saveFile 失败 → 回退临时路径 → 重启失效、头像变默认图。
// 修复：copyFileSync 到 USER_DATA_PATH 固定路径 avatar.png（覆盖写同一文件，不增长、重启有效）。
// 运行：node test/profile_avatar_orphan.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// ---- 1) 静态断言 ----
const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'), 'utf8');
ok('onChooseAvatar 使用 copyFileSync 持久化到 USER_DATA_PATH 固定路径',
  /copyFileSync\((tempPath|checkPath),\s*dest\)/.test(src) && /USER_DATA_PATH\s*\+\s*['"]\/avatar\.png['"]/.test(src));
// 不再出现「不带 filePath 的 fs.saveFile」调用（旧实现：saved-file 区孤儿累积）
ok('不再有无 filePath 的 fs.saveFile 调用', !/saveFile\(\{\s*tempFilePath: tempPath\s*\}/.test(src));

// ---- 2) 功能驱动 ----
let copyCalls = [];   // copyFileSync(src, dest) 记录
let copyThrow = false; // 注入复制失败
let fnResult = null;   // secCheck 云函数返回
let toasts = [];

const USER_DATA_PATH = 'wxfile://usr';
const AVATAR_DEST = USER_DATA_PATH + '/avatar.png';

global.getApp = () => ({ globalData: {} });

// mock cloud 功能，支持 submit/query 两段式流程
let secCheckTraceId = 'test-trace-001';
let secCheckResult = { suggest: 'pass' };
global.wx = {
  env: { USER_DATA_PATH },
  getImageInfo: ({ src, success }) => success({ width: 100, height: 100, path: src }),
  getFileSystemManager: () => ({
    copyFileSync: (src, dest) => {
      copyCalls.push({ src, dest });
      if (copyThrow) throw new Error('copy fail');
    },
    accessSync: () => {}
  }),
  cloud: {
    uploadFile: ({ success }) => success({ fileID: 'cloud://t/1' }),
    callFunction: ({ success, data }) => {
      if (data && data.action === 'submit') {
        // 提交成功，返回 trace_id
        success({ result: { errcode: 0, errmsg: 'ok', trace_id: secCheckTraceId, status: 'submitted' } });
      } else if (data && data.action === 'query') {
        // 查询返回最终结果
        success({ result: { errcode: 0, errmsg: 'ok', status: 'done', suggest: secCheckResult.suggest } });
      }
    },
    deleteFile: ({ success }) => success({})
  },
  showToast: (o) => { toasts.push(o && o.title); }
};
// getFileInfo（secCheck 体积守卫用）
global.wx.getFileSystemManager = (() => {
  const base = () => ({
    copyFileSync: (src, dest) => {
      copyCalls.push({ src, dest });
      if (copyThrow) throw new Error('copy fail');
    },
    accessSync: () => {},
    getFileInfo: ({ success }) => success({ size: 100 * 1024 })
  });
  return base;
})();

let pageObj = null;
global.Page = (o) => { pageObj = o; };
require('../pages/profile/profile.js');

function makeCtx(initialAvatar) {
  const ctx = Object.assign({}, pageObj, {
    data: { editAvatarUrl: initialAvatar || '' },
    setData: (d) => Object.assign(ctx.data, d)
  });
  return ctx;
}
function reset() {
  copyCalls = [];
  copyThrow = false;
  // secCheck 云函数需返回 trace_id 才能正常轮询结果
  fnResult = { errcode: 0, errmsg: 'ok', trace_id: 'test-trace-001', suggest: 'pass' };
  toasts = [];
}

(async () => {
  // 场景 A：正常选头像 → 持久化到固定路径
  reset();
  const a = makeCtx();
  await a.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_a.png' } });
  ok('场景A: editAvatarUrl 为 USER_DATA_PATH/avatar.png', a.data.editAvatarUrl === AVATAR_DEST);
  ok('场景A: copyFileSync 目标为固定路径', copyCalls.length === 1 && copyCalls[0].dest === AVATAR_DEST);

  // 场景 B：连续两次选不同头像 → 复制目标始终同一路径（磁盘只 1 份，不累积）
  reset();
  const b = makeCtx();
  await b.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_b.png' } });
  await b.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_c.png' } });
  ok('场景B: 两次复制目标均为同一固定路径（覆盖写不累积）',
    copyCalls.length === 2 && copyCalls.every((c) => c.dest === AVATAR_DEST));

  // 场景 C：复制失败 → 回退临时路径（本次会话可用）
  reset();
  copyThrow = true;
  const c = makeCtx();
  await c.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_d.png' } });
  ok('场景C: 复制失败回退临时路径', c.data.editAvatarUrl === 'wxfile://tmp/avatar_d.png');

  // 场景 D：内容检测拦截（risky）→ 不复制、头像不变
  reset();
  secCheckResult = { suggest: 'risky' };
  const d = makeCtx('wxfile://usr/avatar.png');
  await d.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/avatar_bad.png' } });
  ok('场景D: 违规头像不复制', copyCalls.length === 0);
  ok('场景D: 头像保持原值', d.data.editAvatarUrl === 'wxfile://usr/avatar.png');
  // 违规时toast提示可能为「头像含违规信息」或默认文案
  ok('场景D: 提示违规或不可用', toasts.some((t) => t && (t.indexOf('违规') !== -1 || t.indexOf('不可用') !== -1)));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

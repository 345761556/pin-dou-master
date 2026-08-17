// test/storage_read_safety.test.js
// 通篇体检（2026-08-16）存储读取安全锁定：
//   静态断言「页面 onLoad 路径上的 wx.getStorageSync 均已包裹 try/catch」，杜绝存储损坏抛错
//   导致整页 onLoad 中断（白屏）。与 app.js 的 safeGetStoragePrefs 约定保持一致。
//   - A: index.js 的 pref_fillBackgroundWhite 已由 IIFE try/catch 包裹（不再裸 `=== true`）
//   - B: profile.js 的 userInfo_safe / userInfo 裸赋值已改为 `let x=null; try{ x=... }catch{}`
const fs = require('fs');
const path = require('path');
const srcIndex = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
const srcProfile = fs.readFileSync(path.join(__dirname, '..', 'pages', 'profile', 'profile.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('PASS | ' + name); }
  else { failed++; console.log('FAIL | ' + name); }
}

// A: 必须存在 `try { return wx.getStorageSync('pref_fillBackgroundWhite') === true; } catch` 包裹，
//    且不存在「声明即裸赋值」写法（let x = wx.getStorageSync('pref_fillBackgroundWhite')）。
const aWrapped = /try\s*\{\s*return wx\.getStorageSync\('pref_fillBackgroundWhite'\)\s*===\s*true;/.test(srcIndex);
const aNoBareDecl = !/let\s+\w+\s*=\s*wx\.getStorageSync\('pref_fillBackgroundWhite'\)/.test(srcIndex);
ok("A. index.js: pref_fillBackgroundWhite 已用 try/catch 包裹（不再裸声明赋值）", aWrapped && aNoBareDecl);

// B: profile.js 两处存储读取已改为「先声明 null，再 try 内赋值」，不再「声明即裸赋值」。
const bNoBareDeclSafe = !/let storedInfo = wx\.getStorageSync\('userInfo_safe'\)/.test(srcProfile);
const bSafeWrapped = /try\s*\{\s*storedInfo = wx\.getStorageSync\('userInfo_safe'\)/.test(srcProfile);
const bNoBareOld = !/const oldInfo = wx\.getStorageSync\('userInfo'\)/.test(srcProfile);
const bOldWrapped = /try\s*\{\s*oldInfo = wx\.getStorageSync\('userInfo'\)/.test(srcProfile);
ok("B. profile.js: userInfo_safe 裸声明赋值得以移除并包裹 try/catch", bNoBareDeclSafe && bSafeWrapped);
ok("B. profile.js: userInfo（旧版迁移）裸赋值得以移除并包裹 try/catch", bNoBareOld && bOldWrapped);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

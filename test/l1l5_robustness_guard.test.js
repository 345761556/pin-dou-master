// L1-L5 回归测试：健壮性增强
// L1: material-list onCopy Array.isArray 守卫
// L2: profile saveProfile nickName 长度钳制
// L3: profile onChooseAvatar 清理压缩临时文件
// L4: secCheck _memRateStore 清理阈值从 2000 降到 500
// L5: gallery viewTemplate URL totalBeads 钳制
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (!cond) { console.log(`  ✗ ${msg}`); fail++; }
  else { console.log(`  ✓ ${msg}`); pass++; }
}

console.log('L1-L5 健壮性增强回归测试:');

// L1: material-list Array.isArray 守卫
console.log('\nL1 material-list onCopy Array.isArray 守卫:');
const mlSource = fs.readFileSync(path.join(root, 'components/material-list/material-list.js'), 'utf-8');
ok(mlSource.includes('Array.isArray(this.data.materials)'), '源码含 Array.isArray(this.data.materials) 守卫');
ok(!mlSource.match(/this\.data\.materials\.forEach/), '源码不含直接 this.data.materials.forEach（应改为先判断）');

// L2: profile saveProfile nickName 长度钳制
console.log('\nL2 profile saveProfile nickName 长度钳制:');
const profileSource = fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf-8');
ok(profileSource.includes('.slice(0, 20)'), '源码含 nickName 长度钳制（slice(0, 20)）');
ok(profileSource.includes('removeFileIfExists'), '源码含 removeFileIfExists 导入（L3 修复）');

// L3: profile onChooseAvatar 清理压缩临时文件
console.log('\nL3 profile onChooseAvatar 清理压缩临时文件:');
ok(profileSource.includes('removeFileIfExists(checkPath)'), '源码含压缩临时文件清理（removeFileIfExists(checkPath)）');
ok(profileSource.includes('if (checkPath !== tempPath)'), '源码含 checkPath !== tempPath 判断（仅在压缩时清理）');

// L4: secCheck _memRateStore 清理阈值
console.log('\nL4 secCheck _memRateStore 清理阈值:');
const secSource = fs.readFileSync(path.join(root, 'cloudfunctions/secCheck/index.js'), 'utf-8');
ok(secSource.includes('> 500') || secSource.includes('>500'), '源码含 _memRateStore.size > 500 阈值（原 2000）');
ok(!secSource.includes('> 2000') && !secSource.includes('>2000'), '源码不含 _memRateStore.size > 2000 原阈值');

// L5: gallery viewTemplate URL totalBeads 钳制
console.log('\nL5 gallery viewTemplate URL totalBeads 钳制:');
const gallerySource = fs.readFileSync(path.join(root, 'pages/gallery/gallery.js'), 'utf-8');
ok(gallerySource.includes('safeTotal'), '源码含 safeTotal 变量（钳制后的 totalBeads）');
ok(gallerySource.match(/total=\$\{safeTotal\}/), 'URL 参数使用 safeTotal（非 item.totalBeads）');

console.log(`\nL1-L5 回归测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

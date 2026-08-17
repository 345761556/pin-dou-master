# 拼豆格子（PinDou Grids）微信小程序

把图片一键转换成「拼豆 / 像素画」制作模板的小程序：自动生成行列标号、色号对照、材料清单，并支持导出高清制作图。

> 本项目已通过一轮安全与质量审查，欢迎提 Issue / PR 一起找 BUG、改进功能。

## 功能

- 图片取色 → 生成拼豆网格模板（支持缩放、行列标号、图例）
- 取色器：从图片选取颜色，识别最接近的色卡（艺术卡 / Hama 等）
- 历史画廊：保存 / 查看 / 删除模板，支持材料清单与尺寸预览
- 内容安全：图片上传经微信 `security.mediaCheckAsync` 机审，fail-closed 拦截违规内容
- 隐私合规：已在 `privacy.json` 声明 `chooseMedia` / `chooseAvatar` / `saveImageToPhotosAlbum` 并启用 `__usePrivacyCheck__`

## 技术栈

- 微信小程序**原生框架**（WXML / WXSS / JS）
- 微信**云开发**：云函数 `secCheck`（限频 + 内容安全主流程）、`mediaCheckResult`（微信推送回调）
- 渲染引擎：`utils/beadEngine.js`（canvas 绘制、图例、缩放自适应）

## 目录结构

```
app.js / app.json / app.wxss     全局入口与配置
pages/                           index（首页）/ template（编辑画布）/ gallery（画廊）/ profile（我的）
components/                      material-list、palette-selector 等
utils/                          beadEngine（渲染引擎）、secCheck（前端安全封装）、colorData / colorLibrary（色卡）
cloudfunctions/                 secCheck、mediaCheckResult 云函数
test/                           纯 Node 测试用例（见下）
privacy.json / sitemap.json / project.config.json   小程序配置
```

## 本地开发

1. 用**微信开发者工具**导入本项目根目录。
2. `project.config.json` 中的 `appid` 可替换为你自己的小程序 AppID（公开标识，不影响代码）。
3. 开通**云开发**环境，首次运行会在 `app.js` 中 `wx.cloud.init` 自动初始化。

## 图标资源

`app.json` 的 tabBar 图标（`images/icons/*.png`，共 6 张）由 `_gen_icons.py` 生成，且**已纳入版本控制**——正常 `git clone` 后即可直接导入运行，无需任何预处理步骤，不会出现图标 404。若你改动了图标源或想重新生成，执行：

```bash
python _gen_icons.py
```

（脚本会在 `images/icons/` 不存在时自动创建目录；正常开发无需手动运行。）

## 运行测试

测试为纯 Node 脚本，无需测试框架 runner，直接运行单个文件即可：

```bash
node test/template_preview_autofit.test.js
node test/sec_check_ratelimit_atomic.test.js
node test/gallery_display_clamp.test.js
# ……test/ 下每个 *.test.js 均可独立运行
```

> 提示：测试用例覆盖渲染自适应、限频原子性、内容安全 fail-closed、画廊展示钳制等关键路径。

## 云函数部署

`cloudfunctions/secCheck` 与 `cloudfunctions/mediaCheckResult` 需在**微信开发者工具**中分别「上传并部署：云端安装依赖」。

- 云函数使用 `cloud.DYNAMIC_CURRENT_ENV`，无需硬编码环境 ID；
- 部署后请验证：图片机审流程、限频、降级恢复告警正常。

## 开源协作

- Bug 反馈：开 Issue，附复现步骤与设备 / 基础库版本。
- 功能建议 / 修复：欢迎 PR，建议先同步设计意图再改核心渲染与云函数逻辑。
- 隐私与安全：涉及 `privacy.json`、`secCheck` 限频 / 内容安全的改动请务必附带测试。

## 许可证

（待补充，请项目所有者确认开源协议）

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

## 安全与隐私

### 内容安全链路（mediaCheckAsync 异步机审）

用户上传图片 → 前端压缩（≤800px，见下）→ 云存储中转 → `secCheck` 云函数调微信 `security.mediaCheckAsync`（异步）→ 微信通过 `wxa_media_check` 消息推送结果 → `mediaCheckResult` 云函数写入 `sec_check_results` → 前端轮询读取 `suggest`（pass 放行 / review、risky 拦截）。

- **超时兜底（不悬挂）**：前端提交后以 1s 间隔轮询最多 **20 次（约 20s）**，若回调未到达（网络抖动 / 微信推送丢失 / 未配置 mediaCheckResult）则按 **fail-closed 拦截**并提示「内容安全检测暂不可用，请稍后重试」——检测结果**永远不会处于悬挂状态**，超时即拒绝放行。
- **fail-closed 语义**：检测链路任何环节未完成（通道不可用 / 超时 / 图片过大 / 限频）一律默认拦截，仅**开发版 develop** 回退放行便于本地调试；体验版 / 正式版强制拦截。
- **误杀救济**：拦截时按原因区分提示（违规 / 图片过大 / 操作频繁 / 服务不可用），用户可**直接重新选图重试**，本地相册原图不受影响（仅清理本次压缩产生的临时文件）。注：微信内容安全 API 不提供人工申诉通道，误判的唯一救济是更换图片后重试。
- **前端上传前校验**（`validateImageFile`，选图即校验，非仅靠云端）：文件类型必须为图片、**大小 ≤10MB**、**宽高 ≤6000px**、真实格式（基于文件内容而非扩展名）在白名单内，图片信息读取超时按失败拒绝。

### 限频分层

- **后端**：`secCheck` 云函数按 openid **每小时 100 次**窗口限频（数据库原子条件更新，数据库故障时降级单实例内存兜底并告警）。
- **前端**：`index.chooseImage` / `profile.uploadPickerImage` / `template.saveTemplate` 均有**忙碌守卫**（连点忽略），避免同一处理链并发重复消耗检测配额。

### 隐私与数据流

- `privacy.json` 已声明全部隐私接口（`chooseMedia` / `chooseAvatar` / `saveImageToPhotosAlbum`）并启用 `__usePrivacyCheck__`。
- **用户图片上传**：内容安全检测需要临时上传图片到云存储 `sec_check/` 目录，**检测结束后云函数立即删除**该文件（含提交失败分支，隐私设计，测试已断言）；前端异常路径亦有兜底清理。
- **数据保留周期**：检测结果（`sec_check_results`）仅存 `suggest` / `label` / `errcode` / 时间戳，不含图片本体；检测完成或拦截后图片即删除，无长期留存。
- **画廊与历史存储**：模板历史、对照原图、头像均存储于**本地**（`wx.storage` 与 `USER_DATA_PATH` 文件系统），不上传云端；用户在画廊可删除单条历史，页面也提供清理入口。

## 云函数部署

`cloudfunctions/secCheck` 与 `cloudfunctions/mediaCheckResult` 需在**微信开发者工具**中分别「上传并部署：云端安装依赖」。

`cloudfunctions/secCheck` 与 `cloudfunctions/mediaCheckResult` 需在**微信开发者工具**中分别「上传并部署：云端安装依赖」。

- 云函数使用 `cloud.DYNAMIC_CURRENT_ENV`，无需硬编码环境 ID；
- 部署后请验证：图片机审流程、限频、降级恢复告警正常。

## 开源协作

- Bug 反馈：开 Issue，附复现步骤与设备 / 基础库版本。
- 功能建议 / 修复：欢迎 PR，建议先同步设计意图再改核心渲染与云函数逻辑。
- 隐私与安全：涉及 `privacy.json`、`secCheck` 限频 / 内容安全的改动请务必附带测试。

## 许可证

本项目采用 **MIT License**。详见 [LICENSE](./LICENSE)。

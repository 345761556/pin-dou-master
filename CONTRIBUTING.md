# 贡献指南（Contributing）

感谢你关注 **拼豆格子（PinDou Grids）**！本项目欢迎通过 Issue 和 PR 一起找 BUG、改进功能。本文档说明如何本地开发、跑测试、提 Bug、提 PR。

---

## 一、环境准备

| 工具 | 用途 | 备注 |
|---|---|---|
| 微信开发者工具 | 导入并运行小程序 | 必装，[官网下载](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) |
| Node.js (LTS) | 运行 `test/` 下的纯 Node 测试 | 无需测试框架，直接 `node` 跑单文件 |
| Python 3 | 重生成 tabBar 图标（`_gen_icons.py`） | 仅改图标源时才需要 |

> 图标（`images/icons/*.png`）**已纳入版本控制**，正常 `git clone` 后无需任何预处理即可导入运行。

---

## 二、本地开发

1. 微信开发者工具 → 导入项目 → 选择本仓库根目录。
2. `project.config.json` 里的 `appid` 可替换为你自己的小程序 AppID。
3. 开通**云开发**环境，首次运行 `app.js` 会自动 `wx.cloud.init`。
4. 云函数 `cloudfunctions/secCheck`、`cloudfunctions/mediaCheckResult` 需在开发者工具中分别「上传并部署：云端安装依赖」。

---

## 三、跑测试

测试是纯 Node 脚本，不依赖任何 runner，直接运行单个文件：

```bash
node test/template_preview_autofit.test.js
node test/sec_check_ratelimit_atomic.test.js
node test/gallery_display_clamp.test.js
# test/ 下每个 *.test.js 都可独立运行
```

- 每个文件末尾会打印 `PASS/FAIL` 与断言计数，全部通过才表示绿。
- 提交前请运行**与你改动相关**的测试文件；涉及核心渲染、内容安全、云函数封装的改动，请**补回归测试**。

---

## 四、提交 Bug（Issue）

请先搜索是否已有相同 Issue。新建时请使用 **Bug Report** 模板，至少包含：

- **复现步骤**：一步一步能稳定复现的操作路径
- **预期 vs 实际**：你期望发生什么、实际发生了什么
- **环境与版本**：微信基础库版本、开发者工具版本、手机型号 / 系统版本
- **截图或日志**：报错截图、`console` 输出、云函数日志（可脱敏）

> 一句话反馈也可以，但越具体越容易被定位和修复。

---

## 五、提交代码（PR）

1. **先同步意图**：改动核心渲染（`utils/beadEngine.js`）、内容安全（`secCheck` / `mediaCheckResult`）或隐私声明（`privacy.json`）前，建议先开 Issue 讨论设计意图，避免方向偏差。
2. **分支策略**：从 `main` 切出 `fix/xxx` 或 `feat/xxx` 分支，改完提 PR 回 `main`。
3. **必须带测试**：
   - 修 Bug → 提供能复现并验证修复的回归测试；
   - 加功能 → 提供覆盖关键路径的测试；
   - 涉及 `secCheck` 限频 / fail-closed、隐私声明的改动 → **强制**附带测试。
4. **变更范围克制**：一个 PR 解决一件事；不要顺手做无关的格式化大改。
5. **描述清晰**：PR 说明里写清「改了什么 / 为什么 / 如何验证」。

---

## 六、安全与隐私红线

- `privacy.json` 涉及隐私授权范围，改动需谨慎并附说明。
- 内容安全机审为 **fail-closed**（机审异常时默认拦截），任何削弱该行为的改动都需充分论证并附降级测试。
- 切勿在代码中硬编码密钥、AppID 之外的敏感配置；云函数环境用 `cloud.DYNAMIC_CURRENT_ENV`，不写死环境 ID。

---

## 七、代码风格

- **原生小程序框架**：WXML / WXSS / JS，不引入跨端框架（uni-app / Taro 等）。
- 逻辑复用优先放进 `utils/`，组件优先放进 `components/`。
- 新增大段异步逻辑时，注意错误必须向上 `reject` / 抛出，不要静默吞掉（本项目已修过多处此类问题）。

---

## 八、许可证

本项目采用 **MIT License**（见仓库根目录 [LICENSE](./LICENSE)）。在遵循该许可证条款（保留版权与许可声明）的前提下，你可以自由使用、修改与再分发本仓库代码。

---

再次感谢你的参与 🎉

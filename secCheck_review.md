# secCheck/index.js Diff 审查报告（512 行）

**审查对象**：`cloudfunctions/secCheck/index.js` 的 H1 速率限制竞态修复 diff  
**审查日期**：2026-08-25  
**总体评价**：✅ diff 整体质量高，逻辑自洽，缺陷可控。发现 **1 个严重问题**、**2 个中等问题**、**1 个建议项**。

---

## 一、变更概览

| # | 变更类别 | 描述 | 风险等级 |
|---|---|---|---|
| H1 | 核心修复 | `updatedCount()` 双形态读取修复 `res.updated` → `res.stats.updated` 的 SDK 差异 | ✅ 正确 |
| H2 | 核心修复 | `readRateDoc()` 区分"文档不存在"与"DB 故障"，消除误将异常当首访的覆盖清零路径 | ✅ 正确 |
| H3 | 新功能 | `checkQueryRateLimit()` 为 query 轮询分支建立独立 600/h 限频 | ✅ 正确 |
| H4 | 新功能 | `memoryQueryRateLimit()` 独立内存兜底，含 L4 三段式清理 | ✅ 正确 |
| H5 | 安全加固 | submit 成功路径写入 pending 文档（含 openid + appid），失败则阻断 | ✅ 正确 |
| H6 | 安全加固 | query 分支归属绑定（openid 校验），越权查询返回 pending | ✅ 正确 |
| H7 | 安全加固 | `getTempFileURL` 返回值增加 `status !== 0` 校验 | ✅ 正确 |
| H8 | 安全加固 | 云日志 openid 打码（maskedOpenid） | ✅ 正确 |
| H9 | 健壮性 | `finally` 中文件删除时机后移（成功路径不删，失败路径删） | ✅ 正确 |
| H10 | 新增 | `action=text` 文本检测接入 msgSecCheck v2 同步接口 | ⚠️ 见下文 P1 |
| H11 | 清理 | 孤立文档删除失败从静默吞错 → warn | ✅ 正确 |
| H12 | 清理 | 移除历史误写注释（msgSecCheck/base64） | ✅ 正确 |

---

## 二、严重问题（需修复）

### P1-1：`action=text` 中 `checkRateLimit` 使用 `OPENID` 但未做 OPENID 判空前的限频短路

**位置**：diff 第 337-360 行（`action=text` 分支）

**问题**：`text` 分支在获取 `OPENID` 后直接调用 `checkRateLimit(OPENID)`，但 `checkRateLimit` 内部**没有对 `OPENID` 为空做防御**。虽然外面有 `if (!OPENID)` 返回 -7，但 `checkRateLimit` 自身不校验。如果未来有人重构调用顺序或 `cloud.getWXContext()` 返回 `{OPENID: ''}`（空字符串），`checkRateLimit` 会用空字符串作为 `_id` 去数据库操作——这不会抛错但会产生一条以空串为 `_id` 的限频记录，污染限频数据。

**修复建议**：`checkRateLimit` 和 `checkQueryRateLimit` 函数内部增加 `if (!openid) return { allowed: false, reason: 'missing openid', source: 'db' };` 作为首行防御。不依赖调用方判空。

---

## 三、中等问题（建议修复）

### M1-1：`updatedCount()` 在 `updatedCount(resetRes) === 1` 分支的窗口重置路径中遗漏了"重置被抢占"的 return

**位置**：diff 第 260-272 行（`checkRateLimit` 窗口过期重置被抢占）

**问题**：当 `resetRes` 的 `updatedCount` 不为 1（重置被并发抢占）时，代码**没有 `return`**，控制流直接落入下方"同窗口原子累加"。这与 `checkQueryRateLimit` 第 358-361 行的设计一致（刻意不加 return）。但 `checkRateLimit` 在此处的注释未像 `checkQueryRateLimit` 那样明确标注"勿在此补 return"，后续维护者可能误补 return 导致重置被抢占路径漏计一次。

**修复建议**：在 `checkRateLimit` 的重置被抢占路径下方加一行注释，与 `checkQueryRateLimit` 对齐：`// 重置被抢占：不加 return，控制流落入下方重试窗口内累加。勿在此补 return，否则漏计一次。`

### M1-2：`memoryQueryRateLimit` 与 `memoryRateLimit` 的 L4 清理阈值不一致

**位置**：diff 第 389-416 行 vs 第 427-459 行

**问题**：`memoryRateLimit` 使用阈值 500 → 全量清扫 → 仍超限则裁剪至 300。`memoryQueryRateLimit` 同样使用 500 → 清扫 → 裁剪至 300。数值一致，但 `memoryQueryRateLimit` 的裁剪步长是 `200`（500-300），与 `memoryRateLimit` 完全一致。✅ 这一点实际上是对的，但 diff 的注释"语义与 memoryRateLimit 完全一致"容易让人误以为实现完全一致——实际上 `memoryQueryRateLimit` 没有在 L2 阶段做"不能依赖插入顺序 == windowStart 顺序"的详细注释说明，存在维护盲区。

**修复建议**：将 `memoryRateLimit` L3 的注释（"不能依赖插入顺序 == windowStart 顺序做早停"）复制到 `memoryQueryRateLimit` 对应位置，避免后续修改其中一个时漏改另一个。

### M1-3：`mediaCheckResult` 的 `PENDING_RETRY_DELAY_MS` 默认值与 diff 中注释不一致

**位置**：`mediaCheckResult/index.js` 第 63-67 行 vs `secCheck/index.js` diff 中的注释引用

**问题**：`secCheck/index.js` diff 在 L2+ 竞态兜底注释中引用"3 秒重读一次"，但 `mediaCheckResult/index.js` 当前代码中实际默认值是 **500ms**（非 3000ms）。diff 的注释可能基于旧代码或计划中的值。如果当前线上已部署 500ms 版本，diff 描述的 3s 兜底窗口不存在，竞态保护弱于注释所述。

**修复建议**：确认当前线上部署的 `mediaCheckResult` 是否已包含 P3-9 修复（500ms）。如果是，diff 中的"3 秒"注释需改为"500ms"；如果计划升级为 3000ms，需同步更新代码。

---

## 四、建议项

### S1-1：`pending write failed` 返回码 -14 与现有错误码体系未对齐

**位置**：diff 第 688 行

**问题**：现有错误码体系为 -1（参数无效）、-2（内容超长）、-4（内部错误）、-6（限频）、-7（缺失 openid）、-8（临时 URL 不可用）、-9（无效 traceId）、-10（查询失败）、-11（无 trace_id）、-12（SDK 不支持）、-14（pending 写入失败）。新错误码 -14 是合理扩展，但 `pollSecCheckResult` 前端轮询逻辑需确认已处理 -14 为可重试错误（与 -10 同口径），否则前端可能将 pending 写入失败误判为"检测完成"而停止轮询。

**修复建议**：在前端 `pollSecCheckResult` 中将 `-14` 列入可重试/继续轮询的 errcode 列表，与 `-10` 同口径。

### S1-2：`msgSecCheck` 文本检测的 `scene=1` 与前端场景映射

**位置**：diff 第 369-374 行

**问题**：`msgSecCheck` v2 固定 `scene=1`（资料），与"昵称编辑属资料场景"的注释一致。但前端 `utils/secCheck.js` 的 `checkText` 调用可能在其他场景也触发（如评论中的文本检测）。如果将来有非资料场景的文本检测需求，`scene=1` 会不准确。

**修复建议**：目前无需改动，但建议在 `checkText` 的入参中预留 `scene` 字段传递能力，或在 `action=text` 分支允许 `data.scene` 传入（需做白名单校验，与 `sceneNum` 一致）。

---

## 五、整体架构评价

### ✅ 正确且高质量的部分

1. **`updatedCount()` 双形态读取**：精准解决了对抗式审查 #30 发现的 SDK 返回结构差异问题，是真正的高价值修复。注释中的"背景"段清晰解释了为何此前 `res.updated` 直接读取会退化为"每用户每窗口仅首次放行"。

2. **`readRateDoc()` 错误路径分流**：将"文档不存在"与"DB 故障"严格区分，消除了原 `.catch(() => ({data:null}))` 把 DB 抖动当首访创建、导致配额被重置清零的并发放大路径。中危 #1 的修复思路正确。

3. **pending 文档写入 + fail-closed**：submit 成功路径写 pending、失败则阻断，是正确的 fail-closed 决策。pending 文档携带 openid + appid 作为 L2/L3 信任锚点，与 `mediaCheckResult` 端的 L2/L3/L4 校验链完整对接。

4. **`query` 分支独立限频**：解决了原 query 分支在校验之前直接 return 可被匿名刷调用量的安全问题。`qCount`/`qWindowStart` 独立字段设计正确，与 submit 配额互不干扰。

5. **`finally` 文件删除时机后移**：正确识别了"成功路径立即 deleteFile 与 mediaCheckAsync 异步下载竞态"的 -1008 误拦问题。延迟到 mediaCheckResult 回调删除 + 前端兜底删除双层覆盖，隐私目标不变。

6. **`getTempFileURL` status 校验**：修复了"仅判 tempFileURL 空串会漏掉 status 非 0 但带残留 URL"的对抗式审查 #5 问题。

### ⚠️ 耦合风险（运维层面）

diff 头部明确标注了与本函数耦合的 `mediaCheckResult` 云函数必须同时重新上传部署。当前 `mediaCheckResult/index.js` 已包含对应的 L2/L3/L4 校验链（P2-6 相关逻辑已就位），但需注意：

- `mediaCheckResult` 端的 `readPendingDoc` 函数与 `secCheck` 端的 `readRateDoc` 采用了**相同的文档不存在 vs DB 故障分流模式**，二者的一致性很好。
- 但 `mediaCheckResult` 端没有使用 `updatedCount()` 辅助函数（仍用内联双形态读取），建议统一以减少重复代码。

### 📊 变更规模评估

| 指标 | 数值 |
|---|---|
| 新增行数 | ~160 |
| 删除行数 | ~15 |
| 净增行数 | ~145 |
| 新增函数 | `updatedCount`, `readRateDoc`, `checkQueryRateLimit`, `memoryQueryRateLimit` |
| 修改函数 | `checkRateLimit`（多处替换）, `exports.main`（query + text + submit 三段） |
| 新增注释行 | ~60（注释密度高，与代码质量正相关） |

---

## 六、结论

**diff 整体通过，建议合入**。1 个严重问题（P1-1：`checkRateLimit`/`checkQueryRateLimit` 缺少内部 OPENID 防御）建议修复后合入；2 个中等问题（M1-1、M1-2）为注释/维护性改进，不影响正确性；1 个建议项（S1-1）需确认前端轮询已处理 -14 错误码。

**合入前确认清单**：
- [ ] 修复 P1-1：`checkRateLimit`/`checkQueryRateLimit` 首行增加 openid 防御
- [ ] 确认 M1-1：`checkRateLimit` 重置被抢占路径补注释
- [ ] 确认 M1-3：`mediaCheckResult` 的 `PENDING_RETRY_DELAY_MS` 默认值与 diff 注释一致
- [ ] 确认 S1-1：前端 `pollSecCheckResult` 已将 -14 列入可重试 errcode
- [ ] 两个云函数（secCheck + mediaCheckResult）同时重新上传部署

---

*审查人：高见远（软件架构专家）*  
*基于对抗式审查 #30/#1/#5/#9/#11 及上下文中的 P0-P3 问题跟踪*

# 内容安全与健壮性审查 · 全量闭环记录

> 本文件为历轮代码审查修复的**权威闭环记录**。每轮发现项无论风险高低均登记，含修复状态、改动文件与验证结果，供后续回溯核对（避免误判「中危未处理」）。

## 总览（含中危项，均已闭环）

| 轮次 | 项 | 风险 | 根因 | 修复 | 状态 |
|---|---|---|---|---|---|
| M1/M2 | M1 渲染/复制/预览脏数据 | **中** | `renderTemplate`/`onCopy` 直取 `item.color.*`、缺字段抛 `TypeError`；`renderCanvas` 无 try/catch 静默空白 | `beadEngine` 加判空+非数组兜底、`_drawLegend` 跳过缺色；`onCopy` 占位符；`renderCanvas` exec 包 try/catch+toast | ✅ |
| M1/M2 | M2 rleDecode 维度+累计总长 | **中** | 单段 count 上限取 `cols*rows`，脏维度下被放大；多段累计无上限 → 16KB 串膨胀 2880 万项 OOM | `rleDecode` 钳制维度(≤4096/≤20000)、count 随钳制计算、累计总长硬截断 | ✅ |
| L1–L5 | L1 极端竖图 slider 失真 | 中 | `chooseImage` 死钳 `MIN_COLS`，slider 显示≠生成 | 默认列数取自然上限+动态 `[colMin,colMax]` | ✅ |
| L1–L5 | L2 历史脏数据兜底 | 中 | `loadStats`/`gallery` 元素级无判空 | `Array.isArray` 判型 + `m.color.id` 判空 | ✅ |
| L1–L5 | L3 重复点击守卫 | 中 | save/share 无 busy 守卫 → 并发重复保存 | `_saveBusy`/`_shareBusy` 守卫 + finally 清理 | ✅ |
| L1–L5 | L4 限频并发重复+内存 | 低 | 并发 add 重复文档；`_memRateStore` 不回收 | `doc(openid).set` 幂等 upsert；内存超 2000 清理 | ✅ |
| L1–L5 | L5 event 注释不符 | 纯文档 | 注释称可解析 JSON 字符串，实现不 parse | 注释改为准确描述 | ✅ |
| L1–L2 | L1 限频双文档竞态 | 中(窄) | 灰度/回滚残留旧格式 auto-id 文档 → 计数写错文档，限频失效 | 优先读 `_id===openid` 规范文档并清理孤立文档 | ✅ |
| L1–L2 | L2 默认列数行为 | 非 bug | 选新图默认跳到自然上限(89×89) 过大 | 改为 `min(capCols, DEFAULT_COLS=50)`，极端竖图(<50)仍取真实上限 | ✅ |
| L1–L2 | L3 renderCanvas 兜底 | — | 上一轮 M1 已修复（try/catch+toast 已存在） | 无需改动 | ✅ 已具备 |
| L1–L2 | L4 琐碎项 | 低 | `wx:key="color"` 同色重复告警；取色 `onerror` 缺失败分支 | `wx:key="index"`；`imgEl.onerror` 反馈 | ✅ |
| M2闭环 | 渲染端维度≠解码端 | 中 | `viewTemplate` 写脏声明 `cols` 到 currentTemplate，渲染按脏维度跑满 4 亿格卡死（try/catch 兜不住） | `template.onLoad` + `gallery.viewTemplate` 以解码矩阵反推真实维度覆盖 | ✅ |
| L1–L3 | L1 renderCanvas 日志脱敏 | 低 | catch 用 `console.error` 绕过脱敏约定 | 改为 `log.error`（security.js 已导入，生产自动脱敏） | ✅ |
| L1–L3 | L2 展示字段无钳制 | 低 | `totalBeads/colorCount/physicalWidth/beadSize` 原样透传，脏记录显示 1e20 超长串 | `clampDisplayNumber` 钳制卡片+currentTemplate 字段 | ✅ |
| L1–L3 | L3 交付文档不符 | 文档 | 旧 overview 未登记 M1/M2 中危项，闭环证据链缺中危记录 | 本文件重写为全量闭环总览 | ✅ |
| L1–L4 | L1 卡片 sizeLabel 未走钳制 | 低 | `sizeLabel` 用原始 `physicalWidth/Height`，同 map 的 `totalBeads/colorCount` 已钳制 → 内部处理不一致 | `sizeLabel` 改用 `clampDisplayNumber(...,DISPLAY_MAX_MM)` 后再 `formatMm`（与 siblings 一致） | ✅ |
| L1–L4 | L2 profile 总数未钳制 | 低 | `loadStats` reduce 累加原始 `item.totalBeads`，脏 1e20 污染总数、显示超长串 | 累加前每项 `clampDisplayNumber(...,20000)`，脏记录只贡献上限 | ✅ |
| L1–L4 | L3 材料 count 脏值未防护 | 低 | `percent/percentText` 与 `onCopy` 直取原始 `item.count`，脏 1e20 → percentText="500000000000000000%"、清单超长串 | 计算/展示前 `count=clampDisplayNumber(item.count,20000)`（template 页 + material-list 同源） | ✅ |
| L1–L4 | L4 卡片角标 cols×rows 未钳制 | 低 | `{{item.cols}}×{{item.rows}}` 用原始声明值，脏记录显示 99999999×4 | loadHistory 返回对象覆盖 `cols/rows` 为 `clampDisplayNumber(item.cols,4096)`（与 rleDecode DIM_HARD 一致） | ✅ |
| L1–L5 | L5 colorPreview.percent 未钳制 | 低 | `colorPreview` 的 `percent` 用原始 `m.count`/`item.totalBeads`，同 map 的 totalBeads/colorCount/sizeLabel/cols/rows 已全部钳制 → **直接违背启发 5（同源一致性）**；脏 count=1e20→色条 `width:5e17%` 布局异常，反向脏 totalBeads→塌缩 0% | `percent: Math.min(100, calcPercent(clampDisplayNumber(m.count,20000), clampDisplayNumber(item.totalBeads,20000)))`（两端钳制 + 占比语义封顶 100%） | ✅ |
| S1 | 云函数 fileID 归属校验为子串匹配 | **中(安全)** | `secCheck` 云函数 `if (!fileID.includes('/sec_check/'))` 是子串包含匹配而非存储 key 的路径前缀匹配；fileID 中 `/sec_check/` 出现在非开头位置（如 `user/sec_check/evil.png`）即误过，成为 finally 内无条件 `deleteFile` 的唯一防线 → 授权边界可被绕过（与 L10 同源） | 新增 `getStorageKey()` 解析 fileID 得 env 根目录相对 key（cloud:// 取首 `/` 之后、https 丢 env 段），`isOwnedSecCheckFile()` 校验 key 精确以 `sec_check/` 开头（`startsWith`）且不含 `..` 路径遍历段 | ✅ |
| S2 | 内容安全全链路 fail-open | **中(安全/合规)** | `checkImageByPath` 的 5 条失败分支（cloud_unavailable / image_too_large / errcode≠0 / call_failed / internal_error）全部 `pass:true`，唯一防线做成 fail-open = 没有防线；攻击者可断网、跳过压缩、或触发限频稳定绕过检测（微信审核要求的安全控制形同虚设） | 改为**默认 fail-closed**（检测未完成即拦截）；仅 `develop` 环境回退 fail-open（本地未部署云函数可调试）；新增 `isFailClosedMode()`/`resolveFail()`/`blockMessage()`/`BLOCK_TYPE`；拦截按类型（size/rate/unavailable/error/violation）给差异化提示；保留 M1 的 errcode≠0 / call_failed 已上传文件回收 | ✅ |
| S3 | 云函数限频计数非原子 + 内存兜底单实例 | **中(资源/安全)** | `checkRateLimit` 数据库分支 `where({openid}).get()` → 本地算 `newCount=count+1` → `doc(openid).set()` 是典型读-改-写非原子序列（TOCTOU）；云函数多实例并发时多个请求同时读到旧 count 并各自写回，窗口内实际调用次数可远超 `RATE_LIMIT_MAX=100`，msgSecCheck 免费额度可被刷爆。内存兜底 `_memRateStore` 仅单实例，多实例/冷启动/扩容都会重置，且与数据库分支无一致性 | 数据库分支改为**数据库端条件更新**原子自增：`where({_id, windowStart, count:_.lt(MAX)}).update({count:_.inc(1)})`（仅满足「当前窗口且计数<上限」才被 server 原子自增，并发者因 count 已被+1 不再满足 `_.lt(MAX)` → 判定超限）；窗口重置用 `where({_id, windowStart:_.neq(当前)}).update` 条件重置+重试，避免重置竞态误拦截/回退；内存兜底拆为 `memoryRateLimit` 仅作数据库故障降级（接受跨实例不精确代价） | ✅ |
| M1(取色) | profile 取色画布对 0/NaN 尺寸无守护 | 中(健壮性) | `pickColorAtPoint` 的 `imgWidth/imgHeight` 直取 `pickerImageInfo`（脏数据可 0/NaN），`viewWidth/viewHeight` 直取 `boundingClientRect`（图片隐藏时返回 0）；`viewRatio=viewWidth/viewHeight` 除零得 NaN → `dispW/dispH` 失真；`canvasW=0` 时 `pixelX` 钳制为 `-1` → `getImageData(-1,…)` 越界；`canvas.width=canvasW` 在 try 块外，canvasW 为 NaN/0 直接抛异常中断整个 `query.exec` 回调（该回调无 try/catch） | 读取维度后立即用 `isPositiveFinite` 校验 imgWidth/imgHeight/viewWidth/viewHeight，任一非正有限数即 `toast` 返回；`canvasW/canvasH` 在缩放分支与兜底分支均 `Math.max(1, Math.round(...))` 钳到至少 1，从源头消除除零/越界/画布异常 | ✅ |
| M2(闸门) | validateImageFile 校验"失败即通过"语义错误 | **中(健壮性/安全)** | `getImageInfo` 失败分支 `resolve(true)` fail-open，破损/临时路径失效/非图片内容文件被放行流入 `compressImageIfNeeded` 与 `beadEngine.generateTemplate`，仅由 6000px 断言兜底；chooseImage 压缩链路可能因源图不可读反复失败 | `fail` 分支改为 `resolve(false)` + `wx.showToast('图片读取失败，请重试')`，与 S2 内容安全 fail-closed 原则一致（无法验证即拒绝） | ✅ |
| M3(常量) | 导出尺寸上限魔法数漂移：EXPORT_MAX_SIDE=2048 死常量 vs template.js 硬编码 4096 | 中(维护性/一致性) | `utils/util.js` 定义 `EXPORT_MAX_SIDE:2048` 全项目零引用（死代码），而 `pages/template/template.js` 实际导出上限是本地硬编码 `const maxSide=4096`；同一「Canvas 单维硬上限」概念在导出(4096)、预览(4096)、`beadEngine.DIM_HARD`(4096) 多处硬编码，唯独 `util.js` 留一个矛盾且无人引用的 2048 常量——未来若有人按 2048 接上限，会把 2048 以上导出全部砍掉（行为漂移） | 删除死常量 `EXPORT_MAX_SIDE`；在 `template.js` 提升模块级共享常量 `MAX_CANVAS_SIDE=4096`（导出 `maxSide` 与预览 `MAX_PREVIEW_SIDE` 均引用之），注释明确与 `beadEngine.DIM_HARD=4096` 同源一致；33MB 位图预算 `MAX_EXPORT_BITMAP_BYTES` 保留并补一致性说明 | ✅ |
| M4(遮蔽) | index.js 内层 const colorLib 同名遮蔽模块引用 | 中(可维护性/健壮性隐患) | `pages/index/index.js` 模块级 `const colorLib = require('../../utils/colorLibrary')`（模块对象，含 `getCurrentColors`/`switchPalette` 等方法），在 `generateTemplate` 的 `query.exec` 回调内被 `const colorLib = colorLibraries[selectedPalette] \|\| …`（数组）重新声明遮蔽——类型从模块对象变成数组；当前回调内未再调用模块方法故不崩溃，但属高风险同名遮蔽，后续开发者在该回调内新增 `colorLib.getCurrentColors()` 会直接 TypeError | 内层变量改名 `paletteData`（并加注释点明与模块级 `colorLib` 的区分），`beadEngine.initPalette(paletteData)` 同步更新；模块级 `colorLib` 恢复在整个文件可见，遮蔽消除 | ✅ |
| M5(脏矩阵) | rleEncode 对畸形矩阵无结构校验，可持久化垃圾数据 | 中(数据完整性/健壮性) | `utils/beadEngine.js` 的 `rleEncode` 假定 template 是规整二维数组（`cols=template[0].length` 定列数）。若历史存储出现：① 缺失行（稀疏数组空洞 `template[r]` 为 undefined）→ `template[r][c]` 直接抛 TypeError，中断 `saveToHistory` 链路丢用户作品；② 行内列数不等 → 长行被首行列数截断、`undefined` 元素被 `== null` 静默归空位，真实色号无声改判为空白；③ 元素为 number/object → 原样拼成 `5:N`/`[object Object]:N` 脏令牌。RLE 是长期持久化产物，历史上已出现过脏数据（多处展示钳制即佐证），畸形矩阵会被编码成脏串落库并污染材料统计口径 | `rleEncode` 改为 sanitize 防御：非数组/空矩阵返回 `''`；缺失行→整行空位（不再裸抛）；**列数取最大行宽**（规整矩阵行为不变，脏矩阵避免长行被截断丢色）；非字符串非 null 元素→归一空位（杜绝 `undefined`/`NaN`/对象字面令牌）；与 `rleDecode`「永不抛、脏数据归空位」防御哲学一致，**不 throw**（避免保存链路丢作品）。另给 `rleDecode` 加最小防御：历史上的 `'undefined'`/`'NaN'` 字面令牌归一成空位 | ✅ |
| M6(信息泄露) | 云函数错误信息透传客户端，存在环境细节泄露 | 中(安全/合规) | `cloudfunctions/secCheck/index.js` 的 `catch` 分支把底层异常消息 `e.errMsg || e.message` 原样塞进返回 `errmsg` 透传客户端，可能泄露资源名/调用链/SDK 版本/region 等内部细节；客户端 `utils/secCheck.js` 仅依据 `errcode`（数字）做 fail-closed 分支、不依赖 `errmsg` 字符串，故泄露无必要 | `catch` 分支 `errmsg` 收敛为固定通用令牌 `'sec_check_internal_error'`，底层异常详情仅 `console.error` 写入**服务端**日志（不回传客户端）；`errcode` 数值保留供客户端分支 | ✅ |
| L1(空色号) | rleDecode 对空 colorId（:5 形态 chunk）容忍 | 中(数据完整性/健壮性) | `utils/beadEngine.js` 的 `rleDecode` 在 `chunk.lastIndexOf(':')===0` 时 `colorId=''`，空串既不是 `EMPTY_CELL_TOKEN(__E__)`、也不命中 `'undefined'`/`'NaN'` 归一分支，于是被 `flat.push(value)` 原样填进矩阵；渲染端 `colorMap['']` 查不到而静默跳过，材料统计里留下无意义空串、且脏数据无感知 | 空 `colorId` 归一为空位 `null`（与 `__E__`/`'undefined'`/`'NaN'` 同源），**填 count 个格子保持矩阵对齐**——不字面「跳过整个 chunk」（否则后续 chunk 全部错位、整张矩阵错位，比空串污染更糟）。静态+动态回归测试覆盖 | ✅ |
| L2(量化) | medianCutQuantize 对同色像素桶重复切分（性能浪费） | 低(性能) | `utils/beadEngine.js` 的 `medianCutQuantize` 在桶内 `maxRange===0`（全同色）时仍继续切分直到 `buckets.length === maxColors`，把同色桶反复劈成重复颜色桶，浪费约 `maxColors` 次全桶扫描（`getBucketRange`）+ 排序 + `slice`；极端场景（纯色图 + colorCount=50）白做约 50 次全桶扫描。下游 `usedPalette` 去重后**功能无影响**，纯属无效计算 | 在 `forEach` 找到全局最大 `maxRange` 后，若 `maxRange===0`（所有桶已单色）提前 `break`——继续切分只造重复同色桶、无收益。功能零变化（同色桶经 `getAverageColor` 与下游去重后等价）；纯色图 + colorCount=50 由返回 50 桶降为 1 桶，混合图在「全单色」时即停（如 3 色图由逼到 50 桶降为 14 桶） | ✅ |
| L3(色工具) | hexToRgb 对 3 位短 hex（#FFF）当非法返回黑色、8 位带 alpha hex（#RRGGBBAA）静默丢弃 alpha | 低(健壮性/通用性) | `utils/beadEngine.js` 的 `hexToRgb` 用 `hex.length < 6` 一刀切：`#FFF`（长度 3）被当成非法返回黑色（应展开为 #FFFFFF）；`#RRGGBBAA`（长度 8）只靠 `substring(0,6)` 侥幸取前 6 位、无显式 8 位分支，作为通用颜色工具易被未来数据格式扩展坑到（当前色卡均为 6 位 hex，无实际影响） | 取消 `length<6` 一刀切；新增 3 位展开（每位重复一次）+ 8 位截断（取前 6 位丢弃 alpha）**显式分支**，其余长度（非 3/6/8）仍黑色兜底；文档注释声明支持的格式 | ✅ |
| L4(存活) | index.js `generateTemplate` 的 `img.onload`/`img.onerror` 回调未检查页面存活状态 | 低(健壮性/UX) | `img.onload` 在图片异步加载 + 长耗时同步计算（大图 + 中位切分 + 抖动）后才执行 `this.setData` / `wx.navigateTo` / `this.saveToHistory`；若用户在此期间返回上一页或切换 tab，页面已卸载/隐藏，回调仍跑——触发「页面已卸载 setData」告警，或把 template 页误推到用户已离开的页面栈上（误跳转）。原代码无任何 `_pageAlive`/栈顶判断 | 引入 `this._pageAlive` 标记：`onLoad`/`onShow` 置 `true`，`onHide`/`onUnload` 置 `false`（tab 切换只触发 onHide/onShow 不卸载，故 onShow 必须重新置 true，否则切回后首次生成被误判为死）；`img.onload`/`img.onerror` 入口判 `this._pageAlive === false` → 仅 `wx.hideLoading()` 清理全局遮罩并 `return`，跳过一切页面操作 | ✅ |
| L5(标号) | calcLabelSpace 对 cols/rows ≤ 0（含负数）无下限守卫 | 低(健壮性/通用性) | `utils/beadEngine.js` 的 `calcLabelSpace` 是导出 Canvas（`_calcExportParams`）与绘制（`renderTemplate`）共用的标号预留空间计算入口，原 `(cols - 1).toString().length` 在 `cols=0` 时取 `-1` 的长度（"-1".length=2）、`cols=-10` 取 `-11` 的长度（3），不崩溃但语义错误（把空/负网格当多位数标号、预留空间偏大）；正常调用方已保证 ≥1 故无实际影响，但作为共用入口被未来异常数据命中会算错标号区尺寸 | 入口对 cols/rows 做 `Math.max(1, x)` 钳制后再算（≤0 一律当 1 列/1 行最小网格）；对正常 cols/rows ≥ 1 输出零变化（钳制为恒等），导出/渲染同源一致性不变 | ✅ |
| L6(启动GC) | app.js 冷启动 gcBeadTempFiles 对 USER_DATA_PATH 全量 readdirSync 遍历 | 低(性能/可接受) | `utils/util.js` 的 `gcBeadTempFiles`（app.js L149 冷启动调用）每次启动对 `wx.env.USER_DATA_PATH` 做一次 `readdirSync` 全量枚举 + 逐条 `unlinkSync` 尝试；历史文件多/无关文件累积多时启动路径有少量耗时（O(n)，n=USER_DATA_PATH 下全部文件，含非 bead 前缀的无关文件）。`unlinkSync` 失败被静默吞掉（可接受）。属性能级轻微问题，作者明确「可接受现状」 | **本轮不改源码**（遵循作者「可接受现状」建议）。仅新增契约测试把当前「全量扫描 + 三前缀删除 + keepSharePath + 孤儿 history_source 仅清」行为钉死，使未来若做「缩小扫描范围」优化时须保持同等删除语义。技术澄清：文件名「日期前缀」**不能**降低 readdirSync 成本（它枚举整目录，前缀过滤是枚举后的 JS 逻辑）；真正能缩小扫描的是把 bead 临时文件移入**专用子目录**再 `readdirSync(子目录)`——属更大重构（需改 3 处写入点 + 旧文件迁移），作者未要求故不动 | 🔵 接受现状(未改) |
| H1(异步拒绝) | chooseImage / uploadPickerImage 的 wx.chooseMedia success 是 async 回调，内部 await 抛异常被吞成「未处理 Promise 拒绝」 | 低(健壮性/UX) | `pages/index/index.js` 的 `chooseImage`（L195 `success: async (res)=>`）与 `pages/profile/profile.js` 的 `uploadPickerImage`（L260 `success: async (res)=>`）回调内对 `validateImageFile` / `_compressForSecCheck`(内部 `compressImageIfNeeded` 可 `reject(new Error('invalid_image_path'))`) / `secCheck.checkImageByPath` / `setData` 等多个调用 `await`；若任一抛异常而非返回 falsy，`wx.chooseMedia` 的 `fail` 回调**只捕获 chooseMedia 自身失败**、拦不到 success 内的异步异常 → 异常变成未处理的 Promise 拒绝，控制台告警且**用户无任何 toast、操作静默失败**。当前 `validateImageFile`/`secCheck.checkImageByPath` 虽恒 `resolve`（不 reject），但 `compressImageIfNeeded` 确有 reject 路径、且未来任一被重构为 reject 即触发该潜藏 bug——属「async 回调无顶层守卫」的健壮性缺口 | 两处 success 回调体**顶层包 `try {…} catch (err) { log.error('[…] 异步处理异常（兜底未处理拒绝）:', err); wx.showToast({ title: '图片处理失败，请重试', icon:'none' }); }`**——异常时记日志 + 通用 toast，fail-closed 兜底（绝不静默吞错）；与 M2/S2 内容安全「无法验证即拒绝/提示」口径一致。`fail` 回调语义保持不变（仍只处理 chooseMedia 自身失败如隐私未授权），不重复覆盖 | ✅ |
| H1'(共用canvas) | saveTemplate / shareTemplate 共用同一 #export-canvas node，但 _saveBusy/_shareBusy 互不拦截 | 低(健壮性/数据损坏) | `pages/template/template.js` 的 `saveTemplate`(L481) 与 `shareTemplate`(L596) 均经 `_getExportCanvas` 拿到**同一个** `#export-canvas` 的 node，再各自设 `canvas.width`/`canvas.height` 并绘制。两方法原有 `_saveBusy`/`_shareBusy` 仅拦「同按钮重复点击」、**不互相拦截**；用户点「保存」后立即点「分享」→ 两个 async 操作并发执行，交替改写同一 canvas 的 width/height 与绘制内容 → 导出图损坏 / canvas 状态错乱（如分享图被保存流程的中途尺寸覆盖、或 `canvasToTempFilePath` 读到半渲染状态）。属「共享可变资源 + 并发异步 + 无交叉锁」竞态 | `saveTemplate` 与 `shareTemplate` 进入时均判 `if (this._saveBusy || this._shareBusy)`——任一忙碌即忽略（保留各自 `_saveBusy`/`_shareBusy` 标记 + `finally` 清理，仅把「对方忙碌」也纳入拦截条件），实现共用 canvas 的**交叉互斥**；warn 文案含「重复点击」以兼容既有 `template_double_click_guard.test.js` 的断言。既堵跨按钮并发，又不破坏同按钮双击守卫 | ✅ |
| M1(slider上限) | colorCount slider 上限固定 50，与色卡实际颜色数不一致（artkalC=30、neko=35） | 低(UX/误导性) | `pages/index/index.wxml` 的 slider `max="50"` 与 `index.js` 的 `Math.min(50, ...)` 都是硬编码，但 `utils/colorData.js` 的色卡实际颜色数：artkalC=30、hama=50、perler=40、photoPearl=50、neko=35。artkalC 用户把 slider 拖到 50，实际量化最多返回 30 色，UI 显示"50"具误导；历史已保存的超色卡容量 colorCount 也不会被回写色卡容量上限。 `beadEngine.medianCutQuantize` 静默返回少于请求数的桶，但 `templateData.colorCount` 记录请求值而非实际返回桶数 | 在 `colorLibrary.js` 新增 `getPaletteColorCount(paletteKey)`；`index.js` 新增 `colorCountMax` 数据字段，由 `loadPaletteList`/`onPaletteChange` 同步为当前色卡实际颜色数；slider handler 改为钳制到 `this.data.colorCountMax`；`index.wxml` 的 slider `max` 绑定 `{{colorCountMax}}`；加载色卡后若历史 colorCount 超新色卡容量一并钳制 | ✅ |
| M2(formatNumber) | formatNumber 未拦截 Infinity/-Infinity，isNaN(Infinity)===false → 展示层输出非数字串 | 低(UX/数据格式) | utils/util.js 的 formatNumber 用 isNaN(num) 守卫（L77）；isNaN(Infinity)===false，传入 Infinity 返回 Infinity 字符串。index.js:329 与 template.js:120 均未先 clamp，脏数据直接透传展示层可见非数字串。clampDisplayNumber 已用 !isFinite 但两者口径不一致 | 守卫改为 !isFinite(num)——与 clampDisplayNumber 口径一致，拦截 NaN/Infinity/-Infinity 统一归 0 | ✅ |
| M3(renderCanvas警告) | renderCanvas canvas node 获取失败时静默 return，无用户反馈 | 低(UX/可观测性) | pages/template/template.js 的 renderCanvas（L154-160）wx.createSelectorQuery().select(#template-canvas).exec 回调内 `if (!res[0] || !res[0].node) return;` 无任何日志/提示；而同文件 _getExportCanvas（L396-415）有 retry + log.warn + reject 明确失败。口径不一致：预览路径用户看到空白无任何提示，导出路径有日志告警 | renderCanvas 的 canvas not found 分支加 `log.warn`——与 _getExportCanvas 口径一致；不改变控制流（仍 return，不抛错），仅补可观测性 | ✅ |
| M4(path校验) | isValidFilePath 对 http(s) 路径未校验 host，evil.com 类远程域名通过校验 | 低(安全/口径一致性) | `utils/security.js` 的 `isValidFilePath`（L99）对 `http://`/`https://` 直接 `return true`；与同文件 `isRemoteImageUrl` 用 host 含 "." 判别远程的口径矛盾——`isRemoteImageUrl(evil.com)=true`（远程）但 `isValidFilePath(evil.com)=true`（放行），语义不一致 | `http(s)://` 分支新增 host 正则匹配，仅 host 不含 "."（本地沙盒 tmp/store/usr）放行；含 "." 的远程域名一律拒绝——与 `isRemoteImageUrl` 口径对齐 | ✅ |
| M5(debounce取消) | debounce 返回裸函数无 cancel，onUnload 未清理定时器 | 低(健壮性/内存) | `utils/util.js` debounce 返回裸函数，外部无法取消 pending timer；`pages/index/index.js` onUnload 仅置 `_pageAlive=false`，300ms 后 debounce 回调仍触发 `this.setData` 操作已销毁页面实例 | `debounce` 返回包装器并附加 `cancel()` 方法；`index.js onUnload` 调用 `this.debouncedOnColsChange.cancel()` 和 `this.debouncedOnColorCountChange.cancel()` | ✅ |


## 本轮（L1–L3）明细

### L1 · renderCanvas 异常日志走脱敏通道
- **文件**：`pages/template/template.js:227`
- **改动**：`console.error('[template] renderCanvas 渲染异常…', err)` → `log.error(...)`。
- **依据**：`security.js` 的 `log.error` 已在该文件顶部导入（line 6），且 `sanitizeForLog` 对 `Error` 对象递归脱敏（剥离 `wxfile://tmp_...` 等设备路径）。原 `console.error` 绕过项目统一脱敏约定，生产环境可能把含设备特征的栈打上控制台。
- **验证**：`test/template_render_log_sanitized.test.js`（4 断言：catch 用 log.error、无残留 console.error、顶部已导入 log）。

### L2 · 展示字段脏数据钳制
- **新增**：`utils/util.js` 导出 `clampDisplayNumber(value, max)` —— 非有限/负数归零，超限截断为上限位，合法数据（≤上限）显示完全不受影响。
- **文件**：`pages/gallery/gallery.js`
  - `loadHistory`（卡片显示）：`totalBeads`/`colorCount` 钳制到 `DISPLAY_MAX_BEADS=20000`（合法模板 ≤120×120=14400 珠，留余量）。
  - `viewTemplate`（写 currentTemplate → 驱动 template 页顶部信息栏）：`totalBeads`/`colorCount` 钳到 20000，`physicalWidth`/`physicalHeight`/`beadSize` 钳到 `DISPLAY_MAX_MM=100000`（mm，远超正常成品）。
- **验证**：`test/gallery_display_clamp.test.js`（16 断言：脏记录卡片+currentTemplate 字段收敛、合法记录不变、M2 维度闭环不被破坏、L1 sizeLabel 收敛、L4 卡片 cols/rows 钳制）。
- **说明**：`cols/rows` 卡片角标（`{{item.cols}}×{{item.rows}}`）原本轮未纳入，已在后续 L1–L4 轮由 **L4** 一并收敛（见下）。

### L3 · 交付文档补记
- 原 overview 仅反映单轮、未登记中危 M1/M2，回溯会误判「中危未处理」。本文件重写为**全量闭环总览**，所有轮次含中危项均留痕。

## 本轮（L1–L4）明细 · 展示层脏数据钳制收尾

### L1 · 卡片 sizeLabel 走钳制值
- **文件**：`pages/gallery/gallery.js:60`
- **改动**：`sizeLabel` 由 `formatMm(item.physicalWidth) × formatMm(item.physicalHeight)` 改为
  `formatMm(clampDisplayNumber(item.physicalWidth, DISPLAY_MAX_MM)) × formatMm(clampDisplayNumber(item.physicalHeight, DISPLAY_MAX_MM))`。
- **依据**：同 `loadHistory` map 内的 `totalBeads/colorCount` 已钳制（L2 轮），`sizeLabel` 用原始脏值属内部处理不一致；脏 `physicalWidth=1e20` 收敛到 `DISPLAY_MAX_MM=100000` 后 `formatMm` 输出有限串。
- **验证**：`test/gallery_display_clamp.test.js`（断言 sizeLabel 传入 formatMm 的最大值为 100000、脏记录不含 1e20）。

### L2 · profile.loadStats 总数钳制
- **文件**：`pages/profile/profile.js:69`
- **改动**：`reduce` 累加由 `sum + (item.totalBeads || 0)` 改为 `sum + clampDisplayNumber(item.totalBeads, 20000)`。
- **依据**：脏记录 `totalBeads=1e20` 累加会污染总数并显示 `10000000000000000.0万` 超长串；逐项钳制后脏记录只贡献上限 20000，合法总数不受影响（例：20000+2500+3000=25500→"2.6万"）。
- **验证**：`test/profile_loadstats_clamp.test.js`（3 断言：无 1e20 串、总数=2.6万、脏记录只贡献上限）。

### L3 · 材料 count 数值钳制（template 页 + material-list 同源）
- **文件**：`pages/template/template.js:97-104`、`components/material-list/material-list.js:27-30`
- **改动**：
  - `template.js` 的 materialList map：`const safeCount = clampDisplayNumber(item.count, 20000)`，`percent`/`percentText` 用 `safeCount`，并回写 `count: safeCount` 透传给组件；
  - `material-list.js` 的 `onCopy`：`const count = clampDisplayNumber(item.count, 20000)`，清单/建议购买数用此值。
- **依据**：与 M1 修的「缺 color」同层，但此前缺「count 数值」防护；脏 `count=1e20` → `percentText="500000000000000000%"`、onCopy 清单与建议购买数均超长串。
- **验证**：`test/template_material_count_clamp.test.js`（5 断言：脏 count→20000、percentText="100%"、合法 count 不变）+ `test/material_list_oncopy_dirty.test.js`（扩展：脏 count→20000颗、无 1e20）。

### L4 · 卡片角标 cols×rows 钳制
- **文件**：`pages/gallery/gallery.js`（loadHistory 返回对象）
- **改动**：返回对象在 `...item` 之后覆盖 `cols: clampDisplayNumber(item.cols, DISPLAY_MAX_DIM)`、`rows: clampDisplayNumber(item.rows, DISPLAY_MAX_DIM)`，`DISPLAY_MAX_DIM=4096` 与 rleDecode 硬上限 `DIM_HARD` 一致（合法解码模板 cols/rows 均 ≤4096，钳制不误伤）。
- **依据**：`gallery.wxml:21` 的 `{{item.cols}}×{{item.rows}}` 用原始声明值，脏记录显示 99999999×4；纯展示防护。
- **验证**：`test/gallery_display_clamp.test.js`（断言脏卡片 cols===4096、rows===4、合法卡片 50×50 不变）。

### L5 · colorPreview.percent 走钳制 + 占比封顶（同源一致性补盲）
- **文件**：`pages/gallery/gallery.js:50-53`（`loadHistory` 内 `colorPreview` 构建）
- **改动前**：`percent: calcPercent(m && m.count, item.totalBeads)` —— 直接取原始脏值。
- **改动后**：
  ```js
  const safeTotal = clampDisplayNumber(item.totalBeads, DISPLAY_MAX_BEADS);
  const colorPreview = materialList.slice(0, 10).map(m => ({
    color: (m && m.color && m.color.hex) || '#CCCCCC',
    percent: Math.min(100, calcPercent(clampDisplayNumber(m && m.count, DISPLAY_MAX_BEADS), safeTotal))
  }));
  ```
- **依据**：同 `loadHistory` map 内的 `totalBeads/colorCount/sizeLabel/cols/rows` 均已钳制（L1–L4 各轮），唯独 `colorPreview.percent` 漏掉——**直接违反启发 5「同源展示字段钳制要一致」**。脏 `count=1e20` + 正常 `totalBeads=20000` → `calcPercent(1e20,20000)=5e17` → 色条 `width:500000000000000000%` 布局异常；反向（count 正常、totalBeads 脏 1e20）→ `calcPercent(100,1e20)=0` 色条塌缩 0%。两端钳制后两种方向均收敛；`Math.min(100, …)` 按「占比恒 ≤100%」语义额外封顶，与 `calcPercent` 除零兜底同级兜底，即便数据正常也不改变结果（合法占比均 <100）。
- **验证**：`test/gallery_display_clamp.test.js`（扩展至 20 断言：脏 count→封顶 100%、反向脏 total→不再塌缩 0%、合法占比 50% 不变、全部 percent 有限且 ≤100 无科学计数法）。

### S1 · 云函数 fileID 归属校验：子串匹配 → 精确路径前缀（授权边界加固）
- **文件**：`cloudfunctions/secCheck/index.js`（L126 原 `if (!fileID.includes(SEC_CHECK_PATH_PREFIX))`）
- **根因**：`String.prototype.includes` 是子串包含匹配，不是存储 key 的路径前缀匹配。fileID 形如 `cloud://<env>.<suffix>/<key>`，归属校验本应验证「key 是否在本函数授权管理的 `sec_check/` 目录」，却用 `fileID.includes('/sec_check/')`。一个 `key` 为 `user/sec_check/evil.png` 的文件（如项目未来在其它目录上传文件、或云存储写权限放开后攻击者自传）仍含 `/sec_check/` 子串 → 通过校验 → 被 finally 内 `deleteFile` 无差别删除。原注释「云存储 key 不允许 '..' 路径遍历，includes 已能拦住非本路径文件」论断错误：子串匹配根本不校验位置。
- **修复**：
  ```js
  function getStorageKey(fileID) {
    if (typeof fileID !== 'string' || fileID.length === 0) return null;
    if (fileID.startsWith('cloud://')) {
      const rest = fileID.slice('cloud://'.length);
      const slash = rest.indexOf('/');
      return slash === -1 ? null : rest.slice(slash + 1);
    }
    if (fileID.startsWith('https://')) {
      try {
        const seg = new URL(fileID).pathname.split('/').filter(Boolean);
        seg.shift(); // 丢弃 env 段
        return seg.join('/');
      } catch (e) { return null; }
    }
    return null;
  }
  function isOwnedSecCheckFile(fileID) {
    const key = getStorageKey(fileID);
    if (!key) return false;
    if (!key.startsWith(SEC_CHECK_KEY_PREFIX)) return false; // 精确前缀，非子串
    if (key.split('/').some((seg) => seg === '..')) return false; // 防路径遍历
    return true;
  }
  ```
  常量由 `SEC_CHECK_PATH_PREFIX = '/sec_check/'` 改为 `SEC_CHECK_KEY_PREFIX = 'sec_check/'`（key 不含前导斜杠）。校验点由 `fileID.includes(...)` 改为 `isOwnedSecCheckFile(fileID)`。两种 fileID 格式（cloud:// 与 https://）均按「env 根目录相对路径」解析 key，确保 `sec_check/` 是**第一段目录**才放行。
- **验证**：`test/sec_check_cloudfunction.test.js`（由 21 → **25 断言**）：升级静态断言为「精确前缀 startsWith + 非 fileID.includes + 防 ..」；新增 4 个 S1 用例——
  - 子串绕过 `cloud://env-test/user/sec_check/evil.png` → **errcode -5**（旧 includes 会误放过），不 download/delete；
  - 路径遍历 `cloud://env-test/sec_check/../other/x.png` → **errcode -5**，不 download；
  - https 合法 `https://bucket.tcb.qcloud.com/env-test/sec_check/...png` → 正常收容（downloadFile + pass）；
  - 原 cloud:// 合法/非 sec_check/ 前缀/限频/内存兜底用例全部维持。

### S2 · 内容安全检测 fail-open → fail-closed
- **文件**：`utils/secCheck.js`（`checkImageByPath` 全部分支 + 新增 `isFailClosedMode`/`resolveFail`/`blockMessage`/`BLOCK_TYPE`）；调用方 `pages/index/index.js:206`、`pages/profile/profile.js:115`、`:278` 改用 `secCheck.blockMessage(...)` 给差异化提示。
- **改动要点**：
  1. 5 条失败分支（cloud_unavailable / image_too_large / errcode≠0 / call_failed / internal_error）统一经 `resolveFail()` 收敛为**默认 `pass:false`（拦截）**，仅当 `isFailClosedMode()` 返回 false（即 `wx.getAccountInfoSync().miniProgram.envVersion === 'develop'`）才回退 `pass:true`（fail-open）。`trial`/`release`/无法判定环境一律 fail-closed。
  2. `image_too_large` 由「放行兜底」改为**拦截**：>7MB 本就无法送审 msgSecCheck（base64 膨胀超 10MB 上限），放行等于跳过检测；前端 `compressImageIfNeeded(≤800px)` 已在前置压缩，正常远小于该值，触发此分支多为压缩失败回退原图且原图超大，应提示用户压缩后重试。
  3. 拦截按 `blockType`（size/rate/unavailable/error/violation）经 `blockMessage()` 给差异化提示，避免把「图片过大 / 限频 / 服务暂不可用」误提示成「含违规信息」。限频(errcode -6) 单独标 `rate`（提示「操作过于频繁」）。
  4. **保留 M1 文件回收**：errcode≠0（含 -6/-5/45009）与 call_failed 分支拦截后仍 `deleteCloudFile` 已上传文件（隐私 + 配额清理不变）。
  5. 拦截时 `log.error('[secCheck][BLOCKED] ...')` 上报告警（生产环境可在云开发日志/实时日志按 `[BLOCKED]` 检索监控安全门健康度）。
- **验证**：
  - `test/sec_check.test.js` 由 11 → **40 断言**：失败分支全部断言 fail-closed（`pass=false` + `blockType` 正确：`unavailable`/`size`/`error`/`rate`）；新增 develop 环境逃生测试（fail-open）；新增 `blockMessage` 差异化文案断言。
  - `test/sec_check_errcode_cleanup.test.js`：errcode -6/-5/45009 改为「拦截 `pass=false` + 仍回收文件」断言（M1 行为不变）。
  - 集成测试 `chooseimage_cols_clamp` / `chooseimage_compress_fallback_estimate` / `profile_userinfo_migration` 的 `global.wx` mock 补 `getAccountInfoSync → develop`，使安全门在测试中 fail-open、聚焦本职（与本地开发语义一致），不被 fail-closed 牵连。
- **部署/运行影响**：fail-closed 依赖云函数已部署且云通道可用；正式环境若云函数未部署或云开发未开通，用户选图/传头像将被拦截（提示「检测暂不可用，请稍后重试」）。**提审前务必完成 S1 轮列出的云函数部署 + 集合创建**，否则正式环境上传功能会被安全门卡住。开发版(develop)不受影响（fail-open）。

### S3 · 云函数限频原子化（TOCTOU 修复）
- **文件**：`cloudfunctions/secCheck/index.js`（`checkRateLimit` 重写为数据库端条件更新 + 拆出 `memoryRateLimit` 兜底 helper）。
- **根因**：旧实现 `coll.where({openid}).get()` 读 `existing.count` → 本地 `newCount = existing.count+1` → `doc(openid).set({count:newCount})` 是典型读-改-写，云函数多实例并发时多个请求同时读到旧 count 并各自 +1 写回，窗口内实际放行次数可远超 100，msgSecCheck 免费额度可被刷爆。
- **改动要点**：
  1. **窗口内原子累加**：`coll.where({_id: openid, windowStart, count: _.lt(RATE_LIMIT_MAX)}).update({ data: { count: _.inc(1) } })` —— 由云开发 server 端原子完成「校验计数<上限 + 自增」，返回 `updated===1` 即放行；并发请求只有满足条件者被原子自增，其余因 count 已被 +1 不再满足 `_.lt(MAX)` → `updated===0` → 判定为超限，从根上杜绝并发突破。
  2. **窗口重置原子化**：`where({_id, windowStart: _.neq(当前窗口)}).update({windowStart, count:1})` 条件更新确保同一时刻仅一个并发请求成功重置；抢占失败者（文档已是新窗口）重试窗口内累加以正确纳入计数，避免重置竞态导致的误拦截或计数回退。
  3. **首次创建路径**：文档不存在时 `doc(openid).set({_id, windowStart, count:1})` 创建（云开发「不存在则创建」语义），作为当前窗口第 1 次计数；并发首访最多让窗口首访瞬时多放行少量（真实云开发 server 端事务隔离下不会并发创建），属可接受边界。
  4. **内存兜底降级**：拆出 `memoryRateLimit()`，仅当数据库整体不可用（catch，未建集合/权限/网络）时启用；单实例内 JS 单线程天然原子，但跨实例无一致性——S3 修复结论明确**接受此不精确代价**（仅降级层）。孤儿文档清理保留 best-effort（`where({openid, _id:_.neq(openid)})` 删除灰度遗留 auto-id 文档）。
- **验证**：
  - `test/sec_check_ratelimit_atomic.test.js`（**新增，18 断言**）：边界 count=100→限频且计数不越界；count=99→放行后 100、再限频；过期窗口→重置为 1 且 `windowStart` 切到当前；顺序爆发 150→仅 100 放行；**并发爆发（Promise.all，预置 count=50）→ 仅再放行 50 次且计数收敛到 100（原子 _.inc 杜绝并发突破）**；并发空文档首访不崩溃且计数恒 ≤100；数据库抛错→内存兜底放行。
  - `test/sec_check_cloudfunction.test.js` 由 25 → **29 断言**：新增 S3 静态断言（`_.inc`/`_.lt`/`_.neq` 原子条件更新、旧 `existing.count` 读-改-写模式已移除）；限频/内存兜底用例因 mock 升级同步维持（窗口按 `RATE_LIMIT_WINDOW_MS` 取整，预置 fixture 已对齐）。
  - `test/sec_check_migration_dual_doc.test.js` mock 升级支持 `_.inc/_.lt/_.neq` 与 `updated`，双文档竞态用例仍 5/5 通过。

### M1(取色) · 取色画布 0/NaN 维度守护
- **文件**：`pages/profile/profile.js`（`pickColorAtPoint`，L350 起）。
- **根因**：`imgWidth/imgHeight` 直取 `pickerImageInfo`（脏数据/图片未加载可拿到 0 或 NaN），`viewWidth/viewHeight` 直取 `boundingClientRect`（图片元素隐藏时返回 0 尺寸）。`query.exec` 回调本身无 try/catch 包裹，下列异常会直接中断回调：
  1. `viewRatio = viewWidth/viewHeight` 在 `viewHeight=0` 时得 `NaN`，级联使 `dispW/dispH` 失真、`imgX/imgY` 判定异常；
  2. `pixelX = Math.min(Math.max(0, pixelX), canvasW-1)` 在 `canvasW=0` 时钳制结果为 `-1`，`getImageData(-1, …)` 越界抛错（虽在 onload 的 try 内，但整条取色链路失败且提示含糊）；
  3. `canvas.width = canvasW`（L413）在 try 块**之外**，若 `canvasW` 为 NaN/0 直接抛异常。
- **改动要点**：
  1. 维度读取后新增 `isPositiveFinite`（typeof===number && isFinite && >0）校验 `imgWidth/imgHeight/viewWidth/viewHeight`，任一不满足 → `wx.showToast({'取色失败，请重新选择图片'})` 并 `return`，不让错误向下传播。
  2. `canvasW/canvasH` 计算：缩放分支已 `Math.max(1, …)`，新增 else 兜底分支同样 `Math.max(1, Math.round(...))` 钳到至少 1（经上方校验已保证 >0，此处防御浮点取整为 0）；canvas 尺寸恒 ≥1 后，`canvas.width` 与 `getImageData` 均不再越界/抛异常。
- **验证**：
  - `test/profile_picker_dim_guard.test.js`（**新增，7 断言**）：imgWidth=0 / imgHeight=0 / imgWidth=NaN / viewWidth=0 / viewHeight=0 五种 0/NaN 场景均提示返回、不触发 `getImageData`、且 `pickColorAtPoint` 不抛异常（证明回调不再中断）；合法 400×400 → 正常取色且坐标映射正确（不误伤）；1×1 极端小图 → canvas 钳到 ≥1、`getImageData` 坐标不为 -1。
  - 既有 `test/profile_picker_canvas_oom.test.js`（6 断言 OOM 缩放）维持通过，证明守护未破坏坐标映射正确性。

### M2(闸门) · validateImageFile 校验闸门 fail-open → fail-closed
- **文件**：`utils/util.js`（`validateImageFile`，L470 起，`getImageInfo` 的 `fail` 分支 L511-514）。
- **根因**：`validateImageFile` 是图片进入 `compressImageIfNeeded` 与 `beadEngine.generateTemplate` 前的**第一道闸门**，但其 `wx.getImageInfo` 的 `fail` 分支写 `resolve(true)`——即「**校验失败即通过**」的 fail-open 语义错误。文件损坏、临时路径失效、非图片内容等本应被闸门店拦截的输入，会直接放行继续流向压缩与生成算法，仅由 `beadEngine.generateTemplate` 的 6000px 断言（beadEngine.js L177-181）兜底避免算法崩溃；且放行后 `chooseImage` 压缩链路可能因源图实际不可读而反复失败，浪费用户等待。
- **改动**：`fail` 分支由 `resolve(true)` 改为 `resolve(false)` 并补 `wx.showToast({ title: '图片读取失败，请重试', icon: 'none' })`——与 S2 内容安全「无法验证即拒绝」的 fail-closed 原则一致；两个调用方（`pages/index/index.js:182`、`pages/profile/profile.js:268`）均已 `if (!valid) return` 正确处理，且期望 toast 由 `validateImageFile` 自身弹出（与同函数内其余拒绝分支 fileType/大小/格式/尺寸一致），改动对调用方透明、无回归。
- **测试联动修正**：`test/chooseimage_compress_fallback_estimate.test.js` 原 mock 用单一 `failGetImageInfo` 标志同时模拟「校验首读」与「压缩失败补取」两次 `getImageInfo` 失败。M2 后首读失败会被闸门直接拦截、压缩兜底场景（B/D）无法触达，暴露该测试**将两个不同调用混淆**的设计缺陷。修正：新增调用序号 `giCallSeq`，`failGetImageInfo` 仅作用于「二次读取」（`giCallSeq >= 2`，即 `readImageSize` 补取），首读（`validateImageFile`）必须成功放行进入压缩链路——使测试正确隔离两条路径，且隔离后语义更贴合「M2 首读已 fail-closed 通过、压缩失败才走补取兜底」的真实流程。
- **验证**：
  - `test/validate_image_getinfo_fail.test.js`（**新增，5 断言**）：静态断言 fail 分支不再 `resolve(true)` 放行；动态断言 `getImageInfo` 失败 → `resolve(false)` 拒绝 + 弹「图片读取失败」提示；尺寸 >6000px 与安全分支无回归；正常图片仍放行（success 路径不变）。
  - `test/chooseimage_compress_fallback_estimate.test.js` 由 19 → **24 断言**：B/D 场景在修正 mock 后恢复「压缩失败 + 补取失败 → 占位符」链路，A/C/E 无回归。

### M3(常量) · 导出尺寸上限魔法数漂移（死常量 + 同源硬编码）
- **文件**：`utils/util.js`（`CONSTANTS.EXPORT_MAX_SIDE`，L48 附近）、`pages/template/template.js`（导出 `maxSide` L345、预览 `MAX_PREVIEW_SIDE` L202、位图预算 `MAX_EXPORT_BITMAP_BYTES` L21）。
- **根因**：`utils/util.js` 的 `CONSTANTS` 定义了 `EXPORT_MAX_SIDE: 2048`（注释「导出图片最大边长」），但**全项目零引用**（死代码）；而真正生效的导出上限是 `pages/template/template.js` 内硬编码的 `const maxSide = 4096`。同一「Canvas 单维硬上限」概念在 **三处**硬编码：导出 `4096`、预览 `MAX_PREVIEW_SIDE=4096`、解码端 `beadEngine.DIM_HARD=4096`，唯独 `util.js` 留一个**矛盾且无人引用**的 2048 常量。风险：未来若有人看到 `EXPORT_MAX_SIDE` 并把它接成导出上限，会把 2048px 以上的导出全部砍掉（行为漂移）；或改 4096 时只改了一处，另两处仍旧值，导出/预览/解码维度失配。
- **改动**：
  - 删除死常量 `EXPORT_MAX_SIDE: 2048`（`utils/util.js` 的 `CONSTANTS`），并在同处注释说明导出维度上限已迁至 `template.js` 的 `MAX_CANVAS_SIDE`，避免「死常量 2048」与真实上限 4096 矛盾。
  - 在 `pages/template/template.js` 模块级新增共享常量 `const MAX_CANVAS_SIDE = 4096;`，注释明确其与 `utils/beadEngine.js` 的 `DIM_HARD = 4096` **同源**（均对应微信/iOS Canvas 单维 4096px 硬上限，模板解码网格已被 `rleDecode` 钳制到 ≤4096），改动需三处同步；并补注「单靠 4096 维度限制仍不足以防 OOM（4096×4096×4≈64MB > 33MB 预算），故叠加 `MAX_EXPORT_BITMAP_BYTES` 位图内存预算」。
  - 导出路径 `const maxSide = MAX_CANVAS_SIDE;`、预览路径 `const MAX_PREVIEW_SIDE = MAX_CANVAS_SIDE;`，两处同源漂移消除。
  - `MAX_EXPORT_BITMAP_BYTES = 33 * 1024 * 1024;` 保留，仅补一致性说明。
- **验证**：
  - `test/export_dimension_shared_const.test.js`（**新增，11 断言**）：静态断言 `util.js` 不再含 `EXPORT_MAX_SIDE:2048` 且 `EXPORT_QUALITY` 未误删；`template.js` 定义 `MAX_CANVAS_SIDE=4096` 且导出/预览均引用之；**跨文件一致性**断言 `template.MAX_CANVAS_SIDE(4096) === beadEngine.DIM_HARD(4096)`；33MB 预算保留。
  - `test/template_preview_dpr.test.js` 静态断言正则在 M3 后兼容 `MAX_PREVIEW_SIDE = MAX_CANVAS_SIDE`（仍 44 断言 0 失败）。
  - 功能零回归：导出上限数值仍是 4096（行为不变，仅从重复硬编码收拢为单一共享常量）。

### M4(遮蔽) · index.js 内层 const colorLib 同名遮蔽模块引用
- **文件**：`pages/index/index.js`（模块级 L4 `const colorLib = require('../../utils/colorLibrary')`；`generateTemplate` 的 `query.exec` 回调内 L402-404）。
- **根因**：模块级 `colorLib` 是 `colorLibrary` 模块对象（含 `getCurrentPaletteKey`/`getCurrentColors`/`getPaletteList`/`getPaletteName`/`switchPalette` 等方法，见 L127-158）。在 `query.exec` 回调内又用 `const colorLib = colorLibraries[selectedPalette] || colorLibraries.artkal_c || []` 重新声明同名变量（类型为**色卡数组**），遮蔽了模块级引用。当前回调内仅用 `beadEngine.initPalette(colorLib)`（数组合法），未再调用模块方法，故不崩溃；但属于**高风险同名遮蔽**——后续开发者在该回调内若新增 `colorLib.getCurrentColors()` 等模块方法调用，会因 `colorLib` 此刻是数组而直接抛 `TypeError`，且静态/动态都难第一时间定位（变量名「看起来」是对的）。
- **改动**：内层变量改名 `paletteData`（并加注释点明「此处是色卡数据数组，区别于模块级 colorLib 模块对象」），`beadEngine.initPalette(paletteData)` 同步更新。模块级 `colorLib` 在整个文件中恢复唯一可见，遮蔽消除；功能零变化（数组仍按原样传给 `initPalette`）。
- **验证**：
  - `test/index_colorlib_shadow.test.js`（**新增，6 断言**）：断言模块级 `const colorLib = require(colorLibrary)` 仍存在；全文件 `const colorLib` 声明仅 1 处（无内层遮蔽重声明）；不再存在 `const colorLib = colorLibraries[...]` 旧遮蔽模式；内层已改名 `paletteData` 且 `beadEngine.initPalette(paletteData)` 使用之；模块级 `colorLib` 既有方法调用（getCurrentColors/switchPalette）在文件其他处仍保留。
  - 功能零回归：`initPalette` 入参类型与值不变。

### M5(脏矩阵) · rleEncode 对畸形矩阵无结构校验
- **文件**：`utils/beadEngine.js`（`rleEncode` L937 起；`rleDecode` 令牌归一 L1041 起）。
- **根因**：`rleEncode` 假定入参是「首行定列数」的规整二维数组。三类畸形输入会出问题：① 缺失行——`template[r]` 为 `undefined`（稀疏数组空洞）时 `template[r][c]` 抛 `TypeError`，原本在 `saveToHistory` 链路里会**中断用户保存、丢失作品**（比静默持久化更糟）；② 列数不等——`cols=template[0].length` 只认首行，长行被截断、短行越界元素被 `== null` 静默归空位，真实色号被无声改判为空白；③ 非法元素——`number`/`object` 元素被原样 `flat.push` 拼成 `5:N`/`[object Object]:N` 脏令牌。RLE 是长期持久化产物，历史上已出现过脏数据（多处展示钳制即为佐证），畸形矩阵会被编码成脏串落库并污染材料统计口径（渲染端查不到色号而静默跳过，视觉等同空位但数据语义错乱）。
- **改动**：`rleEncode` 改为 sanitize 防御，与 `rleDecode`「永不抛、脏数据归空位」的防御哲学一致（**不直接 throw**，避免保存链路丢用户作品）：
  - 非数组 / 空矩阵 / 首行非数组 → 返回 `''`（与原空矩阵行为一致）。
  - **列数取「最大行宽」**而非首行列数：规整矩阵下 `maxWidth === row0.length`，编码格式完全不变；脏矩阵下避免长行被首行列数截断为 `undefined`（静默丢色），仅把较短行末尾补空位。
  - 缺失行（稀疏空洞）→ 整行空位，不再裸抛 `TypeError`。
  - 元素必须是**字符串色号或 null/空位**；其余（`undefined`/数字/对象）一律归一为空位令牌，**杜绝把 `undefined`/`NaN`/对象编码进 RLE 串**。
  - 另给 `rleDecode` 加最小防御：历史上可能已落库的 `'undefined'`/`'NaN'` 字面令牌（旧畸形矩阵产物）归一成空位，而非在渲染端因查不到颜色静默跳过（污染材料口径）。
- **验证**：
  - `test/rle_encode_malformed_matrix.test.js`（**新增，23 断言**）：① 静态断言不再以首行列数为唯一列数来源、对元素做类型校验、解码对 `undefined`/`NaN` 令牌归一；② 规整矩阵 round-trip 格式与还原不变（sanity）；③ 稀疏数组缺失行不抛、产出合法 RLE、decode 还原 3 行；④ 列数不等矩阵 encode 输出不含 `undefined:` 且短行真实色号 `C01` 未被截断；⑤ 数字/对象非法元素归一空位（`__E__`）、decode 后为 `null`、不产生 `5:`/`[object Object]:` 垃圾令牌；⑥ `rleDecode('undefined:3'/'NaN:2')` 全部归空位；⑦ 非数组/空矩阵/`[[]]` 安全返回 `''`。
  - 功能零回归：正常 `generateTemplate` 输出为规整矩阵，编码格式与历史落库数据完全兼容（maxWidth===row0.length 分支一致）。

### M6(信息泄露) · 云函数错误信息透传客户端
- **文件**：`cloudfunctions/secCheck/index.js`（`catch` 分支 L273 起；前端约定注释 L9-10）。
- **根因**：云函数 `main` 的 `catch` 分支（除 87014 违规归一化之外的「其余错误」）把底层异常消息 `(e && (e.errMsg || e.message)) || 'sec_check_failed'` 原样塞进返回 `errmsg` 透传客户端。微信 `security.msgSecCheck` / `cloud.downloadFile` 等接口抛出的 `errMsg` 常含内部细节（资源名、调用链、SDK 版本、region、bucket 等），构成**服务端环境信息泄露**面。客户端 `utils/secCheck.js` 仅依据 `result.errcode`（数字）做 fail-closed 分支判定（`-6`→限频、`errcode!=0`→拦截），**完全不依赖 `errmsg` 字符串做任何逻辑**，故原始消息透传既无功能价值、又有泄露风险。
- **改动**：`catch` 分支 `errmsg` 收敛为**固定通用令牌** `'sec_check_internal_error'`；底层异常详情（`e.errMsg || e.message` + `e.stack`）仅 `console.error('[secCheck] internal error:', …)` 写入**云函数服务端日志**（不回传客户端）；`errcode` 数值（`e.errCode`，缺省 `-4`）保留不变供客户端分支。同步更新 L9-10 前端约定注释，声明 errmsg 固定为通用令牌、绝不透传内部细节。客户端 `secCheck.js` 的 L256 日志原本会把 errmsg 打到客户端控制台，收敛后其记录的是固定令牌，泄露面一并消除。
- **验证**：
  - `test/sec_check_errmsg_leak.test.js`（**新增，11 断言**）：① 静态断言源码不再把 `e.errMsg/e.message` 直接作为返回 `errmsg`、已收敛为 `errmsg:'sec_check_internal_error'`、且存在 `console.error('[secCheck] internal error:')` 服务端日志、L10 注释声明固定令牌；② 动态断言——令 `msgSecCheck` 抛含 `env:prod-xyz/sdk:2.3.1/region:ap-shanghai/bucket:…` 的敏感异常：返回 `errcode` 保留底层数值(-100)、`errmsg==='sec_check_internal_error'`、且 `errmsg` 中**不含**任何敏感片段（资源名/api unauthorized/ap-shanghai 等均未泄露）、原始敏感细节仅出现在捕获到的服务端 `console.error` 日志中（未回传）、已下载文件仍触发 `deleteFile` 清理（隐私/配额）；③ `errCode` 缺省时 `errcode` fallback 为 `-4`、`errmsg` 仍为固定令牌（不回退到 `sec_check_failed` 或原始消息）。

### L1(空色号) · rleDecode 对空 colorId（:5 形态 chunk）容忍
- **文件**：`utils/beadEngine.js`（`rleDecode` 解析循环 L1026 起）。
- **根因**：`rleDecode` 对每个 `chunk` 取 `colonIdx = chunk.lastIndexOf(':')`，`colorId = chunk.substring(0, colonIdx)`；当 `chunk` 形如 `:5`（`colonIdx===0`）时 `colorId=''`。空串既不是 `EMPTY_CELL_TOKEN(__E__)`、也不命中 M5 的 `'undefined'`/`'NaN'` 归一分支，于是 `value=''` 被 `flat.push(value)` 原样填进矩阵。渲染端 `colorMap['']` 查不到而静默跳过、材料统计里留下无意义空串（色号口径被污染），且对脏数据无感知（不崩溃≠正确）。
- **修复决策（与用户建议的关键偏差）**：用户原建议「colorId 为空时跳过该 chunk」。**字面跳过整个 chunk 是错的**——`:5` 本表示 5 个格子，若跳过则后续所有 chunk 整体错位、整张矩阵错位（比空串污染更严重）。正确做法是把空 `colorId` 当作**空位（null）**，与原 `EMPTY_CELL_TOKEN`/`'undefined'`/`'NaN'` 同源归一，**填 count 个格子保持矩阵对齐**。
- **改动**：在 `rleDecode` 解析循环内，`value` 归一后追加 `if (value === '') value = null;`（紧邻 M5 的 `'undefined'`/`'NaN'` 归一分支，注释说明空 colorId 来源与对齐必要性）。
- **验证**：
  - `test/rle_decode_empty_colorid.test.js`（**新增，10 断言**）：① 静态断言源码存在 `if (value === '') value = null;` 防回归；② 动态断言 `rleDecode(':5;A01:3', 8, 1)` 前 5 格全为 `null`（非空串）、矩阵中无任何空串色号、第 6-8 格为 `A01`（对齐未被破坏）、`A01` 计数恰为 3（空 colorId 占位不挤占真实色号）、材料统计色号集合仅含 `A01`；③ 边界 `rleDecode(':3;:2', 5, 1)` 纯空 colorId 串整体还原为全空位矩阵、不抛不污染。
  - 功能零回归：正常非空色号链路（`'C01:5'` 等）与 `EMPTY_CELL_TOKEN(__E__)` 空位令牌编码/解码格式完全不变；`rleDecode` 仅对真·空串 `colorId` 多一次归一。

### L2(量化) · medianCutQuantize 对同色像素桶重复切分（性能浪费）
- **文件**：`utils/beadEngine.js`（`medianCutQuantize` 主循环 L170 起）。
- **根因**：`medianCutQuantize` 的 `while (buckets.length < maxColors)` 每轮 `forEach` 找「全局最大 `maxRange`」的桶切分。当所有桶已单色（`maxRange===0`）时，切分只把同色桶从中位劈成两个同色桶，下一轮仍选到 `maxRange===0` 的桶继续切，直到 `buckets.length === maxColors` 才停——产生大量冗余同色桶。每轮要全桶扫描（`getBucketRange` 遍历桶内像素）+ `sort` + `slice`，纯色图 + colorCount=50 白做约 49 次全桶扫描。下游 `usedPalette` 去重后功能无影响，纯属无效计算。
- **修复**：`forEach` 后、切分前，在 `if (maxIdx === -1) break;` 紧接着加 `if (maxRange === 0) break;`。因为 `maxRange` 是**所有桶的最大通道范围**，其为 0 即说明每个桶都已单色（同色像素），再切分只造重复颜色桶、无收益。功能零变化：同色桶经 `getAverageColor` 与下游去重后完全等价（单色图修复前返回 50 桶同色、修复后 1 桶，去重后皆 1 色）。
- **验证**：
  - `test/mediancut_samecolor_earlybreak.test.js`（**新增，11 断言**）：① 静态断言源码存在 `if (maxRange === 0) break;` 防回归；② 单色图（红,100px）+ colorCount=50 → 返回 **1 桶**（未修复为 50），平均色精确为 (200,0,0)；③ 纯色图 + colorCount=200 → 1 桶（非 200）；④ 混合图（红/绿/蓝各 30px）+ colorCount=50 → 返回 **14 桶（<50，未修复逼到 50）** 且 3 种真实颜色全在、无杂色（每平均色精确等于三目标色之一）；⑤ colorCount===颜色数（4）时返回 4 桶（与原行为一致，无回归）。
  - 功能零回归：`transparent_quantize_white.test.js`（A/B/C 三例，断言 `usedPalette`/`materialList`/`totalBeads`）仍全过——提前 break 不改变去重后的调色板与材料统计。

### L3(色工具) · hexToRgb 短 hex / 带 alpha hex 处理补全
- **文件**：`utils/beadEngine.js`（`hexToRgb`，L81 起）。
- **根因**：`hexToRgb` 是通用颜色工具，对输入格式做了 `#` 剥离后用 `if (hex.length < 6) return 黑色` 一刀切。这导致两类合理输入被错误处理：① **3 位短 hex**（`#FFF`、`#F0A`）：长度 3 < 6 → 被误判非法、返回黑色，而正确语义应是每位展开为两位（`#F0A`→`#FF00AA`）；② **8 位带 alpha hex**（`#RRGGBBAA`）：长度 8，原代码靠 `substring(0,6)` 侥幸取到前 6 位、RGB 数值恰好正确，但**没有显式的 8 位分支**——alpha 被静默丢弃且全凭巧合正确，一旦未来改成其它切法就会出 bug。当前色卡数据均为 6 位 hex，无实际业务影响，但作为通用工具极易被未来数据格式扩展（如带透明度的色卡、CSS 短写法）坑到。
- **修复决策**：采用用户建议的「**补全逻辑**」而非「仅加注释」——因为该函数的定位就是通用颜色转换，显式支持 3/6/8 位比单纯注释「仅支持 6 位」更不易被未来调用方踩坑；同时保留对非法输入（非字符串 / 长度非 3·6·8）的黑色兜底，与下游 `matchToPalette` 空位哨兵（`null`/`__E__`）约定解耦（空位不走本函数）。
- **改动**：
  - 取消 `if (hex.length < 6) return 黑色` 一刀切；
  - `hex.length === 3` → 每位重复一次展开为 6 位（`hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]`）；
  - `hex.length === 8` → `hex = hex.substring(0, 6)` 截断丢弃 alpha（本函数只返回 RGB，与 `rgbToHex` 单向下行一致）；
  - `else if (hex.length !== 6)` → 其余长度（2/4/5/7 位）黑色兜底；
  - 入参 `hex.replace('#','').trim()` 增加 `trim()` 容错首尾空格；非法 hex 字符仍由 `parseInt(...,16) || 0` 兜底为 0。
  - 文档注释显式声明支持 `#RGB` / `#RRGGBB` / `#RRGGBBAA` 三种格式及兜底规则。
- **验证**：
  - `test/hex_to_rgb_format.test.js`（**新增，18 断言**）：① 静态断言源码存在 `hex.length===3` 展开分支与 `hex.length===8` 截断分支、且不再有 `hex.length < 6` 一刀切（防回归）；② 3 位：`#FFF`→(255,255,255)、`#F0A`→(255,0,170)、`#abc`→(170,187,204)、`F00`(无#)→(255,0,0)；③ 8 位：`#FF0000FF`→(255,0,0) alpha 丢弃、`#00FF0080`→(0,255,0)、`#ff00ffaa`→(255,0,255)；④ 6 位基线不变：`#FF0000`/`#ff00ff`/`00FF00`(无#)；⑤ 非法兜底：长度2(`#FF`)/长度7(`#1234567`)/空串/`null`/数字均返回黑色。
  - 既有调用方无回归：色卡数据（均为 6 位 hex，`color_data_unique_hex.test.js` / `beadEngine.test.js` 的 hexToRgb 段）走 6 位分支完全不变；`beadEngine.js:928` `hexToRgb(c.hex)` 量化取色路径行为不变。

### L4(存活) · index.js img.onload 回调未检查页面存活状态
- **文件**：`pages/index/index.js`（`generateTemplate` 的 `img.onload`/`img.onerror`，L434/L483 起；生命周期 `onLoad` L98 / `onShow` / `onHide` / `onUnload` 新增）。
- **根因**：`generateTemplate` 在 `query.exec` 回调里 `canvas.createImage()` 后设 `img.onload`，`img.src = imagePath` 触发**异步图片加载**；`img.onload` 内部先同步执行 `beadEngine.generateTemplate`（大图 + 中位切分 + 抖动是长耗时计算），再 `this.setData({generating:false})` / `wx.navigateTo` / `this.saveToHistory`。在这段「图片异步加载 + 长耗时计算」窗口里，用户可能：① 返回上一页（`wx.navigateBack` 真正卸载页面）；② 切换 tab（index 是 tabBar 页，仅 `onHide` 不卸载）。两种情况下 `img.onload` 仍会执行：对已卸载页面 `this.setData` 触发「页面已卸载 setData」告警，且 `wx.navigateTo` 会把 template 页推到用户已离开的页面栈（误跳转）；即使在隐藏但未卸载的页面上 `this.setData` 不崩溃，也会无谓写历史 + 误跳转。
- **修复决策**：采用用户建议的「`_pageAlive` 标记」方案（而非 `getCurrentPages()` 栈顶判断，因标记法对「已卸载」与「仅隐藏」都能统一判死，且语义更直白、不依赖页面栈结构）。关键细节——**tabBar 页切换只触发 `onHide`/`onShow` 不卸载**，故必须：
  - `onLoad` / `onShow` → `this._pageAlive = true`（`onShow` 保证切回 tab 后恢复存活，否则切回后首次生成会被误判死而丢弃）；
  - `onHide` / `onUnload` → `this._pageAlive = false`（`onHide` 覆盖「用户已离开当前 tab」的误跳转风险）。
- **改动**：`img.onload` 与 `img.onerror` 入口统一加 `if (this._pageAlive === false) { wx.hideLoading(); return; }`——已死则**仅清理全局 loading 遮罩**（安全副作用），跳过 `setData` / 跳转 / 写历史 / 弹 toast 等一切页面操作；`wx.hideLoading` 为全局 API，对已卸载页面调用亦安全（避免遮罩残留）。
- **验证**：
  - `test/index_pagealive_guard.test.js`（**新增，19 断言，含 6 条静态防回归 + 3 场景运行时**）：① 静态断言 `onLoad` 置 `true`、`onShow` 置 `true`、`onHide`/`onUnload` 置 `false`、`img.onload`/`img.onerror` 入口均判 `this._pageAlive === false` 提前 return（防有人删守护）；② 运行时**真实加载 `pages/index/index.js`**（mock 微信运行时），驱动 `generateTemplate` 并触发 `img.onload`/`img.onerror`：场景 A（存活）→ `wx.navigateTo` 跳转 + URL 带 cols/rows/total + `saveToHistory` 写入 + `setData({generating:false})` + `hideLoading`，与原行为一致；场景 B（已死 + onload）→ 不跳转、不写历史、不对已死页面 `setData`、仅 `hideLoading`、不弹 toast；场景 C（已死 + onerror）→ 同上静默退出。
  - 功能零回归：现有 69 个测试文件（含 `chooseimage_compress_fallback_estimate`、`index_colorlib_shadow`）全过——新增生命周期方法不影响 `chooseImage`/`generateTemplate` 既有流程（这些测试不触发 onLoad/onHide，且 `_pageAlive` 默认在 generateTemplate 执行时由调用方上下文决定；本测试显式设置 `_pageAlive` 模拟两种状态）。

### L5(标号) · calcLabelSpace 对 cols/rows ≤ 0 的下限守卫
- **文件**：`utils/beadEngine.js`（`calcLabelSpace`，L32 起）。
- **根因**：`calcLabelSpace(cols, rows, cellSize, showLabels)` 是**导出 Canvas 尺寸（`_calcExportParams`）与绘制（`renderTemplate`）共用的标号预留空间计算入口**（注释显式声明「修改尺寸规则只改这一处即可」，是导出/预览同构性的唯一来源），原实现用 `const maxColDigits = (cols - 1).toString().length;` 直接对 `cols-1` 取长度。当 `cols ≤ 0` 时：
  - `cols=0` → `cols-1 = -1` → `"-1".length = 2`（把空网格当 2 位数标号，预留空间凭空偏大）；
  - `cols=-10` → `cols-1 = -11` → `"-11".length = 3`（负数更明显，且负号字符计入长度）；
  不崩溃但语义错误。正常调用方（template 页 `templateData.cols/rows`、引擎 `generateTemplate` 内部）已保证 ≥1，故当前无实际影响；但作为**共用入口**，一旦被未来异常数据（历史脏记录、外部导入模板）命中，会把标号预留区算错，进而让导出图/预览图尺寸错位（破坏同源一致性约定）。
- **修复决策**：采用用户建议的「**下限守卫**」方案（`Math.max(1, cols)` / `Math.max(1, rows)`），而非「仅加注释声明仅支持正数」——通用入口显式钳制比声明更不易被未来调用方踩坑；钳制对正常 ≥1 输入是恒等操作，导出/渲染同源一致性**零变化**。
- **改动**：入口新增 `const safeCols = Math.max(1, cols); const safeRows = Math.max(1, rows);`，位宽计算改用 `safeCols`/`safeRows`（`(safeCols - 1).toString().length`）。`≤0` 一律被钳制为 1 列/1 行最小网格，位宽=1（与 1 列网格标号 "1" 同口径）；注释声明钳制语义与原因。
- **验证**：
  - `test/calc_label_space_guard.test.js`（**新增，15 断言**）：① 静态断言源码存在 `Math.max(1, cols)` / `Math.max(1, rows)` 守卫（防回归回无守卫旧逻辑）；② 正常输入逐值等价——遍历 cols/rows∈[1,5,9,10,11,50,99,100,120] × cellSize∈[3,5,6,8,9,10,12,20] × showLabels∈[false,true] 共 **1296 组**，与「旧内联公式（无守卫）」计算结果偏差 0 组（证明对合法输入零变化）；③ 已知值基线 `calcLabelSpace(20,20,10,true)=32` / `(120,120,10,true)=44` / `(5,5,6,false)=0` 不变；④ 边界语义：`calcLabelSpace(0,5,10,true)=30`（修复前旧公式算得 32，已修复为 30）、`(0,5,10,true) !== 旧公式结果`（确证旧语义已改）、`cols=0` 与 `cols=1` 等价、`cols=-10` 负数钳制为 1、rows 同理、双零 `(0,0,10,true)=30`、不显示标号时 `(0,-5,10,false)=0` 不受守卫影响。
  - 既有 `test/calc_label_space_verify.js`（1296 组逐值等价校验）仍 0 mismatch 通过——本修复未改变任何合法输入输出。
- **附带观察（未改，供后续决策）**：原函数 `(cols - 1).toString().length` 计算的是「最大列号减一」的位数，而**真正最宽的列标号是 `cols` 本身**，故当 `cols` 恰为 10 的幂（10/100/1000…）时，位宽会**少算一位**（如 `cols=100` → 最宽标号 "100" 是 3 位，旧公式算 `(100-1)=99` → 2 位）。但因 `LABEL_SPACE_MIN=30` 下限兜底，小 cell 场景下被 MIN 吸收看不出；仅当 `cols≥100` 且 cellSize 较大（位宽项 > MIN）时才真正少预留约 12px（如 `cols=100,cellSize=10` 旧公式预留 32px、正确应 44px）。该问题**仅影响 ≥100 列大网格、且与本次 ≤0 边界修复正交**，未在本轮改动（避免扩大范围改动导出/渲染共享布局），若需修正应单独一轮（把 `(cols-1)` 改为 `(cols)` 并回归 `calc_label_space_verify`/`template_preview_*` 系列断言）。

### L6(启动GC) · 冷启动全目录遍历：接受现状 + 契约锁死
- **文件**：`utils/util.js` 的 `gcBeadTempFiles`（L565 起）、`app.js` 的 `onLaunch` 调用（L149）。
- **根因**：每次冷启动对 `wx.env.USER_DATA_PATH` 做一次 `readdirSync(base)` 全量枚举（base = USER_DATA_PATH），再逐条按前缀 `bead_export_` / `bead_share_` / `history_source_` 过滤并 `unlinkSync` 尝试；`unlinkSync` 失败被各自 `try/catch` 静默吞掉（可接受）。O(n) 成本中的 n 是 USER_DATA_PATH 下的**全部文件**（含非 bead 前缀的无关文件：缓存、头像缩略、其它本地数据），历史文件/无关文件多时启动路径有少量耗时。作者明确评级「性能级轻微问题 / 可接受现状」。
- **修复决策**：**遵循作者「可接受现状」建议，本轮不改源码**。理由：① 缺陷确属轻微、无功能/安全影响；② 作者提出的两个选项中，「按日期前缀缩小扫描范围」**技术不成立**——`readdirSync` 枚举的是整目录，文件名带日期前缀并不能减少枚举条目数（前缀过滤是枚举之后的 JS 逻辑），故无法降低 L6 描述的启动耗时；③ 真正能缩小扫描的「专用子目录」方案属更大重构（需改 `template.js` L513/L624、`index.js` L528 三处写入点把文件写进子目录、旧根目录文件一次性迁移、并让 `readdirSync(子目录)` 成为新扫描入口），作者未要求，故不动。
- **本轮交付（契约测试，防未来优化回归）**：不改源码的前提下，新增 `test/gc_scan_full_contract.test.js` 把「全量扫描」行为契约锁死：
  - 用「200 个无关文件 + 6 个 bead 临时文件」模拟冷启动文件多的场景（L6 描述的确切条件），断言全扫契约正确、计数精确；
  - 三条静态契约守卫断言源码**仍检查全部三个前缀**（`bead_export_`/`bead_share_`/`history_source_`）且仍对 USER_DATA_PATH 做 `readdirSync(base)` 全量枚举——使未来若真做「缩小扫描范围」优化（专用子目录），必须保持「仍删除全部三前缀 + 保留 keepSharePath + 仅清孤儿 history_source」的语义，否则本测试会失败（提示优化者同步更新）。
- **验证**：
  - `test/gc_scan_full_contract.test.js`（**新增，14 断言**）：200 个无关文件一个都没误删；2 个 `bead_export_*` 全删、旧 `bead_share_*` 删而 keepSharePath 保留、孤儿 `history_source_*` 删而**被历史引用**的 `history_source_*` 保留；`removed` 计数精确 = 4；静态断言三前缀检查与全量 `readdirSync(base)` 仍在。
  - 既有 GC 契约测试 `test/file_leak_cleanup.test.js` / `test/file_orphan_cleanup.test.js`（分别覆盖「空 storage 保守跳过 history_source」「有 storage 删孤儿保引用」）仍全过——全扫语义未变。
  - **全量 72/72 测试文件 0 失败**（较上轮 71 +1）。
- **真正可选优化（供后续决策，本轮未做）**：若日后确实要压启动耗时，做「专用子目录」方案——`mkdirSync(USER_DATA_PATH + '/bead_tmp', recursive)`，`template.js`/`index.js` 三处写入点改为写进该子目录，`gcBeadTempFiles` 改为 `readdirSync(子目录)`（根目录旧文件做一次迁移清理）。注意迁移期要同时扫根目录旧文件，否则升级前的历史临时文件会残留。

### H1(异步拒绝) · chooseImage / uploadPickerImage 的 async success 回调顶层守护
- **文件**：`pages/index/index.js` 的 `chooseImage`（L195 `success: async (res) =>`）；`pages/profile/profile.js` 的 `uploadPickerImage`（L260 `success: async (res) =>`）。
- **根因**：两处 `wx.chooseMedia` 的 success 是 `async` 回调，内部对 `validateImageFile` / `_compressForSecCheck`（其内 `compressImageIfNeeded` 在 `util.js:330` 确有 `reject(new Error('invalid_image_path'))` 路径）/ `secCheck.checkImageByPath` / `this.setData` / `this.updateEstimate` 等多处 `await`。`wx.chooseMedia` 的 `fail` 回调**只捕获 chooseMedia API 自身失败**（如隐私未授权、用户取消），**拦不到 success 异步体内的异常**。若任一 `await` 抛出（而非返回 falsy），异常即变为「未处理的 Promise 拒绝」：`console` 告警 + 用户无任何 toast、操作静默失败。当前 `validateImageFile`/`secCheck.checkImageByPath` 虽恒 `resolve(false/true)` 不 reject，但「async 回调无顶层 try-catch」是真实健壮性缺口——未来任一被重构为 reject（或 `setData`/`updateEstimate` 抛错）即触发。
- **修复**：两处 success 回调体**顶层包 `try { … } catch (err) { … }`**，catch 内 `log.error('[chooseImage] 异步处理异常（兜底未处理拒绝）:', err)` / `log.error('[uploadPickerImage] …')` + `wx.showToast({ title: '图片处理失败，请重试', icon: 'none' })`。fail-closed 兜底（异常必给反馈，绝不静默吞错）；`fail` 回调语义不变（仍只处理 chooseMedia 自身失败）。`index.js` 内已有的「压缩失败局部 try-catch → 补取尺寸」分支不受影响（外层 catch 仅在它之后的环节再抛时才触发）。
- **验证**：
  - `test/chooseimage_async_rejection_guard.test.js`（**新增，20 断言**）：静态断言两处 success 均 `success: async (res) => { try {` 顶层包 try、且 `} catch (err) {` + 通用 toast 文案存在；运行时用「可抛函数注入」让 `validateImageFile` / `secCheck.checkImageByPath` 主动 `reject`，驱动真实加载的 `chooseImage`/`uploadPickerImage`：
    - 断言① 异步体抛异常后 `success` 返回的 promise **已 resolve**（未逃逸为拒绝）；② 弹出通用失败 toast `图片处理失败，请重试`；③ `process.on('unhandledRejection')` 捕获数为 **0**（无「未处理 Promise 拒绝」逃逸）；④ 对照场景（validate+secCheck 均通过）不弹该 toast、正常完成。
  - 既有 `chooseimage_compress_fallback_estimate.test.js` / `profile_sec_check_compress.test.js`（压缩前置 + 兜底）仍全过——顶层 try-catch 对正常链路透明、零回归。
  - **全量 73/73 测试文件 0 失败**（较上轮 72 +1）。

### H1'(共用canvas) · saveTemplate / shareTemplate 共用 #export-canvas 的交叉互斥守卫
- **文件**：`pages/template/template.js` 的 `saveTemplate`（L481）/ `shareTemplate`（L596）；两者经 `_getExportCanvas`（L396，`.select('#export-canvas').fields({node:true})`）拿到**同一个** canvas node，再各自 `_generateExportImage` → 设 `canvas.width`/`canvas.height` 并绘制。
- **根因**：原 `_saveBusy`/`_shareBusy` 仅拦「同按钮快速双击」，**不互相拦截**。用户点「保存」后立即点「分享」→ 两个 async 操作并发执行，都拿到同一 canvas node 并交替设 width/height + 绘制 → 导出图损坏（如分享图被保存流程中途尺寸覆盖、或 `canvasToTempFilePath` 读到半渲染状态）/ canvas 状态错乱。属「共享可变资源（canvas node）+ 并发 async + 无交叉锁」竞态。
- **修复**：两方法进入时均判 `if (this._saveBusy || this._shareBusy)`——任一方进行中即忽略（保留各自标记 + `finally` 清理，仅把「对方忙碌」纳入拦截条件），实现共用 canvas 的**交叉互斥**。`log.warn` 文案含「重复点击」以兼容既有 `template_double_click_guard.test.js` 的断言（该测试隔离验证各按钮自身双击守卫）。
- **验证**：
  - `test/template_shared_canvas_mutex.test.js`（**新增，13 断言**）：静态断言两方法进入时均含 `if (this._saveBusy || this._shareBusy)`；运行时用 `_generateExportImage` 挂起模拟「忙碌中」：
    - A 保存进行中 → 分享被互斥拦截（`_generateExportImage` 仅调用 **1 次**=未并发碰共用 canvas；warn 含「重复点击」；分享未置位 `_shareBusy`；返回已 resolve promise 不逃逸）。
    - B 分享进行中 → 保存被互斥拦截（同上对称）。
    - C 无忙碌时两方法各自正常进入（不误杀合法操作）。
  - 既有 `template_double_click_guard.test.js` 同按钮双击守卫仍全过（因该测试「保存段」挂起使 `_saveBusy` 残留为真，原假定守卫独立、分享段会误入；已在其分享段前补 `tpl._saveBusy = false` 重置为隔离场景，使测试语义与「交叉互斥」新契约一致——属测试对齐修复，非放宽断言）。
  - **全量 85/85 测试文件 0 失败**（较上轮 73 +1）。

### H3(限频TOCTOU) · checkRateLimit 读-改-写非原子 → 核实为 S3 已修复 + 边界并发断言补充
- **文件**：`cloudfunctions/secCheck/index.js` 的 `checkRateLimit`（L108-186），主流程 `main` L237-240（`checkRateLimit` 在 `downloadFile` 之前 fail-closed 拦截，超限返回 `errcode:-6`）。
- **核实结论**：**已修复（S3 轮）**。作者描述的「`where({openid}).get()` 读 count → 本地 `newCount=count+1` → `doc(openid).set()` 写回」读-改-写序列**在现行代码中不存在**：
  - 增量主路径（L127-135）：`coll.where({_id: openid, windowStart, count: _.lt(RATE_LIMIT_MAX)}).update({ data: { count: _.inc(1), _updatedAt: now } })`——**条件原子更新**，server 端原子完成「读-判-写」，并发请求只有满足 `count < MAX` 者被原子自增，其余 `updated===0` → 走区分分支判定超限。正是作者建议的 `db.command.inc(1)` 方案 + `_.lt` 上限守卫。
  - 窗口重置（L152-155）：`where({_id, windowStart: _.neq(windowStart)}).update({windowStart, count:1})` 条件重置 + 抢占重试（L160-164），无重置竞态。
  - 首次访问（L140-147）：`doc(openid).set({count:1})`——并发首访各写 count=1、计数收敛为 1，仅「文档尚不存在」的首次窗口存在、且客户端无该集合写权限无法反复触发，注释已文档化接受。
  - 内存兜底（L194-212）：单实例 JS 单线程天然原子，跨实例不精确被接受（仅数据库故障降级）。
  - **H3 描述的「N 个并发同时读到 count=99 → 全部判定 newCount=100 → 放行 N 次」在当前原子实现下不可能发生**：server 串行化后首个请求把 count 自增到 100，其余请求 `_.lt(100)` 条件不再满足 → 全部拒绝。
- **本轮改动**：不改源码（属「✅ 已具备」闭环，符合 overview 启发 7「计数器/配额类必须数据库端原子更新」）。向既有 `test/sec_check_ratelimit_atomic.test.js` **追加 2 条 H3 精确边界断言**（场景 8）：预置 `count=99` + 50 并发 `Promise.all` → 断言**仅 1 次放行**（99→100）、计数收敛为 100 无覆写——把 H3 攻击场景钉死为不可能，防未来重构回退读-改-写。
- **验证**：`test/sec_check_ratelimit_atomic.test.js` **20/20 通过**（原 18 + H3 2）；既有 `sec_check_cloudfunction.test.js` / `sec_check_migration_dual_doc.test.js` 等云函数套件零回归；**全量 85/85 测试文件 0 失败**（无新增文件，断言数 +2）。


### M1(slider上限) · colorCount slider 上限与色卡实际颜色数对齐
- **文件**：`utils/colorLibrary.js`（新增方法）、`pages/index/index.js`（新增数据字段 + 3 处同步调用）、`pages/index/index.wxml`（slider max 绑定）
- **根因**：`index.wxml` 的 colorCount slider `max="50"` 与 `index.js` 的 `Math.min(50, ...)` 都是硬编码，但 `colorData.js` 的色卡实际颜色数：artkal_c=30、hama=50、perler=40、photoPearl=50、neko=35。artkal_c 用户把 slider 拖到 50，实际量化最多返回 30 色，UI 显示「50」具误导；历史已保存超色卡容量 colorCount 也不会被回写色卡容量上限。`beadEngine.medianCutQuantize` 静默返回少于请求数的桶，但 `templateData.colorCount` 记录请求值而非实际返回桶数。
- **修复**：
  - `colorLibrary.js`：新增 `getPaletteColorCount(paletteKey)` 方法，读取 `globalData.colorLibraries[key].length`，未知 key 回落 `artkal_c`，null key 用 `getCurrentPaletteKey()` 当前色卡。
  - `index.js`：data 新增 `colorCountMax: 30` 字段；`loadPaletteList()` 同步 `colorCountMax` 并钳制历史 `colorCount`（`Math.min(this.data.colorCount, maxCount)`）；`onPaletteChange()` 切换色卡后同步更新 `colorCountMax` 并钳制；`debouncedOnColorCountChange()` 改为钳制到 `this.data.colorCountMax`（而非硬编码 50）。
  - `index.wxml`：slider `max="50"` → `max="{{colorCountMax}}"`。
- **验证**：`test/m1_color_count_slider_max.test.js`（**新增，13 断言**）：静态断言 colorLibrary 导出 getPaletteColorCount、index.js data 含 colorCountMax、loadPaletteList/onPaletteChange 调用并 setData、slider handler 用 this.data.colorCountMax、WXML max="{{colorCountMax}}"；运行时预置色卡数据验证 artkal_c=30、hama=50、perler=40、photoPearl=50、neko=35、未知 key 回落 artkal_c=30、null key 默认当前色卡=30。既有 `colorchart_preview_wxml.test.js` 因 mock 缺 getPaletteColorCount 崩 → 补 mock 后 11/11 仍全过；总数 90。


### M2(formatNumber) · formatNumber 未拦截 Infinity / -Infinity → isNaN 改为 !isFinite
- **文件**：`utils/util.js` 的 `formatNumber`（L76-79）
- **根因**：`isNaN(Infinity) === false`，`isNaN(-Infinity) === false`，导致 `formatNumber(Infinity)` 返回 `'Infinity'` 字符串而非 `'0'`。`clampDisplayNumber`（L89-97）已用 `!isFinite(n)` 守卫，口径一致。触发路径：`index.js:329` `formatNumber(total)` 与 `template.js:120` `formatNumber(templateData.totalBeads)` 均未先 clamp，若脏数据流入（如 localStorage 残留 Infinity），展示层出现非数字字符串。
- **修复**：`formatNumber` 守卫从 `isNaN(num)` 改为 `!isFinite(num)`——等价于拦截 NaN / Infinity / -Infinity，与 `clampDisplayNumber` 口径一致。
- **验证**：`test/m2_formatNumber_infinity_guard.test.js`（**新增，18 断言**）：静态断言源码使用 `!isFinite(num)` 且无 `isNaN` 残留；运行时断言 Infinity / -Infinity / NaN / null / undefined 均返回 `'0'`；1234567 等合法数保留逗号格式化；与 `clampDisplayNumber` 口径一致（`!isFinite(n)` 守卫共存）；**全量 85/85 测试文件 0 失败**。

### M3(renderCanvas警告) · renderCanvas canvas node 获取失败静默 return → 加 log.warn
- **文件**：`pages/template/template.js` 的 `renderCanvas`（L152-160）
- **根因**：`renderCanvas` 内 `wx.createSelectorQuery().select('#template-canvas')...exec` 回调的 canvas not found 分支 `if (!res[0] || !res[0].node) return;` 无任何日志或 toast，用户看到空白预览但控制台无告警。而同文件 `_getExportCanvas`（L396-415）在 canvas 未找到时做 3 次重试 + `log.warn` + `reject`，口径不一致——预览路径可观测性为零。
- **修复**：canvas not found 分支改为 `log.warn('[template] renderCanvas canvas node not found')`——与 `_getExportCanvas` 的 warn 日志口径一致；控制流不变（仍 return，不抛错），仅补可观测性。
- **验证**：`test/m3_rendercanvas_canvas_notfound_warn.test.js`（**新增，8 断言**）：静态断言 canvas not found 守卫含 `log.warn`、无残留静默裸 `return`、`_getExportCanvas` 仍含 warn、顶部已导入 security.log、无 console.error/console.warn 残留、warn 文案含可定位关键词；8/8 通过；**全量 85/85 测试文件 0 失败**。

### M4(isValidFilePath) · isValidFilePath 对 http(s) 路径未校验 host → 与 isRemoteImageUrl 口径一致补 host "." 守卫
- **文件**：`utils/security.js` 的 `isValidFilePath`（L94-104）
- **根因**：原逻辑 `filePath.startsWith('http://') || filePath.startsWith('https://')` 直接 `return true`，不区分本地沙盒（`http://tmp/...`、`http://store/...` 无点 host）与远程域名（`http://evil.com/...` 有点 host）。`isRemoteImageUrl` 已用 `host.indexOf('.') !== -1` 判别远程，但 `isValidFilePath` 未对齐——语义矛盾。虽当前仅用于微信系统生成的 `canvasToTempFilePath` 路径（风险低），但若未来复用到用户可控路径会成为安全隐患。
- **修复**：`http(s)://` 分支新增 host 正则匹配，仅当 host 不含 "."（本地沙盒 tmp/store/usr）才 `return true`；含 "." 的远程域名一律 `return false`。与 `isRemoteImageUrl` 口径一致（`isRemoteImageUrl(evil.com)=true ↔ isValidFilePath(evil.com)=false`，`isRemoteImageUrl(tmp)=false ↔ isValidFilePath(http://tmp/...)=true`）。
- **验证**：`test/m4_isValidFilePath_host_check.test.js`（**新增，15 断言**）：微信沙盒本地路径（wxfile/http://tmp/http://store/http://usr）返回 true；远程域名（evil.com/cdn.example.com）返回 false；null/空串/路径遍历返回 false；与 `isRemoteImageUrl` 口径一致双向断言；静态断言源码含 host "." 守卫；15/15 通过；`test/is_remote_image_url.test.js` 16/16 无回归；**全量 85/85 测试文件 0 失败**。
### M5(debounce取消) · debounce 返回包装器缺 cancel，onUnload 未清理定时器
- **文件**：`utils/util.js` 的 `debounce`（L99-105）、`pages/index/index.js` 的 `onUnload`（L311, L328）
- **根因**：`debounce` 返回裸函数，无法外部取消 pending timer。`index.js onUnload` 仅置 `_pageAlive=false`，300ms 后 debounce 回调仍触发并调 `this.setData`，对已销毁页面实例操作。
- **修复**：`debounce` 返回包装器并附加 `cancel()` 方法；`index.js` 增加 `onUnload` 取消 `debouncedOnColsChange` 和 `debouncedOnColorCountChange`。
- **验证**：`test/m5_debounce_cancel_guard.test.js`（**新增，10 断言**）：静态验证 cancel 方法存在、onUnload 调用 cancel、其余逻辑不变；运行时验证 cancel 后回调不触发、新调用正常触发；**全量 85/85 测试文件 0 失败**。

### M6(副作用) · template.js onLoad 直接修改 app.globalData.currentTemplate 属性
- **文件**：`pages/template/template.js` 的 `onLoad`（L86-99）
- **根因**：`onLoad` 用 `templateData.cols = realCols; templateData.rows = realRows` 直接修改 `app.globalData.currentTemplate`（即 `templateData`）的属性，产生全局副作用。虽功能上无害（真实值更正确），但违反「不修改共享状态」原则，且与 `gallery.viewTemplate` 已写入正确维度的语义重复。
- **修复**：`onLoad` 改为 `this._templateData = { ...templateData }` 浅拷贝，后续修改均作用于拷贝；`onUnload` 置 `this._templateData = null` 并恢复 `app.globalData.currentTemplate = null`（原逻辑不变）。
- **验证**：`test/m6_template_noshallow_copy_guard.test.js`（**新增，10 断言**）：运行时验证 dirty currentTemplate.cols=99999999 经 onLoad 后未被污染（仍为 99999999），`this._templateData.cols` 为真实维度 2；静态断言源码含浅拷贝语法、不含直接修改 `templateData.cols` 的写法；10/10 通过；**全量 85/85 测试文件 0 失败**。

### R1(路由竞态) · routeDone webviewId not found 双路径修复
- **文件**：`pages/template/template.js` 的 `onLoad`/`onUnload`、`pages/gallery/gallery.js` 的 `viewTemplate`/`onShow`
- **根因**：`routeDone with a webviewId X is not found` 是路由完成时目标 webview 已销毁。本项目两条触发路径：① template 页无效数据分支的 `setTimeout(()=>wx.navigateBack(),1500)` 是未跟踪定时器，用户 1.5s 内手动返回后它对已卸载页面再发 navigateBack（启发 #25 漏网）；② gallery 的 viewTemplate 无防连点守卫，快速双击同一卡片触发两次 navigateTo，第二次路由完成时第一次的 webview 状态已失效。
- **修复**：① 定时器挂 `this._invalidDataTimer`，回调内先置空再 navigateBack，`onUnload` clearTimeout 并置空；② viewTemplate 入口 `if (this._viewNavBusy) return`，navigateTo 前置位 `true`，catch（解码失败未跳转）与 onShow（返回本页）复位 `false`。
- **验证**：`test/route_race_guard.test.js`（**新增，13 断言**）：静态断言定时器跟踪/清理语法、连点守卫三处置位复位；运行时断言无效数据 onLoad 挂起 1500ms 定时器、onUnload 后 pending 清零、navigateBack 未被重复调用；13/13 通过；**全量 85/85 测试文件 0 失败**。

### R2(云函数超时) · secCheck 云函数未配置 timeout 被默认 3 秒超时终止
- **文件**：`cloudfunctions/secCheck/config.json`
- **根因**：微信云函数不配置 `timeout` 时默认执行超时仅 3 秒。secCheck 链路（downloadFile 下载云存储图 → base64 编码 → `cloud.openapi.security.msgSecCheck` 云调用 → deleteFile）总耗时极易超过 3 秒，云函数被强制终止，前端 `wx.cloud.callFunction` 收到 `Error: timeout`（2026-08-16 部署后实测复现）。检测未完成 → 正式/体验版 fail-closed 拦截（用户无法上传），develop 降级放行（开发时功能可用但防线未验证）。
- **修复**：`config.json` 显式配置 `"timeout": 20`（微信云函数执行超时上限 60 秒，20 秒足够下载+送检余量）。前端 `utils/secCheck.js` 的 `callFunction` 已带 `fail: reject` → 落入 `checkImageByPath` catch → fail-closed 拦截，无需改动。
- **验证**：`test/sec_check_timeout_guard.test.js`（**新增，6 断言**）：config.json 可解析、已配 timeout 且 ∈[15,60]、openapi 权限未被破坏、前端 callFunction 有 fail 兜底；6/6 通过；既有 `test/sec_check.test.js` 40/40 无回归；**全量 85/85 测试文件 0 失败**。
- **⚠️ 部署提醒**：修改 config.json 后须在开发者工具**重新「上传并部署：云端安装依赖」**使新超时配置生效，然后按自检流程验证。

### R3(getImageInfo超时) · wx.getImageInfo 挂起不回调 → 框架层裸 Error: timeout
- **文件**：`utils/util.js`（新增 `getImageInfoWithTimeout`；`validateImageFile`/`compressImageIfNeeded` 改用）、`pages/index/index.js`（`readImageSize` 改用）
- **根因**：`wx.getImageInfo` **没有 timeout 参数**，在开发者工具 Windows 模拟器上对 `wxfile://tmp_xxx` / `http://tmp/xxx` 本地路径可能挂起且**不触发 fail 回调**，框架层（WAServiceMainContext）最终抛裸 `Error: timeout`——业务代码的 fail 分支根本不会执行，日志一行打不出。上传链路 `validateImageFile`（校验）→ `compressImageIfNeeded`（压缩）→ `readImageSize`（压缩失败兜底补尺寸）三处裸调，任一处挂起都会出现该现象（2026-08-16 三次实测复现，与云函数 timeout 无关）。
- **修复**：新增 `getImageInfoWithTimeout(src, timeoutMs=10000)`：Promise.race 语义——`done` 标志防重入（resolve/reject 只触发一次），`setTimeout` 10s 超时 reject `image_info_timeout`，success/fail 先到先得并 clearTimeout。三处调用点全部改用：`validateImageFile` 超时/失败统一走 fail-closed（toast「图片读取失败」+ `resolve(false)`）；`compressImageIfNeeded` 超时 reject「获取图片信息失败」；`readImageSize` 超时 reject → 调用方保留 width/height=0 占位。超时从「框架层裸报错」收敛为「可控失败分支 + 用户提示」，防线不破。
- **验证**：`test/get_image_info_timeout_guard.test.js`（**新增，14 断言**）：静态断言函数定义/done 防重入/超时兜底/导出/三处调用点改用/不再裸调；运行时用「永不回调」桩验证挂起后 10s 超时 reject `image_info_timeout`；14/14 通过；**全量 85/85 测试文件 0 失败**。

### R4(msgSecCheck媒体类型) · media.type 传字符串 image → 47001 数据格式错误
- **文件**：`cloudfunctions/secCheck/index.js`（`msgSecCheck` 调用处）、`test/sec_check_cloudfunction.test.js`
- **根因**：`cloud.openapi.security.msgSecCheck` v2 接口的 `media.type` 要求**数字枚举：1=音频，2=图片**，代码误传字符串 `'image'` → 微信返回 `47001 data format error`。前端收到 `errcode_47001` → develop 降级放行（日志 `检测未完成，开发环境降级放行 reason=errcode_47001`）、正式/体验版 fail-closed 拦截**所有**上传——内容安全防线实际未生效，提审必拒。
- **修复**：`media.type` 改为数字 `2`（附注释说明枚举语义）。同步在 `test/sec_check_cloudfunction.test.js` 给 msgSecCheck mock 增加参数记录，并新增 4 条断言：`version===2`、`media.type===2`（数字非字符串）、`openid` 必填、`media.content` 为 base64 字符串。
- **验证**：`test/sec_check_cloudfunction.test.js` 33/33 通过（原 29 + 新增 4）；`test/sec_check.test.js` 40/40 无回归；**全量 85/85 测试文件 0 失败**。
- **⚠️ 部署提醒**：修改云函数代码后须**重新「上传并部署：云端安装依赖」**，再重新测试上传图片，控制台应出现 `[secCheck] 检测完成 suggest=pass` 而非 `errcode_47001`。

## 验证结果
- **全量回归：85/85 测试文件 0 失败**（较上轮 73 新增 `template_shared_canvas_mutex.test.js` 1 个；H1' 为 `pages/template/template.js` 的 `saveTemplate` 与 `shareTemplate`（共用同一 `#export-canvas` node）补**交叉互斥**——进入时判 `if (this._saveBusy || this._shareBusy)` 任一忙碌即忽略，杜绝「先做保存再点分享」并发改写同一 canvas 的尺寸/绘制导致导出图损坏；既有 `template_double_click_guard.test.js` 同按钮双击守卫因交叉互斥新契约在分享段前补 `_saveBusy=false` 重置（测试对齐），仍全过；总数 90）。

## 可复用启发
1. **解码端钳制 ≠ 消费端安全**（M2/M2闭环）：RLE/压缩解码产生的「被钳制结构」必须让消费端以**实际结构**反推维度/长度，否则只防了内存暴涨，仍留耗时卡死类 DoS。
2. **脏数据防护须追到全部消费点**（M1）：load→decode→render→copy→export，仅护 load 层会漏掉渲染/复制/解码端。
3. **统一日志通道不能绕过**：任何 `catch` 都应走项目 `log.*`（脱敏），禁止裸 `console.error` 打可能含设备路径的错误对象。
4. **展示层与存储层解耦**：显示用的数值（尤其是历史记录透传字段）应在展示前独立钳制，存储脏值不应直接渲染。
5. **同源展示字段钳制要一致**（L1 教训）：同一 map/同一对象内的多个展示字段，只要有一个走了钳制，其余同语义脏值字段必须同样走钳制，否则内部处理不一致、且一旦有人接上未钳制字段（如死代码 `sizeLabel`）就会爆超长串。**占比类字段（percent 等）除两端钳制外还应按语义封顶（≤100%）**——这一点在 L5 轮由 `colorPreview.percent` 漏钳触发，补此约定。
6. **安全控制/输入校验闸门默认 fail-closed，开发态才 fail-open**（S2 + M2 教训）：内容安全、鉴权、以及 `validateImageFile` 这类**入口校验闸门**，任何失败分支都不该 `pass:true`/`resolve(true)` 放行——可被攻击者稳定构造的异常（断网、跳压缩、触发限频、提交损坏文件）绕过的放行等于没有防线。校验函数「无法判定输入合法」时应**拒绝**（fail-closed）而非丢给下游兜底（如靠生成算法 6000px 断言兜底属语义错位）。兜底策略用「环境判定」：正式/体验版 fail-closed，仅 `develop` 回退 fail-open 保开发体验；fail-closed 分支必须上报告警（如 `[BLOCKED]` 日志）以便监控健康度。
7. **计数器/配额类必须数据库端原子更新，杜绝读-改-写 TOCTOU**（S3 教训）：限频/库存/余额等「读计数→本地+1→写回」是经典并发漏洞，云函数多实例下窗口内实际用量可远超上限。正确做法是让数据库 server 端完成「校验+自增」（`where(条件).update({count: _.inc(1)})` 配合 `_.lt` 上限守卫，或事务 CAS），而非应用层读后写；内存兜底仅作数据库故障降级，并接受其跨实例不精确代价。
8. **几何/尺寸类输入须入口校验正有限数 + 画布尺寸钳到 ≥1**（M1 取色教训）：任何来自 `boundingClientRect`、图片 info、外部数据结构的尺寸/坐标，进入「除法/索引/画布 API」前必须先校验「typeof===number && isFinite && >0」——除零得 NaN 会级联污染下游所有几何计算；画布 `width/height` 必须钳到至少 1，否则 `getImageData(x,y)` 在坐标 = 尺寸-1 的钳制下会得到 -1 越界。异步回调（如 `query.exec` 的 cb）本身无 try/catch 时，这类异常会直接中断整条链路，故校验应放在回调入口、挡在异常之前。
9. **共享不变量的魔法数必须单一来源 + 跨文件一致性断言**（M3 教训）：同一物理概念（如「Canvas 单维 4096 硬上限」）在多个文件多处硬编码时，必须提升为**一处共享常量**并在注释里显式声明「与 X 同源、改动需同步 Y/Z」；**零引用且数值矛盾的死常量（如 `EXPORT_MAX_SIDE:2048`）应立即删除**——它不会自己生效，却会在未来被误接成真实上限而砍掉合法行为（行为漂移）。判别法：grep 常量名，0 引用即死；多文件同义数值即应收敛为单一常量，并写回归测试断言「A 文件值 === B 文件值」（如 `template.MAX_CANVAS_SIDE === beadEngine.DIM_HARD`）。
10. **内层作用域禁止用同名变量遮蔽模块级引用**（M4 教训）：当模块级已 `const x = require(...)` 持有一个带方法的对象时，函数/回调内层**绝不能再** `const x = 局部数组/标量` 同名重声明——当前即便局部只当数组用不崩溃，也是高风险遮蔽，后续在局部新增 `x.method()` 会命中局部值抛 TypeError 且极难定位。判别法：内层局部变量名与模块级 `require` 进来的对象名冲突时，必须改名（如内层 `colorLib`→`paletteData`）；写回归测试断言「`const x` 声明全文件仅 1 处（即 require 那行）」。
11. **编码/解码边界必须对「会被持久化的数据结构」做 sanitize，不裸信其结构**（M5 教训）：RLE/序列化这类**长期落库**的产物，其 encode 端绝不能假定入参是规整二维数组——缺失行（稀疏空洞）会裸抛 TypeError 中断保存链路、列数不等会被首行列数截断丢色、非法元素会被编码成 `undefined:`/`[object Object]:` 脏令牌污染下游统计。正确做法：encode 端 sanitize（缺失行→空位、列数取最大行宽避免截断、非预期类型→归一空位/跳过），与 decode 端「永不抛、脏数据归空位」防御哲学一致，**不 throw**（保存链路抛异常会丢用户作品）；decode 端再对历史上可能已落库的畸形字面令牌（`undefined`/`NaN`）归空位。判别法：凡「入参→序列化→落库」的函数，必须审查「入参来自历史存储/外部」时是否还裸信结构。
12. **服务端返回值/错误信息绝不透传底层异常细节，统一收敛为固定通用令牌**（M6 教训，安全合规）：云函数/后端返回给客户端的 `errmsg`/消息字段，绝不能原样塞入底层异常 `e.errMsg || e.message`——微信/SDK 的异常消息常含资源名、调用链、SDK 版本、region、bucket 等**服务端环境细节**，构成信息泄露面。正确做法：返回**固定通用令牌**（如 `'sec_check_internal_error'`），底层详情仅写**服务端日志**（`console.error` 等，仅服务端可见）供排障。判别前提：客户端若仅依据 `errcode`（数字）等结构化字段做分支、**不依赖消息字符串**，则消息字段天然可收敛为令牌而无功能损失——改前务必确认「客户端是否真的读了该字符串」再动手，避免误伤依赖消息内容的逻辑。
13. **解码端遇畸形令牌必须「归一占位」而非「丢弃 chunk」**（L1 教训，承接 M5/M2 的解码防御体系）：游程/分块解码里，一个 chunk 代表 N 个格子；若其载荷是非法的（空 colorId、未知令牌等），正确做法是**填 N 个空位（null）保持矩阵对齐**，再与 `EMPTY_CELL_TOKEN`/`'undefined'`/`'NaN'` 同源归空位——**绝不能字面「跳过整个 chunk」（即不填任何格子）**，否则后续所有 chunk 整体错位、整张矩阵错位（比原脏数据更糟）。判别法：解码循环里「skip/continue」必须只跳过「不占位」的元信息（如 `__ROW__` 分隔符），凡代表格子数的 chunk 一律走「归一值 + 填 count 格」。
14. **迭代式量化/聚类循环必须设「同色/收敛」终止条件，避免无限逼近冗余桶**（L2 教训，性能）：中位切分、K-means 等「反复切分/重分配直到目标数」的循环，当剩余所有桶的度量（如 `maxRange`）已为 0（全同色/已收敛）时，继续迭代只会把同色桶劈成重复桶、白做整轮扫描+排序，下游去重后功能零变化——此时应**提前 break**。判别法：循环里「选最散桶切分」后追加「若全局最大散度===0 则 break」；用「返回桶数是否等于目标上限」做回归断言（单色图 + 大 colorCount 应远小于上限，而非逼到上限）——注意这类函数自身不去重，桶数可直接反映是否冗余迭代。
15. **通用工具函数须显式支持/声明输入格式边界，忌用「阈值一刀切 + 巧合正确」**（L3 教训，健壮性/通用性）：颜色转换、解析器等**通用工具函数**常被多处调用、且会被未来数据格式扩展命中，绝不能靠 `if (len < N) return 兜底` 一刀切后由 `substring` 巧合取对值。正确做法：对每种合理输入格式写**显式分支**（如 `#RGB` 3 位展开每位、`#RRGGBBAA` 8 位截断前 6 位丢 alpha），非法输入才黑色/兜底；并在函数注释显式声明「支持格式 + 兜底规则」，让未来调用方一眼可知边界。判别法：凡「通用工具 + 输入格式可能有变体（短写/带透明度/大小写/带前缀）」时，逐个格式写分支并断言其数值正确，而不是靠长度阈值 + 子串侥幸。
16. **长耗时异步回调必须入口判「页面存活」，杜绝对已卸载页面操作**（L4 教训，健壮性/UX）：小程序页面里「异步加载 + 同步长计算」的回调（`img.onload`、定时器、`request` success 等）执行时，用户可能已 `navigateBack` 卸载页面或切换 tab。若回调仍 `this.setData`/`wx.navigateTo`/`wx.redirectTo` 仍会触发「页面已卸载 setData」告警或误跳转。正确做法：引入 `this._pageAlive` 标记，`onLoad`/`onShow` 置 `true`、`onHide`/`onUnload` 置 `false`，回调开头 `if (this._pageAlive === false) { wx.hideLoading(); return; }`——已死则仅清理全局遮罩（hideLoading 全局安全）后放弃。**关键**：tabBar 页切换只触发 `onHide`/`onShow` 不卸载，故 `onShow` 必须重新置 `true`（否则切回 tab 后首次回调被误判死而丢弃），只靠 `onUnload` 置 false 会漏掉「切走 tab 但页面未死」的误跳转场景。判别法：凡「回调内做了 setData/跳转/写存储」且「回调可能在用户离开后才触发」的页面方法，都该加存活守护；优先用标记法而非 `getCurrentPages()` 栈顶判断（标记对「已卸载」与「仅隐藏」统一判死、语义更直白）。
17. **共用计算入口（导出/渲染同源）须对「格式边界」下限守卫，而非靠调用方自觉**（L5 教训，健壮性/通用性）：被导出与渲染**同时复用**的尺寸/布局计算函数（如标号预留、legend 高度、单元格像素），应假定未来会被异常数据（历史脏记录、外部导入）命中，对 `≤0`/负数等非法维度**主动 `Math.max(1, x)` 钳制到最小合法网格**，而非依赖「调用方已保证 ≥1」或「仅加注释声明」。关键前提：钳制必须对**正常合法输入恒等**（如 `Math.max(1, n)` 对 n≥1 不变），才能在不改动既有导出/预览布局的前提下堵住边界漏洞——改前用「逐值等价」回归（遍历合法区间断言与旧公式偏差 0）证明零变化。判别法：凡「函数名带 calc/shared 且被多处 require」的几何计算，审查其输入是否可能越界（0/负/超长），是则加下限守卫 + 等价回归测试；注意守卫只解决「越界不崩/语义错」，若公式本身对合法输入也有 off-by-one（如位数公式 `(cols-1)` 在 10 的幂时少算一位），那是**另一类问题**，需单独一轮修（见 L5 附带观察）。
18. **「轻微性能项 / 可接受现状」也要写契约测试钉死行为，且先澄清优化建议是否成立**（L6 教训，性能/决策）：当作者明确「可接受现状」时**不必强行改源码**，但仍应新增契约测试把当前行为锁死，以防未来优化/重构无意中破坏语义。关键澄清：**文件名「日期前缀」无法降低 `readdirSync` 成本**——微信 `readdirSync(dir)` 枚举的是 `dir` 下的**全部条目**，文件名带日期/类型前缀并不减少枚举数量（前缀过滤是枚举之后的 JS 逻辑），故「按日期前缀缩小扫描范围」对「全目录遍历」类性能缺陷**不成立**；真正能缩小扫描的是把目标文件移入**专用子目录**再 `readdirSync(子目录)`（n 由「全部文件」降到「仅该类文件」），但这属更大重构（多写入点 + 旧文件迁移），需作者明确授权才做。判别法：凡「性能级轻微 + 可接受现状」项，先核「建议的优化是否真能命中瓶颈」再决定改不改；不改时至少用契约测试 + 静态守卫（断言关键分支仍在）防回归。
19. **wx.* 的 success 是 async 回调时，必须顶层 try-catch，否则 await 抛异常会变「未处理 Promise 拒绝」**（H1 教训，健壮性/UX）：`wx.chooseMedia`/`wx.getImageInfo`/`wx.request` 等的 `success: async (res) => { … }` 回调里若对 `await` 的调用（校验/压缩/内容安全/setData 等）抛异常（而非返回 falsy），该异常**不会**被同级的 `fail` 回调捕获——`fail` 只处理 API 自身失败（隐私未授权/取消/网络错误），success 内的异步异常直接变为「未处理的 Promise 拒绝」：控制台告警 + 用户无任何 toast、操作静默失败。判别法：凡 success 写成 `async` 且内部有 `await` 的微信 API 回调，一律在其**函数体顶层**包 `try { … } catch (err) { log.error(…); wx.showToast({ title:'…失败，请重试' }); }`——异常时记日志 + 通用 toast（fail-closed 兜底），`fail` 回调语义保持不变。即便当前被 await 的库函数「恒 resolve 不 reject」，也当作健壮性缺口补上（未来任一处重构为 reject，或 setData/updateEstimate 抛错即触发）。回归测试法：用「可抛函数注入」让某 await 主动 reject，断言① success 返回的 promise 已 resolve（未逃逸拒绝）② 弹出通用 toast ③ `process.on('unhandledRejection')` 捕获数为 0；再补一个「全通过」对照断言不弹该 toast。
20. **共享可变资源（canvas node / 文件句柄 / 单例对象）被多个异步入口并发使用，必须「交叉互斥」而非各自独立守卫**（H1' 教训，健壮性/数据损坏）：同一页面里多个 async 操作（如 `saveTemplate` 与 `shareTemplate`）共用同一可变资源（如 `#export-canvas` 的 node，各自设 `canvas.width/height` 并绘制）时，若每个方法只维护**自己的** busy 标志（`_saveBusy`/`_shareBusy` 互不检查对方），则「先点 A 再点 B」两个操作并发执行、交替改写同一资源 → 导出图损坏 / 状态错乱。正确做法：**进入时判 `if (this._flagA || this._flagB)` 任一忙碌即忽略**（保留各自标记 + `finally` 清理，只是把「对方忙碌」也纳入拦截条件），或用单一共享 mutex。关键点：① 守卫是「操作级别」而非「按钮级别」——凡共用资源的入口都要互斥；② 改互斥后，**既有「各自隔离」的回归测试可能因前一挂起场景残留对方 busy 标志而误失败**——这不是放宽断言，而是测试场景需重置对方标志以保持隔离（对齐新契约）；③ 回归测试用「挂起被调函数」让调用方保持忙碌态，再调对方方法，断言被调函数**只执行 1 次**（未并发碰共享资源）+ warn 日志存在 + 对方标志未被误置位。
21. **UI 控件上限须与实际数据容量对齐**（M1 教训）：slider / checkbox / dropdown 等控件的 max/options 应动态取实际数据源容量，而非硬编码——否则 UI 显示超出实际容量产生误导，且历史脏数据不会被自动回写容量上限。
22. **数值格式化工具的「空/NaN」守卫必须顺带覆盖 Infinity / -Infinity**（M2 教训）：`isNaN(Infinity) === false`，仅用 `isNaN` 无法拦截极值——任何展示层数字格式化函数（千分位、百分比、科学计数、货币）都应改用 `!isFinite(num)` 守卫，与「非有限值归零/归默认」的展示层语义一致。判别法：凡工具函数形如 `if (num == null || isNaN(num)) return default`，审查是否同时需拦截 `Infinity`/`-Infinity`；若该函数被「历史脏数据直接透传」路径（如 localStorage→展示）命中，一律改为 `!isFinite(num)`。
23. **同源功能路径的失败可观测性须口径一致**（M3 教训）：同一页面/模块里承担「同类操作」（如 renderCanvas 预览 vs _getExportCanvas 导出）的不同 async 路径，对「资源未就绪」等失败状态的可观测性（log.warn / toast / 返回值）必须保持一致——否则某条路径静默失败会在未来排查时埋下盲区。判别法：找到同一模块内同语义的「多入口操作」，逐条检查它们的失败分支是否都有 log.warn 或等价告警；无告警的补 log.warn（不改变控制流，仅补可观测性）。
24. **同源安全函数的判别口径须一致——远程/本地判定不能一处有 host 校验另一处裸信前缀**（M4 教训）：`isRemoteImageUrl` 用 host 含 "." 判别远程，`isValidFilePath` 却只按前缀 `http://`/`https://` 放行，两者语义矛盾。凡同文件/同模块内承担「相似分类任务」的函数（如「是否远程」「是否合法路径」「是否安全」），对同一类输入（如 http(s) URL）的判定逻辑必须对齐——否则一处严格一处宽松，宽松处会成为绕过通道。判别法：找到所有判定「http(s) URL 是本地还是远程/合法」的函数，逐条检查是否都用 host 含 "." 统一口径；不一致的补对齐。
25. **页面卸载时必须清理所有 pending 定时器（debounce/throttle/setTimeout）**（M5 教训）：`debounce` 内部用 `setTimeout` 创建延迟回调，页面卸载时若不调用 `cancel()` 取消 pending timer，回调在 delay ms 后仍触发并操作已销毁页面实例的 `this.setData`（即使有 `_pageAlive` 守护，也应从源头取消定时器，避免不必要的全局事件循环开销）。判别法：凡页面 `data` 或方法中用 `setTimeout`/`setInterval`/`debounce` 创建定时器的，检查 `onUnload`/`onHide` 是否对应清理；未清理的补上。
26. **共享状态（app.globalData / 全局单例）只写不污染——修改前必须浅拷贝或深拷贝**（M6 教训）：`app.globalData.currentTemplate` 是跨页共享对象，任意页面/方法直接修改其属性（如 `templateData.cols = realCols`）会污染其他可能引用该对象的路径。正确做法：需要修改时**创建浅拷贝**（`this._templateData = { ...templateData }`）并仅操作拷贝，原对象保持不变；生命周期结束时（`onUnload`）清理拷贝引用并恢复全局对象为 `null`。判别法：凡「从 app.globalData / 全局单例取出对象后修改其属性」的代码，审查是否应改为「取前浅拷贝 → 修改拷贝」；用回归测试断言「修改前后原对象属性不变」。
29. **导航 API（navigateTo/navigateBack/redirectTo）必须做竞态守卫——延迟导航定时器要跟踪清理，入口按钮要防连点**（R1 教训）：`routeDone webviewId not found` 类路由错误的两类根因：① 延迟导航（`setTimeout(()=>wx.navigateBack(),N)`）未跟踪，页面先卸载后定时器触发对已死 webview 再导航——属启发 #25 的特例（导航定时器比普通 setData 定时器后果更重，直接报系统错误）；② 触发导航的入口无防连点守卫，快速双击产生两次并发导航，第二次找不到目标 webview。判别法：凡「setTimeout/回调内调 navigate*」的，定时器必须挂实例属性并在 onUnload clearTimeout；凡「点击事件里调 navigateTo/redirectTo」的，入口加 busy 守卫并在 onShow/catch 复位。
30. **云函数必须显式配置 timeout——默认 3 秒执行超时对「下载+第三方 API 调用」类链路必然不够**（R2 教训）：微信云函数不配 `config.json` 的 `timeout` 时默认执行超时仅 3 秒，凡是「downloadFile/uploadFile + 外部云调用（msgSecCheck/OCR/AI 等）+ 清理」的多跳链路必然超时被终止，前端表现为 `Error: timeout` 或静默失败。判别法：审查每个云函数 config.json 是否显式声明 `timeout`；链路含外部 API 调用的至少 15-20 秒，纯数据库操作可保持默认。改配置后必须重新部署才生效。
31. **wx.* 无 timeout 参数的 API（getImageInfo 等）必须自己包超时兜底——否则挂起不回调时框架层裸报 Error: timeout 且业务日志打不出**（R3 教训）：`wx.getImageInfo` 没有 timeout 参数，在开发者工具模拟器/部分真机环境下对本地临时路径可能永远不触发 success/fail，框架层最终抛裸 `Error: timeout`（纯 WAServiceMainContext 堆栈），业务代码的 fail 分支形同虚设、日志一行打不出，极难定位。判别法：凡「Promise 化的 wx.* 回调型 API」且该 API **不支持 timeout 参数**的（getImageInfo/getFileInfo/canvasToTempFilePath 等），必须用 `setTimeout + done 防重入` 包一层超时（如 10s），超时按「该步骤失败」走调用方既有失败分支（fail-closed），使错误可控、可提示、可日志。
32. **微信云调用（openapi.*）参数类型必须严格按文档——枚举字段用数字而非字符串，否则报通用错误码且难以定位**（R4 教训）：`security.msgSecCheck` v2 的 `media.type` 是数字枚举（1=音频 2=图片），传字符串 `'image'` 会报 47001（data format error）——错误码是通用格式错误，不看文档根本猜不到是枚举类型问题，且 develop 环境 fail-open 降级放行会把问题掩盖成「偶尔不可用」。判别法：调用任何 `cloud.openapi.*` 接口前，逐一核对官方文档的参数类型表，**枚举字段确认是 number 还是 string**；云函数测试里必须记录并断言传给 openapi 的原始入参（version/media.type/openid 等关键字段），防止「测试 mock 只看返回值不看入参」漏掉此类 bug。
33. **微信内容安全接口选型必须核对官方文档接口名——msg_sec_check 是文本、图片走 media_check_async（异步），用错接口报 47001 且 develop 降级放行掩盖**（R7 教训）：`/wxa/msg_sec_check`（msgSecCheck）是**文本**检测接口；图片/音频的正确接口是 `/wxa/media_check_async`（mediaCheckAsync，**异步**：提交返回 trace_id，结果通过消息推送 wxa_media_check 事件回写，或按 trace_id 主动查询）。wx-server-sdk 的 openapi.security 按接口名映射，用 msgSecCheck 传图片 media 对象会报 47001 data format error。判别法：凡「内容安全/图片检测」需求，先查官方 OpenApiDoc 确认接口名与同步/异步性质；异步接口需要「提交→trace_id→结果回写→轮询」链路（消息推送配置或主动查询），前端超时必须 fail-closed。
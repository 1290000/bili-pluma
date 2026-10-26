# 文档索引

> **Pluma**（`bili-pluma`）— B站双账号画质助手
> 许可证：GPL-3.0-only + [附加条款](../ADDITIONAL-TERMS.md)
>
> ⚠️ 使用前请先读 [README](../README.md) 首屏的免责声明与合规提示
> 🤖 **AI 代理 / 新接手者：先读 [AGENTS.md](../AGENTS.md)**，那是硬约束。
> **本文件只是文档导航**——项目门面（免责声明、它做什么、怎么装）在根 [README.md](../README.md)。
>
> 仓库里有 3 个 `README.md`，各是不同目录的首页（GitHub 浏览该目录时会自动渲染）：
> 根 = 项目门面 · `docs/` = 本文件 · `poc/q2-dnr-concurrency/` = Q2 操作手册。
> **引用时请写"根 `README.md`"或 `docs/README.md`**，只写 `README.md` 会有歧义。

---

## 按顺序读

| # | 文档 | 回答什么问题 |
| --- | --- | --- |
| 0 | [AGENTS.md](../AGENTS.md) | **什么不能做**。12 条不可翻案决策、依赖禁令、改文档规则 |
| 1 | [01-architecture.md](./01-architecture.md) | **为什么这么设计**。取流链路、代码复用风险、关键难点 |
| 2 | [02-ui-spec.md](./02-ui-spec.md) | **界面长什么样**。popup 七种状态、options 四页、页内角标、视觉令牌 |
| 3 | [03-open-questions.md](./03-open-questions.md) | **还差什么**。16 条待确认问题，含状态标记，末尾有决策变更日志 |
| 4 | [04-project-structure.md](./04-project-structure.md) | **代码放哪**。技术选型、目录结构（WXT 约定）、分层职责、依赖禁令、解耦手段 |

---

## 按用途查

### 我想知道某个决策当初为什么这么定

看 [decisions/](./decisions/)（ADR，一条决策一个文件）：

| ADR | 决策 |
| --- | --- |
| [0001](./decisions/0001-use-mv3-pure-extension.md) | 纯 MV3 扩展，不做桌面端（撤回三进程方案） |
| [0002](./decisions/0002-dnr-to-replace-cookie-header.md) | 用 DNR 换 Cookie 头，不用 debugger（✅ Q2 已验证） |
| [0003](./decisions/0003-gplv3-with-additional-terms.md) | GPL-3.0-only + 第 7 条附加条款 |
| [0004](./decisions/0004-request-level-identity-proxy.md) | 请求级身份代理，不切 Cookie |
| [0005](./decisions/0005-adopt-wxt-conventions.md) | 接入 WXT 约定，放弃自定 `src/content/` 结构 |
| [0006](./decisions/0006-no-per-request-nonce.md) | **不用 per-request nonce**，改为按路径的常驻 DNR 规则 |
| [0007](./decisions/0007-v1-video-only-bangumi-deferred.md) | v1 只支持普通视频，番剧留作 v1.5 实验性功能 |
| [0008](./decisions/0008-cookies-permission-for-playback-credential.md) | **推翻 Q5「不申请 cookies」**：登录必须读 httpOnly 的 SESSDATA |
| [0009](./decisions/0009-drop-passphrase-mode.md) | 移除口令模式与自动锁定：防不住本机程序的机制一律不加 |
| [0010](./decisions/0010-page-proxy-via-tab-ids.md) | 页面代理用 tabIds 限定 + 常驻规则（不 hook fetch） |
| [0011](./decisions/0011-playback-login-overwrites-primary.md) | 登录播放账号会覆盖主账号登录态（问题记录） |
| [0012](./decisions/0012-isolated-window-login.md) | **播放账号在隔离窗口登录**：凭据脱离浏览器登录态 |
| [0013](./decisions/0013-patch-player-info-response.md) | **允许改写 `/x/player/wbi/v2` 响应体**（Q12 的例外，精确到字段） |
| [0014](./decisions/0014-quality-compare-from-page-data.md) | **画质对比只用页面已有的数据**：主账号列取自 SSR，且不承诺 HDR |
| [0015](./decisions/0015-lazy-health-check-no-alarms.md) | **凭据健康只做惰性检查**：不用 alarms，不做 cookie 刷新 |

ADR 里没有的，查 [03-open-questions.md](./03-open-questions.md) 末尾的"决策记录"表格。

### 我要改代码 / 加功能

先读 [04-project-structure.md](./04-project-structure.md) §2「各层职责与禁令」。**别凭直觉往目录里塞文件**——禁令都是有原因的。

### 我要动消息协议

读 [protocols/messages.md](./protocols/messages.md)。注意：`src/shared/types/messages.ts` 是真相源，文档是解释。

### 我要排查一个 bug / 改完不确定有没有坑

读 [guides/methodology.md](./guides/methodology.md)。两个部分：
**穷举法**（怎么从症状走到根因，什么时候不该用它）和
**考虑周全七问**（判据还是参数、修在哪一层、时序约束、反例验证……）。

具体怎么调 DNR、抓包、看日志，看 [guides/debugging.md](./guides/debugging.md)。

### 我要在真实登录态下验证画质 / 抓 playurl

`poc/verify/` 那套是干净 profile，拿不到你的登录态。要用 `bsk`（browser-skill）：
配置、三个坑、验证命令见 [guides/browser-skill-setup.md](./guides/browser-skill-setup.md)。
**这是本机环境快照，不是通用安装指南**；通用安装看官方 `AGENT_INSTALL.md`。

### 我在调 DNR 相关的问题

读 [decisions/0002](./decisions/0002-dnr-to-replace-cookie-header.md) 的"已知风险"一节，以及 [guides/debugging.md](./guides/debugging.md)。

---

## 已定事项与进度

> **本文不维护这两样，因为它们各有权威位置**，抄一份必然漂移（这里就抄错过一次：
> 曾写「Q4 ❌ 未做」，而 `03-open-questions.md` §0 记的是「Q4 ✅ 已实测」）。

| 想知道 | 去哪看 |
| --- | --- |
| **进度**（做到哪了） | 根 [README.md](../README.md) 首屏那一行 |
| **阶段与路线** | [04-project-structure.md](./04-project-structure.md) §6 |
| **16 个待确认问题的状态** | [03-open-questions.md](./03-open-questions.md) §0 总览表 |
| **每个决策的理由** | [decisions/](./decisions/) |

---

## 文档一致性约定

**规则本身在 [AGENTS.md](../AGENTS.md) §6**（权威位置表、引用规则、长度纪律），本文不重复。
这里只放**检查命令**——因为 `AGENTS.md` §6.3 指向本文。

> 本文曾自己维护一份「权威位置」副本，已与 §6.1 漂移（少了两行），2026-10-26 删除。
> 同一张「已定事项」表也抄错过（Q4 状态写反）。**凡是"两边各写一份"的，最后都会变成两边不一样。**

### 文档检查命令

```bash
node scripts/check-docs.mjs
```

死链 + 4 份主文档的章节连号（含重复编号检测）。

**改了文档跑 `node scripts/verify.mjs --fast` 就够** —— 文档检查已在那条链里，不用单独跑。

**任何一项输出异常，先修完再交付。**

> 这是**唯一权威位置**。`AGENTS.md` §6.3 只写"必须跑"，不复制命令。


---

## 文档维护原则

1. **代码是真相，文档是解释。** 不要在文档里维护第二份"可执行的事实"（完整路径列表、完整类型定义）。文档放摘要 + 指向代码的引用。
2. **ADR 只记"改了主意"和"做了选择"。** 不记日常改动。
3. **待确认清单是有状态的**：🔴 阻塞 / 🟡 影响架构 / 🟢 可延后 / ✅ 已决策。解决一条就更新，别让它变成考古材料。
4. **编号即阅读顺序。** 新增文档时想清楚它该排第几，而不是随便加个名字。

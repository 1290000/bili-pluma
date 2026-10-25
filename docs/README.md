# 文档索引

> **Pluma**（`bili-pluma`）— B站双账号画质助手
> 许可证：GPL-3.0-only + [附加条款](../ADDITIONAL-TERMS.md)
>
> ⚠️ 使用前请先读 [README](../README.md) 首屏的免责声明与合规提示
> 🤖 **AI 代理 / 新接手者：先读 [AGENTS.md](../AGENTS.md)**，那是硬约束，本文件只是导航

---

## 按顺序读

| # | 文档 | 回答什么问题 |
| --- | --- | --- |
| 0 | [AGENTS.md](../AGENTS.md) | **什么不能做**。10 条不可翻案决策、依赖禁令、改文档规则 |
| 1 | [01-architecture.md](./01-architecture.md) | **为什么这么设计**。取流链路、代码复用风险、关键难点 |
| 2 | [02-ui-spec.md](./02-ui-spec.md) | **界面长什么样**。popup 五种状态、options 四页、页内角标、视觉令牌 |
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

ADR 里没有的，查 [03-open-questions.md](./03-open-questions.md) 末尾的"决策记录"表格。

### 我要改代码 / 加功能

先读 [04-project-structure.md](./04-project-structure.md) §2「各层职责与禁令」。**别凭直觉往目录里塞文件**——禁令都是有原因的。

### 我要动消息协议

读 [protocols/messages.md](./protocols/messages.md)。注意：`src/shared/types/messages.ts` 是真相源，文档是解释。

### 我在调 DNR 相关的问题

读 [decisions/0002](./decisions/0002-dnr-to-replace-cookie-header.md) 的"已知风险"一节，以及 [guides/debugging.md](./guides/debugging.md)。

---

## 已定事项（不含进度）

> **进度看根 [README.md](../README.md) 首屏那一行。** 本文不重复维护进度，
> 避免两处漂移。

| 项 | 状态 |
| --- | --- |
| 架构选型 | ✅ 纯 MV3 扩展（[ADR 0001](./decisions/0001-use-mv3-pure-extension.md)） |
| 命名 | ✅ Pluma / `bili-pluma` |
| 协议 | ✅ GPL-3.0-only + 附加条款（`LICENSE` / `ADDITIONAL-TERMS.md` 已落地） |
| 分发方式 | ✅ 只发源码，不上架商店，不发预编译包 |
| 合规文案 | ✅ 根 [README](../README.md) 首屏免责声明已落地 |
| UI 规范 | ✅ 已定 |
| 技术选型 | ✅ WXT + TS `^5.9` + Preact（仅 UI）+ 原生 CSS 变量 + Vitest + pnpm |
| 目录结构 | ✅ 已定（v1.1，遵循 WXT `entrypoints/` 约定） |
| 实施路线 | ✅ 已定（P0 半天 → P1 骨架 → P2 可用 → P3 完善） |
| **Q2 DNR 并发验证** | ✅ **已实测通过**：180 并发请求串号 0、残留 0；结论是**不需要 nonce**（[ADR 0006](./decisions/0006-no-per-request-nonce.md)） |
| **Q4 番剧边界验证** | ❌ **未做，第二优先级** |

**下一步：P1-a 脚手架。** Q2 已通过，架构不再有阻塞项。P1 分三个里程碑（脚手架 → 扫码存副账号 → 端到端取流），详见 [`03-open-questions.md`](./03-open-questions.md) 末尾的实施顺序。

---

## 文档一致性约定

为避免文档之间互相矛盾（这类问题在本次修订中一次性清理了 11 处），遵守三条：

1. **每件事只有一个权威位置**
   - 技术选型 → `04-project-structure.md` §〇
   - 实施路线 → `04-project-structure.md` §6（`01-architecture.md` §9 只写验收标准，不写目录细节）
   - 待确认问题状态 → `03-open-questions.md` §0 总览表
   - 决策理由 → `decisions/`
2. **交叉引用必须带文件名**，不写"见 §6.2"这种无锚点的相对位置——章节会重排。
3. **改动后跑一遍死链检查**（见下）。

### 死链自检命令

```bash
for f in README.md ADDITIONAL-TERMS.md docs/*.md docs/*/*.md; do
  dir=$(dirname "$f")
  grep -o "\](\.\.\?/[^)#]*)" "$f" 2>/dev/null | sed 's/](//;s/)$//' | while read -r link; do
    [ -e "$dir/$link" ] || echo "❌ $f → $link"
  done
done
```


---

## 文档维护原则

1. **代码是真相，文档是解释。** 不要在文档里维护第二份"可执行的事实"（完整路径列表、完整类型定义）。文档放摘要 + 指向代码的引用。
2. **ADR 只记"改了主意"和"做了选择"。** 不记日常改动。
3. **待确认清单是有状态的**：🔴 阻塞 / 🟡 影响架构 / 🟢 可延后 / ✅ 已决策。解决一条就更新，别让它变成考古材料。
4. **编号即阅读顺序。** 新增文档时想清楚它该排第几，而不是随便加个名字。

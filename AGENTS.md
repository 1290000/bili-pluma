# AGENTS.md

> 给所有接手本项目的 AI 代理（以及人类开发者）的**强制规则**。
>
> 本文件**不是建议，是约束**。违反其中任何一条，请停下来问，不要自行判断。

---

## 0. 开工前必做（**第一条，比什么都重要**）

**先确认"我是不是在 Pluma 仓库里"。判据是仓库身份，不是路径字符串。**

```bash
git rev-parse --show-toplevel     # 必须能跑通（是 git 仓库）
ls AGENTS.md docs/decisions/      # 必须都存在
grep -q '"name": "pluma"' package.json   # 项目身份
```

**三条全部满足 → 开工。任一不满足 → 停下来问用户，不要新建任何文件。**

> ⚠️ **不要用绝对路径做判据**。`pwd == D:\Projects\Pluma` 会在这些正常场景误报：
> `git worktree add ../Pluma-feat-x`（`..\Pluma-feat-x`）、换机器 / 换用户名、
> macOS / Linux（`~/code/Pluma`）、CI 容器（`/workspace`）。
> **只要 `.git` + `AGENTS.md` + `docs/decisions/` + `package.json` 的 name 对得上，在哪里都是正确的仓库。**

> **为什么放最前面**：2026-10-25 一个代理没确认目录，在空目录里重建了整个项目
> （11 处文档冲突、ADR 编号撞车、按已推翻的方案写代码），数小时后被整体删除。
> **本项目只有一个工作目录：`git rev-parse --show-toplevel` 的输出。**

---

## 1. 三分钟认知

**Pluma**（`bili-pluma`）= B站双账号画质助手，纯 MV3 扩展。
**原理**：浏览器全程保持主账号登录；扩展只在**白名单内的取流接口**上，用另一个（大会员）账号的凭据重发该请求。
**不是**破解，不是切 cookie，不是冒充会员。**当前状态**见 [README.md](./README.md) 首屏那一行，不要在此维护第二份。

---

## 1.5 先实测，再动手（**优先级仅次于 §0**）

**能实测就不要推理。** 2026-10-26 那一轮连续六次用"读代码 + 推理"判断根因，每次都被下一次实测推翻 ——
**只要第一次就去实测，这些弯路全部可以避免。**

| 情况 | 错误做法 | 正确做法 |
| --- | --- | --- |
| 用户报"角标显示错了" | 读代码推理"可能是 X 的锅"，改一版 | **把真实数据喂进真实函数，看它输出什么** |
| 别人能做而我做不了 | 在自己代码里找原因 | **先完整读完那份能工作的实现**，逐项对照 |
| 不确定某个 API 的语义 | 按名字猜（`(dynamic-range)` vs `(video-dynamic-range)`） | 写最小复现脚本，实测两个值的实际差异 |
| 不确定某条数据是否存在 | 从别的分 P / 别的样本推断 | 抓**当前这个场景**的真实响应 |

**硬性要求：任何"修好了"的结论，必须附一条能复现旧 bug 的验证**。
改完代码把关键判断反向改回去，测试必须变红 — 否则那个测试等于没写。
穷举法的四步、以及"改完会不会翻车"的七问 → [docs/guides/methodology.md](docs/guides/methodology.md)。

现成的实测工具（都在 `poc/probe/`，不接入 WXT，零构建）：

```bash
node poc/probe/probe-logged-in.mjs   # 用日常 Chrome profile 抓 4 个分 P 的真实轨道
bash poc/probe/run-all.sh            # 启动带端口的 Edge → 等就绪 → 实测 → 收尾（一条命令跑完）
```

### ⚠️ 浏览器自动化的硬限制

**自动化无法同时拿到「用户登录态」和「调试端口」。** 需要用户真实 HDR 环境的数据时，
**不要试图自动化** —— 用扩展自己的诊断日志（`entrypoints/content.ts` 的 `[角标输入]` 行），
让用户在正常浏览器里看一次视频即可。逐条实测与原因见
[docs/guides/debugging.md](docs/guides/debugging.md) §「自动化测试的限制」。

---

## 2. 先读什么（按此顺序，不要跳）

| 顺序 | 文件 | 读它的目的 |
| --- | --- | --- |
| 1 | [README.md](./README.md) | 这是什么、边界在哪、为什么只发源码 |
| 2 | **本文件** | 硬约束 |
| 3 | [docs/03-open-questions.md](./docs/03-open-questions.md) §0 总览表 | **还剩几件事没定**，哪些已定不要翻案 |
| 4 | [docs/04-project-structure.md](./docs/04-project-structure.md) §〇 + §1 + §2 | 技术选型、目录、分层禁令 |
| 5 | [docs/decisions/](./docs/decisions/) | 已定决策的理由 |
| 6 | [docs/01-architecture.md](./docs/01-architecture.md) | 需要理解原理时再读 |
| 7 | [docs/02-ui-spec.md](./docs/02-ui-spec.md) | 只在做 UI 时读 |

**不需要一次读完 `docs/`。** 按需查，但**决策清单（第 3 步）必须读**。

---

## 3. 不可翻案的决策（12 条）

以下决策已经过讨论并定稿。**没有用户明确指示，不得更改、不得"优化"、不得"顺便改进"。**

| # | 决策 | 违规示例（不要做） |
| --- | --- | --- |
| 1 | **纯 MV3 扩展，不做桌面端** | 提议"加个 Rust 后台进程会更稳" |
| 2 | **请求级代理，不切 cookie** | 提议"切一下 cookie 更简单" |
| 3 | **`declarativeNetRequest` 换 Cookie 头，不用 `chrome.debugger`** | 提议"用 debugger 能改响应体" |
| 4 | **主账号不归扩展管理**，就是浏览器当前登录态 | 提议"加个主账号管理页" |
| 5 | **不做伪装的会员标识**，连开关都不放（**例外**：可改写 `/x/player/wbi/v2`、`/x/player/v2` 响应体的 vip 字段，仅限 [ADR 0013](./docs/decisions/0013-patch-player-info-response.md)） | 提议"让画质菜单看起来正常点"；或往 `PATCH_PATHS` 加新接口 |
| 6 | **不做远程配置**，只本地版本号 + 升级提示 | 提议"加个远程白名单热更新" |
| 7 | **GPL-3.0-only + 第 7 条附加条款** | 提议"换成 MIT 更容易被采用" |
| 8 | **只发源码**，不上架商店、不发预编译包 | 提议"打包个 zip 方便用户" |
| 9 | **v1 只支持 Chrome + Edge** | 提议"顺手适配 Firefox" |
| 10 | **WXT 的 `entrypoints/` 约定** 优先于个人目录偏好 | 提议"把入口改回 `src/content/`" |
| 11 | **用无痕分区（`incognito: "split"`）登录播放账号** —— 推翻原"不支持无痕"（[ADR 0012](./docs/decisions/0012-isolated-window-login.md)） | 提议"直接在普通窗口扫码更简单" |
| 12 | **申请 `cookies` 权限**，仅在扫码登录那一刻读一次播放账号凭据 —— 推翻原"不申请"（[ADR 0008](./docs/decisions/0008-cookies-permission-for-playback-credential.md)） | 提议"从 `document.cookie` 借就够了" |

**如果你认为某条决策有问题**：不要直接改，也不要绕过它写代码。**先向用户说明理由和建议，由用户决定**。ADR 记录"为什么当时这么定"，不是让你重新讨论一遍。

---

## 4. 动手前必须知道的事

### 4.1 Q2 已实测通过，架构不再有阻塞项

**2026-10-25 实测：DNR 并发安全**（180 并发串号 0、残留 0）→ **不需要 per-request nonce**，
架构层面已经没有赌的成分。具体规则怎么写见 §5.4，理由见 [ADR 0006](./docs/decisions/0006-no-per-request-nonce.md)。
**这条已经验过，不要重新论证。**

目录结构见 `docs/04-project-structure.md` §1；**判断某文件是否存在请用 `git ls-files`，不要照那棵树。**

### 4.2 动手前必须确认的四个文件

- [ ] `src/shared/constants/routes.ts` —— 路径白名单
- [ ] `src/shared/types/messages.ts` —— 消息类型（判别联合，漏处理编译期报错）
- [ ] `src/design/tokens.css` —— 视觉令牌（`core`/`shared` 一律不许引用 `@design/*`）
- [ ] `src/platform/http/dnr.ts` —— **风险最高，且无法用 Vitest 测**，只能靠 `poc/verify/`

---

## 5. 写代码的硬规则

### 5.1 依赖方向

`entrypoints/* → src/background、src/content → src/core → src/shared`

**反向一律禁止。** 如果 `core/` 里想用 `chrome.storage`，正确答案是给 `core` 注入一个接口，实现在 `platform/`。

**怎么被强制的**：ESLint 管静态 import，`scripts/check-boundaries.ts` 抓动态绕过（`(globalThis as any).chrome`），**两道缺一不可**。
原理与实测见 [docs/04-project-structure.md](./docs/04-project-structure.md) §4「解耦的三道保险」。
这不是洁癖 —— 整套单测能在 Node 里跑，全靠 `core/` 不碰 `chrome` / `window` / `document`。

### 5.2 三个"不许"

1. **`core/` 里不许出现 `chrome.` / `window.` / `document.` / `fetch(`**——CI 的 `check-boundaries.ts` 会拦。
2. **不许在 popup 里做长任务**——popup 失焦即销毁。扫码走独立窗口（`chrome.windows.create`）。
3. **不许把凭据下发给 UI**——UI 只能拿到 `{uname, mid, vipLabel, expireAt, healthy}`。

### 5.3 页内注入

- **必须用 Shadow DOM**（`mode: 'closed'`）隔离，否则和 B 站页面样式互相污染。
- **不用 Preact**，纯 DOM 20 行即可。
- `tokens.css` 必须能注入 shadow root——**CSS 变量不穿透 shadow 边界**。

### 5.4 DNR 相关

- 所有 DNR 代码只在 `src/platform/http/dnr.ts`，对外只暴露 `withCookieFor()`。
- **按白名单路径各建一条常驻 session 规则，不带 nonce。** 不要每请求 add/remove，也不要规则 ID 池（ADR 0006）。
- 必须实现总开关 + SW 启动自愈重建，否则凭据失效时所有 playurl 一起变未登录。
- `/ogv/player/playview` 是 POST、csrf 在 body 里，DNR 改不了 —— 走 JS 拦截重建，不走这里。
- 改动这个文件后**必须重跑** `node poc/verify/run-q2-auto.cjs`。

---

## 6. 改文档的硬规则

> 这一节来自一次「自检修出 11 处矛盾」的教训。**违反它就会重现那些问题。**

### 6.1 每件事只有一个权威位置

| 内容 | 权威位置 | 其他地方怎么写 |
| --- | --- | --- |
| 技术选型与版本 | `docs/04-project-structure.md` §〇 | 只说"见 04 §〇" |
| 实施路线与阶段 | `docs/04-project-structure.md` §6 | `01` §9 只写验收标准 |
| 待确认问题状态 | `docs/03-open-questions.md` §0 总览表 | 正文各节与总览表**必须一致** |
| 决策理由 | `docs/decisions/` | 一句话结论 + 链接 |
| 合规/免责文案 | 根 `README.md` 首屏 + `docs/03-open-questions.md` Q10 | 不复制到别处 |
| 目录结构 | `docs/04-project-structure.md` §1 / §2 | 不在 01/02 重画 |
| 排查方法论（穷举法 / 七问） | `docs/guides/methodology.md` | §1.5 只规定"必须实测"和工具清单，不复述四步七问 |

**发现两处都写了同一件事 → 删掉一处，改成引用。** 不要"两边都更新，保持同步"——那必然漂移。

### 6.2 引用规则

**必须写文件名**：`见 docs/04-project-structure.md §2`，不写"见 §7.2"——章节会重排，无锚点的相对位置一定会指错。

### 6.3 改完必跑检查

改了任何文档，**必须**跑 [docs/README.md](./docs/README.md) §「文档检查命令」里的两项检查
（死链 + 章节编号连号）。**命令不在本文件复制，避免两处漂移。**

**任何一项输出异常，先修完再交付。**

### 6.4 长度纪律

| 文件 | 上限 | 为什么 |
| --- | --- | --- |
| 根 `README.md` 全文 | **80 行** | 它是门面，不是手册 |
| 任何文档的单节 | **80 行** | 超了考虑拆分 |
| 本文件 `AGENTS.md` | **240 行** | 它必须一次读完，长了就没人读 |

**测试方法**：如果一段话删掉后，读者仍然知道"该做什么、不该做什么"，这段话就该删。
**不许把"解释为什么"写成流水账**：ADR 记理由，正文只记结论。

---

## 7. 遇到不确定时的处理

| 情况 | 正确做法 |
| --- | --- |
| 觉得某条决策有问题 | **停下来说明理由，由用户决定**，不要直接改 |
| 文档之间矛盾 | **先查 §6.1 的权威位置表**，改错误的那一份 |
| 接口行为不确定 | **抓官方前端**，不要猜；也不要依赖第三方文档（bilibili-API-collect 已关停） |
| 测试挂了 | 先判断是 `core/` 逻辑错还是 `platform/` 适配错，不要"改测试让它过" |
| 想加新依赖 | **先问**。当前依赖清单是封闭的，加任何一个都要有理由 |

---

## 8. 交付前自检清单

**一条命令跑完全部**：`pnpm verify`（= typecheck && format:check && lint && check:boundaries && test）

- [ ] `pnpm verify` 全绿；`format:check` 挂了就跑 `pnpm format`，**不要手改**
- [ ] 若改了 `dnr.ts` → 已重跑 `node poc/verify/run-q2-auto.cjs`
- [ ] 若改了文档 → 已跑 §6.3 的检查
- [ ] 没有新增"两边都写同一件事"的重复
- [ ] 没有偷偷改 §3 的 12 条决策

---

## 9. 一句话总结

**这个项目不缺想法，缺的是"不擅自发挥"。**

所有该决定的都已决定，该记录的都已记录。你的任务是**按图施工**，遇到图有问题就报告，不要自己改图。

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
grep -q '"name": "bili-pluma"' package.json   # 项目身份（仓库名，不是项目名 Pluma）
```

**三条全部满足 → 开工。任一不满足 → 停下来问用户，不要新建任何文件。**

> ⚠️ **不要用绝对路径做判据**。`pwd == D:\Projects\Pluma` 会在这些正常场景误报：
> `git worktree add ../Pluma-feat-x`、换机器 / 换用户名、macOS/Linux（`~/code/Pluma`）、CI 容器。
> **只要 `.git` + `AGENTS.md` + `docs/decisions/` + name 对得上，在哪里都是正确的仓库。**

> **为什么放最前面**：2026-10-25 一个代理没确认目录，在空目录里重建了整个项目
> （11 处文档冲突、ADR 编号撞车、按已推翻方案写代码），数小时后被整体删除。

## 1. 三分钟认知

**Pluma**（`bili-pluma`）= B站双账号画质助手，纯 MV3 扩展。
**原理**：浏览器全程保持主账号登录；扩展只在**白名单内的取流接口**上，用另一个（大会员）账号的凭据重发该请求。
**不是**破解，不是切 cookie，不是冒充会员。**当前状态**见 [README.md](./README.md) 首屏那一行，不要在此维护第二份。

---

## 1.5 先实测，再动手（**优先级仅次于 §0**）

**能实测就不要推理。** 2026-10-26 一轮连续六次"读代码 + 推理"判断根因，每次都被下次实测推翻。
四种典型：报"显示错了"→ 把真实数据喂进真实函数看输出（✗ 推理"可能是 X 的锅"）；
别人能做而我做不了 → 读完那份能工作的实现逐项对照（✗ 在自己代码里找原因）；
API 语义不确定 → 写最小复现脚本（✗ 按名字猜，如 `(dynamic-range)` vs `(video-dynamic-range)`）；
某条数据是否存在 → 抓**当前这个场景**的真实响应（✗ 从别的分 P / 别的样本推断）。

**任何"修好了"的结论，必须附一条能复现旧 bug 的验证**：把关键判断反向改回去，测试必须变红，
否则那个测试等于没写。穷举法四步与"会不会翻车"七问 → [docs/guides/methodology.md](docs/guides/methodology.md)。

现成的实测工具（`poc/probe/`，不接入 WXT、零构建）：

```bash
node poc/probe/probe-logged-in.mjs   # 用日常 Chrome profile 抓 4 个分 P 的真实轨道
bash poc/probe/run-all.sh            # 启动带端口的 Edge → 等就绪 → 实测 → 收尾
```

### ⚠️ 浏览器自动化：CDP 走不通，走扩展

**Playwright/CDP 无法同时拿到「用户登录态」和「调试端口」**（新 profile 没 cookie，带端口又与日常浏览器冲突），
所以它**只用于不带登录态的验证**（DNR 规则、扩展加载、SW 生命周期）。
**需要真实登录态时用 `bsk`（browser-skill）**：扩展 + 本地 IPC，不占调试端口，直接复用当前 profile。
本机配置与三个坑见 [docs/guides/browser-skill-setup.md](docs/guides/browser-skill-setup.md)。

---

## 2. 先读什么（按此顺序，不要跳）

1. [README.md](./README.md) —— 这是什么、边界在哪、怎么装
2. **本文件** —— 硬约束
3. [docs/03-open-questions.md](./docs/03-open-questions.md) §0 总览表 —— **还剩几件事没定**，哪些已定不要翻案
4. [docs/04-project-structure.md](./docs/04-project-structure.md) §〇 + §1 + §2 —— 技术选型、目录、分层禁令
5. [docs/decisions/](./docs/decisions/) —— 已定决策的理由
6. [docs/01-architecture.md](./docs/01-architecture.md) —— 需要理解原理时再读
7. [docs/02-ui-spec.md](./docs/02-ui-spec.md) —— 只在做 UI 时读

**不需要一次读完 `docs/`**，按需查；但**决策清单（第 3 步）必须读**。

---

## 3. 不可翻案的决策（12 条）

已定稿。**没有用户明确指示，不得更改、不得"优化"、不得"顺便改进"。**

| # | 决策 | 违规示例（不要做） |
| --- | --- | --- |
| 1 | **纯 MV3 扩展，不做桌面端** | 提议"加个 Rust 后台进程会更稳" |
| 2 | **请求级代理，不切 cookie** | 提议"切一下 cookie 更简单" |
| 3 | **`declarativeNetRequest` 换 Cookie 头，不用 `chrome.debugger`** | 提议"用 debugger 能改响应体" |
| 4 | **主账号不归扩展管理**，就是浏览器当前登录态 | 提议"加个主账号管理页" |
| 5 | **不做伪装的会员标识**，连开关都不放（**例外**：可改写 `/x/player/wbi/v2`、`/x/player/v2`、`/x/web-interface/nav` 响应体的 vip 字段，仅限 [ADR 0013](./docs/decisions/0013-patch-player-info-response.md)；加路径必须同时改 ADR，`check-patch-scope` 会红） | 提议"让画质菜单看起来正常点"；或往 `PATCH_PATHS` 加新接口 |
| 6 | **不做远程配置**，只本地版本号 + 升级提示 | 提议"加个远程白名单热更新" |
| 7 | **GPL-3.0-only + 第 7 条附加条款** | 提议"换成 MIT 更容易被采用" |
| 8 | **不上架商店**；分发方式见 [ADR 0018](./docs/decisions/0018-ship-built-artifacts.md)（可发 zip，但必须同时提供带源码的版本） | 提议"上架商店能扩大用户量"；或只发 zip 不发源码版 |
| 9 | **v1 只支持 Chrome + Edge** | 提议"顺手适配 Firefox" |
| 10 | **WXT 的 `entrypoints/` 约定** 优先于个人目录偏好 | 提议"把入口改回 `src/content/`" |
| 11 | **用无痕分区（`incognito: "split"`）登录播放账号** —— 推翻原"不支持无痕"（[ADR 0012](./docs/decisions/0012-isolated-window-login.md)） | 提议"直接在普通窗口扫码更简单" |
| 12 | **申请 `cookies` 权限**，仅在扫码登录那一刻读一次播放账号凭据 —— 推翻原"不申请"（[ADR 0008](./docs/decisions/0008-cookies-permission-for-playback-credential.md)） | 提议"从 `document.cookie` 借就够了" |

**认为某条决策有问题**：不要直接改、也不要绕过它写代码，**先说明理由由用户决定**（见 §7）。
ADR 记录"为什么当时这么定"，不是让你重新讨论。

---

## 4. 动手前必须知道的事

### 4.1 Q2 已实测通过 + 四个必读文件

**2026-10-25 实测 DNR 并发安全（180 并发串号 0、残留 0）→ 不需要 per-request nonce。**
规则写法见 §5.4，理由见 [ADR 0006](./docs/decisions/0006-no-per-request-nonce.md)。**不要重新论证。**
目录结构见 `docs/04-project-structure.md` §1；**判断某文件是否存在用 `git ls-files`，不要照那棵树。**

动手前确认这四个文件：

- [ ] `src/shared/constants/routes.ts` —— 路径白名单
- [ ] `src/shared/types/messages.ts` —— 消息类型（⚠️ **漏处理不会编译报错**，靠 `check-messages.mjs` 兜）
- [ ] `src/design/tokens.css` —— 视觉令牌（`core`/`shared` 不许引用 `@design/*`）
- [ ] `src/platform/http/dnr.ts` —— **风险最高，且无法用 Vitest 测**，只能靠 `poc/verify/`

---

## 4.3 触发路由表（**先查表，再动手**）

改完代码先跑 `git diff --name-only` 对照下表（边界见 `node scripts/verify.mjs --help`）：

| 信号（`git diff --name-only` 命中） | 动作 |
| --- | --- |
| `src/platform/http/dnr.ts` | **重跑两个脚本**：`node poc/verify/run-q2-auto.cjs`（并发安全，约 3 分钟）**和** `node poc/verify/dnr-disable-clears-tab-rules.cjs`（关开关后两类规则清零，约 15 秒）。**两个都不需要登录态**；单测测不到 DNR，见 §5.4 |
| `public/main-world.js` | `node --check` 它；涉及轨道判定/角标时必须向用户要一次真机日志 |
| `src/shared/types/messages.ts` | 新增类型时单跑 `node scripts/check-messages.mjs` 看白名单（verify 内已含） |
| `.github/workflows/**` | `verify` 只抓 `set -x` / `printenv` 这类必泄露写法。**`echo "$RESP"` / `cat x.json` / `curl \| jq` 它抓不到** —— 必须**人工过一遍每个打印点**，判据只有一句：「这个响应里有没有属于别人的字段？」（`getUpdates` 有，`getMe` 没有） |
| `docs/**`、`*.md` | `node scripts/verify.mjs --fast` |
| `package.json` / `eslint.config.mjs` / `scripts/**` | 跑**完整** `node scripts/verify.mjs`（不是 `--fast`） |
| 用户说"不生效 / 闪一下 / 偶尔 / 感觉不对" | **停**：先做能产出真实数据的工具，禁止读代码推理（§1.5） |

**表里没有的情况**：不要自己发明检查项，**先报告**（见 §7）。任何改动的最终门是 §8 清单。

---

## 5. 写代码的硬规则

### 5.1 依赖方向

`entrypoints/* → src/background、src/content → src/core → src/shared`

**反向一律禁止。** `core/` 想用 `chrome.storage`，正确答案是注入接口、实现在 `platform/`。
**强制手段**：ESLint 管静态 import，`scripts/check-boundaries.ts` 抓动态绕过（`(globalThis as any).chrome`），
**两道缺一不可**；原理见 [docs/04-project-structure.md](./docs/04-project-structure.md) §4。

### 5.2 三个"不许"

1. **`core/` 不许出现 `chrome.` / `window` / `document` / `fetch(`** —— 见 §5.1 的两道闸。
2. **不许在 popup 里做长任务**——失焦即销毁。扫码走独立窗口（`chrome.windows.create`）。
3. **不许把凭据下发给 UI**——UI 只能拿到 `AccountSummary`（`src/shared/types/account.ts`，不含凭据字段）。

### 5.3 页内注入

**必须用 Shadow DOM**（`mode: 'closed'`）隔离，否则和页面样式互相污染；**不用 Preact**，纯 DOM 即可；
`tokens.css` 必须能注入 shadow root——**CSS 变量不穿透 shadow 边界**。

### 5.4 DNR 相关

- 所有 DNR 代码只在 `src/platform/http/dnr.ts`；它导出的函数分四组（装/删/自愈/只读诊断），
  各有用途。⚠️ 曾写「只对外暴露 `withCookieFor()`」——**那函数从不存在**，是 ADR 0006 之前的残留。
- **按白名单路径各建一条常驻 session 规则，不带 nonce**；不要每请求 add/remove，也不要规则 ID 池（[ADR 0006](./docs/decisions/0006-no-per-request-nonce.md)）。
- 必须实现总开关 + SW 启动自愈重建，否则凭据失效时所有 playurl 一起变未登录。
- `/ogv/player/playview` 是 POST、csrf 在 body 里，DNR 改不了 → 走 JS 拦截重建。

### 5.5 响应体改写范围（决策 5 的例外边界）

`public/main-world.js` 有两类响应体改写，**各带一个 ADR + 路径常量，不许合并**；**加路径或主机 = 扩大越权，先改 ADR 再改代码**（`check-patch-scope.mjs` 强制一致）：
- `PATCH_PATHS` → 会员字段伪装（[ADR 0013](./docs/decisions/0013-patch-player-info-response.md)）；字段限 `status`/`type`/`due_date`，**禁改 `mid`/`rights`**
- `PROGRESS_PATCH_PATHS` → 只改 `last_play_time`/`last_play_cid`，把被换成"播放账号的 0"的进度还原成主账号自己的（[ADR 0017](./docs/decisions/0017-restore-primary-progress-in-playurl.md)）

---

## 6. 改文档的硬规则

> 来自一次「自检修出 11 处矛盾」的教训。**违反它就会重现那些问题。**

### 6.1 每件事只有一个权威位置

| 内容 | 权威位置 |
| --- | --- |
| 技术选型与版本 | `docs/04-project-structure.md` §〇 |
| 实施路线与阶段 | `docs/04-project-structure.md` §6（`01` §9 只写验收标准） |
| 目录结构 | `docs/04-project-structure.md` §1 / §2 |
| 待确认问题状态 | `docs/03-open-questions.md` §0（正文各节必须与总览表一致） |
| 决策理由 | `docs/decisions/` |
| 合规/免责文案 | 根 `README.md`：首屏放**使用风险 + 一句归属声明**，完整声明与维护风险在末尾「声明」一节（2026-10-27 调整）。细则见 `docs/03` Q10 |
| 排查方法论（穷举法 / 七问） | `docs/guides/methodology.md`（§1.5 不复述四步七问） |
| **所有检查命令** | `scripts/`（`node scripts/verify.mjs --help`） |

**两处都写了同一件事 → 删掉一处改成引用**，不要"两边都更新"——那必然漂移。

### 6.2 引用规则

**必须写文件名**：`见 docs/04-project-structure.md §2`，不写"见 §7.2"——章节会重排，无锚点的相对位置一定会指错。

### 6.3 改完必跑检查

改了任何文档，**必须**跑 `node scripts/verify.mjs --fast`（死链 + `scripts/` 引用 + 篇幅上限 + 章节连号）。
**命令不在本文件复制，避免两处漂移。** 任何一项异常，先修完再交付。

**敏感信息（硬约束）**：克隆后第一件事 `git config core.hooksPath .githooks`，详见 [.githooks/README.md](./.githooks/README.md)。
**写「我脱敏了哪些值」时不要写具体值** —— 2026-10-27「修复泄露」的提交就是在信息里又列了一遍。

### 6.4 长度纪律

| 文件 | 上限 | 为什么 |
| --- | --- | --- |
| 根 `README.md` 全文 | **95 行** | 门面 + 快速上手；80 装不下七类内容（2026-10-27 放宽，理由见 `check-docs.mjs`） |
| 任何文档的单节 | **80 行** | 超了考虑拆分（`check-docs` 提示，不判失败） |
| 本文件 `AGENTS.md` | **260 行** | 必须一次读完，长了就没人读（2026-10-27 从 240 放宽，理由见 `check-docs.mjs`） |

**测试方法**：一段话删掉后读者仍知道"该做什么"，就该删。ADR 记理由，正文只记结论。
超限且不拆的例外写在 `check-docs.mjs` 的 `SECTION_LIMIT_WAIVED`，**加条目必须写理由**。

## 7. 遇到不确定时的处理

| 情况 | 正确做法 |
| --- | --- |
| 觉得某条决策有问题 | **停下来说明理由，由用户决定**，不要直接改 |
| 文档之间矛盾 | **先查 §6.1 的权威位置表**，改错误的那一份 |
| 接口行为不确定 | **抓官方前端**，不要猜；也不要依赖第三方文档（bilibili-API-collect 已关停） |
| 测试挂了 | 先判断是 `core/` 逻辑错还是 `platform/` 适配错，不要"改测试让它过" |
| 想加新依赖 | **先问**。依赖清单是封闭的，加任何一个都要有理由 |
| 触发路由表里没有的情况 | **先报告**，不要自己发明检查项 |

## 8. 交付前自检清单

**一条命令跑完全部**：`node scripts/verify.mjs`（`--help` 看检查项）

- [ ] `node scripts/verify.mjs` 全绿（`--fast` 只够改文档时用）
- [ ] §4.3 路由表的提醒都处理了（尤其 `dnr.ts` → **两个** DNR 回归脚本）
- [ ] 没有新增"两边都写同一件事"的重复
- [ ] 没有偷偷改 §3 的 12 条决策

## 9. 一句话总结

**这个项目不缺想法，缺的是"不擅自发挥"。** 该决定的都已决定，该记录的都已记录。
你的任务是**按图施工**，遇到图有问题就报告，不要自己改图。
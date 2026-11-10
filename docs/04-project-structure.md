# Pluma 目录结构与架构规范

> 项目名 **Pluma** / 仓库名 `bili-pluma` / 副标题 B站助手 · 画质与净化（**2026-11-10 定位改版**，见 [ADR 0034](./decisions/0034-dual-account-demoted-from-headline.md)）
> 本文规定：**代码放哪、分层怎么通信、哪些东西绝对不许跨层访问。**

> **维护纪律（2026-11-10 重构）**：本文只保留**规则与结论**。设计理由按 `AGENTS.md` §6.1 的指针去
> `docs/decisions/`；实施路线的验收标准去 [01-architecture.md](./01-architecture.md) §9。
> **判断某个文件是否存在，用 `git ls-files`，不要照 §1 那棵树**（树是设计稿，不是事实）。

---

## 〇、技术选型（含版本约束）

> **版本一律写范围，不钉死 minor。** 具体以各库官方 latest 为准，本文不承担"记住最新版本号"的职责。

| 层面 | 选择 | 版本约束 | 备注 |
|---|---|---|---|
| 扩展框架 | **WXT** | `^0.x` 跟 latest 稳定版 | 不追 beta / canary。入口约定见 [ADR 0005](./decisions/0005-adopt-wxt-conventions.md) |
| 语言 | **TypeScript** | `^5.9` | 不钉 minor；**TS 7.0（Rust 重写版）暂不采用** |
| 严格度 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | — | `noUncheckedIndexedAccess` 对本项目尤其必要（数组下标取 DASH 轨） |
| UI 渲染（popup / login window / 页内面板） | **Preact** | `^10` | 约 4KB，需 `@preact/preset-vite` |
| UI 渲染（content script 角标） | **原生 DOM + Shadow DOM** | — | **不用框架**，见 §2「页内角标」 |
| 样式 | **原生 CSS 变量**（`tokens.css`） | — | 不用 Tailwind：唯一真相源是 `tokens.css`，多一层构建换不来收益 |
| 单测 | **Vitest** | `^2` | 只跑 `core/` `shared/`，不碰浏览器 |
| 集成测试 | **P0 独立最小扩展**（常驻） | — | `dnr.ts` 的唯一测试手段，见 §6「P0」 |
| 代码规范 | **ESLint**（flat config）+ **Prettier** | `^9` / `^3` | ESLint 管"对不对"（含依赖方向强制），Prettier 管"好不好看"；`eslint-config-prettier` 关掉重叠规则 |
| 包管理 | **pnpm** | `^12` | **Windows 下必须 `nodeLinker: hoisted`**，见下 |
| 边界检查 | **`scripts/check-boundaries.ts`** | — | 按符号静态检查，CI 卡 PR |

### 环境约束：`pnpm-workspace.yaml` 里两条必须有

```yaml
nodeLinker: hoisted   # pnpm 默认 isolated 布局在含空格的路径下会静默失败
allowBuilds:
  esbuild: true       # 只放行 esbuild：wxt / vite / vitest / tsx 都靠它的平台二进制
```

**`nodeLinker: hoisted`**：默认 `isolated` 要为每个直接依赖建顶层 symlink，**路径含空格时创建会静默失败**——
表现为 `node_modules/wxt` 不存在、`wxt prepare` 报 `MODULE_NOT_FOUND`，而 `pnpm install` 显示成功。
⚠️ `.npmrc` 里的 `node-linker=hoisted` 在 pnpm 12 上**不生效**（配置已迁到 workspace 文件）；安装后建议直接确认 `node_modules/wxt` 存在。

**`allowBuilds`**：pnpm 默认不许依赖跑安装脚本，未裁决的包会让 `install` 以 `ERR_PNPM_IGNORED_BUILDS` **非零退出**（CI 直接红）。
三个坑全部实测过：① 写法是 **map 不是列表**；② 旧名 `onlyBuiltDependencies` 从 pnpm v11 起被移除，写了不报错但**完全不生效**（迁移命令 `pnpx codemod run pnpm-v10-to-v11`）；③ pnpm 会自动往文件开头插条目，手工再改容易产生重复键导致 `duplicate mapping key`，改前先完整读一遍。
**不要图省事改成 `dangerouslyAllowAllBuilds`。** 文档：<https://pnpm.io/settings/build#allowbuilds>

### 为什么版本只写范围

TS 每季度一个 minor，钉死具体版本会在半年内变成"落后两个版本"；写 `^5.9` 既不走太前也不落后。
WXT / Preact / Vitest 同理，"当前最新是几"交给 `pnpm outdated`。

---

## 0. 三条不可违背的原则

在讲目录之前先定三条规则——目录结构只是结果，**这三条才是原因**。

### 原则 1：依赖只能从外往里流

```
entry (entrypoints) → features → core → shared
```

反向依赖一律禁止：`core` 里不许出现 `chrome.tabs` / DOM / 具体业务 URL，`shared` 里不许出现业务逻辑。
因为 `core`（取流、签名、凭据）是最需要测试的部分，必须能在 Node 里跑单测，不能被浏览器 API 绑死。
强制手段见 §4（ESLint 管静态 import + `check-boundaries` 抓动态绕过，两道缺一不可）。

> 入口目录用 WXT 约定的 `entrypoints/`（原 `src/content/` + `src/ui/`），见 [ADR 0005](./decisions/0005-adopt-wxt-conventions.md)。

### 原则 2：跨进程通信必须走"协议"，不能走"引用"

MV3 有三到四个独立执行环境，它们**内存不共享**：

| 环境 | 能力 | 不能做什么 |
|---|---|---|
| **MAIN world**（页面 JS 上下文） | 能访问页面的 `window`、`MediaSource`、`__INITIAL_STATE__` | 不能用 `chrome.*` API |
| **ISOLATED world**（content script） | 能用 `chrome.runtime`、能操作 DOM | 看不到页面的 JS 变量 |
| **Service Worker** | 能用全部 `chrome.*` API、能发跨域请求、能读写存储 | 没有 DOM、每 30s 可能被休眠 |
| **Popup** | 有 DOM、能用部分 `chrome.*` | 生命周期短，失焦即销毁 |

所以**任何跨环境的数据传递都必须是消息类型**，不能"我直接读一下那个变量"。协议见 [protocols/messages.md](./protocols/messages.md)。

### 原则 3：模块边界 = 一个人能一次读完的篇幅

一个目录级模块（`core/auth/`、`core/playinfo/`）超过约 8 个文件，说明它承担了不止一件事，该拆。

---

## 1. 目录结构（只画到目录层）

> ⚠️ **不列文件名，也不写逐文件用途**——那是第二份"可执行的事实"，必然漂移（AGENTS.md §4.1）。
> 想知道有哪些文件用 `git ls-files`；想知道与设计的差异看 §9。

```
bili-pluma/
├── entrypoints/     # 【WXT 约定】入口，文件名即 manifest 清单项；归框架管，我们只放薄壳
├── src/             # 业务代码，WXT 不管
│   ├── shared/      # 最底层：零依赖、纯类型与纯函数（★ routes.ts = 路径白名单唯一真相源）
│   ├── core/        # 领域层：不知道"浏览器"存在，可在 Node 单测
│   ├── platform/    # 适配层：唯一允许碰 chrome.* 的地方
│   ├── background/  # SW 内部实现（handlers/ 按消息域拆分）
│   ├── content/     # 页面侧实现（★ main-world.js 与 isolated/）
│   └── design/      # ★ tokens.css = 视觉唯一真相源
├── tests/           # Vitest，跑在 Node，不碰浏览器
├── scripts/         # 检查脚本（唯一权威位置：node scripts/verify.mjs --help）
├── docs/            # 全部设计文档（索引见 docs/README.md）
└── poc/             # 一次性验证 + 常驻回归测试，不接入 WXT、零构建
```

> **没有 `public/`**：主世界脚本 2026-10-28 已移到 `src/content/main-world.js` 由 `main-hook.content.ts` 直接 `import`，
> 它不再需要对外可访问，manifest 里那段 `web_accessible_resources` 是死配置，已删。

---

## 2. 各层职责与禁令（最重要的一节）

### `shared/` —— 只放"不需要知道任何事"的东西

| 允许 | 禁止 |
|---|---|
| 类型定义、常量、纯函数工具 | `chrome.*` 调用 |
| 零外部依赖（除 TS 标准库） | 任何 `import` 自 `core`/`platform` |
| 路径白名单、Cookie 解析 | 网络请求、存储读写 |

- `shared/constants/routes.ts` 是 **URL 白名单的唯一真相源**。所有匹配逻辑都必须引用它，不许在别处硬编码路径字符串——B 站改路径时只改一个文件。
- `shared/types/messages.ts` 用**判别联合**定义消息，成功/失败靠 `:ok` / `:err` 后缀区分。**完整清单以该文件为准，本文不抄第二份**。

⚠️ **编译期不会替你抓漏**：分发处用的是 `if (type === '...')` 链而不是 `switch`，判别联合的穷举能力用不上——忘了加分支 `tsc` 看不出来，运行时只是静默拿到 `undefined`。真正的防线是 `scripts/check-messages.mjs`。

### `core/` —— 业务逻辑，完全不知道浏览器的存在

| 允许 | 禁止 |
|---|---|
| 纯 TS、依赖 `shared` | `chrome.*`、`window`、`document` |
| 通过参数注入 http / storage 接口 | 直接 `fetch()`（必须用注入的 `fetcher`） |

**为什么这条要卡死**：`core/identity/router.ts` 和 `core/wbi/signer.ts` 最容易写错、最需要单测；一旦直接调 `chrome.*` 就只能在装好的扩展里点来点去验证，那是灾难。
注入方式：`core` 只声明"我需要一个能发请求的东西"（`generateQr(http: HttpClient)`），实现在 `src/platform/http/fetcher.ts`，测试时传假实现。

### `platform/` —— 唯一的"浏览器污染区"

这里所有代码只做一件事：**把浏览器 API 包成 core 需要的接口。**

`platform/http/dnr.ts` 是**技术风险最高**的文件（对应 Q2），负责三件事：**两套规则集**（全局路径规则 10000 段 priority 1 无 `tabIds` + 标签页规则 20000 段 priority 2 有 `tabIds`，Cookie 值相同）、**总开关 + SW 启动自愈**（`sessionRules` 浏览器重启即清空，启动必须重建；凭据读不到就关开关，绝不留下"开关开着、一条规则都没有"）、**幂等**（`installTabRule` 先比对 Cookie 值，一样就跳过——反复重建是"恢复标签页时卡一下"的直接来源）。
**它要独立写测试，且必须在真实 Chrome 里跑**：DNR 行为无法在 Node 模拟。

> ⚠️ 本节曾列出 nonce 生成 / `try-finally` 回收 / 并发计数等设计——那些是 **ADR 0006 之前**的方案，已全部废除。现行写法以 [ADR 0006](./decisions/0006-no-per-request-nonce.md) 与 AGENTS.md §5.4 为准。

### `background/` —— 只做编排

| 允许 | 禁止 |
|---|---|
| 注册监听器、把消息分发给 handler | 写业务算法 |
| 调 `core` + `platform` | 直接操作 DOM（做不到） |
| 维护 SW 级状态（内存缓存 + 持久化） | 长时间同步阻塞 |

`handlers/` 里每个文件对应一组消息类型，**handler 只做三件事**：解析参数 → 调 core → 返回结果/错误。
一个 handler 超过 60 行，说明业务逻辑漏在这儿了，该挪进 `core`。

### `content/` —— 页面侧，必须分 MAIN 与 ISOLATED

这是最容易写乱的地方：两个执行环境不能互相访问变量，只能 `postMessage`。

**结构**：入口文件在 `entrypoints/`（WXT 约定，声明 `world: 'MAIN'` 或默认 ISOLATED），实现代码在 `src/content/`。
**入口归框架管，实现归我们管**（[ADR 0005](./decisions/0005-adopt-wxt-conventions.md)）：WXT 负责 manifest、注入时序、产物路径，我们负责逻辑。

**为什么必须分**：MAIN world 才能 hook 页面的 `fetch`（页面的 `fetch` 在页面 `window` 上），但它拿不到 `chrome.*`；ISOLATED world 有 `chrome.*`，却看不到页面的 `fetch`。

**channelToken 的三层防护**（页面本身也能监听 `postMessage`，恶意脚本可以伪造消息让扩展"用副账号凭据请求任意 URL"）：
① MAIN world 注入时生成随机 token，只通过闭包传给自己的 hook；② ISOLATED world 收到消息先校验 token；③ **收到后再做一次 URL 白名单 + 方法校验**（不信任 MAIN world 的任何输入）。缺一不可。

### 页内角标：原生 DOM + Shadow DOM，**不用 Preact**

1. **必须用 Shadow DOM 隔离**，否则 B站全局样式（`body` 规则、`*` 选择器、`!important`）会污染角标，我们的样式也会漏到页面上。`mode: 'closed'` 是刻意的——页面脚本拿不到 `host.shadowRoot`，无法篡改。
2. **不用 Preact**：角标只有 20 行 DOM，上框架收益为零，多一个渲染器就多一处和页面冲突的可能。
3. **`tokens.css` 必须能注入 shadow root**：CSS 变量不穿透 shadow 边界，要先读 `tokens.css` 文本塞进 shadow root 的 `<style>`（或在 shadow root 内重新声明变量）。

### `entrypoints/` —— 只跟消息协议打交道

| 允许 | 禁止 |
|---|---|
| 调 `chrome.runtime.sendMessage` | 直接读 `chrome.storage`（凭据相关） |
| 用 `src/design/tokens.css` 的变量 | 硬编码颜色/字号 |
| Preact 组件 | 在 popup 里做长任务（失焦即销毁） |

`src/design/tokens.css` 是 UI 的唯一真相源，对应 [02-ui-spec.md](./02-ui-spec.md) 的色值与字号——**改配色只改这一个文件**。

`entrypoints/popup/` 只负责**一个开关**（显示/隐藏页内悬浮入口，[ADR 0033](./decisions/0033-panel-first-interface.md)）：界面主体已迁入页内面板（`src/content/panel/`），popup 保留的唯一理由是"用户关掉悬浮入口后，这是唯一能重新打开它的地方"。它**不判页面**——判页面的守卫在面板入口（AGENTS.md §4.3）。

---

## 3. 文档放哪：`docs/` 一个目录，按"用途"而非"格式"分

```
docs/
├── README.md               ← 索引，告诉新人从哪读起
├── 01-architecture.md      ← 为什么这么设计
├── 02-ui-spec.md           ← 界面长什么样
├── 03-open-questions.md    ← 还有什么没定（状态权威在 §0 总览表）
├── 04-project-structure.md ← 本文（代码放哪、分层禁令）
├── decisions/              ← ADR：一条决策一个文件
├── protocols/              ← 消息协议（会与代码类型定义互相引用）
└── guides/                 ← 操作手册（怎么调、怎么发、怎么排查）
```

**为什么按数字前缀**：`01 / 02 / 03 / 04` 让阅读顺序在文件列表里就体现出来，不用在 README 里解释。

**为什么 `decisions/` 单独拆**：`03` 的「决策变更日志」只记结论，**记不下理由和当时排除了哪些方案**。ADR 的格式（背景 / 决策 / 理由 / 被放弃的方案 / 后果）以现有文件为准，本文不抄模板。
**什么时候写 ADR**：只在"改了主意"或"选了其中一条路"时写；"我叫 Pluma"这种是 README 的事。

### 文档和代码的一致性怎么保证

| 面对 | 同源于 | 做法 |
| --- | --- | --- |
| 路径白名单 | `src/shared/constants/routes.ts` | `routes.ts` 注释里标注来源（`01-architecture.md` §4.1），改一处时人工同步 |
| 消息协议 | `src/shared/types/messages.ts` | **代码为准，文档从代码抄**，并注明"以 types/messages.ts 为准" |
| UI 令牌 | `src/design/tokens.css` | 同样以 CSS 为准 |

**原则：代码是真相，文档是解释。** 不要在文档里维护第二份"可执行的事实"。

---

## 4. 解耦的三道保险

光靠约定不够，要靠工具卡住。三道**缺一不可**——它们各自漏的东西不同。

### 保险 1：TS 路径别名 + 编译器拦住符号

`tsconfig.json` 的 `paths` 定义 `@shared/*` / `@core/*` / `@platform/*` / `@design/*`。
⚠️ WXT 会自动生成 `.wxt/tsconfig.json` 并合并，别名建议写在 `wxt.config.ts` 的 `vite.resolve.alias`，同时同步到根 `tsconfig.json` 的 `paths`（IDE 需要）；两处不一致时**以 `wxt.config.ts` 为准**。

### 保险 2：ESLint 的 `no-restricted-imports` 限定层间引用 ✅ 已落地

见 `eslint.config.mjs`：在 `src/core/**` / `src/shared/**` 下禁 `@platform/*` `@background/*` `@content/*` `wxt/*`，并用 `no-restricted-globals` 禁掉 `chrome` / `browser` 全局对象。配合 `overrides` 按目录生效，就是**编译期强制依赖方向**。
**实测**：在 `core/vault/vault.ts` 顶部加 `import { browser } from 'wxt/browser'`，ESLint 立刻报 2 条。

> `@design/*` 只允许 `entrypoints/` 引用，`shared`/`core`/`platform` 一律禁止——设计令牌是 UI 概念，业务层不该知道颜色。
> 这条由 `scripts/check-design-imports.mjs` 强制（**不是** ESLint）。实装教训：规则会漏**副作用导入**（`import '@design/x'` 没有 `from`），
> 六种写法（副作用 / 静态 from / export 再导出 / 动态 import / 相对副作用 / 相对 from）已逐个反例验证。

### 保险 3：`scripts/check-boundaries.ts` 抓动态绕过 ✅ 已落地

**为什么 ESLint 抓不到 `globalThis.chrome`**：它只看静态 import 语句，`(globalThis as any).chrome` 里没有 import，ESLint 只报 `no-explicit-any`，**完全没提分层违规**。

| 项 | 做法 |
| --- | --- |
| 扫描范围 | `src/core/` + `src/shared/` 下所有 `.ts` |
| 禁止符号 | `chrome` / `browser.` / `window` / `document` / `fetch(` / `localStorage` / `sessionStorage` / `XMLHttpRequest` |
| 注释与字符串 | **掩码成等长空白**（保持列号），注释里提到 `chrome` 不误报 |
| 输出 | 文件名:行:列 + 原始代码片段 + 修复提示 |

⚠️ **检查项是 `\bchrome\b` 而不是 `chrome\.`** —— `globalThis.chrome`、`('chrome' in x)` 拿到的是同一个对象，只拦 `chrome.` 会漏（实测踩出来的）。
**六种变异的交叉实测**：`wxt/browser` 导入 / `globalThis.chrome` / `fetch` / `document.title` / `localStorage` / 注释或字符串提到 `chrome` —— 唯一"ESLint 漏、boundaries 抓"的正是 `globalThis.chrome`，这就是两道闸都要有的原因（AGENTS.md §5.1）。

---

## 5. 与 Q2 的关系：目录结构本身就要为最大风险让位

**Q2（DNR 并发安全）是唯一可能推翻方案的未知数**，所以目录结构要让它可以被独立验证、独立替换：

- `platform/http/dnr.ts` 是**唯一**碰 DNR 的地方；它不关心 bilibili、不关心账号，只关心"把某些请求的 Cookie 头换成指定值，且能干净撤销"
- 它的导出按用途分**四组，不要合并**：装/删全局路径规则（`enableProxy` / `disableProxy`；`disableProxy` **必须同时删标签页规则**，否则关开关后画质不回落——2026-10-27 修过的真实 bug）、装/删标签页规则（`installTabRule` / `removeTabRule`）、自愈（`rebuildRulesIfEnabled` / `reconcileTabRules`）、只读诊断（`isProxyEnabled` / `countPathRules` / `describeRules`）
- 若 DNR 方案失败要换成油猴式 hook，**只换这一个文件**，`core` 一行不改

> ⚠️ 本节曾写「对外只暴露 `withCookieFor<T>(url, cookie, fn)`」——**那个函数从未实现过**，是 ADR 0006 之前的残留。现行实现是常驻规则 + 总开关，不需要"包一个请求"的形态。

**这就是解耦最实际的收益：最大风险被关在一个文件里。**

---

## 6. 实施路线与阶段

> **本节是「实施路线与阶段」的权威位置**（`AGENTS.md` §6.1）：这里只写**建什么、什么状态**。
> 每阶段的**验收标准与逐条证据**在 [01-architecture.md](./01-architecture.md) §9 与 [guides/v1-acceptance-checklist.md](./guides/v1-acceptance-checklist.md)，本文不复制。

### P0：Q2 验证 —— ✅ **已完成（2026-10-25）**

`poc/q2-dnr-concurrency/`（**不在 `src/` 下，不接入 WXT**）：180 并发请求串号 0、规则残留 0 → **不需要 per-request nonce**（[ADR 0006](./decisions/0006-no-per-request-nonce.md)），产物**保留为常驻回归测试**，以后每次改 `dnr.ts` 都跑。

**为什么不放进主项目**：P0 的价值在于失败时沉没成本为零。它用裸 JS + 零依赖写成，任何时候"加载已解压的扩展程序"就能跑，不受主项目构建失败、依赖升级、WXT 换版本影响。

### P1 之后才建主项目

| 阶段 | 建哪些 | 状态 |
|---|---|---|
| **骨架** | WXT 初始化 → `shared/` `core/identity/` `core/vault/` `platform/` `background/` | ✅ 2026-10-25 |
| **P2-a 数据源** | `core/auth/` `core/playinfo/stats` `background/handlers/`（account / stats） | ✅ 2026-10-25 |
| **P2-b 总开关** | `proxy/set` 消息 + 受影响标签页统计 | ✅ 2026-10-25 |
| **P2-c 界面** | popup + 登录窗口（框架；细节在 P3 补齐） | ✅ 2026-10-25 |
| **P2-d 页面侧** | 页内角标（Shadow DOM） | ✅ 2026-10-26 |
| **P3 完善** | 账号 / 诊断 / 显示三块内容 + 成功率条形图 + 路径失效检测 + P2 顺延的四项（体检表与音质自检独立页已砍，[ADR 0016](./decisions/0016-drop-quality-report-page.md)） | ✅ 2026-10-27 |
| **v1.1 面板化** | 上述三块全部迁入页内面板 `src/content/panel/`；popup 瘦身为单开关；**`entrypoints/options/` 已删除**（[ADR 0033](./decisions/0033-panel-first-interface.md)） | ✅ 2026-11-10 |
| **预留** | `platform/browsers/firefox.ts` | ⬜ v1.5 |

> **判断某文件是否存在，用 `git ls-files`，不要看 §1 那棵树。**

### v1.0 → v1.1 的三个结构变更（保留结论，理由见 ADR）

| 变更 | 一句为什么 |
| --- | --- |
| 入口在 `src/content/` `src/ui/` → `entrypoints/`（WXT 约定） | 框架约定优先于个人偏好（[ADR 0005](./decisions/0005-adopt-wxt-conventions.md)） |
| UI 统一上框架 → popup 用 Preact、页内角标用原生 DOM | 角标 20 行，上框架收益为零且增加页面冲突风险 |
| options 三页 → 全部迁入页内面板，popup 只剩一个开关 | 设置页是死链来源；面板是用户真正看视频的地方（[ADR 0033](./decisions/0033-panel-first-interface.md)） |

### 凭据健康检查：惰性，不用 alarms

**不做后台定时探测**：`incognito: "split"` 下普通/无痕是两个 SW 实例、共享 `storage.local`，定时任务在哪个实例跑不确定，两个实例会互相覆盖健康标记。
改为**惰性检查**，只在三个时机触发：popup 打开（`checkedAt` 超 6 小时）、`page/activate` 成功/失败（用真实取流结果反推，比 `nav` 更准）、用户点"重新检查"。
代价是"既不开 popup 也不看视频时失效不会被发现"——而那种场景本来也不需要发现。理由见 [ADR 0015](./decisions/0015-lazy-health-check-no-alarms.md)。

### v1 只支持单个播放账号

`core/vault` 的 `Credential` 是单数、vault 存储只存一个 blob。多账号（对齐 bilipai 的多 profile）**推迟到 v1.5**（[02-ui-spec.md](./02-ui-spec.md) 已同步）。

### 测试策略：两个层次，不可互相替代

| 层 | 工具 | 覆盖什么 | 不能覆盖什么 |
| --- | --- | --- | --- |
| 单测 | Vitest（Node / jsdom） | `core/identity/router`、`core/wbi/signer`、`core/auth/health`、`shared/utils/*` | 碰真实浏览器的 API（`chrome.*`、DNR） |
| 集成 | **P0 独立扩展**（真实浏览器） | `platform/http/dnr.ts` 的并发正确性、规则回收 | 业务逻辑（它只测 Cookie 头对不对） |

**关键认知**：`dnr.ts` 是风险最高的文件，却恰好**无法用 Vitest 测**。所以 P0 那个测试页**不是一次性验证，是这个文件唯一的测试手段**，必须长期留在仓库里跑。

### 主世界脚本怎么测（2026-10-28 定稿）

`src/content/main-world.js` 是近 3000 行纯 JS，由 `entrypoints/main-hook.content.ts` 直接 `import`。

**先说清楚它没有的保护**（这一段曾写反过）：`tsc` ❌（`include` 不含它，也没有 `checkJs`；"加 `// @ts-check`"从未实现）、`eslint` ❌（`ignores` 明确排除）、`prettier` ❌（`.prettierignore` 排除）。**唯一手段是行为测试**：`tests/unit/content/main-world-{real,pgc}.test.ts`。

**为什么不做静态检查**：它大量 hook 页面原生对象（`fetch` / `XHR` / `MediaSource` / `addSourceBuffer`），大量 `var` 与被 hook 的原函数签名；按项目 lint 规则改一遍只增加行为风险、换不来正确性。搬成 TS 还会引入第二个构建产物、让"唯一源文件"变成"构建产物"。**这是明确决策，不是遗漏。**

**做法是"读真源码、在 jsdom 里 eval"**：每个用例新建 jsdom 并 `window.eval(SOURCE)`，所以测的是真源码不是复刻——此前用"复刻函数"测，主世界改了而测试没跟着改就会悄悄漂移。

**代价要认**：测试只覆盖被断言的路径。改主世界脚本里**没被断言**的分支（尤其是 PGC 时序），`verify` 不会告诉你坏了——那类改动必须按 AGENTS.md §4.3 要一次真机日志。

---

## 7. 一句话总结

**目录结构不是为了好看，是为了让"最容易错的东西"被关在最小的范围里。**

- 最大技术风险（DNR 并发）→ 关在 `platform/http/dnr.ts`，配 `poc/q2-*` 做回归
- 最需要测试（路由/签名/选轨）→ 放 `core/`，不许碰浏览器 API
- 最容易被伪造（跨 world 消息）→ 类型化协议 + token + 二次校验
- 最容易过期（路径白名单）→ 只在 `shared/constants/routes.ts` 维护一份
- 最容易和页面打架（页内角标）→ Shadow DOM 隔离 + 原生 DOM，不上框架

文档则集中 `docs/`，编号顺序是"为什么（architecture）→ 长什么样（ui-spec）→ 还差什么（open-questions）→ 代码在哪（structure）"，决策的"为什么"单独放 `decisions/`。

---

## 8. v1.0 → v1.1 变更清单

> 只列**改变规则**的项；单项的结构变更详见 §6「v1.0 → v1.1 的三个结构变更」。

| # | v1.0 | v1.1 | 原因 |
| --- | --- | --- | --- |
| 1 | 入口在 `src/content/` `src/ui/` | 入口在 `entrypoints/`（WXT 约定），实现仍在 `src/` | 框架约定优先于个人偏好（[ADR 0005](./decisions/0005-adopt-wxt-conventions.md)） |
| 2 | Vitest 覆盖所有测试 | Vitest 只测 `core/`；`dnr.ts` 靠 P0 独立扩展做集成测试 | DNR 无法在 Node 模拟，Vitest 覆盖不到最大风险点 |
| 3 | P0 是"主项目第一个模块" | P0 完全独立，不接 WXT | Q2 失败时沉没成本归零 |
| 4 | 未列技术选型 | 新增 §〇 技术选型表，版本一律写范围 | 避免钉死版本号后半年就落后 |
| 5 | 未提 ESLint / Prettier | 列入必选工具 | 依赖方向强制手段，不是可选项 |

---

## 9. 实现现状

§1 那棵树是设计稿。实际实现与设计的**差异**如下，避免把设计当成事实：

| 设计稿 | 实际实现 | 原因 |
| --- | --- | --- |
| `entrypoints/bili.content.ts` + `bili-main.content.ts` | `entrypoints/content.ts`（ISOLATED）+ `main-hook.content.ts`（MAIN，`document_start`）+ `src/content/main-world.js` | 原假设"MAIN world 只能用资源文件注入"——**实测 `world: 'MAIN'` 可用**，且必须用它：`<script src>` 异步加载赶不上 PGC 页的内联脚本（2026-10-27 真机） |
| `src/content/main-world/` `src/content/isolated/` | `src/content/main-world.js`（单文件）+ `src/content/isolated/*` | 同上 |
| `src/background/index.ts` `src/manifest.json` | `entrypoints/background.ts` + `wxt.config.ts` 的 `manifest` 字段 | WXT 约定 |
| `src/platform/runtime/messaging.ts` | 无独立封装，页面直接 `sendMessage` | 只有 3 个 UI 页面，封装收益低于成本 |
| `public/main-world.js` + `web_accessible_resources` | **已删**：脚本移到 `src/content/main-world.js` 并被 `import` | WAR 是死配置（无人按 URL 加载它），留着只是让全站页面能 fetch 到它 |
| `entrypoints/options/`（账号/净化/显示/诊断四块） | ❌ **已删除（2026-11-10，[ADR 0033](./decisions/0033-panel-first-interface.md)）**：全部迁入 `src/content/panel/` 页内面板 | 诊断曾是排查 InPrivate 权限的唯一入口，现在那个入口是面板的诊断浮层 |
| `.eslintrc.cjs` | `eslint.config.mjs` | ESLint 9 默认 flat config |

**已实现且与设计一致**：`src/shared/{types,constants,utils}`、`src/design/tokens.css`、`src/core/{auth,vault,wbi,identity,playinfo,ui}`、`src/platform/{http,storage,page,qr,diagnostics}`、`src/background/{login-window,login-handshake,handlers/}`、`src/content/main-world.js`、`src/content/isolated/*`、`entrypoints/{background,content,main-hook,popup,login-window,need-incognito}`。
`scripts/` 的检查项与项数以 `node scripts/verify.mjs --help` 为准（**别在文档里写数字，已漂移过三次**）。

**判断"某文件是否存在"请用 `git ls-files`，不要看 §1。**

# Pluma 目录结构与架构规范

> 项目名 **Pluma** / 仓库名 `bili-pluma` / 副标题 B站双账号画质助手
> 版本：**v1.1** · 2026-10-24（v1.0 → v1.1：接入 WXT 约定，修正目录结构，补技术选型）
> 本文规定：**代码放哪、文档放哪、层与层之间怎么通信、哪些东西绝对不许跨层访问。**

---

## 〇、技术选型（v1.1 新增，含版本约束）

> **版本一律写范围，不钉死 minor。** 具体以各库官方 latest 为准，本文不承担"记住最新版本号"的职责。

| 层面 | 选择 | 版本约束 | 备注 |
|---|---|---|---|
| 扩展框架 | **WXT** | `^0.x` 跟 latest 稳定版 | 不追 beta / canary |
| 语言 | **TypeScript** | `^5.9` | 不钉 minor；**TS 7.0（Rust 重写版）暂不采用**，生态适配需时间 |
| 严格度 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | — | `noUncheckedIndexedAccess` 对本项目尤其必要（数组下标取 DASH 轨） |
| UI 渲染（popup / options / login window） | **Preact** | `^10` | 约 4KB，需 `@preact/preset-vite` |
| UI 渲染（content script 角标） | **原生 DOM + Shadow DOM** | — | **不用框架**，见 §2「页内角标」 |
| 样式 | **原生 CSS 变量**（`tokens.css`） | — | 不用 Tailwind：样式唯一真相源是 `tokens.css`，多一层构建换不来收益 |
| 单测 | **Vitest** | `^2` | 只跑 `core/` `shared/`，不碰浏览器 |
| 集成测试 | **独立最小扩展**（P0 常驻） | — | `dnr.ts` 的回归测试，见 §6「P0」 |
| 代码规范 | **ESLint**（flat config）+ **Prettier** | `^9` / `^3` | 分工：ESLint 管"对不对"（含依赖方向强制），Prettier 管"好不好看"。`eslint-config-prettier` 关掉重叠规则，避免互相改来改去 |
| 包管理 | **pnpm** | `^12` | **Windows 下必须 `nodeLinker: hoisted`**，见下方「环境约束」 |
| 边界检查 | **`scripts/check-boundaries.ts`** | — | 按符号静态检查，CI 卡 PR |

### 环境约束：pnpm 在 Windows 上的 node_modules 布局

pnpm 默认的 `isolated` 布局要为每个直接依赖创建顶层 symlink。**本项目路径含空格时，创建会静默失败**——表现为 `node_modules/wxt` 不存在、`wxt prepare` 报 `MODULE_NOT_FOUND`，而 `pnpm install` 却显示成功。

必须在 `pnpm-workspace.yaml` 里配：

```yaml
nodeLinker: hoisted
```

两个坑：

1. `.npmrc` 里的 `node-linker=hoisted` 在 pnpm 12 上**不生效**（pnpm 10+ 把配置迁到了 workspace 文件）。
2. `pnpm exec` / `pnpm run` 会先做一次依赖校验，可能把布局切回 `isolated`。安装后建议直接确认 `node_modules/wxt` 存在。

（2026-10-25 实装时踩到，排查耗时较久——`install` 显示成功但产物缺失，是典型的静默失败。）

### 环境约束：依赖构建脚本白名单（`allowBuilds`）

pnpm 默认**不允许**依赖跑安装脚本。未裁决的包会让 `pnpm install` 以
`ERR_PNPM_IGNORED_BUILDS` **非零退出**——CI 会直接红。

```yaml
allowBuilds:
  esbuild: true
```

三个坑，全部实测过：

1. **写法是 map，不是列表。** `allowBuilds: [esbuild]` 不报错但语义不对。
2. **旧名 `onlyBuiltDependencies` 从 pnpm v11 起已被移除。** 写了不报错、**完全不生效**——
   这是本项目"`pnpm install` 每次失败"的真正原因，排查时先以为是 pnpm 版本行为差异，实际是配置名过期。
   同批被移除的还有 `neverBuiltDependencies` / `ignoredBuiltDependencies`。
   迁移命令：`pnpx codemod run pnpm-v10-to-v11`。
3. **pnpm 会自动往文件里写。** 发现未裁决的包时，它会把条目**插在文件开头**，
   手工再改容易产生重复的 `allowBuilds:` 键，YAML 直接解析失败（报 `duplicate mapping key`）。
   改这个文件前先完整读一遍。

只放行 `esbuild`：wxt / vite / vitest / tsx 都靠它的平台二进制，装不上工具链就起不来。
其余依赖不需要执行脚本，一律不放行——这是故意的保守选择，**不要图省事改成 `dangerouslyAllowAllBuilds`**。

文档：<https://pnpm.io/settings/build#allowbuilds>

### 为什么不用 TypeScript 钉版本

TS 每季度一个 minor，钉死具体版本会在半年内变成"落后两个版本"的状态。写 `^5.9` 表示"5.9 及以上、允许升到 5.x 内的新 minor"，既不走太前也不落后。

**同理**：WXT、Preact、Vitest 都写范围。文档不维护"当前最新版本是几"，那件事交给 `pnpm outdated`。

### 为什么这是"先进"的正确理解

在扩展开发里，工具链越新，可依赖的成熟方案越少。**真正体现技术水平的不是新框架，而是这四件事**：

1. 用 `chrome.storage.session`（MV3 新 API，内存态不落盘）存运行期凭据
2. DNR `sessionRules` 的 nonce 隔离写对（而非用静态规则）
3. 消息协议用**判别联合 + `never` 穷举检查**，漏处理在编译期就报错
4. `AbortSignal.timeout()` 代替手写 `setTimeout` + `Promise.race`

这四样比"用了 React 19"有价值得多。

---

## 0. 三条不可违背的原则

在讲目录之前，先定三条规则。因为目录结构只是结果，**这三条才是原因**。

### 原则 1：依赖只能从外往里流

```
entry (entrypoints) → features → core → shared
```

`entry` 依赖 `features`，`features` 依赖 `core`，`core` 依赖 `shared`。
**反向依赖一律禁止**：`core` 里不许出现任何 `chrome.tabs` / DOM / 具体业务 URL，`shared` 里不许出现业务逻辑。

为什么：`core` 是最需要测试的部分（取流、签名、凭据），它必须能在 Node 里跑单测，不能被浏览器 API 绑死。

> ⚠️ **v1.1 变更**：入口目录从 `src/content/` + `src/ui/` 改为 WXT 约定的 `entrypoints/`，原因见 [ADR 0005](./decisions/0005-adopt-wxt-conventions.md)。

### 原则 2：跨进程通信必须走"协议"，不能走"引用"

MV3 有三到四个独立执行环境，它们**内存不共享**：

| 环境 | 能力 | 不能做什么 |
|---|---|---|
| **MAIN world**（页面 JS 上下文） | 能访问页面的 `window`、`MediaSource`、`__INITIAL_STATE__` | 不能用 `chrome.*` API |
| **ISOLATED world**（content script） | 能用 `chrome.runtime`、能操作 DOM，但看不到页面的 JS 变量 | 不能访问页面 `window` 上的业务对象 |
| **Service Worker**（background） | 能用全部 `chrome.*` API、能发跨域请求、能读写存储 | 没有 DOM、每 30s 可能被休眠 |
| **Popup / Options** | 有 DOM、能用部分 `chrome.*` | 生命周期短，popup 失焦即销毁 |

所以**任何跨环境的数据传递，都要定义成消息类型**，而不是"我直接读一下那个变量"。

### 原则 3：模块边界 = 一个人能一次读完的篇幅

一个目录级模块（`core/auth/`、`features/playinfo/`）如果超过约 8 个文件，说明它承担了不止一件事，该拆。

---

## 1. 完整目录结构

> ⚠️ **只画到目录层，不列文件名。** 文档不维护第二份"可执行的事实"
> （见 [README.md](./README.md) 的维护原则第 1 条）——列了就会漂移。
> 想知道有哪些文件用 `git ls-files`；想知道与设计的差异看 §9「实现现状」。

```
bili-pluma/
├── entrypoints/            # 【WXT 约定】入口，文件名即 manifest 清单项
│   ├── background.ts       # → Service Worker
│   ├── content.ts          # → ISOLATED world content script
│   ├── main-hook.content.ts# → MAIN world content script（document_start 注入）
│   ├── popup/              # → action.default_popup
│   ├── options/            # → options_ui（P3）
│   └── login-window/       # 独立扫码窗口（chrome.windows.create 打开）
│
├── src/                    # 业务代码，WXT 不管
│   ├── shared/             # 最底层：零依赖、纯函数、纯类型
│   │   ├── types/          # 跨环境消息的判别联合
│   │   ├── constants/      # ★ routes.ts = 路径白名单唯一真相源
│   │   └── utils/          # cookie / url / video-page 等纯函数
│   ├── core/               # 领域层：不知道"浏览器"存在
│   │   ├── identity/       # ★ router.ts = URL → 用哪个身份
│   │   ├── auth/           # 扫码、凭据校验、健康度
│   │   ├── vault/          # 凭据加密存储
│   │   ├── playinfo/       # 取流解析与选轨（parse / rank / stats / summary-view / pgc-merge）
│   │   ├── ui/             # popup 状态判定（纯函数，可单测）
│   │   └── wbi/            # WBI 签名
│   ├── platform/           # 适配层：唯一允许碰 chrome.* 的地方
│   │   ├── http/           # ★ dnr.ts = 风险最高（装/删/自愈/诊断四组函数）
│   │   ├── storage/        # credential / health / stats / diag / pgc-cache / ui-prefs
│   │   ├── page/           # 页面侧数据通道
│   │   ├── diagnostics/    # 诊断取数
│   │   └── qr/
│   ├── background/         # SW 内部实现（handlers/ 按消息域拆分）
│   ├── content/            # 页面侧实现
│   │   ├── main-world.js   # ★ 注入 MAIN world 的脚本，唯一源文件（近 3000 行纯 JS）
│   │   └── isolated/       # badge（Shadow DOM）/ page-state / pgc-*
│   └── design/             # ★ tokens.css = 视觉唯一真相源
│
├── tests/                  # Vitest，跑在 Node，不碰浏览器
├── scripts/                # ★ check-boundaries.ts 依赖方向检查
├── docs/                   # 全部设计文档（索引见 docs/README.md）
└── poc/                    # 一次性验证 + 常驻回归测试，不接入 WXT、零构建
```

> ⚠️ **没有 `public/`**。主世界脚本曾经放在那里（`public/main-world.js` + `web_accessible_resources`），
> 2026-10-28 改为 `src/content/main-world.js` 由 `main-hook.content.ts` 直接 `import`：
> 它不再需要对外可访问，manifest 里那段 WAR 声明是死配置，已删。

---

## 2. 各层职责与禁令（最重要的一节）

### `shared/` —— 只放"不需要知道任何事"的东西

| 允许 | 禁止 |
|---|---|
| 类型定义、常量、纯函数工具 | `chrome.*` 调用 |
| 零外部依赖（除 TS 标准库） | 任何 `import` 自 `core`/`platform` |
| 路径白名单、Cookie 解析 | 网络请求、存储读写 |

**关键文件说明**：

- `shared/constants/routes.ts` 是 **URL 白名单的唯一真相源**。所有匹配逻辑都必须引用它，不许在别处硬编码路径字符串。这样 B 站改路径时只改一个文件。
- `shared/types/messages.ts` 用**判别联合（discriminated union）**定义所有消息，
  成功/失败靠 `type` 的 `:ok` / `:err` 后缀区分。摘三条示意（**完整清单以该文件为准，本文不抄第二份**）：

```ts
| { type: 'account/summary'; recheck?: boolean }
| { type: 'account/summary:ok'; configured: boolean; account: AccountSummary | null; needsRecheck: boolean }
| { type: 'account/summary:err'; code: ErrorCode; detail: string | null }
```

**⚠️ 编译期不会替你抓漏**：分发处（`entrypoints/background.ts`）用的是 `if (type === '...')` 链，
不是 `switch`，所以判别联合的穷举能力用不上——定义了类型却忘了加分支，`tsc` 完全看不出来，
运行时只会静默拿到 `undefined`。真正的防线是 `scripts/check-messages.mjs`（比对类型与路由分支）。

### `core/` —— 业务逻辑，完全不知道浏览器的存在

| 允许 | 禁止 |
|---|---|
| 纯 TS、依赖 `shared` | `chrome.*`、`window`、`document` |
| 通过参数注入 http / storage 接口 | 直接 `fetch()`（必须用注入的 `fetcher`） |

**为什么这条要卡死**：`core/identity/router.ts` 和 `core/wbi/signer.ts` 是最容易写错、最需要单测的部分。如果它们直接调 `chrome.*`，就没法在 Node 里测，只能靠手动装扩展点来点去验证——那是灾难。

注入方式示例（真实代码，见 `src/core/auth/qrcode.ts`）：

```ts
// core 只声明"我需要一个能发请求的东西"，不关心它是 fetch 还是别的
export async function generateQr(http: HttpClient): Promise<QrGenerateResult> { ... }
```

`HttpClient` 接口与 `createHttpClient()` 实现在 `src/platform/http/fetcher.ts`；
测试时传一个假实现就行，不需要浏览器。

### `platform/` —— 唯一的"浏览器污染区"

这里的所有代码都只做一件事：**把浏览器 API 包成 core 需要的接口。**

- `platform/http/dnr.ts` 是整个项目**技术风险最高**的文件（对应 Q2）。它实际负责三件事：
  - **两套规则集**：全局路径规则（ID 10000 段，priority 1，无 `tabIds`，`enableProxy()` 装）+
    标签页规则（ID 20000 段，priority 2，有 `tabIds`，页面报到时装）。两套的 Cookie 值相同
  - **总开关 + SW 启动自愈**：`sessionRules` 浏览器重启即清空，启动时必须重建；
    凭据读不到就关掉开关，绝不留下"开关开着、一条规则都没有"的状态
  - **幂等**：`installTabRule` 先比对现有规则的 Cookie 值，一样就跳过——
    反复重建规则是"恢复标签页时卡一下"的直接来源

**这个文件要独立写测试**，且测试必须在真实 Chrome 里跑（DNR 行为无法在 Node 模拟）。

> ⚠️ 本节曾列着「nonce 生成与 urlFilter 拼接 / 加规则→请求→删规则的 `try/finally` /
> 超时回收 / 并发计数与降级」——那些是 **ADR 0006 之前**的设计，已全部废除。
> 现行规则写法以 [ADR 0006](./decisions/0006-no-per-request-nonce.md) 与 AGENTS.md §5.4 为准。

- `platform/runtime/messaging.ts` 要统一处理 MV3 的坑：SW 休眠导致 `sendMessage` 抛 `Could not establish connection`，需要重试一次。

### `background/` —— 只做编排

| 允许 | 禁止 |
|---|---|
| 注册监听器、把消息分发给 handler | 写业务算法 |
| 调 `core` + `platform` | 直接操作 DOM（做不到） |
| 维护 SW 级状态（内存缓存 + 持久化） | 长时间同步阻塞 |

`handlers/` 里每个文件对应一组消息类型，**handler 只做三件事**：解析参数 → 调 core → 返回结果/错误。如果一个 handler 超过 60 行，说明业务逻辑漏在这儿了，该挪进 `core`。

### `content/` —— 页面侧，必须分 MAIN 与 ISOLATED

这是最容易写乱的地方。两个执行环境**不能互相访问变量**，只能通过 `postMessage`。

**v1.1 结构性变更**：入口文件在 `entrypoints/`（WXT 约定），实现代码在 `src/content/`。

```
entrypoints/bili-main.content.ts   ← WXT 入口，声明 world: 'MAIN'
  └─ import from src/content/main-world/*

entrypoints/bili.content.ts        ← WXT 入口，默认 ISOLATED world
  └─ import from src/content/isolated/*
```

这样做的原因见 [ADR 0005](./decisions/0005-adopt-wxt-conventions.md)：**入口归框架管，实现归我们管**。WXT 负责 manifest、注入时序、构建产物路径；我们负责逻辑。

```
MAIN world                    ISOLATED world
─────────────                 ──────────────
net-hook.ts                   router.ts（二次校验）
检测到 playurl 请求             
   │                             │
   └── postMessage ──────────────┘
       （带随机 channelToken）
```

**为什么必须分**：
- MAIN world 才能 hook 页面的 `fetch`（因为页面的 `fetch` 是页面 `window` 上的）
- 但 MAIN world 拿不到 `chrome.*`，所以不能发请求、不能读存储
- ISOLATED world 有 `chrome.*`，但看不到页面的 `fetch`

**channelToken 的安全作用**（从 Dual Account Helper 学到的关键设计）：页面本身也能监听 `postMessage`，恶意脚本可以伪造消息让扩展"用副账号凭据请求任意 URL"。所以：
1. MAIN world 注入时生成一个随机 token，只通过闭包传给自己的 hook
2. ISOLATED world 收到消息先校验 token
3. **收到后再做一次 URL 白名单 + 方法校验**（不信任 MAIN world 的任何输入）

三层防护缺一不可。

### 页内角标：原生 DOM + Shadow DOM，**不用 Preact**

这条容易被忽略。`content/isolated/badge.ts` 往 B 站页面注入角标时：

1. **必须用 Shadow DOM 隔离**。否则 B 站的全局样式（`body` 规则、`*` 选择器、`!important`）会污染角标，而且我们的样式也会漏到页面上。
2. **不用 Preact**。角标只有 20 行 DOM，上框架的收益为零，而多一个渲染器就意味着多一处和页面冲突的可能。
3. **`tokens.css` 必须能注入 shadow root**。CSS 变量不穿透 shadow 边界，所以要先读 `tokens.css` 文本再塞进 shadow root 的 `<style>`，或者在 shadow root 内重新声明变量。

```ts
const host = document.createElement('div');
host.style.position = 'fixed';
const shadow = host.attachShadow({ mode: 'closed' });
shadow.appendChild(styleWithTokens());      // tokens.css 内容
shadow.appendChild(badgeElement());          // 纯 DOM 构建
document.body.appendChild(host);
```

`mode: 'closed'` 是刻意的：页面脚本拿不到 `host.shadowRoot`，无法篡改我们的角标。

### `entrypoints/`（原 `ui/`）—— 只跟消息协议打交道

| 允许 | 禁止 |
|---|---|
| 调 `chrome.runtime.sendMessage` | 直接读 `chrome.storage`（凭据相关） |
| 用 `src/design/tokens.css` 的变量 | 硬编码颜色/字号 |
| Preact 组件 | 在 popup 里做长任务（失焦即销毁） |

`src/design/tokens.css` 是 UI 的唯一真相源，对应 `docs/02-ui-spec.md` 里定义的色值与字号。**改配色只改这一个文件**，不许在各组件里写死。

`entrypoints/popup/` **没有按状态拆目录**，只有三个文件：`index.html` / `main.tsx` / `style.css`。
状态判定放在 `src/core/ui/popup-state.ts`（纯函数，可单测），渲染在 `main.tsx` 一个组件里。
`PopupState` 共 **8** 种（`not-configured`/`credential-missing`/`expired`/`stopped`/`not-video`/`inconsistent`/`degraded`/`active`），各是什么见 `docs/02-ui-spec.md` §3。

> 原设计稿写的是"每个状态一个文件"，实装时发现状态之间共享大量结构，拆开反而重复，所以没采用。

---

## 3. 文档放哪：`docs/` 一个目录，按"用途"而非"格式"分

```
docs/
├── README.md               ← 索引，告诉新人从哪读起
├── 01-architecture.md      ← 技术方案（为什么这么设计）
├── 02-ui-spec.md           ← UI 规范（界面长什么样）
├── 03-open-questions.md    ← 待确认问题（还有什么没定）
├── 04-project-structure.md ← 本文（代码放哪）
├── decisions/              ← ADR：一条决策一个文件
├── protocols/              ← 消息协议（会和代码类型定义互相引用）
└── guides/                 ← 操作手册（怎么调、怎么发、怎么排查）
```

### 为什么按数字前缀

`01 / 02 / 03 / 04` 让阅读顺序在文件列表里就体现出来。新人打开 `docs/` 一眼知道先读架构、再看 UI、最后看未决问题。**不用在 README 里解释阅读顺序**——文件名自己说了。

### 为什么 `decisions/` 单独拆

现在的 `03-open-questions.md` 里已经有"决策变更日志"表格了。但表格只记结论，**记不下理由和当时排除了哪些方案**。

ADR（Architecture Decision Record）就是为这个存在的。一个 ADR 一个文件，格式固定：

```markdown
# 0001. 采用纯 MV3 扩展，不做桌面端

日期：2026-10-24
状态：已采纳

## 背景
最初设计了「扩展 + Rust Core + Flutter」三进程方案。

## 决策
v1 只做纯 MV3 扩展。

## 理由
请求级代理能在 JS 层完成全部取流，引入桌面端只增加维护成本……

## 被放弃的方案
- 三进程：过度设计，v1 成本翻倍
- 油猴脚本：受脚本管理器限制，且无法做凭据加密

## 后果
- 凭据只能存 chrome.storage（安全强度低于 DPAPI）
- 无法做跨设备同步
```

**什么时候写 ADR**：只在"改了主意"或"选了其中一条路"时写。不写"我叫 Pluma"这种，那是 README 的事。

建议先补 5 个 ADR（前 4 个已写、第 5 个本次新增）：
- `0001-use-mv3-pure-extension.md`（撤三进程）✅
- `0002-dnr-to-replace-cookie-header.md`（DNR 能改 Cookie 头）✅
- `0003-gplv3-with-additional-terms.md`（协议选择）✅
- `0004-request-level-identity-proxy.md`（代理而非切换）✅
- `0005-adopt-wxt-conventions.md`（接入 WXT、放弃 `src/content/` 自定结构）✅

### 文档和代码的一致性怎么保证

三个具体做法：

1. **路径白名单**：`docs/01-architecture.md` §4.1 的表格和 `src/shared/constants/routes.ts` 要一致。做法是在 `routes.ts` 里注释"来源：docs/01-architecture.md §4.1"，改一处时人工同步（这是低技术手段但最可靠）。

2. **消息协议**：`docs/protocols/messages.md` 的表格和 `src/shared/types/messages.ts` 的联合类型要一致。做法是**代码为准，文档从代码抄**，文档里注明"以 types/messages.ts 为准"。

3. **UI 令牌**：`docs/02-ui-spec.md` 的色值表与 `src/design/tokens.css` 一致。同样以 CSS 为准。

**原则：代码是真相，文档是解释。** 不要在文档里维护第二份"可执行的事实"。

---

## 4. 解耦的三道保险

光靠约定不够，要靠工具卡住。

### 保险 1：TS 路径别名限定引用方向

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@core/*": ["src/core/*"],
      "@platform/*": ["src/platform/*"],
      "@design/*": ["src/design/*"]
    }
  }
}
```

> 注：WXT 会自动生成 `.wxt/tsconfig.json` 并合并你的配置，别名建议写在 `wxt.config.ts` 的 `vite.resolve.alias` 里，同时同步到根 `tsconfig.json` 的 `paths`（IDE 需要）。两处不一致时以 `wxt.config.ts` 为准。

**`core` 里不许出现 `chrome.`**——这一条可以用 ESLint 规则卡死。

### 保险 2：ESLint 的 `no-restricted-imports` 限定层间引用 ✅ 已落地

实现见 `eslint.config.mjs`，跑 `node scripts/verify.mjs`。核心规则：

```js
// src/core/**、src/shared/** 下
'no-restricted-imports': ['error', {
  paths: [{ name: 'wxt/browser' }, { name: 'wxt' }],
  patterns: [
    { group: ['@platform/*'], message: 'core/shared 不许依赖 platform' },
    { group: ['@background/*', '@content/*'], message: 'core/shared 不许依赖上层' },
    { group: ['wxt', 'wxt/*'], message: 'core/shared 禁止依赖 WXT' },
  ],
}],
// 还禁了 chrome / browser 全局对象
'no-restricted-globals': ['error', { name: 'chrome' }, { name: 'browser' }],
```

**实测（2026-10-25）**：在 `core/vault/vault.ts` 顶部加一行
`import { browser } from 'wxt/browser'`，ESLint 立刻报 2 条 `no-restricted-imports`。

配合 `overrides` 按目录生效，就能做到**编译期强制依赖方向**。

> `@design/*` 只允许 `entrypoints/` 引用，`shared`/`core`/`platform` 一律禁止——因为设计令牌是 UI 概念，业务层不该知道颜色。
> 这条由 `scripts/check-design-imports.mjs` 强制（**不是** ESLint）。
> 实装教训：规则本身会漏**副作用导入**（`import '@design/x'` 没有 `from`），
> 六种写法（副作用 / 静态 from / export 再导出 / 动态 import / 相对副作用 / 相对 from）已逐个反例验证。

### 保险 3：`scripts/check-boundaries.ts` 在 CI 跑 ✅ 已落地

ESLint 管 import 方向，但**管不住 `globalThis.chrome` 这类动态访问**。所以再加一个文本级检查：

```bash
node scripts/verify.mjs   # boundaries 是其中一项
```

实现要点：

| 项 | 做法 |
| --- | --- |
| 扫描范围 | `src/core/` + `src/shared/` 下所有 `.ts` |
| 禁止符号 | `chrome` / `browser.` / `window` / `document` / `fetch(` / `localStorage` / `sessionStorage` / `XMLHttpRequest` |
| **注释与字符串** | **掩码成等长空白**（保持列号），避免注释里提到 `chrome` 就误报 |
| 输出 | 文件名:行:列 + 原始代码片段 + 修复提示 |

**为什么 ESLint 抓不到 `globalThis.chrome`**：它只看静态 import 语句。
`(globalThis as any).chrome` 里没有 import，ESLint 只报了 `no-explicit-any`，
**完全没提分层违规**。这正是需要第二道防线的原因。

**实测（2026-10-25，六种变异）**：

| 变异 | ESLint | boundaries |
| --- | --- | --- |
| `import { browser } from 'wxt/browser'` | ✅ 抓到 | ✅ 抓到 |
| `(globalThis as any).chrome` | ❌ **只报 any，漏了分层** | ✅ 抓到 |
| `await fetch(...)` | ✅ 抓到 | ✅ 抓到 |
| `document.title` | ✅ 抓到 | ✅ 抓到 |
| `localStorage.setItem` | ✅ 抓到 | ✅ 抓到 |
| 注释/字符串提到 `chrome` | ✅ 不误报 | ✅ **不误报**（掩码生效） |

> ⚠️ **检查项是 `\bchrome\b` 而不是 `chrome\.`** ——
> `globalThis.chrome`、`('chrome' in x)` 拿到的都是同一个对象，
> 只拦 `chrome.` 会漏。这是实测踩出来的。

---

## 5. 与 Q2 的关系：目录结构本身就要为最大风险让位

回顾一下：**Q2（DNR 并发安全）是唯一可能推翻方案的未知数。**

所以目录结构上要让它**可以被独立验证、独立替换**：

- `platform/http/dnr.ts` 是**唯一**碰 DNR 的地方
- 它的导出分成四组，**按用途区分，不要合并**：
  - 装/删全局路径规则：`enableProxy` / `disableProxy`（`disableProxy` **必须同时删标签页规则**，
    否则关开关后画质不回落 —— 2026-10-27 修过的真实 bug）
  - 装/删标签页规则：`installTabRule` / `removeTabRule`
  - 自愈：`rebuildRulesIfEnabled` / `reconcileTabRules`
  - 只读诊断：`isProxyEnabled` / `countPathRules` / `describeRules`
- 它不关心 bilibili、不关心账号——只关心"把某些请求的 Cookie 头换成指定值，且能干净撤销"
- 如果 DNR 方案失败要换成油猴式 hook，**只换这一个文件的实现**，`core` 一行不改

> ⚠️ 曾经这里写的是「对外只暴露 `withCookieFor<T>(url, cookie, fn)` 这一个函数」——
> **那个函数从来没有被实现过**，是 ADR 0006 之前的残留设计。现行实现是常驻规则 + 总开关，
> 不需要"包一个请求"的形态。别按那句旧话去设计。

这就是解耦最实际的收益：**你的最大风险被关在一个文件里。**

---

## 6. 落地顺序建议

不要一次把所有目录建全，那会变成"文件夹驱动的开发"（建完目录不知道填什么）。

### P0：Q2 验证 —— ✅ **已完成（2026-10-25）**

| 项 | 内容 |
| --- | --- |
| 位置 | `poc/q2-dnr-concurrency/`（**不在 `src/` 下，不接入 WXT**） |
| 内容 | `manifest.json` + `background.js` + `lab.html`/`lab.js`/`lab.css` |
| 结果 | **通过**：180 并发请求串号 0、规则残留 0；结论是**不需要 per-request nonce**（[ADR 0006](./decisions/0006-no-per-request-nonce.md)） |
| 产出 | **保留为常驻回归测试**，以后每次改 `dnr.ts` 都跑一遍 |

**为什么不放进主项目**：P0 的价值就在于失败时沉没成本为零。它用裸 JS + 零依赖写成，任何时候 `加载已解压的扩展程序` 就能跑，不受主项目构建失败、依赖升级、WXT 换版本影响。

### P1 之后才建主项目

| 阶段 | 建哪些 | 状态 |
|---|---|---|
| **骨架** | WXT 初始化 → `shared/` `core/identity/` `core/vault/` `platform/` `entrypoints/background.ts` `src/background/` | ✅ 2026-10-25 |
| **P2-a 数据源** | `core/auth/health.ts` `core/auth/account-info.ts` `core/playinfo/stats.ts` `background/handlers/account.handler.ts` `stats.handler.ts` | ✅ 2026-10-25 |
| **P2-b 总开关** | popup 接上 `proxy/set`；`tabs.handler.ts` 统计受影响标签页 | ✅ 2026-10-25 |
| **P2-c 界面** | `entrypoints/popup/` + 登录窗口 + 登录入口迁移 | ✅ 已完成（P2 阶段做了框架；§2.3/§2.4/§2.6 在 P3 补齐） |
| **P2-d 页面侧** | 页内角标（Shadow DOM） | ✅ 2026-10-26 |
| **P3 完善** | `entrypoints/options/` **三**分区内容（账号/诊断/显示） | ✅ **已完成（2026-10-27，六条验收全过）**：popup §2.3/§2.4/§2.6/状态 5、options 三分区、条形图、路径版本号全部落地。体检表与音质自检独立页已砍（[ADR 0016](./decisions/0016-drop-quality-report-page.md)） |
| **预留** | `platform/browsers/firefox.ts` | ⬜ v1.5 |

> **判断某文件是否存在，用 `git ls-files`，不要看 §1 的那棵树。**

#### P2 顺延到 P3 的四项（2026-10-26 决定）

P2 收尾时逐条对照 [02-ui-spec.md](./02-ui-spec.md) 核验，发现以下规范要求**没有落地**。
它们全部依赖 P3 的东西（options 页，或 `core/playinfo/parse.ts` / `rank.ts`），
硬在 P2 里补等于先造临时实现、下一阶段再拆掉。所以顺延，**不删减**：

| 规范条目 | 原文位置 | 依赖 | 为什么顺延 |
| --- | --- | --- | --- |
| **当前页解锁画质（核心价值区）** ✅ 2026-10-26 已完成 | §2.3 | `core/playinfo/parse.ts` `rank.ts` `summary-view.ts` + content 上报 playurl | 需要 `accept_quality` 与主/副账号对比，这套解析是 P3 的核心模块 |
| 双账号卡片（主 A / 播放 B 对比） ✅ 2026-10-26 已完成 | §2.4 | 同 §2.3 | 当前 popup 只有播放账号一行摘要 |
| popup 底部按钮（§2.6） ✅ 2026-10-26 已完成（两个：播放账号 / 设置） | §2.6 | `entrypoints/options/` | 按钮指向 options 页，页不存在时是死链 |
| 角标「设置里可关闭」 | §5 | `entrypoints/options/` | 设置页不存在；且 §2.5 明确「popup 只放一个开关」，不能再往 popup 塞 |

> ⚠️ **§2.3 是规范里写的"整个 popup 唯一不能省的部分"**。
> 它顺延意味着：当前 popup 只能回答"现在生效了吗"（状态条 + 开关），
> 还不能回答"解锁了什么"（对比表）。这是 P3 必须最先补的一块，
> 也是 README 首屏「功能自证」的素材来源。

**代价（已知并接受）**：
- 用户想隐藏角标只能关总开关（`proxying: false` 时角标不渲染，见 `badge-content.ts` 的 `visible` 判定）
- popup 无法展示"主账号仅可用 1080P vs 已解锁 4K"的对比，产品说服力打了折扣


### 为什么 P2 的顺序是 a → b → c → d

> 这节记的是**当初为什么这么排**，不是当前状态。当时 popup 规范要求覆盖 7 种状态，
> 但其中 3 种没有数据源：`account/summary` 无处理方、`core/auth/health.ts` 未实现、
> `stats.handler.ts` 未实现。先做界面等于画空壳。
>
> **三者现在都已实现（P2-a，2026-10-25）。** 但这套顺序逻辑仍然成立——
> 以后加任何新界面，先问"它的数据从哪来"，再动手画。

### 凭据健康检查：惰性，不用 alarms

**不做后台定时探测。** `incognito: "split"` 下普通/无痕是两个 SW 实例，共享 `storage.local`，
定时任务在哪个实例跑不确定，两个实例会互相覆盖健康标记。

改为**惰性检查**，只在三个时机触发：

| 时机 | 做什么 |
| --- | --- |
| popup 打开 | 若 `checkedAt` 超过 6 小时，查一次 `nav` |
| `page/activate` 成功/失败 | 用真实取流结果反推健康度（比 `nav` 更准） |
| 用户点"重新检查" | 强制查一次 |

代价：用户既不开 popup 也不看视频时，失效不会被发现——而那种场景本来也不需要发现。
好处：不申请 `alarms` 权限，不多一条跨分区协调逻辑。

### v1 只支持单个播放账号

`core/vault` 的 `Credential` 是单数、`vault-storage.ts` 只存一个 blob。
**多账号（对齐 bilipai 的多 profile）推迟到 v1.5**，`docs/02-ui-spec.md` §4.1 已同步修正。

### 测试策略：两个层次，不可互相替代

| 层 | 工具 | 覆盖什么 | 不能覆盖什么 |
| --- | --- | --- | --- |
| 单测 | Vitest（Node / jsdom） | `core/identity/router`、`core/wbi/signer`、`core/auth/health`、`shared/utils/*` | 碰真实浏览器的 API（`chrome.*`、DNR） |
| 集成 | **P0 独立扩展**（真实浏览器） | `platform/http/dnr.ts` 的并发正确性、规则回收 | 业务逻辑（它只测 Cookie 头对不对） |

**关键认知**：`dnr.ts` 是风险最高的文件，却恰好**无法用 Vitest 测**。所以 P0 那个测试页不是"一次性验证"，而是**这个文件唯一的测试手段**，必须留在仓库里长期跑。

### 主世界脚本怎么测（2026-10-28 定稿）

`src/content/main-world.js` 是近 3000 行纯 JS，由 `entrypoints/main-hook.content.ts` 直接 `import`。

**先说清楚它没有的保护**（这一段曾经写反过，2026-10-28 更正）：

| 手段 | 对它生效吗 | 说明 |
| --- | --- | --- |
| `tsc` | ❌ **不生效** | `tsconfig` 的 `include` 不含它，也没有 `checkJs`。曾计划"文件顶部加 `// @ts-check` + JSDoc"，**从未实现** |
| `eslint` | ❌ **不生效** | `eslint.config.mjs` 的 `ignores` 明确排除了它 |
| `prettier` | ❌ **不生效** | `.prettierignore` 明确排除了它 |
| 行为测试 | ✅ **唯一手段** | `tests/unit/content/main-world-{real,pgc}.test.ts` |

**为什么不做静态检查**：它大量 hook 页面原生对象（`fetch` / `XHR` / `MediaSource` / `addSourceBuffer`），
大量 `var` 与被 hook 的原函数签名，按项目 lint 规则改一遍只会增加行为风险、换不来正确性。
搬成 TS 还会引入第二个构建产物、让"唯一源文件"变成"构建产物"。**这是明确决策，不是遗漏。**

**唯一的手段是行为测试，做法是"读真源码、在 jsdom 里 eval"**：

```ts
const SOURCE = readFileSync(resolve(process.cwd(), 'src/content/main-world.js'), 'utf8');
window.eval(SOURCE);   // 每个用例新建 jsdom，状态才真隔离
```

**这样测的是真源码，不是复刻。** 此前 `main-world-logic.test.ts` 用"复刻函数"测，
一旦主世界改了而测试没跟着改，两边就悄悄漂移——这个隐患随本方案消失。

**代价要认**：测试只覆盖被断言的路径。改主世界脚本里**没被断言**的分支（尤其是 PGC 时序），
`verify` 不会告诉你坏了 —— 那类改动必须按 AGENTS.md §4.3 要一次真机日志。

`tests/` 建议在**骨架阶段就开始**，至少给 `core/identity/router.ts` 和 `core/wbi/signer.ts` 写单测。这两个是纯逻辑、易出错、改一次就得重新验的东西——手测成本远高于写测试。

---

## 7. 一句话总结

**目录结构不是为了好看，是为了让"最容易错的东西"被关在最小的范围里。**

- 最大技术风险（DNR 并发）→ 关在 `platform/http/dnr.ts`，配 `poc/q2-*` 做回归
- 最需要测试（路由/签名/选轨）→ 放 `core/`，不许碰浏览器 API
- 最容易被伪造（跨 world 消息）→ 用类型化协议 + token + 二次校验
- 最容易过期（路径白名单）→ 只在 `shared/constants/routes.ts` 维护一份
- 最容易和页面打架（页内角标）→ Shadow DOM 隔离 + 原生 DOM，不上框架

文档则集中 `docs/`，按"为什么（architecture）→ 长什么样（ui-spec）→ 还差什么（open-questions）→ 代码在哪（structure）"的顺序编号，决策的"为什么"单独放 `decisions/` 做 ADR。

---

## 8. v1.0 → v1.1 变更清单

| # | v1.0 | v1.1 | 原因 |
| --- | --- | --- | --- |
| 1 | 入口在 `src/content/` `src/ui/` | 入口在 `entrypoints/`（WXT 约定），实现仍在 `src/` | 框架约定优先于个人偏好，见 ADR 0005 |
| 2 | UI 统一用框架 | popup/options 用 Preact；页内角标用原生 DOM + Shadow DOM | 角标 20 行，上框架收益为零且增加页面冲突风险 |
| 3 | `tokens.css` 只给 popup | 必须能注入 shadow root | CSS 变量不穿透 shadow 边界 |
| 4 | Vitest 覆盖所有测试 | Vitest 只测 `core/`；`dnr.ts` 靠 P0 独立扩展做集成测试 | DNR 无法在 Node 模拟，Vitest 覆盖不到最大风险点 |
| 5 | P0 是"主项目第一个模块" | P0 完全独立，不接 WXT | Q2 失败时沉没成本归零 |
| 6 | 未列技术选型 | 新增 §〇 技术选型表，版本一律写范围 | 避免钉死版本号后半年就落后 |
| 7 | 未提 ESLint/Prettier | 列入必选工具 | 依赖方向强制手段，不是可选项 |

---

## 9. 实现现状（2026-10-28）

§1 那棵树是设计稿。实际实现与它的**差异**如下，避免把设计当成事实：

| 设计稿 | 实际实现 | 原因 |
| --- | --- | --- |
| `entrypoints/bili.content.ts` + `bili-main.content.ts`（两个入口） | `entrypoints/content.ts`（ISOLATED）+ `entrypoints/main-hook.content.ts`（MAIN，`document_start`）+ `src/content/main-world.js` | 原设计假设"MAIN world 只能用资源文件注入"——**实测 `world: 'MAIN'` 可用**，而且必须用它：`<script src>` 是异步加载，赶不上 PGC 页的内联脚本（2026-10-27 真机踩到） |
| `src/content/main-world/` `src/content/isolated/` | `src/content/main-world.js`（单文件）+ `src/content/isolated/*` | 同上 |
| `src/background/index.ts` | `entrypoints/background.ts` | WXT 约定 |
| `src/platform/runtime/messaging.ts` | 无独立封装，页面直接 `sendMessage` | 只有 3 个 UI 页面，封装收益低于成本 |
| `src/manifest.json` | `wxt.config.ts` 的 `manifest` 字段 | WXT 约定 |
| `public/main-world.js` + `web_accessible_resources` | **已删**：脚本移到 `src/content/main-world.js` 并被 `import` | WAR 是死配置（无人按 URL 加载它），留着只是让全站页面能 fetch 到它 |
| `entrypoints/popup/` | ✅ **完整实现**（P3 补齐 §2.3 解锁画质对比 / §2.4 双账号卡片 / §2.6 底部两按钮） | 此前依赖 options 页与 `core/playinfo` 解析 |
| `entrypoints/options/` | ✅ **三分区全部完成**：hash 路由导航、账号页（两张卡片 + 扫码/退出）、显示页（角标开关）、诊断页（自检信息 + 音质折叠块 + 日志 + 导出 + 白名单版本） | 体检/音质两页已砍（ADR 0016）；独立自检页已并入诊断分区 |
| `scripts/`（8 个 `check-*` + `verify.mjs` 入口 + `package.mjs`） | ✅ **已实现**（`node scripts/verify.mjs`） | 边界 / 消息路由 / 设计令牌 / 文档 / 敏感信息 / 改写范围 / 播放页判据 / 工作流日志；**检查命令的唯一权威位置是 `scripts/`**，项数以 `--help` 为准（别在文档里写数字，已漂移过三次）。`package.mjs` 是打包，不在 verify 链里 |
| ESLint 配置 | ✅ **已实现**（`eslint.config.mjs`；跑 `node scripts/verify.mjs`） | `no-restricted-imports` + `no-restricted-globals` 封死 core/shared |
| Prettier 配置 | ✅ **已实现**（`.prettierrc`；跑 `node scripts/verify.mjs`） | 用 `eslint-config-prettier` 关掉冲突规则；Markdown 不纳入格式化（见 `.prettierignore` 说明） |
| `.eslintrc.cjs` | `eslint.config.mjs` | ESLint 9 默认 flat config |

### 已实现且与设计一致的

```
src/shared/{types,constants,utils}     ✅ 全部落地，零依赖
src/design/tokens.css                  ✅
src/core/{auth,vault,wbi,identity}     ✅
src/core/playinfo/{stats,parse,rank,summary-view,pgc-merge}.ts   ✅（pgc-merge 为 ADR 0023 新增）
src/core/ui/popup-state.ts             ✅ popup 状态判定（纯函数，43 个单测）
src/platform/{http,storage,qr}         ✅
src/platform/page/                     ✅ 页面侧数据通道
src/platform/diagnostics/collect.ts    ✅ 诊断取数
src/background/{login-window,login-handshake,handlers/}  ✅
src/content/main-world.js              ✅ 近 3000 行纯 JS，不进 tsc / eslint / prettier（§6）
src/content/isolated/                  ✅ badge / badge-content / page-state
                                       + pgc-{cache-inject,fetch,reload-plan,resume}.ts（ADR 0020/0023）
entrypoints/{background,content,main-hook,popup,options,login-window,need-incognito}  ✅
# ⚠️ 没有 entrypoints/diagnostics —— 诊断是 options 的一个分区（sections/diagnostics.tsx）
```

**判断"某文件是否存在"请用 `git ls-files`，不要看 §1。**

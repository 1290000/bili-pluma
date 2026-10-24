# ADR 0005. 接入 WXT 约定，放弃自定的 `src/content/` 与 `src/ui/` 结构

日期：2026-10-24
状态：已采纳
取代：`docs/04-project-structure.md` v1.0 中的目录设计
影响面：**所有入口文件的路径**

## 背景

`04-project-structure.md` v1.0 设计了一套完全自定的目录：

```
src/
├── content/
│   ├── main-world/        # MAIN world
│   └── isolated/          # ISOLATED world
└── ui/
    ├── popup/
    ├── options/
    └── login-window/
```

manifest 手写、构建脚本自己写。

后来决定工具链选 WXT（理由见下文"为什么选 WXT"），随即发现两者冲突。

## 冲突是什么

WXT 的核心理念是 **"entrypoints 即 manifest"**：

- `entrypoints/background.ts` → 自动生成 `background.service_worker`
- `entrypoints/popup/index.html` → 自动生成 `action.default_popup`
- `entrypoints/*.content.ts` → 自动生成 `content_scripts`（含 `matches`、`run_at`、`world`）
- `public/icon/` → 自动生成 `icons`

它**不支持**任意目录结构，只认 `entrypoints/` 下的约定。而且双 world 的声明方式就是文件名/配置：

```ts
// entrypoints/bili-main.content.ts
export default defineContentScript({
  matches: ['https://www.bilibili.com/*'],
  world: 'MAIN',              // ← 这一行就是全部工作
  runAt: 'document_start',
  main() { ... },
});
```

## 决策

**采用 WXT 的 entrypoints 约定。放弃自定的 `src/content/` 与 `src/ui/` 入口结构。**

但保留分层思想，只是把"入口"和"实现"拆开：

```
entrypoints/          ← 框架管：manifest 生成、注入时序、产物路径
├── background.ts        薄壳，import src/background/index
├── bili.content.ts      薄壳，import src/content/isolated/index
├── bili-main.content.ts 薄壳，import src/content/main-world/index
├── popup/               UI 入口（Preact 组件直接放这里）
├── options/
└── login-window/

src/                  ← 我们管：业务实现
├── shared/
├── core/
├── platform/
├── background/         被 entrypoints/background.ts 调用
├── content/            被 entrypoints/*.content.ts 调用
└── design/
```

**一句话：入口归框架，实现归我们。**

## 理由

### 1. 框架约定优先于个人偏好

我的 `src/content/` 设计在架构上更"干净"（同层级的两个 world 并列），但它要求我手写 manifest、手写注入时序、手写双 world 的构建产物处理。

这些事 **WXT 已经踩过坑了**：`document_start` 的实际生效时机、`world: 'MAIN'` 在不同 Chrome 版本的行为差异、CSP 相关的注入失败、HMR 时 content script 的重载。我重新踩一遍不会得到更好的结果。

**代价是对比的**：既然选了这个框架，就该用它的约定。让框架迁就我的目录设计，等于"用着 WXT 但手工绕过它所有便利"，是最差的组合。

### 2. "入口 / 实现"分离保住了分层

采用 WXT 约定**不意味着**放弃依赖方向控制。`entrypoints/` 下的文件是薄壳（通常 5–15 行），它 `import` 自 `src/`，而不是相反。

所以依赖方向依然是：

```
entrypoints/*  →  src/background、src/content  →  src/core  →  src/shared
```

**ESLint 的 `no-restricted-imports` 规则照旧生效**，`core` 依然不许依赖 `platform`，`shared` 依然不许依赖上层。WXT 只改变了入口位置，没有改变分层逻辑。

### 3. 双 world 的声明成本从"自己做"降到"写一行"

原设计需要在 manifest 里手写两个 `content_scripts` 条目，各带 `world` 字段，还要确保构建产物路径对得上、`document_start` 和 `document_idle` 分开配。

WXT 里就是两个文件、各一行 `world`。

**这不是偷懒，是把精力留给真正需要手工做的事**：DNR 并发、WBI 签名、白名单维护。

## 被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| 保留自定结构，关掉 WXT 的自动注入，手写 manifest | 等于只用 WXT 的打包功能，放弃它 80% 的价值 |
| 换 CRXJS + Vite，manifest 手写 | CRXJS 对 content script 的 HMR 支持弱，且维护节奏不稳 |
| 零框架 esbuild | HMR 全要自己写，改 popup 一行要手动刷新 |

## 后果

### 收益

- 双 world 注入、manifest 生成、HMR、多浏览器产物全部由框架处理
- 新增一个 `entrypoints/xxx` 就自动出现在 manifest 里，不需要同步两处
- 产物目录 `.output/chrome-mv3/` 开箱即用，直接可加载

### 代价

- **学习成本**：需要理解 WXT 的 `defineContentScript` / `defineBackground` 包装器，以及 `.wxt/` 生成目录的作用（**不要手动改 `.wxt/`，它每次构建都会重建**）
- **抽象泄漏风险**：出问题时需要读 WXT 源码定位，而不是直接看自己写的 manifest
- **版本耦合**：WXT 大版本升级可能带来 breaking change，需要跟着改
- **别名双写**：路径别名要同时写在 `wxt.config.ts` 的 `vite.resolve.alias` 和根 `tsconfig.json` 的 `paths`（IDE 用），不一致时以 `wxt.config.ts` 为准

### 对既有文档的影响

- `04-project-structure.md` 升到 v1.1，目录树重画
- `02-ui-spec.md` 中提到的 `ui/design/tokens.css` 路径改为 `src/design/tokens.css`
- ADR 中涉及 UI 路径的地方同步更新

## 相关

- 目录结构：`docs/04-project-structure.md` §1、§2
- WXT 的双 world 写法与 `platform/http/dnr.ts` 的关系：`docs/04-project-structure.md` §5
- 被本 ADR 修正的选型讨论：`docs/04-project-structure.md` §〇

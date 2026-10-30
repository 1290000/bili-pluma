# AGENTS-TOOLS.md —— 脚本与工具清单（**唯一权威位置**）

> 本文件回答一个问题：**「我要做 X，该跑哪个命令？」**
> 规则本体在 [AGENTS.md](./AGENTS.md)；这里只做「场景 → 命令」的索引，**不复述规则**。
>
> ⚠️ **为什么单独成文件**：2026-10-30 发现 `reload-extension.mjs`（能自动重载扩展）
> 在 `AGENTS.md` 里**一次都没被提到**，只躺在 `docs/guides/browser-skill-setup.md` 里，
> 结果**团队里没人记得它存在**，每次都手工去点「重新加载」。
> 根因不是文档太长，是**清单不完整**。所以本文件的存在意义是：**让每个工具都有且只有一个登记处。**
>
> 完整性由 `scripts/check-tools.mjs` 强制：仓库里每个 `scripts/`、`poc/` 下的可执行脚本
> 都必须在本文件出现，否则 `verify` 变红。

---

## 0. 最常用的五条（先看这里）

| 我要… | 命令 | 需要登录态 | 副作用 |
| --- | --- | --- | --- |
| 跑全部检查 | `node scripts/verify.mjs` | ❌ | 无 |
| 只改文档后快查 | `node scripts/verify.mjs --fast` | ❌ | 无 |
| **改了 `src/` 后重载扩展** | `node poc/probe/reload-extension.mjs --no-build` | ❌ | ⚠️ **会关掉并重启浏览器** |
| 读扩展状态 / 拨总开关 | 见 [bsk-page-bridges.md](./docs/guides/bsk-page-bridges.md) | ✅ | 需 bsk daemon |
| 抓真实播放轨道 | `node poc/probe/probe-logged-in.mjs` | ✅ | 无 |

> ⚠️ `reload-extension.mjs` 会**强制结束 Edge 再重启**（`Preferences` 只有退出后才能改）。
> 有未提交的表单 / 正在上传的东西时**不要跑**。重载可能换扩展 ID，
> 脚本会自动搬运 `Local Extension Settings/<id>/`，但**跑完要确认凭据还在**。

---

## 1. 检查类（`scripts/`，全部不需要登录态）

| 命令 | 查什么 | 何时必须跑 |
| --- | --- | --- |
| `node scripts/verify.mjs` | **全部 13 项** | 任何改动交付前（`--help` 看清单） |
| `node scripts/verify.mjs --fast` | 只跑文档与静态项 | 只改 `docs/**`、`*.md` |
| `node scripts/check-messages.mjs` | 消息类型白名单（**漏处理不会编译报错**） | 改 `src/shared/types/messages.ts` |
| `node scripts/check-patch-scope.mjs` | 四类响应体改写的授权与常量对账 | 改 `main-world.js` 的改写常量 |
| `node scripts/check-boundaries.ts` | 依赖方向（抓动态绕过） | 改 `core/`、`shared/` |
| `node scripts/check-page-gate.mjs` | 「这是不是播放页」判据只走 `parsePlayPage()` | 改 popup / `tabs.handler.ts` / `page-state-client.ts` |
| `node scripts/check-secrets.mjs` | 测试账号标识与凭据 | 提交前（pre-commit 自动跑） |
| `node scripts/check-artifact.mjs` | 产物与源码一致性 | 改 `package.mjs` 或发版 |
| `node scripts/check-docs.mjs` | 文档死链 / 篇幅上限 / 章节连号 / 换行符 | 改任何 `docs/**`（`verify --fast` 已含） |
| `node scripts/check-workflow-logs.mjs` | CI 日志泄露（只抓 `set -x` / `printenv` 这类必泄露写法） | 改 `.github/workflows/**`，**仍须人工过每个打印点**（§4.3） |
| `node scripts/check-design-imports.mjs` | `core`/`shared` 不许引用 `@design/*` | 改视觉令牌或 `tokens.css` |
| `node scripts/check-tools.mjs` | **本文件自身的完整性**（每个脚本都要有登记处） | 新增/删除任何 `scripts/`、`poc/` 脚本 |
| `node scripts/check-adr-refs.mjs` | 代码注释里的 ADR 编号必须真实存在 | 新增 ADR、改 ADR 编号、或大量改注释 |
| `node scripts/check-doc-sections.mjs` | 文档里「AGENTS.md §N」的章节与**条目**引用必须真实存在 | 改 `AGENTS.md` 的章节结构、或改文档里的跨章引用 |
| `node scripts/loc.mjs` | **行数统一口径**（见 §5） | 想知道文件多长时 |

---

## 2. 真机验证类（`poc/verify/`，多数不需要登录态）

| 命令 | 查什么 | 何时必须跑 |
| --- | --- | --- |
| `node poc/verify/run-q2-auto.cjs` | **DNR 并发安全**（约 3 分钟） | **改 `src/platform/http/dnr.ts` 必跑** |
| `node poc/verify/dnr-disable-clears-tab-rules.cjs` | 关开关后两类规则清零（约 15 秒） | **改 `dnr.ts` 必跑（与上一条一起）** |
| `node poc/verify/dnr-updatesessionrules-atomicity.cjs` | `updateSessionRules` 组合形式原子性 | 改 DNR 规则写法 |
| `node poc/verify/dnr-atomicity-sampler-selftest.cjs` | 上一项的采样器可信性自检 | 同上 |
| `node poc/verify/run-p0.cjs` | P0 阶段基线 | 追溯历史用 |
| `node poc/verify/check-urlfilter.cjs` | `urlFilter` 写法 | 改规则条件 |

> **两个 DNR 脚本必须一起跑**（`AGENTS.md` §4.3）——它们测的是不同东西，缺一不可。

---

## 3. 真机探针（`poc/probe/`，需要登录态 / bsk）

| 命令 | 用途 |
| --- | --- |
| `node poc/probe/reload-extension.mjs --build\|--no-build\|--dry-run` | **重载扩展**（改了 `src/` 之后）。先 `--dry-run` 看计划 |
| `node poc/probe/probe-logged-in.mjs` | 用日常 profile 抓真实轨道 |
| `node poc/probe/verify-pgc-by-snapshot.mjs <session-id>` | **判播放完整性**（passive read，跨 bsk 版本可用） |
| `node poc/probe/probe-pgcpatched-timing.mjs <sid> <ep>` | `pgcPatched` 的到达时机（ADR 0030 前提验证） |
| `node poc/probe/probe-pgc-guard-paths.mjs <sid> <tab> <ep>` | 刷新护栏四条路径回归 |
| `node poc/probe/probe-pgc-path1-strict.mjs <sid> <ep>` | 只构造 `still-truncated` 裁决轮（路径 1 严格版） |
| `node poc/probe/probe-pgc-layer2-chain.mjs <sid> <tab> <ep>` | 第二层清缓存 → 第三层的完整链路 |
| `node poc/probe/read-diag.cjs` | 读产品自己写的 `pluma:diag` 日志 |
| `node poc/probe/popup-inspect.mjs` | 读 popup 状态 |
| `node poc/probe/setup-profile.mjs` | 准备测试用 profile |

> ⚠️ **读页面状态必须用 `async IIFE` + 内部 `await` 再 stringify**。
> 直接 stringify 一个 Promise 会得到 `{}`，而 `bsk evaluate` **exit 0** ——看起来完全"成功"。
> 踩过的坑：[bsk-page-bridges.md](./docs/guides/bsk-page-bridges.md)。

---

## 4. bsk（browser-skill）专用

| 事项 | 位置 |
| --- | --- |
| 本机配置、**版本锁 0.3.3（不要升 0.4.x）**、能力边界 | [browser-skill-setup.md](./docs/guides/browser-skill-setup.md) |
| 读扩展状态 / 拨总开关（页面桥用法） | [bsk-page-bridges.md](./docs/guides/bsk-page-bridges.md) |

**每次调用都必须先设环境变量**：

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;" + $env:PATH
```

- daemon 用 `run_in_background` 起，**不要起第二个**（会撞 `daemon.lock`；进程名不叫 bsk，`Get-Process *bsk*` 看不到）
- 活动 home 是 `~/.bsk`，不是 `.bsk-agent`
- `bsk doctor` / `bsk status` 会一直提示「可升级 0.4.0」—— **忽略它，别跑 `bsk update`**
- ⚠️ **本机没有 bash / Git Bash**（只有 PowerShell 5.1）。所以一切命令都写成 PowerShell 语法。
  `export PATH=...`、`/c/Users/...` 这类写法在这台机器上**跑不了** —— 2026-10-30 实测确认。

---

## 5. 环境与口径（踩过的坑，别重踩）

| 坑 | 正确做法 |
| --- | --- |
| **`node` 不在 PATH** | 每条 pwsh 先加 `$env:PATH = "C:\Users\i1290\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:PATH` |
| **`npx` 不可用** | 用 `node node_modules/vitest/vitest.mjs run` / `node node_modules/typescript/bin/tsc` |
| **`Get-Content` 数行数少读**（PS 5.1，`main-world.js` 报 2963 / 真值 3804） | 统一用 `node scripts/loc.mjs` |
| **`Get-Content` 读中文乱码**（`閲嶆柊鍔犺浇`） | 读文件用 read 工具；**绝不用 `Get-Content` + `Set-Content` 回写**（会真写坏中文） |
| **PowerShell 内联 Node 脚本的引号转义反复失败** | 写成独立 `.mjs` 文件再 `node` 执行 |
| **临时文件被 lint/prettier 扫到** | 放 `.tmp/`（已在 ignores 里），不要放 `.tmp-xxx/` |

---

## 6. 未登记的工具？

`verify` 里的 `check-tools` 会拦住它。**新增脚本必须同时更新本文件**——
这正是 2026-10-30 那次遗漏（`reload-extension.mjs` 没人知道）的防复发机制。

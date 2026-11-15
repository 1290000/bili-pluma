# `poc/probe/` 目录盘点与去留建议（2026-11-11）

> **只给建议，不执行。** 由 Lead 转交用户决定。
>
> 现状：`poc/probe/` 下 **10 个子目录 + 23 个根文件**，全部**未跟踪**（`git ls-files` = 0）。
> 合计约 **1.1 MB**、**185 个文件**。

---

## 一、判断分级的依据

一个探针该不该留，看三件事：

| 判据 | 含义 |
| --- | --- |
| **① 被 `AGENTS-TOOLS.md` 引用** | 是"工具清单里的正式工具"，删了会留死链（`check-docs` 会报） |
| **② 被 ADR / 其他文档引用** | 是**历史证据**，ADR 是不可改的,删了 ADR 会死链 |
| **③ 还会不会被再跑** | 一次性取证 vs 长期回归 |

**三项至少占一条 → 建议保留。三项全无 → 可删。**

---

## 二、主表

### 2.1 子目录（10 个）

| 目录 | 文件数 | 大小 | 主文档 | 被引用 | **建议** | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `verify-report/` | 8 | 85 KB | `REPORT.md` | ❓ | **保留** | 终验报告 + `FINAL.md` + `PRE-AUDIT.md`，是本轮交付的证据链 |
| `api-inventory/` | 27 | 133 KB | `RESULT.md` | ✅ **ADR 0035** | **保留** | ADR 0035（推荐流白名单）的唯一取证来源 |
| `dnr-initiator/` | 16 | 70 KB | `RESULT.md` | ✅ **ADR 0035** | **保留** | DNR 能力边界（`initiatorDomains` / `tabIds` / 5000 上限）的唯一实测记录 |
| `ui-impact/` | 5 | 109 KB | `IMPACT.md` 等 | ✅ **ADR 0035** | **保留** | 界面影响面盘点（96 项），是步骤 6 的施工依据 |
| `history-entry/` | 10 | 52 KB | `RESULT.md` | ✅ **ADR 0035** | **保留** | 历史按钮「DOM 通、数据死」的实测依据 |
| `feed-boundary/` | 5 | 23 KB | `RESULT.md` | ✅ **ADR 0035** | **保留**（附注） | **分界线功能已整体移除**，但 ADR 0035 仍引用它作为"批大小 sd=0"的证据 |
| `feed-boundary-anchor/` | 1 | 13 KB | `RESULT.md` | ❌ | **建议删** | 1 个文件、无外部引用；分界线功能已移除，它测的东西不存在了 |
| `feed-cover/` | **85** | **417 KB** | `RESULT.md` | ❌ | **建议删（最大头）** | **占全部体积的 38%**。85 个文件里大概率是截图/HTML 快照。功能已移除、无引用 |
| `realdevice/` | 1 | 11 KB | ❌ 无主文档 | ❌ | **看内容再定** | 只有 1 个文件且没有 `REPORT.md`/`RESULT.md`，需人工看一眼 |
| `search-identity/` | 2 | 9 KB | `REPORT.md` | ✅ `AGENTS-TOOLS` | **保留** | 本轮 search 取证。通用工具 `bsk-eval.mjs` **已挪到 `poc/probe/` 根目录**（见 §3） |

### 2.2 根目录文件（23 个）

| 文件 | 大小 | 引用 | **建议** | 理由 |
| --- | --- | --- | --- | --- |
| `reload-extension.mjs` | 17.8 KB | ✅ TOOLS + ADR | **保留** | 改 `src/` 后必用的重载工具 |
| `verify-pgc-by-snapshot.mjs` | 6.3 KB | ✅ TOOLS + ADR | **保留** | 判播放完整性，长期回归 |
| `probe-pgc-guard-paths.mjs` | 36.3 KB | ✅ TOOLS + ADR | **保留** | 刷新护栏四条路径回归 |
| `probe-pgc-layer2-chain.mjs` | 33.2 KB | ✅ TOOLS + ADR | **保留** | 第二层→第三层链路 |
| `probe-pgcpatched-timing.mjs` | 28.1 KB | ✅ TOOLS + ADR | **保留** | ADR 0030 前提验证 |
| `probe-pgc-path1-strict.mjs` | 15.7 KB | ✅ TOOLS | **保留** | 路径 1 严格版 |
| `probe-streaming-status.mjs` | 3.8 KB | ✅ TOOLS | **保留** | 测 background SW 消息通道 |
| `popup-inspect.mjs` | 9.3 KB | ✅ TOOLS | **保留** | 读 popup 状态 |
| `probe-logged-in.mjs` | 3.4 KB | ✅ TOOLS | **保留** | 抓真实轨道 |
| `read-diag.cjs` | 2.1 KB | ✅ TOOLS | **保留** | 读诊断日志 |
| `setup-profile.mjs` | 2.3 KB | ✅ TOOLS | **保留** | 准备测试 profile |
| `probe-badge.mjs` | 3.3 KB | ❌ | **看内容** | 角标相关，可能仍有用 |
| `probe-cdp.mjs` | 3.1 KB | ❌ | **建议删** | **CDP 走不通是已定结论**（AGENTS.md §1.5：CDP 拿不到登录态），保留一个 CDP 探针会误导人 |
| `probe-edge.mjs` | 4.7 KB | ❌ | **建议删** | 同上（Edge 启动探针，已被 `reload-extension.mjs` 取代） |
| `run-all.sh` | 1 KB | ❌ | **看内容** | 若是批量跑上述工具的入口 → 保留；否则删 |
| `probe-pgc-timing.cjs` | 4.7 KB | ✅ ADR 0019 | **保留（附注）** | ADR 引用，但可能已被 `.mjs` 版取代 |
| `probe-pgc-is-preview.cjs` | 4.1 KB | ✅ ADR 0021 | **保留（附注）** | 同上 |
| `probe-pgc-full-cfg.cjs` / `.js` | 2 + 4.2 KB | ❌ | **建议删（2 个）** | 同名 `.cjs`/`.js` 两份，无引用 |
| `probe-pgc-prefetch-inplace.cjs` | 6.4 KB | ❌ | **建议删** | PGC 预取原地替换，已被 ADR 0020 的缓存路线取代 |
| `probe-pgc-takeover.cjs` | 5.7 KB | ❌ | **建议删** | ADR 0019 的 hook 回调路线**已被 ADR 0020 推翻**，代码留着会误导 |
| `result-pgc-prefetch-inplace.json` | 0.8 KB | ❌ | **建议删** | 一次性结果文件 |

---

## 三、汇总建议

| 类别 | 文件数 | 体积 | 处置 |
| --- | --- | --- | --- |
| **必须保留**（被 TOOLS / ADR 引用） | 约 60 | 约 400 KB | 保持 |
| **建议删**（无引用 + 功能已移除 / 已推翻） | 约 105 | **约 520 KB** | `feed-cover/`(85) + `feed-boundary-anchor/`(1) + 根目录 19 个 |
| **需人工看内容再定** | 约 20 | 约 30 KB | `realdevice/`、`probe-badge.mjs`、`run-all.sh`、`probe-pgc-timing.cjs`、`probe-pgc-is-preview.cjs` |

### 如果只做一件事

**删 `feed-cover/`（85 个文件 / 417 KB）** —— 它占了三分之一体积，
且它服务的**分界线功能已整体移除**（`.feed-card` 内嵌 `.bili-feed-card`，隐藏会连 B 一起删）。

### ⚠️ 三个不能删的理由（提醒）

1. **ADR 引用了 `api-inventory` / `dnr-initiator` / `ui-impact` / `history-entry` / `feed-boundary` 的 `RESULT.md`**
   —— ADR 是不可改的历史记录，删了会死链（`check-docs` 会报）。
2. **`AGENTS-TOOLS.md` 引用了 12 个脚本**
   —— 删了 `check-tools` / `check-docs` 会报"工具清单里的脚本不存在"。
3. **`bsk-eval.mjs` 是刚推广的通用工具**
   —— 它现在位于 `poc/probe/` **根目录**（原在 `search-identity/`），是所有 `bsk evaluate` 的标准入口。

### 一个结构性调整（**已执行**）

**通用工具已从 `search-identity/` 挪到 `poc/probe/` 根目录**：

```
poc/probe/search-identity/ev.mjs  →  poc/probe/bsk-eval.mjs
```

理由：它是通用工具，不是搜索取证专用。`AGENTS-TOOLS.md` 与 `search-identity/REPORT.md` 的引用已同步。

---

## 四、最终处置（Lead 裁决，2026-11-11）

> **全部保留，不删。**

**理由**：1.1 MB / 185 个文件是**本轮所有实测证据的唯一载体**。
今天有**三次结论被推翻**，全靠这些探针数据 —— 删了下一次同一问题要重测。
ADR 引用 5 个、`AGENTS-TOOLS.md` 引用 12 个，删错一个就是死链或 `check-tools` 报错。
**1.1 MB 不是空间问题。**

本文保留作为**盘点记录**（记下每个目录是干什么的），**不执行任何删除**。

---

## 五、`check-tools` 与 `check-docs` 的**数据源不一致**（2026-11-11 真实踩坑）

**这是判据，不只是记录。** 它解释过一次被误归因的红。

### 两条检查看的东西不同

| 检查 | 数据源 | 问的问题 |
| --- | --- | --- |
| `check-tools`（`verify` 的 `tools` 项） | **磁盘存在性** | "`poc/probe/` 下有这个脚本吗？它在 `AGENTS-TOOLS.md` 里登记了吗？" |
| `check-docs`（`verify` 的 `docs` 项） | **`git ls-files`**（git 索引） | "`AGENTS-TOOLS.md` 里写的脚本名，仓库里真有这个文件吗？" |

`check-docs.mjs:616` 原文：

```js
execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
```

它自己的注释（`:283-287`）写了理由：

> 以 git 索引为准，等于"文档只许引用仓库里真有的东西"。
> `existsSync` 会把"本地有、仓库没有"（比如 `.output/`、本地备份）当成存在，掩盖真问题。

### 所以对**未跟踪的新脚本**，两条检查会给出**互相矛盾**的结论

真实经过（2026-11-11）：

```
[check-tools] ❌ 1 个脚本没有在 AGENTS-TOOLS.md 登记：probe-streaming-status.mjs
[docs]        ❌ AGENTS-TOOLS.md 里 1 处脚本名找不到对应文件：probe-streaming-status.mjs
```

**同一时刻，一个说"没登记"，一个说"登记了但文件不存在"。**

当时的解释是"并行改动期间的采样中间态"。**那个解释看起来合理，但是错的。**
真因是：**两个检查的数据源不同** —— 脚本在磁盘上存在（`check-tools` 看得见），
但不在 git 索引里（`check-docs` 看不见）。

### 判据

> **遇到 `tools` 与 `docs` 对同一个脚本给出矛盾结论时，先查 `git ls-files` 的跟踪状态，
> 不要归因到"采样中间态 / 并行编辑"。**

```bash
git ls-files poc/probe/<脚本名>     # 空 = 未跟踪 → 就是它
```

### 推论：新脚本要 `git add`

> **新加到 `poc/probe/` 且被 `AGENTS-TOOLS.md` 引用的脚本，必须 `git add`，否则 `docs` 会红。**

本次实例：`bsk-eval.mjs` 从 `search-identity/`（未跟踪目录）挪到 `poc/probe/` 根目录后，
`docs` 立刻报"找不到" —— 因为根目录的**老脚本已跟踪**、它是**新未跟踪文件**。
`git add poc/probe/bsk-eval.mjs` 后 `docs` 恢复绿。

### 一个容易被这个机制掩盖的坑

`poc/probe/` 的跟踪状态是**混合**的：

| 位置 | 跟踪状态 |
| --- | --- |
| `poc/probe/*.mjs`（**根目录**的直接子文件） | ✅ 大多已跟踪 |
| `poc/probe/<子目录>/` | ❌ 未跟踪 |

**所以在"根目录"和"子目录"之间挪文件，会改变它的 git 可见性** —— 而文件内容一个字节没变。
**同一次 `cp`/`mv` 可能同时改变"检查结果"和"它是否被检查"。**


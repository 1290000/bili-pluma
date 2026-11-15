# 二次验收报告 · 2026-11-12 · task-12 / 13 / 14 / 15

> **验收者**：verifier（**只审不写**；本目录之外未修改任何文件，6 个源码 SHA 与基线逐字节一致）
> **环境**：Edge 157 + bsk 0.3.3，session `dgrx`
> **工作区**：静默（最后一次写 04:00:10，开验 04:07）
> **基线**：`node scripts/verify.mjs` → **21 项全绿**（`logs/round2-verify.txt`）

---

## 0. 结论总表

| 卡 | Lead 的结论 | 我的独立结论 | 依据 |
| --- | --- | --- | --- |
| **task-12** | 只改注释，零逻辑改动 | ✅ **一致** | 剥注释后两文件 **IDENTICAL**；删除的 7 行全是注释 |
| **task-13** | 三处修完 | ✅ **一致（核心判据通过）** | 恒真用例已删；变异后 `:59-71` **确实变红** |
| **task-14** | 本卡不成立，只补注释 | ✅ **一致（我独立复现）** | 干净环境诊断页 **0 处「读取失败」**，日志 30 条 |
| **task-15** | 本卡不成立，零改动 | ✅ **一致（我做了对照实验）** | Prettier 确实忽略 `.tmp/`；`.prettierignore` 未改 |

**四张卡的结论全部成立。没有发现需要退回的改动。**

---

## 1. 开验前的两项方法学准备

### 1.1 工具先自验证（上一轮的教训）

**`strip-comments-diff.mjs`** —— 剥注释逐行比对器（字符级状态机，按 Lead 要求**不用正则**）。

| 对照 | 结果 |
| --- | --- |
| 阳性：两份只差注释的文件 | `IDENTICAL` exit=0 |
| 阴性：同一份差一个字符 | `DIFFERENT` exit=1，打印差异行 |
| 特殊：字符串 `"含 /* 的不是注释"` | 未被误判为注释起点 ✅ |

**`check-incognito-window.ps1`** —— 窗口存在性探针（已在上一轮做过双向验证）：
阳性 1 / 阴性 0 / 旧坏判据恒 0。

> **纪律**：先证明探针能看到"存在"，再用它判"不存在"。

### 1.2 干净起点（本轮的必修前置）

上一轮我判错的直接成因是**在孤儿 content script 上观测**。本轮严格按：
**reload → 刷新页面 → 桥往返自检 → 才开观测**。

Lead 建议用两条不依赖业务状态的判据，实测结果：

| 判据 | 结果 |
| --- | --- |
| `chrome.runtime` 可从页面上下文读到 | ⚠️ **不可用**（主世界没有 `chrome`，实测 `Cannot read properties of undefined`） |
| `proxy/status` 往返成功 | ✅ 可用（走项目 sanctioned 桥，返回 `{"bridge":"OK","proxy":{...}}`） |

⇒ **建议以后就用「桥往返成功」这一条**，`chrome.runtime.id` 在页面主世界读不到。

---

## 2. task-12 · `assumed` 判定路径（零逻辑改动）

### 2.1 代码确实没变 ✅

```
src/background/login-window.ts : 85 非空代码行 vs 85  ->  IDENTICAL
entrypoints/background.ts      : 281 非空代码行 vs 281 -> IDENTICAL
```

`git diff` 删除的行共 **7 条，全部是 `//` 注释**（"情况 3：返回 undefined…"那一整段说明被改写成新注释）。
**没有删除任何一行可执行代码。**

### 2.2 注释声称的统计：我复现了一条 ✅（附限制）

干净环境下点一次「扫码登录取流账号」，当场采集（`evidence/S12-login-open-log.txt`）：

```
04:13:04  isAllowedIncognitoAccess        true
04:13:05  windows.create returned         id=undefined incognito=undefined windowsBefore=1 windowsAfter=1 loginTabs=0
04:13:05  create 返回 undefined 且窗口数未变，交给握手判定
04:13:05  login/open                      {"ok":true,"reason":"assumed"}
04:13:05  create 返回 undefined 但权限正常 → 按已创建处理
```

同时用修好的探针查 OS 层窗口：

```
INCOGNITO_COUNT=1
  hwnd=4524346 size=420x600 title=登录播放账号 - [InPrivate]
PROCESS_MAINTITLE_COUNT=1
```

⇒ **关键事实：`reason:'assumed'` 时，窗口其实是真的开出来的**（这一次）。
形状与注释描述完全一致（`id` 未返回、窗口数未变、`loginTabs=0`）。

**⚠️ 如实标注限制**：我只复现了 **1 次**，不是注释说的"4/4 次"。
**原始 LevelDB 日志我没有逐条统计** —— 诊断环形缓冲只有 30 条，早被覆盖。
所以我确认的是「**该现象真实存在、形状与注释一致**」，**不是**「4 次全部如此」这个计数本身。

### 2.3 结论

✅ **task-12 成立**：零逻辑改动属实；注释描述的 `assumed` 现象真实存在，
且这次 `assumed` 是**猜对了**（窗口确实存在）。这与「把 `assumed` 直接改 false 会误弹说明页」
的判断一致 —— 所以**不改逻辑、只补注释**是正确处理。

---

## 3. task-13 · 三处修完

### 3.1 恒真用例已删除 ✅

- `feed-account-effective-state.test.ts` 中 `★★ 不再出现「勾着 + 灰」的自相矛盾组合` → **ABSENT**
- `saysPleaseLogin` 只剩注释里的一句说明（`L97`），**无代码残留**
- 全量测试：**1785 条**（上一轮 1786 → 减 1，正好是被删的那条）

### 3.2 ★ 核心判据：真守卫仍在且真的会红 ✅

变异 `tabs.ts` 的 `checked` 改回 `actions.feedAccountEnabled`（重新引入 task-5 修的 bug）：

```
× ★★★ 真机那个矛盾态：feedAccountEnabled:true + hasCredential:false     <- 红了
✓ ★★ 同时仍然禁用（判据不改）
✓ ★★ 下方那句提示已删除
✓ ★★ 有凭据 + 开着 / 关着
✓ ★ 有凭据时不渲染「先扫码登录」
× ★★ displayTab 的类型里根本没有 StreamingIdentity 这个入口
Tests  2 failed | 5 passed (7)
```

**判据全部满足**：
- `:59-71` **确实变红** → 保护还在 ✅
- 文件跑 **7 条**，不是 0 条 → 没删过头 ✅
- 还原后 SHA 与基线**逐字节一致**（`57E16C33…`），且全绿 ✅

### 3.3 另两项 ✅

| 项 | 结果 |
| --- | --- |
| 文案数字 134 → 103 | ✅ `need-incognito-copy.test.ts:19,26` 现为 `103`，`143` 保留 |
| `dnr.ts` #3 组合态注释 | ✅ 新增整段「合法但危险的组合态」注释，含"装规则前必须重新校验凭据"的规定 |

`dnr.ts` 的 diff：**新增全为注释 + task-10 既有的 `clearAllRules()` 函数体**，
**删除行为空**（没有删任何代码）。

### 3.4 Lead 特别要求：`tabs.ts` 有无 engineer-tests 的变异残留 ✅

`git diff --stat src/content/panel/tabs.ts` = `260 insertions(+), 36 deletions(-)`，
属 task-5/8/11 的既有改动；关键字扫描（`TODO-verifier`/`TEMP`/`临时变异`/`XXX`/冲突标记）**零命中**。
**没有残留。**

---

## 4. task-14 · 「本卡不成立」—— 我独立复现确认

### 4.1 干净环境取证 ✅

（严格按 §1.2 建立：reload → 刷新 → 桥往返成功 → 才开观测）

诊断页读数：

| 项 | 干净环境实测 | 上一轮（孤儿态） |
| --- | --- | --- |
| InPrivate 权限 | **已允许** | 读取失败（background 未返回这一项） |
| 可见窗口数 | **1** | 读取失败 |
| 可见 cookie 分区 | **0** | 读取失败 |
| manifest incognito | **split** | 读取失败 |
| 诊断日志 | **最近 30 条** | 最近 0 条 / "还没有日志。" |
| 全文「读取失败」出现次数 | **0** | 多处 |
| `Extension context invalidated` | **0** | 有 |

### 4.2 代码层：逐项降级确实存在 ✅

`src/background/handlers/diag.handler.ts:356-380`：

```ts
// 四项**全部**读失败才回 `:err`
if (incognitoAllowed === null && windows === null &&
    cookieStores === null && dnrRuleIds === null) { ... :err ... }
return finish({ type: 'diag/facts:ok', facts: {...} });
```

`src/platform/diagnostics/collect.ts` 剥注释后与 HEAD **IDENTICAL（290 行）**，**删除行 0 条** —— 纯注释改动。

### 4.3 结论

✅ **task-14「本卡不成立」判定成立，我独立确认。**

上一轮我报的"诊断页整片读取失败"**确系 content script 孤儿态**（我自己 reload 后未刷新所致），
**不是产品缺陷**。我为此开的那条待修 #5 **不成立**。

> 这一条我要对自己记一笔：**是我上一轮的错误观测催生了这张卡**。
> 现在按 Lead 的授权，我的取证直接支持关闭它。

---

## 5. task-15 · 「本卡不成立、零改动」—— 我做了对照实验

Lead 说被 engineer-tests 推翻（Prettier 3 默认读 `.gitignore`），并邀请我复核。

**同一份坏格式文件，只改位置**：

| 对照 | 命令 | 结果 |
| --- | --- | --- |
| A：放在 `.tmp/verifier-prettier-probe/bad.ts` | `prettier --check` | `All matched files use Prettier code style!` **exit=0** ← 被忽略 |
| B：同内容，放仓库根 `verifier-prettier-control.ts` | `prettier --check` | `[warn] Code style issues found` **exit=1** ← 判据有效 |

环境：prettier **3.9.10**（`package.json` `^3.9.10`）；`.gitignore` **L74** 含 `.tmp/`。

⇒ **两个条件都成立**：Prettier 能发现这份坏格式（B），而它在 `.tmp/` 下被忽略（A）。
**「Prettier 读 .gitignore，`.tmp/` 本就被忽略」成立**。
`.prettierignore` 未修改，`git diff` 为空**是正确结果**。

**探针文件已清理**，`git status` 无残留。

---

## 6. 收尾核验

| 项 | 结果 |
| --- | --- |
| `node scripts/verify.mjs`（开验基线） | ✅ 21 项全绿 |
| 全量单测（变异还原后） | ✅ **108 文件 / 1785 条全绿** |
| 6 个关键文件 SHA vs 基线 | ✅ **全部逐字节一致**（`logs/round2-baseline-sha.txt` 对照） |
| `.verabak` 残留 | ✅ 无 |
| 源码改动数 | 16 个 M（**全部属于各张卡**，我只新增了 `verify-report-2026-11-12/`） |
| InPrivate 权限 | ✅ 仍为「已允许」（未改动） |
| 无痕窗口 | ✅ 已关闭，`INCOGNITO_COUNT=0` |
| 探针/临时文件 | ✅ 无残留 |

---

## 7. 证据索引

| 文件 | 对应结论 |
| --- | --- |
| `evidence/S12-verdict.txt` | task-12 完整取证（零逻辑改动 + `assumed` 统计复现 + 限制说明） |
| `evidence/S12-login-open-log.txt` | `login/open` 真实应答原文（`reason:"assumed"` + `windows.create returned` 行） |
| `evidence/S14-verdict.txt` | task-14 结论与判据（干净环境三项可读 + 逐项降级代码复核） |
| `evidence/S14-clean-diag.txt` | 干净环境诊断页语义树全文 |
| `evidence/S15-verdict.txt` | task-15 对照实验（`.tmp/` 被忽略 vs 根目录被警告） |
| `evidence/probe-validation.txt` | 窗口探针双向验证（阳性 1 / 阴性 0 / 旧判据恒 0） |
| `logs/round2-baseline-sha.txt` | 开验时 8 个关键文件的 SHA 基线 |
| `logs/round2-verify.txt` | `node scripts/verify.mjs` 原文（21 项全绿） |
| `tools/strip-comments-diff.mjs` | 剥注释逐行比对器（状态机，非正则） |
| `tools/check-incognito-window.ps1` | 窗口存在性探针（已双向验证） |

---

## 8. 一句话总结

**四张卡全部成立，无退回项。**

- **task-12**：零逻辑改动属实（剥注释 IDENTICAL，删的 7 行全注释）；注释描述的 `assumed` 现象我实测复现了 1 次，且那次 `assumed` 是**猜对的**。
- **task-13**：恒真用例已删，**真守卫在变异下确实变红**，还原逐字节干净；另两项到位。
- **task-14**：干净环境下诊断页**零「读取失败」、日志 30 条**，逐项降级代码本就在 → **本卡不成立成立**（且这张卡本是我上一轮的错误观测催生的）。
- **task-15**：对照实验证明 **Prettier 确实忽略 `.tmp/`** → **零改动是正确结果**。

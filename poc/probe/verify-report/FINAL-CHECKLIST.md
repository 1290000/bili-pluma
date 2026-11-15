# 终验清单 · 1.2.0 步骤 1–5（修复完成后一次性核对）

> 用途：所有成员报完成后，**拿这一份从头点一遍**，不重新探索。
> 基线 `main` = `9d18154`。生成时间 2026-11-11 02:27。
> ⚠️ **执行前置：工作区必须静默 ≥10 分钟**（见 `METHODOLOGY.md` 规则 3）。

---

## 第 0 步 · 前置检查（不静默就别开始）

```powershell
# 必须为空，否则说明还有人在改
Get-ChildItem -Recurse -Include *.ts,*.tsx -Path src,entrypoints,tests |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) }
```

- [ ] 上表为空，或所有成员已报完成

---

## 第 1 步 · 4 条 🔴 终验（**当前全部已关闭**，此处复核"没被回退"）

### 🔴-1 `run-q2-auto` 真跑过

```powershell
Get-Content .tmp/dnr-regression-stamp.json
```

- [ ] `scripts` 里有 **两个** 键：`dnr-disable-clears-tab-rules` + `run-q2-auto`
- [ ] 两者 `fingerprint` 都 = 当前 `dnr.ts` 的指纹
- [ ] `run-q2-auto` 的 `passed ≥ 1` 且 `skipped = 0`
- [ ] `node scripts/verify.mjs` 中 `dnr-regression` 为 ✅

### 🔴-2 `resolveBoundaryIdentity` 吃 `streamingIdentity`

```powershell
Select-String -Path src/content/feed-boundary/feed-boundary.ts -Pattern "streamingIdentity === 'page'|streamingIdentity: StreamingIdentity"
```

- [ ] `streamingIdentity: StreamingIdentity` 是**必填**入参（不是 `?`）
- [ ] `if (streamingIdentity === 'page') return 'page-identity';` **存在于 mid 比较之前**
- [ ] `probeIdentity()`（`content-feed-boundary.content.ts`）真的**读了** `readStreamingIdentity()` 并传入
- [ ] `feed-boundary.test.ts` 有 `'page'` 模式用例，且**反向删判据会变红**（我已实测：4 条红）

### 🔴-3 类型断链全部派生

```powershell
Select-String -Path src/shared/types/messages.ts -Pattern "export type ProxyActivateReason"
```

- [ ] `messages.ts` 导出具名 `ProxyActivateReason`
- [ ] `playinfo.ts` 的 `proxyIdentity` = `ProxyActivateReason | 'unknown'`（无手抄）
- [ ] `content.ts` 的 `reason?:` = `ProxyActivateReason`（无手抄）
- [ ] `page-snapshot.ts` / `page-state.ts` 无手抄
- [ ] **`'same-account'` 在 `src/`+`entrypoints/` 除注释外零残留**
- [ ] `page-state-same-identity.test.ts` 里"两个值都命中"的断言已删（TODO 要求）

### 🔴-4 用户可见「播放账号」归零（**7 处**）

```powershell
$all = Get-ChildItem -Recurse -Include *.ts,*.tsx -Path src,entrypoints | Select-String -Pattern "播放账号"
Write-Output "总命中: $($all.Count)"                                    # 统计用总数，别截断
$all | Where-Object { $_.Line -notmatch '^\s*(/\*|\*|//)' }             # 再筛
```

| # | 位置 | 期望 |
| --- | --- | --- |
| 4.1 | `badge-content.ts` 角标详情 | ✅ 已改为 `STREAMING_IDENTITY_PREFIX = '取流身份：取流账号'` |
| 4.2 | 同上（×2 处复用） | ✅ 同上 |
| 4.3 | `summary-view.ts` `PGC_ANCHOR` | ✅ `'取流账号提供'` |
| 4.4 | `collect.ts` 诊断行 label | ✅ `'取流账号（页面 playurl 响应）'` |
| 4.5 | `collect.ts` 凭据行 | ✅ `'取流账号凭据'` |
| 4.6 | — | （已含在上面） |
| **4.7** | **`login-window/main.tsx:178`** | ✅ **`登录取流账号`**（**我初验漏掉的第 7 处**） |

- [ ] 过滤注释后**仅剩 0 处**，或剩余处经 `grep '\.xxx\b'` 证明**零消费方**
  （当前唯一候选 `routes.ts:136` 的 `note` 字段：`grep '\.note\b'` = 0 处 → 非用户可见）

---

## 第 2 步 · 3 条 🟡 终验

| # | 项 | 期望 | 状态 |
| --- | --- | --- | --- |
| 🟡-1 | `README.md:20` 的「解锁」 | ✅ **已改为候选 A**：`仅提供取流，**按该账号的会员权益**取得 4K / … 画质` | 完成 |
| 🟡-2 | `tabs.ts` 注释残留 | 改为「取流账号」；**特别** `:553` 注释与 `:562` 代码已不符 | **待步骤 6 完成** |
| 🟡-3 | `TODO(1.2.0-step2-merge)` | 清理条件已满足 → 随 🔴-3 一并清 | 完成 |

**🟡-1 的额外判据（Lead 特别要求）**：改完后 **README:20 与 README:30 必须逻辑连贯**：

```
20: | **取流账号**（大会员） | … | 仅提供取流，**按该账号的会员权益**取得 4K / 1080P60 / HDR / 杜比 / Hi-Res 画质 |
30: - ❌ **不解锁你没有的权益**：4K / 1080P60 来自你登录的大会员账号，没有大会员就没有这些画质；
```

- [ ] 20 行说"靠**这个号的权益**"，30 行说"**没有的权益不会解锁**" → 一个讲来源、一个讲边界，**不矛盾**
- [ ] `README.md` 全文「解锁」只剩 **2 处**，都是**否定句**（`:28` 不解锁地区限制 / `:30` 不解锁你没有的权益）

---

## 第 3 步 · 深挖 A：三处判据说同一件事

**同一用户、同一时刻**，逐格核对（这是本轮唯一的"跨模块语义一致性"检查）：

| 场景 | `page.handler.ts` | `page-state.ts` | `feed-boundary.ts` | 一致？ |
| --- | --- | --- | --- | --- |
| ① `extension` + mid 不等 | `ok` | 基线可用 | `ok` → **显示分界线** | ✅ 应一致 |
| ② `extension` + mid 相等 | `self` | `same-identity`（基线不可用） | `self` → 不显示 | ✅ 应一致 |
| ③ **`page`** + mid 不等 | `page-identity` | **？** | `page-identity` → **不显示**（已修） | ⚠️ **需确认 page-state 那格** |
| ④ **`page`** + mid 相等 | `page-identity` | **？** | `page-identity` → 不显示 | ⚠️ 同上 |
| ⑤ 游客（`pageMid=null`） | `ok`（继续代理） | 不产出 | `unknown` → 不显示 | **刻意不一致** |

- [ ] ③④ 的 `page-state.ts` 那格已明确（`page-identity` 落在"什么都不改"还是产出 `same-identity`？）
- [ ] ⑤ 的刻意不一致在**三处注释里互相指认**（否则下一个人会来"修复"它）

### ✅ ③④ 已确认（2026-11-11 02:30 核查）

**`page-state.ts` 对 `page-identity` 的处理是"刻意什么都不改"**：

| 证据 | 内容 |
| --- | --- |
| `page-state.ts:87` | `SAME_IDENTITY_REASONS = ['self']` —— **只有 `'self'`**，`page-identity` 不在内 |
| `page-state.ts:166` | 输入域表格：`'page-identity'` → 同一身份？**❌ 否**。理由："是**用户的决定**，不是'两个号相同'这个事实" |
| `page-state.ts:247` | "`page-identity` 同理不改判 —— 用户选了用浏览器账号，但那不等于'两个号相同'" |
| `popup-state.ts:213-219` | 与面板对齐："`self` = 事实 / `page-identity` = 选择"，两个界面说同一件事 |

**判定：三处判据语义自洽**，③④ 的 `page-state` 那格答案是"不改判（保持原基线判定）"，
而不是"产出 `same-identity`" —— 这个区分是对的（拿"用户的决定"冒充"两个号相同"就是错归因）。

### ⚠️ 但发现一个**新的理论缺口**（③④ 的下游）

在 `page` 模式下，`content.ts:1841`：

```ts
const proxyEnabled = !(res.activated === false && res.reason === 'disabled');
// page-identity 时：activated=false, reason='page-identity'
// → proxyEnabled = true   ← 实测确认
```

**主世界会认为"扩展在工作"**（`tellMainWorld(true, false)`），于是仍可能改写 `__playinfo__`
（`main-world.js` 的 `cfgEnabled` 门控放行）。

但此时 **DNR 一条规则都没装**（`page-identity` 分支不装规则），取流走的是页面自身身份。

**后果链**：`__playinfo__` 被改写 → `primaryReason = 'client-written'` →
`summary-view.ts:265` 显示「**主账号基线不可用（数据来源是取流账号）**」

**而真相是**：用户主动选了"用页面账号取流"，此时**根本不存在"取流账号"这个第二身份**，
也没有基线不可用这回事。

> **这是"界面陈述错误事实"** —— 与本轮 🔴-2 同一类，只是发生在播放页而非首页。
>
> **但性质不同**：🔴-2 是"该判的没判"（缺维度），这个是"判了但下游有人不认"（`proxyEnabled` 的语义没跟上）。

**需要确认**：
- [ ] `page` 模式下 `__playinfo__` **是否真会被改写**（需真机或读 `main-world.js` 的 `pgcPatchPlayinfo` 门控）
- [ ] 若会 → `summary-view` 需要一个 `page-identity` 的归因分支，或 `primaryReason` 需要一个对应值
- [ ] 若不会 → 记录为什么不会，避免下次有人以为它是 bug

**⚠️ 我未能定论**：`main-world.js` 是裸 JS，`tsc`/单测都管不到它（AGENTS.md §4.3 要真机日志），
静态读码只能读到门控在哪儿，读不出运行时实际走哪条。**这条需要 Lead 决定是派真机还是记为已知项。**

> ⚠️ **③④ 是本清单里唯一可能仍有问题的格子**——`page-state.ts` 的 `ProxyActivateReason`
> 现在是否含 `'page-identity'`、`SAME_IDENTITY_REASONS` 是否含它，需逐行确认。

---

## 第 4 步 · 深挖 B：结构性缺口（写进方案文档，不是修完就算）

`tsc` **无法保护**的 6 类（已由 `messages.ts` 记录）：

| # | 缺口 | 本轮现状 |
| --- | --- | --- |
| B1 | 内联字面量断言 `as { reason?: ... }` | ✅ 已改为派生 |
| B2 | `as Type` 断言 | 需人工复查 |
| B3 | `String(reason)` / 模板拼接 | 需人工复查 |
| B4 | `JSON.parse() as {...}` | 需人工复查 |
| B5 | 跨 world `postMessage`（`main-world.js` 裸 JS） | **不受 `tsc` 管辖** |
| B6 | `Record<string, ...>` 宽容器 | ✅ `collect.ts` 的 `REASON_TEXT` 是封闭键（会报错） |

```powershell
Select-String -Path entrypoints/content.ts -Pattern "as \{"   # 期望 0 处新增
```

- [ ] 无新增内联断言
- [ ] **6 类缺口已写进方案文档作为「已知缺口」**（Lead 要求，不可省）

---

## 第 5 步 · 全量与回归（**必须工作区静默后**）

```powershell
node scripts/verify.mjs
node poc/verify/run-q2-auto.cjs
node poc/verify/dnr-disable-clears-tab-rules.cjs
```

- [ ] 全量 verify **全绿**（当前项数 21）
- [ ] 全量 vitest 文件数 = **磁盘 `.test.ts` 数**（`assertTestTotals` 不报）
  ⚠️ 若报「磁盘 86 / 实报 85」→ **先确认工作区静默**，再重跑；静默下仍复现才是真竞态
- [ ] 测试总数 ≥ **1501**（基线）
- [ ] 人工逐条审 `git diff` 的**所有字符串改动**（`verify` 对文案零兜底）

---

## 第 6 步 · `--fast` 使用纪律（归档用）

见 `FAST-BLINDSPOTS.md`，四条规则：

- [ ] 规则 A：改动任何被 `describeXxx` 消费的枚举值 → **必须全量**
- [ ] 规则 B：改动任何用户可见字符串 → **必须人工审 diff**
- [ ] 规则 C：给函数新增输入维度 → **必须补"新维度导致行为变化"的测试**
- [ ] 规则 D：`dnr.ts` 有改动 → **先跑两个 DNR 脚本，再跑 verify**

---

## 第 7 步 · 归档（步骤 7）

- [ ] `methodology.md` 并入 `METHODOLOGY.md` 的 7 条规则
- [ ] `poc/probe/` 下 6 个目录去留由用户决定
- [ ] `CHANGELOG.md` / `README.md` 首屏 / `docs/03` §0 状态表更新
- [ ] ADR 0006 补说明（**不改结论**）

---

## 附：本轮已关闭项汇总

| 项 | 状态 | 关闭证据 |
| --- | --- | --- |
| 🔴-1 `run-q2-auto` 未跑 | ✅ 关闭 | stamp 两脚本齐全，`passed:1` |
| 🔴-2 分界线在 `page` 模式撒谎 | ✅ 关闭 | 判据在 mid 比较前；**反向删判据 → 4 条测试变红** |
| 🔴-3 类型断链 4 处 | ✅ 关闭 | 全部派生 + 具名类型；`tsc` 绿 |
| 🔴-4 改名遗漏 | ✅ 关闭（**7 处**） | 用户可见残留归零；`note` 字段经 `grep` 证明零消费方 |
| 🟡-1 README「解锁」 | ✅ 关闭 | 改候选 A，与 :30 逻辑连贯 |
| 🟡-3 TODO 清理 | ✅ 关闭 | `same-account` 零残留 |
| 🟡-2 `tabs.ts` 注释 | ⏳ 待步骤 6 | 用户不可见，最低优先级 |
| ⚠️ 深挖 A ③④ | ⚠️ **待确认** | `page-state.ts` 对 `page-identity` 的处理 |

---

## 附：我（verifier）碰过的文件 —— 供 Lead 核对

| 文件 | 改了什么 | 性质 |
| --- | --- | --- |
| `entrypoints/login-window/main.tsx:178` | `登录播放账号` → `登录取流账号` | **获批的正式修复** |
| `README.md:20` | 改候选 A | **获批的正式修复** |
| `src/content/feed-boundary/feed-boundary.ts` | 变异测试（`if (false && …)`）+ 恢复 + prettier | 已恢复，37/37 测试通过 |
| `src/content/isolated/page-state.ts` | 变异测试（`SAME_IDENTITY_REASONS` / `ProxyActivateReason`）+ 恢复 | 已恢复 |
| `poc/probe/verify-report/*.md` | 新建 4 份报告 | 新建 |

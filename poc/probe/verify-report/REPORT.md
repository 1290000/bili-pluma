# 独立验证报告 · 1.2.0 账号职责可配置（步骤 1–5）

> 验证者：**verifier**（独立验证方，未实现任何功能，未修任何 bug）
> 基线 `main` = `9d18154` · 验证时工作区：**27 个修改 + 12 个新增文件**
> 方案：[docs/plans/1.2.0-account-roles-plan.md](../../../docs/plans/1.2.0-account-roles-plan.md)
> 日期：2026-11-11
>
> **结论先行：不能交付。** 1 条交付阻断项（DNR 回归未跑全）+ 2 条会骗用户的语义缺口 + 1 条改名遗漏。

---

## 0. 验证方法

| 手法 | 覆盖 |
| --- | --- |
| 全量 `node scripts/verify.mjs` | 17/17 项（1 项红） |
| 全量 vitest | **85 files / 1501 tests 全绿** |
| **变异测试 ×3**（改判据 → 断言变红 → 恢复 → 校验哈希） | 验证"反向验证"声称的真实性 |
| 逐行读 `git diff` 的用户可见字符串 | 文案（**唯一防线**，`verify` 零兜底） |
| 手动扫边界绕过写法 | `check-boundaries` 绿不等于对 |

**工作区安全性**：反向验证前存 `git diff` 到 `.verify-backup.patch`，
三次变异后逐次恢复，最终 `git diff` 的 **SHA256 与备份完全一致**
（`855E5427…9715F`）。**全程未用 `git stash` / `reset --hard` / `clean -fd`。**

---

## 1. 🔴 必须修（4 条）

### 🔴-1 交付阻断：`dnr.ts` 改了 310 行，但两个 DNR 回归脚本只跑了一个

```
[dnr-regression] ❌ src/platform/http/dnr.ts 有未提交改动，但 DNR 回归没跑全
  还缺这些脚本的凭据：
    - run-q2-auto  （约 3 分钟）
```

`dnr.ts` 改动量 **+310 / −40**，是项目里风险最高、**且无法用 Vitest 测**的文件（AGENTS.md §5.4）。
`.tmp/dnr-regression-stamp.json` 里只有 `dnr-disable-clears-tab-rules`（pass 6 / skip 1），
**`run-q2-auto.cjs` 从未跑过**。

**为什么这比报错严重**：AGENTS.md §4.3 的原话是「DNR 规则写错的后果是『画质静默异常，而 popup 上一切正常』——能骗过用户的 bug，比报错严重」。

**修法**：跑 `node poc/verify/run-q2-auto.cjs`（不需要登录态，约 3 分钟），重跑 verify 直到 17/17。

---

### 🔴-2 `resolveBoundaryIdentity()` **完全不读 `streamingIdentity`** → 用户选了"页面账号取流"，分界线照样显示

**位置**：`src/content/feed-boundary/feed-boundary.ts:199-215`、`entrypoints/content-feed-boundary.content.ts:94-115`

**函数签名里根本没有这个参数**：

```ts
export function resolveBoundaryIdentity(input: {
  proxyEnabled: boolean;
  hasCredential: boolean;
  credentialMid: number | null;
  pageMid: number | null;
}): BoundaryIdentity
```

`probeIdentity()` 只发 `proxy/status` + `account/summary` 两条消息，**从不读 `readStreamingIdentity()`**。

**具体场景**（这是本轮最可能出真 bug 的地方）：

| 用户配置 | 页面 mid | 取流账号 mid | 实际行为 | `resolveBoundaryIdentity` 输出 | 后果 |
| --- | --- | --- | --- | --- | --- |
| **选了「页面账号取流」** | 111 | 222 | **不代理**（`page` 模式） | `'ok'`（111 ≠ 222） | **显示分界线，说"以下推荐来自取流账号"—— 假的** |
| 选了「页面账号取流」 | 111 | 111 | 不代理 | `'self'` | 不显示（碰巧对，但理由是错的） |

`page.handler.ts:107-111` 在播放页已经正确处理了这件事（`!needsProxy(...)` → `reason: 'page-identity'`），
**首页这条路径漏了同一条判据**。

**为什么测试没抓到**：`tests/unit/content/feed-boundary.test.ts` 有 8 个 `resolveBoundaryIdentity` 用例，
**输入全是 4 个字段，没有一条带 `streamingIdentity`**——因为函数签名里就没有它。测试覆盖得很密，但**维度缺失**。

**修法**：加 `streamingIdentity` 入参，`page` 模式直接返回 `'self'` 语义（或新增 `'page-identity'` 值），
`probeIdentity()` 里补读 `readStreamingIdentity()`。补对应单测（`page` + mid 不等 → 不显示）。

---

### 🔴-3 `lastActivateReason` 的类型契约**三处不一致**，`'page-identity'` 在其中两处不存在

| 位置 | 有 `'page-identity'` 吗 |
| --- | --- |
| `src/shared/types/messages.ts:177`（真相源） | ✅ 有 |
| `src/core/ui/popup-state.ts:49-50`（`PopupSnapshot`） | ✅ 有 |
| **`src/core/ui/page-snapshot.ts:83-92`** | ❌ **没有** |
| **`src/shared/types/playinfo.ts:302-303`**（`proxyIdentity`） | ❌ **没有** |
| **`src/content/isolated/page-state.ts:38-51`**（`ProxyActivateReason`） | ❌ **没有** |
| **`entrypoints/content.ts:1761`**（内联字面量联合） | ❌ **没有** |

**`entrypoints/content.ts:1761` 是最严重的一处**：它对 background 回包做了**内联字面量断言**：

```ts
} as {
  type?: string;
  activated?: boolean;
  reason?: 'ok' | 'not-configured' | 'self' | 'disabled' | 'error';  // ← 缺 page-identity
} | null;
```

`page.handler.ts:110` 返回的 `'page-identity'` 在这里被断言成一个不包含它的类型，然后原样传给
`pageState.setProxyIdentity()`（`:1809`）。**这个值一路流过去没人拦**。

**类型系统为什么没报警**：`page-state.ts:51` 的联合里没有 `'page-identity'`，
所以 `res.reason` 的静态类型也不含它——**两边一起错，正好互相抵消**。

**已验证这条是真实的类型断裂**（变异测试）：只把 `'page-identity'` 加进 `ProxyActivateReason`，
`tsc` **立刻报错**：

```
src/content/isolated/page-state.ts(384,7): error TS2322:
  Type 'ProxyIdentityInput' is not assignable to type
  '"unknown" | "ok" | "error" | "not-configured" | "self" | "same-account" | "disabled" | undefined'.
  Type '"page-identity"' is not assignable to type ...
```

**当前后果**：`page-snapshot.ts` 目前**没有调用方**（`grep buildPageSnapshot` 只找到定义），
所以这个 bug 是**潜伏的**，今天不会在真机上触发。但它是真实的契约断裂，一旦有人接上 `buildPageSnapshot`
（这是它存在的目的），popup 就会把 `page-identity` 静默吞成 `undefined` → 退回"已接管"→ **谎报**。

**修法**：把 `ProxyActivateReason` / `proxyIdentity` / `page-snapshot` 的内联联合 / `content.ts:1761`
全部改为从 `messages.ts` **派生**（`Extract<ResponseMsg, {type:'page/activate:ok'}>['reason']`）。
`page.handler.ts:44-47` 已经这么做了并写下了理由（"两个真相源"踩过坑），**三处没跟上**。

---

### 🔴-4 改名只做了一半：**6 处用户可见字符串仍是「播放账号」**

步骤 1 的目标是"仅用户可见字符串"，但这些**会渲染给用户看**的字符串漏了：

| 位置 | 现在的字符串 | 用户在哪看到 |
| --- | --- | --- |
| `src/content/isolated/badge-content.ts:251` | `取流身份：播放账号 ｜ 画面正在切换（上次 Xp）` | **页内角标详情** |
| `src/content/isolated/badge-content.ts:258` | `取流身份：播放账号。等待播放器开始加载视频…` | **页内角标详情** |
| `src/content/isolated/badge-content.ts:338` | `取流身份：播放账号 ｜ …` | **页内角标详情** |
| `src/core/playinfo/summary-view.ts:69` | `PGC_ANCHOR = '播放账号提供'` | **番剧页画面锚点** |
| `src/platform/diagnostics/collect.ts:172` | `label: '播放账号（页面 playurl 响应）'` | **诊断页** |
| `src/platform/diagnostics/collect.ts:456` | `put('播放账号凭据', …)` | **诊断页** |

另有 `src/background/handlers/proxy.handler.ts:125`（`'还没有配置播放账号'`）未确认是否渲染。

**对比**：`src/content/panel/tabs.ts` 的改名**改对了**（562 / 585 / 613 / 619 / 667 都是"取流账号"），
说明步骤 1 只覆盖了面板，**角标 / 番剧锚点 / 诊断页三处被漏掉**。

**为什么这是 🔴**：角标详情里写着"取流身份：**播放账号**"，而同一行前面已经是"取流身份"——
**一个问题两个名字**，用户会以为这是两样东西。而 `PGC_ANCHOR` 是番剧页画面上唯一的来源标注。

**修法**：这 6 处改词即可（语义不变，因为 D2/D3 已裁决写入恒归页面身份，"仅取流"仍是真的）。
⚠️ 改完**必须人工审 diff**——`verify` 对文案零兜底（已实测证明）。

---

## 2. 🟡 建议修（3 条）

### 🟡-1 `README.md` 有 Q10 禁用词「解锁」

`README.md:20`「仅提供取流，**解锁** 4K / 1080P60 / HDR / 杜比 / Hi-Res」

`docs/03-open-questions.md:261` Q10 原文：**「不是"画质解锁工具"」**，
`:267`「①"是助手不是解锁器"这条依然有效」。

**⚠️ 澄清**：这处"解锁"是**原有文案**，engineer-a 只改了前半截（`播放账号`→`取流账号`），
`解锁` 是继承下来的。**不是本轮引入**，但确实是既存违规，且本轮正好动了这一行。

**建议**：顺手改成「仅提供取流，可取得 4K / …」或「仅提供取流，画质上限 4K / …」。
另 `README.md:28` / `:30` 的「不解锁」是**否定句**，语义正确，不动。

---

### 🟡-2 `tabs.ts` 注释里大量残留旧名（不影响用户，但会误导下一个人）

`tabs.ts:338` / `418` / `429` / `443` / `449` / `492` / `553` / `566` / `595`
——全是注释里的"播放账号"，例如 `// ── B：播放账号 ──`（`:492`）。

**用户看不见**，但 `:553` 的表格里写「真的没配置 → 「还没有配置播放账号」」，
而实际渲染的是 `:562` 的「还没有配置取流账号」——**注释与代码已经不符**。

**建议**：一并改。成本低，防的是"下一个人按注释改代码改错"。

---

### 🟡-3 `TODO(1.2.0-step2-merge)` 清理项未执行

`src/content/isolated/page-state.ts:77` / `:83-84` 与 `src/core/ui/page-snapshot.ts:121-122` 写着：

> TODO(1.2.0-step2-merge): engineer-b 的 `'self'` 落地并全量验证后，删除 `'same-account'` 分支。
> ⚠️ 清理时必须**同时**删掉 `tests/unit/content/page-state-same-identity.test.ts` 里那条"两个值都命中"的断言

**`'self'` 已落地、全量 1501 测试已通过** → 清理条件已满足。
`'same-account'` 现在同时出现在 `page-state.ts:49`、`page-state.ts:90`、`page-snapshot.ts:87`、
`page-snapshot.ts:127`、`playinfo.ts:303` 五处，是**跨任务兼容的临时债**。

**建议**：这一轮清掉，否则会变成永久残留（本项目已踩过"名字从不存在却被引用"的坑，AGENTS.md §5.5）。

---

## 3. 🟢 已确认无问题（验了，没问题）

| # | 项 | 怎么验的 |
| --- | --- | --- |
| 1 | **全量单测 1501/1501、85 files 全绿**（基线 1391/79，增量合理） | `vitest run` |
| 2 | **变异测试 1**：`shouldShowBoundary` 改 `!== 'self'` → **4 条测试变红** | 注入 → 跑 → 恢复 → 哈希校验 |
| 3 | **变异测试 2**：`SAME_IDENTITY_REASONS` 删 `'self'` → **6 条测试变红** | 同上 |
| 4 | **`dnr-tab-merge.test.ts` 覆盖扎实**（21 用例）：3 tab→1 规则、50 tab→1 规则、摘除只摘自己、幂等、priority 2>1、只代理 GET | 逐条读 |
| 5 | `background.ts:293-298` 统计排除**正确**，`page-identity` 已在 `NOT_A_FAILURE` 集合内 | 逐行读 |
| 6 | `page.handler.ts:107-111` 的 `page-identity` 判据**顺序正确**（在 `disabled` 之后、mid 比对之前） | 逐行读 |
| 7 | `page.handler.ts:142-146` 的 `self` **走完整收尾路径**（`removeTabRule` + 上报），不再提前 return | 逐行读 |
| 8 | `collect.ts:161` `same-identity` **不设 `ok` 字段**（中性态），遮蔽 bug 已修 | 逐行读 |
| 9 | `routes.ts` 新增 `feed/rcmd`：修订号 3→4、note 写明实测依据、警告"别顺手加别的 feed 接口" | 读 diff |
| 10 | **ADR 0035 已建**并登记进 `docs/README.md:100`；`adr-refs` 289 处引用全有效 | 检查 + 跑脚本 |
| 11 | **`check-boundaries` 绿**，且手动扫 `(globalThis as any).chrome` / `window.chrome` 只命中一行**注释里的警示文字** | 脚本 + grep |
| 12 | `shared/constants/streaming-identity.ts` **零 chrome API**（纯类型 + 纯函数），存储实现在 `platform/` | 读 + grep |
| 13 | `feed-boundary` 的 `unknown` 三态判据（游客/摘要失败都不显示）**合乎"可能不能当断言"原则** | 读 + 测试 |
| 14 | `content-feed-boundary` 独立成入口（未污染 `content-home` 的 ADR 0031 边界） | 读文件头 |
| 15 | 分界线判据用「第 10 个 `.is-rcmd`」而非「有 BV 的第 N 张」 | 读 `feed-boundary-dom.ts` |

---

## 4. `--fast` vs 全量的差异（供步骤 7 归档参考）

- `--fast` 跳过 `vitest`，**这轮全部 4 条 🔴 里，🔴-2/🔴-3/🔴-4 它都抓不到**
  （分别是逻辑维度缺失、类型契约断裂、文案）——`--fast` 只能抓类型/格式/lint。
- **`--fast` 抓不到 `dnr-regression`**（那是独立检查项，但只在 `dnr.ts` 有改动时才红）。
- **本轮新增的 `feed-boundary` / `page-activate-self` 等 6 个测试文件，只在全量里跑**。

**结论**：本轮改动**必须跑全量**，`--fast` 完全不够。步骤 7 归档时建议在
`AGENTS.md` §4.3 明确"新增 content 入口 + dnr.ts 改动 = 全量 + 两个 DNR 脚本"。

---

## 5. 一句话总结

**不能交付。** 4 条 🔴 里有 1 条是硬门槛（`run-q2-auto` 没跑，`verify` 红），
2 条会在真机上骗用户（分界线在 `page` 模式下谎报来源、`page-identity` 类型断链），
1 条是改名遗漏（角标/番剧锚点/诊断页仍是"播放账号"）。

**修完这 4 条 + 跑通 `run-q2-auto` 后可以进入步骤 6/7。**

---

## 5.1 复验结果（2026-11-11 02:20，修复后）

> 修复由 engineer-a / engineer-b 完成。本节是**复验**，不是初验。

### 4 条 🔴 复验：**全部关闭** ✅

| # | 判据 | 结果 | 证据 |
| --- | --- | --- | --- |
| 🔴-1 | `run-q2-auto` 真跑过 | ✅ **通过** | `.tmp/dnr-regression-stamp.json` 两个脚本都在，`run-q2-auto` `passed:1 skipped:0`，fingerprint `fabcaa45…` 与当前 `dnr.ts` 匹配 |
| 🔴-2 | `resolveBoundaryIdentity` 吃 `streamingIdentity` | ✅ **通过** | `feed-boundary.ts:219` 必填入参；`:235` `if (streamingIdentity === 'page') return 'page-identity';` **在 mid 比较之前**，与 `page.handler.ts` 顺序一致 |
| 🔴-3 | 类型断链 4 处全部派生 | ✅ **通过** | `messages.ts:147` 导出 `ProxyActivateReason`；`playinfo.ts:308` → `ProxyActivateReason \| 'unknown'`；`content.ts:1776` → `reason?: ProxyActivateReason`；`page-snapshot.ts` / `page-state.ts` 无手抄 |
| 🔴-4 | 6 处用户可见改名 | ✅ **通过** | `badge-content.ts:26` 抽出 `STREAMING_IDENTITY_PREFIX = '取流身份：取流账号'`（还消除了重复）；`summary-view.ts:69` → `'取流账号提供'`；`collect.ts:172/456` 已改 |

### 🔴-2 的**反向验证**（我亲自做的）

我删掉 `feed-boundary.ts:235` 的判据（改成 `if (false && …)`）→ **4 条测试变红**：

```
× page 身份 + mid 不同 → page-identity，**不显示**
× page 身份 + mid **相同** → 也是 page-identity（用户意图优先于 self）
× page 身份 + 游客 → page-identity（仍不显示）
× 两种 streamingIdentity × 四场景的全矩阵：只有 extension+不同号 会显示
```

**结论：修复与测试都真实有效**，且第四条是"全矩阵"测试 —— 正是我在 `ACCEPTANCE.md` 规则 C 里要求的
"新维度必须测新维度的效果"。测试数 31 → **37**。

### `'same-account'` 旧名清理

✅ **已完成**。`src/` + `entrypoints/` 里除注释外**零残留**。
`page-state.ts:87` 现在是 `SAME_IDENTITY_REASONS: readonly ProxyIdentityInput[] = ['self'] as const;`

### 全量 verify 状态

**✅ 21/21 全绿**（38.5s）。全量 vitest **1501+ tests / 86 files**。

> ⚠️ **但首次运行时 `test` 项红过一次** —— `assertTestTotals` 报
> 「期望 **86** 个测试文件，vitest 只报了 **85** 个」。重跑即绿，
> 且我单独跑 `--reporter=json` 时 **86 个全部实报**。
> **判定：这是 `fileParallelism` 的偶发 worker 失败（该断言存在的意义就是抓它），
> 不是本轮改动引入的 bug。但它说明这条断言会偶发误红，重跑一次即可确认。**

---

## 5.2 复验中新发现（🔴-4 的**第 7 处**，我上次漏了）

**`entrypoints/login-window/main.tsx:178`**：

```tsx
<h1 class="title">登录播放账号</h1>
```

这是**登录窗口的大标题** —— 用户扫码时**必然会看到**。

**为什么我上次漏了**：我第一次扫的是 `*.ts,*.tsx,*.md`（`Get-ChildItem -Include`），
但 `Select-String` 的行过滤 `-notmatch '^\s*(\*|//)'` 对 JSX 不适用，且第一次的输出被
`Select-Object -First 20` 截断在第 20 行 —— **正是 handoff §2.1 记的"21 处实为 26 处，grep 输出被截断"同一类错误，我自己也犯了。**

**同时** `entrypoints/login-window/main.tsx:179` 的副标题：

```tsx
<p class="subtitle">主账号无需配置，自动沿用浏览器当前的登录状态</p>
```

**这句话在新模型下是否仍然成立？** 需要判断：如果用户把取流身份设成 `page`，那"主账号无需配置"是对的；
但如果设成 `extension`，用户就必须配置扩展账号 —— 而这句话在**登录窗口**里，上下文是"你正在配置扩展账号"，
所以**成立**。但措辞容易让用户以为"这个扩展什么都不用配"。**建议加限定语**（🟡 级）。

**其余两处 🟡 状态**：
- 🟡-1 `README.md:20` 的「解锁」**未改**（仍是原有文案）
- 🟡-2 `tabs.ts` 注释残留 —— 未逐条核（用户不可见，优先级最低）

---

## 5.3 修复质量评价

| 方面 | 评价 |
| --- | --- |
| 🔴-2 修复 | ✅ **优秀**。不仅加了入参，还把判据放在 mid 比较**之前**（与 `page.handler.ts` 顺序一致），并写了"反向验证：删掉它 → 哪条用例必须变红"的注释 |
| 🔴-3 修复 | ✅ **优秀**。提取具名类型 + 在注释里列出**6 类 `tsc` 结构性无法保护的写法**，这正是我深挖 B 第 3 问要的答案，且写得比我准备写的更全 |
| 🔴-4 修复 | ✅ **好**。抽出 `STREAMING_IDENTITY_PREFIX` 常量，从根上消除了"三处各写一份"的重复 |
| 🔴-1 | ✅ 真跑了脚本，不是"隔离副本验过" |
| 遗留 | ⚠️ 第 7 处（`login-window` 标题）+ README「解锁」未清 |

---

## 6. 我发现的 Lead 判断问题

1. **步骤 1 的任务卡低估了范围**：方案写"涉及 `tabs.ts`、`popup-state.ts`、`errors.ts:11`、`README.md`"，
   但实际用户可见字符串还分布在 `badge-content.ts`（×3）、`summary-view.ts`、`collect.ts`（×2）。
   **派工时给的文件清单不完整**——这和 handoff §2.1 记的"Lead 判断错 5 次"是同一类问题（清单靠印象而非实测）。
2. **P0-2 的语义冲突在方案里没有对应检查项**：方案 §3.4 只写了"`dnr.ts` 跑两个脚本"，
   但 `streamingIdentity` 这个新维度要贯穿 `page.handler` / `page-state` / `feed-boundary` **三处**，
   而方案只把它们当"各自独立的一步"，**没人负责交叉一致性**。这正是"写的人不能自己验"要防的结构性盲区。

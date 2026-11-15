# 单账号退化路径（取流号 = 记录号 = 浏览器登录态）可实现性评估

> 承接 [IMPACT.md](./IMPACT.md)。基线 `main` = `9d18154`。**只读，未改任何已跟踪文件。**
> 本轮回答 lead 的四个判据问题。凡"未测"的地方明确标注，不猜。

---

## 结论速览

| 问题 | 结论 |
| --- | --- |
| `same-account` 分支真实后果 | **不生效**（不是"用错身份生效"）：规则没装，角标被撤（`content.ts:1840-1846`），且每次打开视频页**多记一次假失败**（`background.ts:281-283`） |
| 代理关闭时覆写是否仍发生 | **会 / 情境相关**：页面加载时开关就关 → 页面可能干脆不发 playurl（`usable` 反而是 true，但那是**同一份数据**，属假的好消息）；先开代理再关 → `client-written` **粘住**到下次刷新。**"关掉代理即可"不成立** |
| `tipFor()` 遮蔽 | **属实**（`collect.ts:566-568` 在所有别的判据之前 return） |
| 画质对比处置 | **现有够用**：用已有的「无法对比」标题，但**需要新增一个 reason 值** `'same-identity'`；**不需要新界面状态、不需要新开关** |

---

## 1. `page.handler.ts:96-100` 的 `same-account`

### 1.1 它现在的真实语义

```ts
// src/background/handlers/page.handler.ts:96-100
if (payload.primaryMid !== null && payload.primaryMid === credential.dedeUserId) {
  await diag('page/activate', '两账号相同 → 拒绝代理');
  return { activated: false, reason: 'same-account' };
}
```

判据是**页面 cookie 里的 `DedeUserID` == 托管凭据的 `dedeUserId`**（`page.handler.ts:29` 的 `primaryMid` 由 content 从**普通分区** `document.cookie` 读出，见 `src/shared/utils/video-page.ts:152-159`）。

### 1.2 ⚠️ 更正我上一轮的断言

上一轮我写的是"**代理照做、规则不装**"，并把全局路径规则（10000 段）当成仍然会生效的东西。**这个断言在单账号场景下是错的**，本轮逐行核实后更正：

**`same-account` 分支 return 之后，已存在的标签页规则**不会被这个分支删，但**content 侧会把 `proxying` 置 false 并把角标撤掉**。链路是（全部逐行核实）：

| 步 | 位置 | 发生了什么 |
| --- | --- | --- |
| 1 | `page.handler.ts:99` | 直接 `return`，**没有** `installTabRule`，也**没有** `removeTabRule` |
| 2 | `entrypoints/content.ts:1756-1757` | `badgeState.proxying = res.activated === true` → `false` |
| 3 | `entrypoints/content.ts:1774-1776` | `proxyEnabled = !(activated===false && reason==='disabled')` → `true`；`tellMainWorld(true, false)` |
| 4 | `entrypoints/content.ts:1840-1846` | 失败分支：`badgeState.proxying = false`；`!hasEverActivated` → **`removeBadge()` 角标消失**，否则重画但不显示"已接管"（`badge-content.ts:214-217` 的 `!input.proxying → visible:false`） |
| 5 | `entrypoints/background.ts:281-283` | ⚠️ **`same-account` 不在排除列表里** → `recordStat(false)` **记一次失败** |

**关于规则本身**：`same-account` 时——除非页面此前曾命中 `entrypoints/content.ts:1810-1816` 的 `reason === 'disabled'` 清缓存——**规则没被任何代码删除**。但**它在单账号场景下是空操作**：全局路径规则（`enableProxy(cookie)`，`dnr.ts:150-166`）里写进去的 Cookie 与浏览器自己的 Cookie **字段值完全相同**（因为 mid 相同就是同一个号），`modifyHeaders` set 成同样的值是语义上的空操作；标签页规则同理（`dnr.ts:456-463`）。所以不存在"用错的身份在生效"。

> 我上一轮引用的 `page.handler.ts:109-112` 那段注释（"拒绝并不能真的不代理"）说的是**游客态**（`primaryMid === null`）分支，**不是** `same-account` 分支。我把两个分支的理由混在一起了，这是上一轮的推理错误。

### 1.3 所以单账号模式的真实后果是

**不生效 + 静默 + 误伤统计。** 不缺任何判据，缺三件事：

1. 不给用户任何反馈（`reason: 'same-account'` 在 **UI 层**零消费方：`entrypoints/content.ts` 只在 `:1774` 用它区分 `disabled`，其余走 `activated===false` 的通用失败分支；`tabs.ts` / `popup-state.ts` 完全不认它）；
2. 把它当成**错误**而不是**一等状态**；
3. ⚠️ **新发现**：`entrypoints/background.ts:281-283` 只排除 `'not-configured'` 和 `'disabled'`，**没排除 `'same-account'`** → 每次打开视频页都会 `recordStat(false)`，单账号用户的"取流成功率"条形图会**一路变红**，指向一个不存在的问题。这条与 `entrypoints/background.ts:276-280` 自己写的"两类不算失败否则统计会谎报"是同一个坑，只是漏了第三种。

### 1.4 这个分支应该变成什么

**同意 lead 的方向：变成一等状态 `identity: 'none'`（"不需要代理"），且必须走和成功一样的收尾路径**（删规则 → 不装 → 上报"无需代理"），而不是提前 `return`。

理由（这是本轮最重要的一条改动原则）：**"不装规则"和"不需要规则"在 DNR 层面是同一件事，在界面上是两件事**。今天代码把它们混成了前者，所以只能靠"提前 return"表达，副作用是规则状态无人清理、界面无话可说。

具体判据（不是建议，是判据）：

| 输入 | 应产出 | 理由 |
| --- | --- | --- |
| `credential` 为 null | `reason: 'not-configured'` | 不变 |
| `isProxyEnabled() === false` | `reason: 'disabled'` | 不变 |
| `primaryMid !== null && primaryMid === dedeUserId` | **`reason: 'self'`（新），并 `removeTabRule(tabId)`** | 代理是空操作，规则留着只是浪费重算 |
| `primaryMid === null` | `reason: 'ok'`（不变，继续代理） | `page.handler.ts:102-117` 的实测理由仍成立 |

⚠️ **但这条改完不会让单账号模式"能用"** —— 见 §2，真正的墙在覆写。

---

## 2. `page-state.ts` 的基线被覆写（本轮最关键）

### 2.1 覆写是什么、由什么触发

不是"主世界改写 SSR"，而是**三步因果链**：

| 步 | 位置 | 事实 |
| --- | --- | --- |
| ① | `src/content/main-world.js:1384` `playinfoHidden = enabled && !IS_PGC` | 代理**开着**时，主世界把 `__playinfo__` 的 getter 变成返回 `undefined`（`main-world.js:526-531`） |
| ② | 同上（`:1381-1382` 注释） | 藏它的**目的**就是"逼播放器发 playurl（好让 DNR 有请求可改）" |
| ③ | `main-world.js:546-551` | 播放器改从网络取到流后，**自己赋值** `window.__playinfo__`；setter 记 `ssrFirstSeen='set'` + `ssrPlayurlBefore = anyPlayurlSeen` |

然后 `src/content/isolated/page-state.ts:140` 判定：

```ts
const usable = payload.firstSeen !== 'none' && !payload.playurlBefore;
```

`firstSeen === 'set'` 且 `playurlBefore === true` → `usable = false` → `primaryReason = 'client-written'`（`page-state.ts:142-149`）。

### 2.2 代理关闭时，这个覆写还会不会发生

**会，但这正是单账号模式的常态，所以问题依然存在。** 分两个入口说清楚：

**入口 A：页面加载时开关就关着**（单账号模式的主路径）

- `enabled = false` → `playinfoHidden = false`（`main-world.js:1384`）→ `__playinfo__` 保持 SSR 原值，**播放器直接读它**。
- 但"直接读它"意味着**页面可能根本不发 playurl** —— 这正是 `main-world.js:1381` 注释里"藏它是为了逼播放器发 playurl"的镜像事实。
- 若页面不发 playurl：`anyPlayurlSeen` 保持 `false` → `playurlBefore = false` → `usable = true`，**基线判定反而是"可用"**。
- 而那唯一一份数据是**浏览器登录身份（= 单账号模式的取流身份）**的 —— 于是 `primary` 与 `playback` 是**同一份数据的两次计量**，`diffCapability` 会算出全 0 → 「无提升（源限制）」。**基线"可用"是假的好消息。**
- 若页面仍发 playurl（切 P / SPA 换页会发，见 `poc/verify/RESULT.md` §二：切 P 必发 1 次）：之后播放器覆写 → `playurlBefore = true` → `usable = false` → 「主账号基线不可用」。

**入口 B：先开代理打开页面，再关代理**（用户点开关 → `proxy.handler.ts:115-120` → `disableProxy()`）

- 关键事实：**页面的 `__playinfo__` 已经被覆写过了，`ssrFirstSeen` 已经定死为 `'set'`**（`main-world.js:547` 的 `if (ssrFirstSeen === 'none')` 只记第一次）。
- 关代理**不会**回滚 `ssrPlayinfo` / `ssrFirstSeen` / `anyPlayurlSeen` —— 主世界没有"关掉后重新读 SSR"的路径。
- `enabled` 变成 false → `playinfoHidden = false` → getter 恢复返回 `playinfoValue`（即被覆写后的客户端数据）。
- 所以 `PageState` 里的 `primaryReason` 停在 `'client-written'`，**关代理救不回来**，除非刷新页面（`setPageKey` 只在 pageKey/p 变化时清空，`page-state.ts:96-108`）。

### 2.3 对本轮的关键含义

> **"单账号模式 = 关掉代理即可"不成立。**

`enabled:false` 确实能让页面回到"不代理"，但：

1. 基线语义**仍然没有第二个身份可比** —— 两侧同一份数据（2.3 入口 A）；
2. 若用户是"先开着代理用了一阵再关"，`client-written` 会**粘住**到下次刷新（2.3 入口 B）；
3. 更根本的：`usable` 这个名字在单账号模式下**没有意义** —— 它回答的是"这份数据是不是一个**不同于取流身份**的基线"，而单账号模式下答案永远是"不是"。

**所以 §2 不需要新增数据通道，需要的是一个判据**：`PageState` 必须知道**本次页面会话里取流身份是否被代理过**（今天 `diffCapability` 的输入无法区分"同一身份"与"两个身份"）。最小可行判据：把 `page/activate` 的回包 reason 记进 `PageState`，据此产出 `primaryReason = 'same-identity'`。

⚠️ **这个回灌不是"改文案"，是新链路**，而且要解一个时序问题：`page/activate` 的回包顺序是 **credential → isProxyEnabled → same-account**（`page.handler.ts:64/86/97`），而 `page-state.ts:140` 的 `applySsr` 判定发生在 SsrPayload 到达时（`main-world.js:3599-3600`，`document_start` 之后不久）。两者谁先到**不确定**（`content.ts:1791` 记录过 `patchedAt: 358ms` vs `page/activate` 回包 ~400ms）→ 所以 `same-identity` 必须能**追认**已经判过的 `client-written`，不能只在判定那一刻读。

### 2.4 需要的实测（我只有只读权限，无法跑真机）

以下三条我只做静态读码，**必须 lead 派真机任务确认**：

| # | 待确认 | 怎么测 | 影响 |
| --- | --- | --- | --- |
| M1 | **代理关闭 + 普通视频页加载，页面到底发不发 playurl？** | 关总开关 → 打开全新视频页 → 读诊断「当前页取流数据」：`主账号基线` 行是 `SSR，可用` 还是 `⚠️ 客户端写入` | 决定 2.3 入口 A 走"可用但无意义"还是"不可用" —— **两种都要改，但改法不同**（前者要判"同一份数据"，后者要判"不需要基线"） |
| M2 | 关代理后不刷新，`primaryReason` 是否粘在 `client-written` | 开代理打开视频页 → 关总开关 → 关掉面板再打开，看诊断那行 | 决定"关代理"能否作为单账号开关的退路（我判断不能，需实测确认） |
| M3 | `same-account` 命中后，本页的 `DNR 标签页规则` 条数与角标是否消失 | 配一个与浏览器同号的凭据（临时造）→ 打开视频页 → 诊断看 `DNR 标签页规则`；同时看播放器右下角**有没有角标** | 确认 1.2 的"规则没被删但角标被撤"这条结论，因为它决定"用户会看到什么" |

---

## 3. `collect.ts` 的遮蔽

### 3.1 属实（行号）

```ts
// src/platform/diagnostics/collect.ts:559-568
export function tipFor(rows: readonly DiagRow[]): string {
  const proxyRow = rows.find(...'播放代理总开关');
  const pathRow  = rows.find(...'DNR 全局路径规则');
  const tabRow   = rows.find(...'DNR 标签页规则');
  const primaryRow = rows.find((r) => r.label.startsWith('主账号基线'));   // :564

  if (primaryRow && primaryRow.ok === false) {
    return '主账号基线不可用';                                              // :566-568  ← 第一个 return
  }
```

`主账号基线` 行由 `collect.ts:125-131` 产出，`ok: primary.usable`。单账号模式下 `usable` 为 `false`（§2）→ **这一句永远先返回**，后面的 `播放代理总开关`（`:578`）、DNR 路径规则（`:594/597`）、DNR 标签页规则（`:602/605`）**全部不可能被用户看到**。

⚠️ 有个额外发现：注释 `collect.ts:563` 写"主账号基线优先：它是 ADR 0014 的验证门"，但 `ADR 0014` 的验证门是**给开发者看诊断行**用的（ADR 0014 §验证门的观测点），**不是《tipFor 该先报哪条》的排序依据**。这条排序把"开发期验证门"泄漏成了"用户端最高优先级告警"。

### 3.2 最小修正

**不是一行谓词能解决的**，因为要区分的原因不是从 `DiagRow` 能推出来的。`DiagRow` 只有 `{label, value, ok}`，而 `value` 是拼好的中文串（`REASON_TEXT[...]`），**靠 `startsWith` 匹配中文是脆的**（这正是本项目反复踩的坑）。

两条路，我倾向后者：

| 方案 | 改动 | 风险 |
| --- | --- | --- |
| A. 一行谓词 | `if (primaryRow?.ok === false && !rows.some(r => r.label === '...'))` | 需要一个"单账号模式"的标记行，等于在 `DiagRow[]` 里塞隐式的跨行依赖，脆弱 |
| **B. 给 `DiagRow` 加可选 `severity`（或 `code`）字段** | `pageTracksRowsFrom` 产出时标 `code: 'baseline-unavailable'`；`tipFor` 判 `code` 而不是中文 label | 改公共类型，但**一次改对**；且顺手解决本项目"文案当判据"的通病 |

**无论哪条，`primaryRow.ok === false` 这一句都必须保留给"真的该报"的场景**（主账号未登录 / SSR 缺失），只是要**知道"基线不需要"不该报警**。这正是需要新增 reason 的地方（见 §4.3）。

---

## 4. 画质对比在单账号模式下的处置

### 4.1 `diffCapability()` 的输入在单账号模式下是什么

| 输入 | 值 | 依据 |
| --- | --- | --- |
| `primary`（基线） | **非 null**（若页面有 playurl 响应可达；见 §2.4 M1 的两种可能） | `page-state.ts:151-157` |
| `playback` | **非 null**，且与 `primary` **来自同一份数据** | 单账号模式下 DNR 不换身份（`same-account`），`applyPlayback`（`page-state.ts:161-169`）解析的就是页面自己的 playurl |
| `diff` | **非 null**，各项增益**全为 0** | `rank.ts:112-116` 全是作差；`qualityGained = primaryTop >= 0 && playbackTop > primaryTop`（`rank.ts:158`）两侧相等 → `false`；`improved`(166-172) 因此为 `false` |

⚠️ 前提是 §2.4 M1 的"页面发了 playurl"。若页面没发，`playback = null`（`page-state.ts:191` 的 `sawPlayback` 为 false）→ `diff = null` → 直接落到「无法对比」，**这种情况反而是对的**。

即：**不是 `null`，是"相同值"**。这一点很重要 —— 它决定了不必新加"关闭对比"开关。

### 4.2 六种标题里哪些已经够用

| 标题 | 触发（`summary-view.ts`） | 单账号模式下能否正确表达 |
| --- | --- | --- |
| `已解锁` | `view.diff?.improved`（`:337-339`） | ❌ 不会触发（`improved=false`），安全 |
| `未登录主账号` | `primary.loggedIn === 'no'`（`:349-351`） | ⚠️ 会误触（游客页），且措辞错（单账号下没有"主账号"） |
| **`无法对比`** | `!view.diff`（`:354-356`） | ✅ **语义正好**：它只说"没有对比数据"，不声称谁强谁弱 |
| `无提升（源限制）` | `same === true`（`:385-396`） | ❌ **会误触且陈述假事实**：两侧同一份数据必然 `same=true` → 说"源限制"，暗示"这个视频本来就是这样"，而真相是"你只有一个号，没什么可比的" |
| `没有提升` | `diff` 存在但 `improved=false` 且 `!same` | ❌ 不会触发（`same` 必为 true） |
| `等待取流…` | `!playback`（`:287-289`） | ✅ 无关，安全 |

**结论：现有「无法对比」这个状态在语义上正好够用**（"有数据但没有可比的第二方"），**不需要新增界面状态、不需要新开关**。

### 4.3 但需要新增的是一个 **reason 值**，不是状态

问题在于今天走不到「无法对比」—— `diff` 非 null，会落到 `same=true` 的「无提升（源限制）」。`same` 的判据（`summary-view.ts:385-389`）是"两侧能力相同"，它**无法区分**：

- 真的两侧能力相同（两个号画质一样）→ 「无提升（源限制）」**正确**
- 两侧是同一份数据（单账号）→ 说「源限制」**错误**

区分它们的唯一办法是让数据层说出来。所以：

**结论：必须新增 `PrimaryBaselineReason` 的一个值（建议 `'same-identity'`），界面状态用现有的「无法对比」。**

配套的三处改动（都很小）：

| 位置 | 改什么 |
| --- | --- |
| `src/shared/types/playinfo.ts:191-199` | `PrimaryBaselineReason` 加 `'same-identity'`（**类型是封闭联合，漏一处 `tsc` 会报**，这是本项目的既有保险） |
| `src/core/playinfo/summary-view.ts:231-240` | `switch (view.primary.reason)` 加一条，锚点返回「当前只有一个身份，无对比基线」 |
| `src/platform/diagnostics/collect.ts:36-41` | `REASON_TEXT` 是 `Record<PrimaryBaselineReason, string>` —— **不加会 `tsc` 报错**，加`'same-identity': '同一身份，无需基线'` |
| `src/core/playinfo/summary-view.ts:354-356` | 该 reason 下跳过 `diff` 分支，直接返回「无法对比」 |

⚠️ `summary-view.ts:231-240` 的 `switch (view.primary.reason)` **没有 default 分支**（我核对过：`ssr` / `client-written` / `absent` / `unparsable` 四条全覆盖），所以新增成员时 TS 会要求补全 —— 这是好事，别写成 `default`。同理 `collect.ts:36-41` 的 `REASON_TEXT` 是 `Record<PrimaryBaselineReason, string>`，也是封闭的。

---

## 5. 工作量与卡点汇总（回应 lead 的"改多少、卡在哪"）

### 5.1 能改的（界面 + 判据层，不含架构）

| # | 项 | 文件 | 规模 |
| --- | --- | --- | --- |
| 1 | `same-account` → 一等状态 `self`，并删规则 | `page.handler.ts:96-100`、`messages.ts:129` | 小 |
| 1b | **统计不要误记失败**（`same-account` 加进排除列表） | `entrypoints/background.ts:281-283` | 极小 |
| 2 | 界面消费该状态并说人话 | `popup-state.ts`、`tabs.ts` | 小 |
| 3 | `PrimaryBaselineReason` 加 `'same-identity'` | `playinfo.ts:191-199` + 3 处 switch | 小 |
| 4 | `tipFor()` 用 `code` 而不是中文 label 排序 | `collect.ts:559-568` + `DiagRow` 类型 | 中（改公共类型） |
| 5 | 单账号模式下不显示总开关/不显示对比锚点 | `tabs.ts`、`summary-view.ts`、`panel-data.ts` | 小 |

合计约 **6 个文件**，全部在 UI/判据层，**不动 DNR、不动 main-world、不动 ADR 0014 的数据通道**。

### 5.2 卡住的（需要 lead 决策或真机）

| 卡点 | 性质 |
| --- | --- |
| `PageState` 不知道"本次会话取流身份是否被代理过" | **数据层契约缺口**。§2.3 结论：这不是文案问题，是 `diffCapability` 的输入无法区分"同一身份"与"两个身份"。要补就必须让 `page/activate` 的结果回灌到 `PageState` —— 那是新链路，不是改文案 |
| M1 / M2 / M3 三条实测 | **需要真机**，我无权限（见 §2.4） |
| 单账号模式还要不要保留"代理总开关" | 产品决策。我倾向"保留但显示为不可用"，因为新模型里用户可能随时切回双账号 |
| 「任意账号记历史/评论/收藏」 | **与决策 4 冲突**，UI 层无解（上一轮已报，仍成立） |

---

## 6. 我这次更正了自己上一轮的哪个结论

| 上一轮说法 | 本轮核实 |
| --- | --- |
| "代理照做、规则不装、界面不知情" | **规则没被删，但也没装上**（`page.handler.ts:99` 直接 return）；"代理照做"在单账号下是 Cookie 完全相同的空操作 → **不生效，不是用错身份生效**。真实后果是：**角标消失**（`content.ts:1840-1846`）+ **一次假失败统计**（`background.ts:281-283`）+ **界面无解释** |
| "`same-account` 让单账号模式整个不工作" | 更准确：单账号模式**不需要代理**，所以"不装规则"本身是对的；真正的问题是**①规则状态无人清理 ②界面不报 ③基线语义失效 ④统计被误伤** |
| "单账号模式必须整块关掉对比" | 收敛为：**不需要关，用现有「无法对比」+ 新增一个 reason 值即可** |
| "关掉代理即可，问题只在 UI 误报" | **不成立**（这是 lead 本轮提出的假设，我核实后否掉）：入口 A 两侧同一份数据；入口 B `client-written` 会粘到下次刷新 |

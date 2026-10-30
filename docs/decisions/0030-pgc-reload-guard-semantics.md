# ADR 0030：PGC 刷新护栏的语义 —— 记「刷过几次」还是记「刷之后成了没有」

- 日期：2026-10-30
- 状态：**已采纳（方案 c）** —— 用户 2026-10-30 拍板。本文的「现状 / 问题 / 候选 a/b」保留为历史论证；落地规定见 §「已采纳的决定」。
- 涉及：[ADR 0020](./0020-pgc-sync-injection-and-reload.md)（护栏最初的三条硬护栏）、
  [ADR 0028](./0028-proxy-off-signal-for-pgc-injection.md)（第三层 `clearPgcReloadGuards()`，**将被本文取代**）、
  [ADR 0021](./0021-patch-pgc-preview-flags.md)（试看标记：玩家会在 361 秒处主动停）
- 风险登记：[docs/plans/1.1.0-plan.md](../plans/1.1.0-plan.md) 的 G3 行与 R1

---

## 已采纳的决定（2026-10-30，用户拍板）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 选 a / b / c | **c**（换判据：记「刷之后成了没有」，成功即清护栏） |
| 2 | 最坏两次闪屏（1~2 秒 × 2）可否接受 | **接受** —— 换取「不再静默卡 10 分钟」 |
| 3 | 是否删掉 ADR 0028 第三层 `clearPgcReloadGuards()` | 用户批准**删除**；**落地时验算推翻了该结论，改为保留** —— 见本文 §「对 ADR 0028 第三层的影响」的更正一节。理由：c 在本场景的 `outcome` 是 `still-truncated`（不清护栏），c 与第三层互补而非替代 |
| 4 | `MAX_RELOAD_ATTEMPTS` 定几 | **2** |
| 5 | `pgcPatchedByUs` 真机 trace | **要做**，落地前完成 |

**落地判据（本文的契约）**：

```
guardActionForOutcome(outcome: PgcRoundOutcome): 'clear' | 'keep' | 'retry'
```

| `outcome` | 护栏动作 | 理由 |
| --- | --- | --- |
| `injected` | `clear` | 刷了且成功，护栏无意义 |
| `native-complete` | `clear` | 本来就完整，无需拦 |
| `still-truncated` | `retry` | 刷了但没成 —— 这才是护栏该拦的 |
| `unknown` | `keep` | 判不了就不改变状态（既不清也不消耗） |

> ⚠️ **第 5 项是本方案的准入门槛**：若真机 trace 证明 `pgcPatchedByUs` 在本轮加载里
> **不可靠（晚到）**，则 c 的判定点不成立，按本文 §「推荐」的兜底条款退回 **b + 保留全部现有清除点**。
> 在 trace 结论出来之前，**不得**把 c 标成「已验证」。

---

## 现状：护栏数的是「次数」，而它想防的是「同一个原因反复刷」

`pgc-reload-plan.ts` 是这条链路唯一的护栏（`src/content/isolated/pgc-reload-plan.ts`）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `MAX_RELOAD_ATTEMPTS` | `1` | 同一 cid 在本次会话里**最多刷一次** |
| `GUARD_TTL_MS` | `10 * 60 * 1000` | 超过 10 分钟算「新的一次尝试」 |
| `GUARD_KEY_PREFIX` | `pluma:pgc-reload:` | 存在 `sessionStorage`（tab 级） |

判据是一个纯函数：`shouldReload({ alreadyTried, hasStream })`。`alreadyTried` 由
`isAlreadyTried(parseGuard(...), now)` 得出，即 `attempts >= 1 且 未过期`。
写护栏只有一个入口 `reloadWithGuard()`（`entrypoints/content.ts`），它在 **`location.reload()` 之前**写入。

关键事实：**`attempts` 永远只会是 `1`，没有任何代码读过刷新之后的结果再回写它。**
护栏记的是「我发起过一次刷新」，不是「那次刷新到底有没有让用户看到完整集」。

### 三个跨轮次入口都读同一个 `alreadyTried`

| 入口 | 位置 | `alreadyTried` 为真时的行为 |
| --- | --- | --- |
| 首访 / 无缓存取流前 | `entrypoints/content.ts` `orchestratePgc` | `return`，**连取流都不做** |
| 取流成功后要刷 | `entrypoints/content.ts` `prepareFullStream` | 缓存已写、`reloadIssued` 不增 |
| 画质补取 | `entrypoints/content.ts` `tryUpgradeForQuality` | 直接 `return false` |

**三条路互相锁死**：任何一个入口先把护栏写上，另外两个在本会话里一起失效。

---

## 问题：护栏的「假阳性」有多少

`MAX_RELOAD_ATTEMPTS = 1` 隐含一个假设：**刷过一次就应该好了**。下面每种情况都打破它，
而症状全部是同一个 —— **用户停在试看，无提示，最长 10 分钟**。

| # | 路径 | 为什么会误伤 | 现在靠什么兜 |
| --- | --- | --- | --- |
| 1 | 关总开关 → 清 `pluma:pgc-vi:` → 重开 → 刷新 | 缓存没了但 guard 还在 → 不取流 | **已修**：ADR 0028 第三层 `clearPgcReloadGuards()` |
| 2 | 手动 F5 | 跨轮次保留，guard 照样有效 | **无** |
| 3 | 切走再切回（SPA / 另一集再回来） | 同上 | **无** |
| 4 | TTL 未到就重开整个页面/浏览器 | 同上（`sessionStorage` 活到 tab 关闭） | **无** |
| 5 | 第一趟取流成功、写入缓存、也 `reload()` 了，但**第二趟注入失败**（主世界没跑到 setter / 缓存过期 / 播放器未采用） | guard 已写、结果是坏的 | **无** |
| 6 | 坏缓存被丢弃（问题 5 自愈） | guard 是上一轮写的 | **已修**：`shouldResetGuardForBadCache()` |

第 1 与第 6 条是「已经各打了一个补丁」的写照：**每发现一个换原因的路径，就补一条清除点。**
这个模式会一直重复 —— 第 2/3/4/5 条就是下一个。

⚠️ **第 5 条是最本质的一条**：它说明护栏记的维度根本不对。`attempts = 1` 只说明
「刷过一次」，而「刷完这一趟有没有拿到完整流」这个**真正的判据**从来没被记录过。
`reloadWithGuard` 写护栏的时刻在 `location.reload()` 之前 —— 那时**任何结果都还不知道**。

### 代价卡：护栏同时是防无限循环的唯一硬闸

`src/content/isolated/pgc-cache-inject.ts` 的 `shouldWritePgcCache` 注释明确记着：
`shouldWrite` 返回 `false` 时调用方必须**整个退出**（既不写缓存也不刷新），否则
「刷了也没缓存可读 → 再取 → 又试看 → 再刷 → **死循环**」，并且说得很直白：

> 真正拦住循环的只有 `pluma:pgc-reload` 护栏（10 分钟 TTL），靠它兜底是"靠副作用"，不该是设计。

**所以任何削弱护栏的方案，都必须同时给出一个「不靠护栏也拦得住循环」的判据。**
这是本文的准入条件，下面三个方案逐一对照。

---

## 候选 a：现状（`MAX_RELOAD_ATTEMPTS = 1` + 10 分钟 TTL）

| 维度 | 评价 |
| --- | --- |
| 防循环 | **最强**。一集一刷，再想刷要等 10 分钟 |
| 用户正确率 | **最低**。上表 5 条路径全部踩中，症状是静默的 |
| 可观测性 | 差。日志只说「本会话已刷过一次」，看不出那次刷**是不是成功的** |
| 维护成本 | 高。每发现一条换原因路径就补一个清除点（已经有 2 个） |

**另外**：`GUARD_TTL_MS` 的设计意图（注释原话）是「用户可能换了网络 / 权益续上了」，
但这两件事**都不能被 TTL 观测到**，只是给它一个上界而已。TTL 越长越安全、越短越不容易卡 ——
这个权衡没有正确答案，说明**参数本身选错了维度**。

---

## 候选 b：提高 `MAX_RELOAD_ATTEMPTS`（例如 2）

**能修好什么**：第 4 条（TTL 未到就重开）与「第一次刷运气差」的场景，
代价是用户可能看到**第二次闪屏**。

**代价一：把「无限刷新」降级成「刷两次还是循环」。**

这条不能靠「2 比 1 大所以安全」带过。`shouldReload` 的 `hasStream` 在
`prepareFullStream` 与 `cache-nosync` 两条路径上都是**硬编码 `true`**
（见 `entrypoints/content.ts` 的 `shouldReload({ alreadyTried, hasStream: true })`），
从来不是取流结果的真实值。所以「还有没有流」这道闸在真正会循环的路径上**根本没生效**，
唯一的闸就是 `attempts`。把它从 1 提到 2 = 循环的周期间隔从 1 次变成 2 次，
**循环本身没有被消除**。

**代价二：与「回到上一集」叠加会变大。**

`guardKey` 按 cid 存在 tab 级 `sessionStorage`。用户在 A/B 两集之间来回切
（这是番剧页最常见的操作），每切一次 A 就消耗一次 attempts → 刷两次 → 闪两次。
`MAX_RELOAD_ATTEMPTS = 2` 下,**同一集连续两次闪屏**是用户能直接感知的退化。

**代价三：它不修第 5 条。** 唯一真正需要「再试一次」的场景是「刷了但没成」，
而 b 是**无条件**多给一次 —— 对「刷了且成了」的集数也允许再刷。
**方向对，判据错**：它用放宽阈值代替了正确维度。

---

## 候选 c：换判据（记「刷之后成功了没有」，成功就清护栏）

把护栏从**计数器**改成**状态机**。它要回答的问题不再是「刷过几次」，
而是「**上一次刷新到现在，用户从试看变成完整集了吗**」。

```
写护栏（reload 之前）  { attempts: 1, at, armedBy: 'prepare' | 'cache-nosync' }
                ↓
新一轮加载  读缓存 + 主世界注入。这一步**已经有答案了**：
             full = SSR 里的流够长，且不是我们注入出来的（即真·完整流）
```

判定点已经在代码里存在了 —— `canSkipPgcInjection({ pgcPatchedByUs, truncated })`
（`src/content/isolated/pgc-cache-inject.ts`）回答的正是
「这份 SSR 够不够长 / 是不是我们注入出来的」。
`pgcPatchedByUs === true` **就是**「注入成功了」的真机可观测信号（`orchestratePgc` 第三个参数已在传）。

于是语义变成三态：

| 新一轮观测 | 结论 | 动作 |
| --- | --- | --- |
| SSR 已是完整流、且**是被我们注入的** | **刷了且成功了** | **清掉护栏**（本集本会话已达目标，护栏无意义） |
| SSR 仍是截断流、`sessionStorage` 里也无可用缓存 | **刷了但没成功** | 保留护栏，允许**再刷一次**（`attempts: 2`），之后停止 |
| SSR 完整、但**不是**我们注入的 | 本来就完整（免费集 / 已到顶） | **清掉护栏**（缓存存在即视为已达目标） |

**这个方案直接解决第 5 条**，因为它判的是结果，不是次数。
第 2/3/4 条（F5、切走切回、TTL 内重开）也一起转绿 —— 因为那些情况下
SSR 已经是被注入的完整流，第一轮读取就会把护栏清掉。**它们不再需要各自的清除点。**

#### c 的门槛：必须自己给出防循环判据

这是 c 能不能成立的全部关键。**去掉/削弱 `alreadyTried` 之后，循环由谁拦？**
候选闸门（必须落至少两个，不能只靠一个）：

| 闸门 | 判据 | 是否已存在 |
| --- | --- | --- |
| G-1 无缓存不刷 | `shouldWritePgcCache(merged, expectedMs) === false` → **整个函数退出** | ✅ 已存在，`prepareFullStream` 已 `return` |
| G-2 硬上限 | `attempts >= 2` → 停止（**这一轮只允许刷两次**，是**上限**不是主判据） | 需改常量 |
| G-3 缓存是否有进展 | 上一轮 `pluma:pgc-vi:` 的 `at`/长度 vs 这一轮，**没变就不刷** | 需新增 |
| G-4 连续失败熔断 | 记录「同一 cid 连续 N 轮都没拿到完整流」→ 停止到 TTL | 需新增（等价于现在的 TTL，但记的是失败） |

**G-1 已经存在且是强闸**，`pgc-cache-inject.ts` 的注释也承认「`shouldWrite` 那道闸在刷新**之前**」。
所以 c 的真实风险不是「无限刷新」，而是**「用户每次手动 F5 多一次取流请求」** ——
`shouldResetGuardForBadCache` 的注释已经把这个代价定性为可接受。
**c 的提案方向：把「一次」的上限换成「两次 + 成功即停」。**

#### c 的代价（如实记）

| 代价 | 上界 | 是否可接受 |
| --- | --- | --- |
| 最坏情况两次闪屏 | 2 × 1~2 秒，**仅当第一次刷了确实没成功** | 需用户拍板：比静默 10 分钟好？ |
| 「刷了但没成功」需要一次额外判定 | 已有 `canSkipPgcInjection` 可复用，不新增接口 | 可 |
| 判定依赖 `pgcPatchedByUs` | 主世界上报，**不许绑异步**（ADR 0028 的硬约束） | ⚠️ 需核实这条信号**是否同步可得** |
| 无痕分区共享 `sessionStorage`？ | 不共享（tab 级），不受 ADR 0028 的已知弱点影响 | 无 |

⚠️ **c 唯一待验证的技术点**：`canSkipPgcInjection` 现在在 `orchestratePgc` 里用的是
`ssrWasPatchedByUs`，而它的来源是 **`ssr-playinfo` 消息**上的 `d.pgcPatched`
（`entrypoints/content.ts` 里 `void orchestratePgc(gate.cid, d.data, d.pgcPatched === true)`），
由 `main-world.js` 在 setter 注入成功后上报。

### ✅ 已实测（2026-10-30，真机 bsk 0.3.3）：**同步可靠，判定点成立**

> 读的是产品自己的运行值（`pgcReloadTrace.ssrPatchedByUs`，由 `orchestratePgc` 第 3 个参数
> 原样写入、经 `page/snapshot` 桥送出），**不是按命名推断**。

| 场景 | 集 | `ssrPatchedByUs` | `patchedInSetter` | `patchedAt - ssAt` | 结论 |
| --- | --- | --- | --- | --- | --- |
| A 有缓存 | ep341217 ×3（含全新 tab） | **`true`** | `true` | **1–2ms** | 注入在 setter 内同步完成，首报即带 `true` |
| A 有缓存 | ep341216（新 session） | **`true`** | `true` | 2ms | 同上 |
| B 真无缓存 | ep341220（新 tab、本会话首访） | **`false`** | — | `patchedAt: -1` | 没注入 → `false` 是**正确的**，且同步 |

**关键推翻**：起初怀疑「注入晚于首次上报（`postSsrPlayinfo` 有 0/1500/5000 三次），
第一轮会读到 `false`」。**实测不成立** —— 因为 `content.ts` 处理完**第一条**
`ssr-playinfo` 就 `return`（`gateSsrPlayinfo({ alreadyTried })` 挡掉后续上报），
而首条上报发生在 IIFE 末尾，此时 setter 内的同步注入已完成。
`patchedAt - ssAt` 稳定在 **1–2ms**，与「`createPlayer` 在赋值后 0~2ms」的既有注释吻合。

**同一轮还实测确认**：SPA 切集时 `bootAt`/`ssAt`/`patchedAt`/`orchestrateCalls` **全部不变**，
`ssCid` 仍是旧值，换流走 `swapCount:1`（ADR 0023 响应层）。
→ **本文下表「切走再切回」那一条不触发 `orchestratePgc`**，c 的判据在该场景用不上
（这对 c 是好事：少一个依赖时序的地方）。

复跑：`node poc/probe/probe-pgcpatched-timing.mjs <session-id> ep341217`
（退出码 0 = 可靠 / 1 = 不可靠 / 3 = 未能实测）。

**未覆盖**：只测了**会员试看集**。「playback 账号无权益」（G1 的 `truncated` 分支）样本仍缺，
那种情况下首轮是否为 `true` 未测 —— 但即便为 `false`，落到 `still-truncated` →
`retry`（不清护栏），属于安全方向。

> 2026-10-30 更正：本文初稿此处写成「`d.pgcPatched === true`（`src/content/isolated/hello-timing.ts`
> 那条通道的字段）」，**归错了模块** —— `hello-timing.ts` 只处理 `hello` / `ready`，
> 没有任何 `pgcPatched` 字段。信号走的是 `ssr-playinfo` 通道。

---

## 对 ADR 0028 第三层的影响

ADR 0028 第三层 `clearPgcReloadGuards()` 的语义是：**只在「开关 false→true」那一刻清护栏**，
并且明确写着「**不能**在每次页面加载时清 —— 那会废掉 `alreadyTried` 的防循环本意」。

| 方案 | `clearPgcReloadGuards()` 还需要吗 | 理由 |
| --- | --- | --- |
| a（现状） | **必需** | 它补的洞 2 仍然存在 |
| b（提 attempts） | **仍然需要**，但覆盖变弱 | attempts=2 时洞 2 只是多磨一轮，用户仍要闪一次才恢复 |
| c（换判据） | ~~可以删除~~ → **实测推演后更正：仍然必需** | 见下 |

### ⚠️ 2026-10-30 更正：c **不能**取代第三层（本文初稿的"可以删除"是错的）

用户最初按本文建议批准「允许删掉 `clearPgcReloadGuards()`」。落地时逐场景验算发现
**这个结论不成立**，已改为保留，并把依据钉成测试
（`tests/unit/content/pgc-reload-guard-reenable.test.ts`）。

### 机制描述（2026-10-30 真机更正）

> ⚠️ 本节初稿写的是「关开关 → 重开 → 刷新，这一轮 outcome 是 `still-truncated`」。
> **真机实测推翻了这句**，保留在此以备对照。

**错的版本**：以为"拨开关"就会触发 ADR 0028 第二层清缓存。
**实测**：第二层 `clearPgcSessionCache()` 挂在 **`page/activate` 回包**上，
且只在 `res.reason === 'disabled'` 时执行（`entrypoints/content.ts` 的回包分支）。
而**拨开关本身不刷新页面** —— 那次回包根本不会发生 → `sessionStorage` 缓存原封不动
（实测 92,568B 仍在）→ 重开后仍命中缓存 → `pgcPatched = true` → outcome 是 **`injected`**。

**真正读到 `still-truncated` 的是另一轮 ——「开关关着的时候整页 reload」**：

```
① 护栏存在（attempts = 2）
② 关总开关 → 只写标记，不刷页面；第二层因没有 page/activate 回包而**不执行**
③ 重开开关 → storage.onChanged → clearPgcReloadGuards() 清掉护栏（ADR 0028 第三层生效）
④ 重开后 reload → 命中缓存 → injected → c 判 clear（c 也清，但护栏已空）
```

```
① 护栏存在（attempts = 2）
② 关总开关 → **在关着开关的状态下整页 reload**
   → 这次 page/activate 回包会来且 reason==='disabled' → 第二层**执行** clearPgcSessionCache()
   → 新一轮：主世界没有可注入的缓存（`hadSync=false`）、SSR 仍截断
   → outcome = 'still-truncated' → guardActionForOutcome = 'retry'   ← **c 不清护栏**
```

**所以第三层仍然必需，但必需的理由是第 ②–④ 那条路径**
（用户关开关后确实刷新过页面），而不是初稿说"重开那一轮是 still-truncated"。

### ⚠️「清掉缓存」不能当可观测判据（2026-10-30 第二次真机更正）

第二层**确实执行了**，但**不能靠 `sessionStorage` 里有没有 `pluma:pgc-vi:*` 判断**：

```
③ 关着开关 reload 后读 sessionStorage：{"pluma:pgc-vi:262765010": 92568}   ← 看起来"没清"
但同一轮的产品日志（pluma:diag）：
  12:43:28.280  [page/activate]  总开关已关闭 → 不装规则
  12:43:28.414  [PGC] 总开关已关闭，已清 1 条同步缓存        ← 第二层执行了
  12:43:29.907  [PGC] 收到 SSR playInfo=true cid=262765010
  12:43:30.016  [PGC] 命中缓存并下发（同步缓存原有=false）   ← **又写回来了**
```

**原因**：`entrypoints/content.ts` 的 `writePgcSessionCache(cid, cached, epId)` 会把
`chrome.storage.local` 的 LRU 缓存**重新写进** `sessionStorage`。同脚本的对照实验证实：
把 `pluma:pgc-vi:*` 删空 → 开关仍关着 → reload → 新 document 里又出现 92,568B
（此时 `hadSync=false`）。**这条路径上缓存一定会被重写。**

所以：
- 「第二层有没有执行」的**权威证据**是产品自己的 `pluma:diag` 日志（`chrome.storage.local`，
  落在 `<Edge profile>/Local Extension Settings/<扩展ID>/*.ldb`），**不是** sessionStorage 内容
- 「这一轮 outcome 是什么」看 `pgcReloadTrace.hadSync` / `ssrPatchedByUs` / `ssrTruncated`，
  不看 sessionStorage 内容

真机实测（`poc/probe/probe-pgc-layer2-chain.mjs`，连跑 3 次稳定，exit 0）：

| 步 | 动作 | 原始读数 |
| --- | --- | --- |
| ① | reload（开关开） | `injected` / `clear` / `patchedByUs=true` / `dur=1441` |
| ② | `set-proxy false` | `enabled=false` / `ruleCount=0` |
| ③ | **reload（开关关）** | `still-truncated` / **`retry`** / `hadSync=false` / `truncated=true` / `dur=360.109` / 护栏 `attempts:2` |
| ④ | `set-proxy true` | 护栏 **1→0**（第三层生效） |
| ⑤ | reload（开关开） | 护栏 0 / `injected` / `dur=1441` / `reloadIssued=0` |

**这条链路已测满**（不再是"未测"）：22 次第二层执行中，清 1 条 = 9 次、清 0 条 = 13 次
（清 0 是因为一次加载里多次 `page/activate` 回包，首次已清空）。

真机四条路径回归（`poc/probe/probe-pgc-guard-paths.mjs`，exit 0）实测：
护栏 `attempts=2` → 关开关后**仍在** → 重开开关后**0 条**（第三层生效）→
重开后 `dur=1439.879`、`reloadIssued=0`（没被挡）。

**结论**：两者互补，各管一半，都保留。

| 清除时机 | 谁负责 | 覆盖的场景 |
| --- | --- | --- |
| **按结果清**：本轮已达目标 | ADR 0030（本次） | 刷了且成功 → 下次 F5 / 整页重进 / TTL 内重开都不会被旧护栏挡（真机实测三条全过） |
| **按事件清**：开关 false→true | ADR 0028 第三层（保留） | 用户**关开关后刷新过**（第二层清掉缓存）之后重开 —— 那一轮的 outcome 是 `still-truncated`，c 判 `retry` 不清，只有第三层能接住 |

### 关于「不同轮」的精确表述

`storage.onChanged` 只在开关变化那一刻、在**当时那个已加载的页面**里跑；
而重开后的刷新是**新 document**，`guardClearedByOutcome` 在新 document 里从 0 重计。
所以**跨 reload 比较这个计数器会误判** —— 判据应是「新 document 里 `>= 1`
**且** 护栏键确实为空」（真机脚本第一版踩过这个坑，已写进脚本注释）。

⚠️ ADR 0028 的三层结构整体**不动** —— 第一层（`localStorage` 门控）、
第二层（关时清缓存）与本文无关，且 ADR 0028 已论证第一层是注入时序问题的根治法。

---

## 推荐：c（换判据），但不是无条件选

**一句话理由**：护栏现在的判据维度（刷了几次）与它想防的东西（同一原因反复刷）不对齐，
所以每一条新路径都要补一个清除点；c 把它换成「刷之后成了没有」，让补丁从「按事件清」
变成「按结果清」，同时天然修掉 5 条里剩下的 4 条。

但下面三条必须同时成立，c 才可落地：

1. **`pgcPatchedByUs` 必须同步可靠**（否则 c 的判定点本身就不成立）—— 需真机 trace
2. **`MAX_RELOAD_ATTEMPTS` 从 1 提到 2 是 c 的一部分**，不是替代品；它是**上限**，主判据是结果
3. **G-1（`shouldWritePgcCache` 整个退出）必须保持现状，不许动** —— 它是 c 的安全底座

若第 1 条实测不成立，则退到 **b + 保留全部现有清除点**，并接受「刷两次仍可能循环」的风险。

---

## 备选方案被否的理由

| 方案 | 为什么不做 |
| --- | --- |
| 缩短 `GUARD_TTL_MS`（例如 1 分钟） | 把「卡 10 分钟」变成「卡 1 分钟」，但**同样放大循环周期** —— 是 a 的参数微调，不动判据维度 |
| 只在「用户手动刷新」时清护栏 | **区分不了** `location.reload()` 与 F5：刷新前后是同一个 document，没有可靠的「这是用户按的」信号。会连我们自己那一次也清掉 → 无限刷新 |
| 缓存一变就清护栏 | 命中不了「刷了但注入失败」这一族：那时缓存**恰好**是好的、变过；清掉反而放开第 5 条的循环 |
| 用 `sessionStorage` 外的标记（`storage.local`） | 跨 tab 共享 → 一个 tab 刷过，另一个 tab 也失效。`sessionStorage` 的 tab 级隔离在这里是**特性**不是缺陷 |
| 完全删掉护栏 | 直接回到 ADR 0020 记录的失败模式（无限重载），且 `pgc-cache-inject.ts` 的「靠副作用不该是设计」说的正是「护栏是最后一道、不许当唯一一道」 |
| 增加一个「本次会话刷了但没成功」的独立计数器 | 与 c 同向但更弱：多一个状态就有两套判据要维护。**c 更小**，因为它复用的是已有的 `canSkipPgcInjection` |

---

## 需要用户决定的具体问题

> 一句话能答的，按编号答即可。**在回答之前不动任何代码。**

1. **选 a / b / c 哪个？**（本文推荐 c；若 `pgcPatchedByUs` 实测不同步则退到 b）
2. 若选 c：**最坏两次闪屏（1~2 秒 × 2）** 是否可以接受？这是 c 换掉「静默卡 10 分钟」的代价。
3. 若选 c：**允许删掉 ADR 0028 第三层 `clearPgcReloadGuards()` 并改写该 ADR 吗？**（不删就得两份规则并存，违反 `AGENTS.md` §6.1）
4. 若选 b 或 c：`MAX_RELOAD_ATTEMPTS` 定 **2** 还是别的数？（`2` 是「再试一次」的最小语义）
5. 谁来做 `pgcPatchedByUs` 的**真机 trace 验证**（同步性 + 晚到最坏值）？这决定 c 能否落地。

## 落地前的验证要求（无论选哪个）

- 新增单测覆盖「刷了且成功 → 护栏清掉」与「刷了没成功 → 允许最后一次」两层，
  并附**反例**：把清护栏那行删掉，测试必须变红
- `tests/unit/content/pgc-reload-plan.test.ts` 现有断言全绿（`shouldReload` 签名不许动）
- 真机：关开总开关 / 手动 F5 / 切走再切回 / TTL 内重开 四条路径都要看到护栏按新语义收尾
- [docs/plans/1.1.0-plan.md](../plans/1.1.0-plan.md) 的 R1（改 PGC 注入判定 → 灰屏或 4K 失效）
  必须按「先 ADR + 反例 + 真机」的既有口径走

## 相关

- 前置：[ADR 0020](./0020-pgc-sync-injection-and-reload.md) —— 护栏的出处，以及为什么 `active` 被移除
- 前置：[ADR 0028](./0028-proxy-off-signal-for-pgc-injection.md) —— 第三层 `clearPgcReloadGuards()`，若选 c 则被本文取代
- 风险：[docs/plans/1.1.0-plan.md](../plans/1.1.0-plan.md) 的 G3 / R1
- 合规边界不变：流仍由播放账号自己的权益换来，服务端没有被骗

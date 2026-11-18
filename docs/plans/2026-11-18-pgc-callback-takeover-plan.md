# PGC（番剧 / 国创 / 电影）回调接管 —— 实施方案

- 作者：架构评审（team-lead 汇总）
- 日期：2026-11-18
- 状态：**进行中**（S0 已完成、S1 已落地 `99f8a2b`；S2/S3 待开工）
- 依据：`poc/probe/pgc/REPORT-sync-callback.md`（真机探针，含四模式对照与返回体形状）
- 关联：ADR 0019（PGC 异步取流注入）、0020（整页注入）、0021（试看标记）、0023（切集换流）、0030（reload 护栏）

---

## 一、做什么、不做什么

**做**：在 PGC 页的 `createPlayer(config)` **返回之前**，保留原 `config.requestConfig` 对象、只替换 `reqHttpPlayUrlInfo`，让播放器**第一次取流**就吃扩展账号的流。收益是**去掉一次整页 reload**，以及少一条「先按试看起步、再刷新纠正」的时序竞争。

**不做**（本期）：
1. 不删除现有的 SSR `__playinfo__` 注入（`pgcPatchPlayinfo`）——双路径并存，回调是加速与兜底，不是替代。
2. 不动 DNR / 权限 / `wxt.config.ts` / 路由白名单。
3. 不改写 `dash` / `support_formats` / `quality`（ADR 硬约束 5）。合并只走 `STREAM_FIELDS` 白名单。
4. 不追求"省掉试看补丁"——探针现场合并成功后播放器仍停在 **360s**，说明试看判定不在返回体形状上，ADR 0021 的补丁继续有效且必需。

---

## 二、硬前提（五条实测事实，违反任一条即方案不成立）

| # | 事实 | 后果 |
|---|---|---|
| 1 | 必须**保留** `config.requestConfig` 原对象（尤其 `reqHttpPlayUrlInfoScope`），只替换 `reqHttpPlayUrlInfo` 字段 | 整个替换 → `cbHits:0`，播放器转去 `/pgc/player/web/v2/playurl`（`enabled:false`），**静默失效、无任何报错** |
| 2 | 回调 `params` 里 `avid`/`bvid`/`cid` **全为 `null`**，也没有 `ep_id` | cid 只能取 `__playinfo__.result.arc.cid`（`main-world.js` 已有 `pgcCidOf`），或复用 ep→cid 映射 |
| 3 | 返回体只有**合并进 SSR 骨架**才能播：把接口的流字段搬进 `result.video_info`；直接返回接口扁平 json、或 `{data:{code:0,data:{durl}}}` 都黑屏（`[flv.js] Non-FLV` / `MediaError.code=4`） | 必须复用 `src/core/playinfo/pgc-merge.ts` 的 `STREAM_FIELDS` 白名单语义（主世界有同源 JS 版） |
| 4 | PGC playurl 的 `result` 里**没有** `last_play_time`/`last_play_cid`，进度来自 SSR `watch_progress` | 不需要做活动页那套进度还原；但**不许**覆盖 `watch_progress` |
| 5 | `/pgc/player/web/playurl` 在 DNR 白名单（`routes.ts:118-122`、`dnr.ts:849-852`） | 我方 fetch 天然是扩展账号身份，无需额外处理 |

---

## 三、现状链路（要在它上面做加法，不是推倒）

1. `__playinfo__` 的 setter 同步调 `pgcPatchPlayinfo(v, true)`（`main-world.js:2350`）——把 sessionStorage 缓存 `pluma:pgc-vi:<cid>` 的完整流合并进 `result.video_info`，并 `pgcPatchPreviewFlags` 改写试看标记。
2. 首次进页面若缓存没有/被判定截断：`content.ts` 的 `orchestratePgc()`（`:1309`）→ `prepareFullStream(cid, ssr)`（`:1834`）取流写缓存 → `shouldReload` + `reloadWithGuard`（ADR 0030）→ **整页 reload** 让 setter 重新跑。
3. SPA 换集：主世界拦 `/ogv/player/playview`（`pgcSwapPlayviewBody`，`:4411`）就地换 durl（ADR 0023）。
4. 试看集：`pgcPatchPreviewFlags`（`:2309`）改 `play_video_type` / `play_check.play_detail` / `video_info.is_preview`。

**痛点**：2 的 reload 是"先让用户看到 360 秒的试看画面，再刷新纠正"，且 reload 本身有护栏与失败态（`pgcReloadTrace`）。

---

## 四、目标架构

```
页面 createPlayer(config)
        │  ← 我们在返回前同步注入（保留 requestConfig 对象）
        ▼
  rc.reqHttpPlayUrlInfo = pgcGateProxy
        │  门控开 → 取流；确定关 → 交还原生 origCb；未知 → 最多等 300ms
        ▼
  fetch('/pgc/player/web/playurl?…', credentials:'include')   ← DNR 换 Cookie
        ▼
  merged = mergeSsrSkeleton(__playinfo__.result, apiResult)   ← 只搬 STREAM_FIELDS
        │  + pgcPatchPreviewFlags(merged)                     ← ADR 0021
        ▼
  返回 { data: { code: 0, result: merged }, headers: {}, status }
        ▼
  播放器首帧即完整流 → orchestratePgc 判定「已接管」→ 跳过 reload
```

与现状的关系：`pgcPatchPlayinfo`（SSR 注入）**继续保留**。回调接管成功时它注入的也是同一份缓存内容，相当于双保险；失败时它就是兜底。

---

## 五、分步实施

### S0 补测（只读探针，不改产品代码）

探针只覆盖了**电影 durl 路径**，番剧 **dash 路径本轮未重跑**。必须先补三个数据点：

| 要测什么 | 判据 |
|---|---|
| 番剧 dash 路径合并后能否起播 | `readyState=4`、`duration>` 试看时长、`height` 达到账号权益上限 |
| `config.prefetch.playUrl` 是否也需要清 | 不清时回调是否仍被调用（活动页的经验是 `prefetch` 存在会抢跑）；若被抢跑，需在注入时 `delete config.prefetch.playUrl` |
| 冷启动时门控到达时刻 | `tGate - tCreate` 分布；PGC 的 `page/activate` 要解密凭据，可能比活动页（p50 50ms）更晚，据此定等待上限 |

**验收**：S0 已产出 `poc/probe/pgc/REPORT-dash-merge.md`，三项都有数字。

**S0 实测结论（2026-11-18，已完成）**：

| 项 | 结果 |
|---|---|
| Q1 番剧 dash 合并 | **通过**：`readyState=4`、`duration=3076s`、`currentSrc=blob:`（MSE）、`MediaError=null`、合并后 `hasDurl=false`。**PGC 的 duration 会跟 `video_info.timelength`/`dash.duration`**（与活动页不同，活动页由 SSR 分 P 锁定） |
| Q2 `prefetch.playUrl` | **必须删**：保留时 `cbHits=0`、回调一次不被调用、播放器直接用 prefetch 流；`delete` 后 `cbHits=1`、我们的 fetch 生效 |
| Q3 门控窗口 | `tGate - tCreate`：p50 76 / p90 119 / max 131ms；同步回调约 create+85ms，实际等待 p50 −9 / p90 34 / max 46ms → **`PGC_GATE_WAIT_MS = 300`** |

⚠️ Q1 的证明手法要记住：该页 guest 的 SSR 与接口 `quality` 都是 32、播放高度都是 360，**单看高度分不清播放器吃的是谁的流**，只能给 `timelength`/`dash.duration` 加时长标记才能坐实。

⚠️ Q2 的局限：本页 SSR 自身 `durlGroups=0`，所以「不删 `durl` 会不会回退 360s」在本页无法做反例，仍需 preview durl 页面（主账号无权益）才能验。

### S1 抽出"骨架合并"单一实现（`main-world.js`）

现状 `pgcPatchPlayinfo` 内联了一份白名单裁剪（与 `src/core/playinfo/pgc-merge.ts` 同源但重复）。已抽出（`99f8a2b`）：

```js
pgcMergeVideoInfo(ssrVideoInfo, source) → { videoInfo: object|null, moved: number }
```

- 只搬 `STREAM_FIELDS` 同源字段；有 `dash` 就删 `durl`/`durls`；不修改入参。
- 返回对象而非 `null`：`pgcPost` 里「缓存里没有可用的流字段（N 个元信息）」的 `N` 是真机排查依赖的信息，返回 `null` 会丢掉它。
- `filterDashOf` / `reportPcdnFilter` **留在调用点**（回调路径的标签不同，抽进纯函数会串标签）。

**验收**：既有 PGC 的 55 条断言一条未改、全绿（零行为变化）；新增 6 条纯函数用例。

### S2 同步注入代理（`main-world.js`，仅供 PGC 分支）

在 `installCreatePlayerProbe` 的 PGC 分支里：

```js
var rc = config.requestConfig;          // ⚠️ 不替换对象
if (rc && typeof rc.reqHttpPlayUrlInfo === 'function') origCb = rc.reqHttpPlayUrlInfo;
rc.reqHttpPlayUrlInfo = pgcGateProxy;   // 只换这一个字段
if (config.prefetch) delete config.prefetch.playUrl;   // ⚠️ S0 实测：不删则回调永不被调用
```

`pgcGateProxy` 三态与活动页一致（复用 `festivalWaitGate` 的队列式等待，或抽公共函数）：
- 门控开 → `pgcFetch`
- 确定关（`cfgEnabled === false` / `pgcActive === false`）→ `origCb`（**不是** fallback 到我们自己的 XHR）
- 未知 → 等 `PGC_GATE_WAIT_MS = 300`，超时 `origCb`

**内置开关**：常量 `PGC_CALLBACK_TAKEOVER = false` 先落地，S5 全绿后改 `true`。出现问题 revert 单个 commit 即可。

**验收**：单测覆盖三态（含"确定关着时一次定时器都不起"）+「`prefetch.playUrl` 被删」；真机上关开关时 `cbHits` 由原生接管、页面表现与今天完全一致。

### S3 取流与合并（`main-world.js`）

- cid：`pgcCidOf(window.__playinfo__)`，取不到则不接管（交还 `origCb`），并记 `lastSkip`。
- 请求：`/pgc/player/web/playurl`，参数形状照 `prepareFullStream`（`content.ts:1834`）与探针抓到的 `ep_id`/`cid`/`qn`/`fnval` 组合；`credentials:'include'`，走 `nativeFetch`（不要走被 hook 的 `fetch`，否则又进响应改写链）。
- 合并：`pgcMergeVideoInfo(ssrResult && ssrResult.video_info, apiResult)`；**再** `pgcPatchPreviewFlags(merged)`。
- 返回：`{ data: { code: 0, result: mergedResult }, headers: {}, status }`（`mergedResult` = SSR `result` 骨架 + 合并后的 `video_info`）。
- 失败/无流（`videoInfo` 为 `null`）：交还 `origCb`，记 `cbHits`/`lastSkip`，**不抛错**。

**验收**：真机番剧页首帧即完整流，Network 中**无** `/pgc/player/web/v2/playurl`，且 `<video>.currentSrc` 指向 dash。

### S4 让编排层跳过 reload（`entrypoints/content.ts`）

`orchestratePgc` 在 `prepareFullStream` 之前加一个早退：

```ts
if (pgcReloadTrace.callbackTakeover === true) {
  pgcReloadTrace.orchestrateExit = 'callback-takeover';
  pageState.applyPlayback({ code: 0, result: ... });   // 面板照常记能力
  return;
}
```

`callbackTakeover` 由主世界随 `pgc` 消息上报（回调成功 + 合并成功才置 true）。

**验收**：开关开、首次进番剧页 **不 reload**；`pgcReloadTrace.orchestrateExit === 'callback-takeover'`；关开关时仍走原来的 reload 链路（行为不变）。

### S5 回归矩阵（真机）

| 维度 | 取值 |
|---|---|
| 页面 | 番剧 / 国创 / 电影 各 1 |
| 集类型 | 免费集、试看集（账号无权益）、大会员集 |
| 进入方式 | 冷启动新标签、SPA 换集、刷新 |
| 开关 | 总开关开 / 关；屏蔽 PCDN 开 / 关 |

必看指标：`duration` 是否整集、`is_preview`、`currentSrc` 是否 dash、是否发生 reload、`watch_progress` 续播位置是否保持、弹幕/字幕是否正常。

**通过条件**：所有组合下画质不回落、续播不丢、不出现黑屏或二次缓冲；关开关的组与今天行为一致。

### S6（可选项，需新 ADR，默认不做）

只有在 S5 连续观察无问题**且**有明确收益时才考虑移除 SSR 注入/藏 `__playinfo__`。收益是少一条路径，风险是回到"首帧按试看起步"。**本期不排期。**

---

## 六、机械闸门与文档变更

| 项 | 变更 |
|---|---|
| 新 ADR | `0041-pgc-callback-takeover.md`：授权在 PGC `createPlayer` 同步注入回调；硬边界（保留 `requestConfig` 对象、只搬 `STREAM_FIELDS`、不动 `watch_progress`、失败必须交还原生） |
| ADR 0019 | 附录已更正归因（`dd477e4`）；落地后补一句"已按 0041 落地" |
| ADR 0021 | 说明补丁在回调路径**同样必须**执行（探针：合并成功后仍停 360s） |
| ADR 0030 | 新增 `callback-takeover` 出口，说明它不改变护栏语义 |
| `check-patch-scope` | 若新增写集，须登记到 ADR 0041 授权；正常情况下只调用既有函数，不需改守卫 |
| `check-page-gate` | 不涉及（页面判据未变） |

---

## 七、风险

| 风险 | 处置 |
|---|---|
| 双路径重复取流（回调 + SSR 注入 + `prefetch.playUrl`） | **S0 已证实必须清**：保留 `prefetch.playUrl` 时 `cbHits=0`、回调永不被调用；注入时 `delete config.prefetch.playUrl` |
| 合并白名单漂移（主世界 JS 版 vs `pgc-merge.ts`） | S1 只允许一处实现；单测比对两边字段集合 |
| 试看集合并后仍被截断 | 保留 ADR 0021 补丁；S5 专门覆盖试看集 |
| 冷启动门控晚于首波 | 埋点 `gateTimeouts`；超限就调等待上限或优化激活时序，**不许**降级成"用主账号身份取流" |
| SPA 换集与 `playview` 拦截冲突 | 明确优先级：回调只管首次取流；换集继续走 `pgcSwapPlayviewBody` |
| 回滚 | `PGC_CALLBACK_TAKEOVER` 常量置 `false` 即回到今天的行为，无需 revert 代码 |

---

## 八、与活动页实现的差异（照抄会踩坑）

| 维度 | 活动页 | PGC |
|---|---|---|
| `config.requestConfig` | 原生**没有**，可新建 | 原生**有**，必须保留对象 |
| 返回体 | `{data: 接口 json}` 直接用 | 必须合并进 SSR 骨架 |
| cid 来源 | `params.cid` | `params.cid` 为 null → `__playinfo__.result.arc.cid` |
| 进度 | playurl 带 `last_play_time`，需还原 | 无该字段，不需要 |
| 试看 | 无此概念 | 必须打 ADR 0021 补丁 |

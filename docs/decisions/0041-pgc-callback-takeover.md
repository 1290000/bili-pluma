# ADR 0041：PGC 页回调接管 —— `createPlayer` 同步注入取流回调

- 日期：2026-11-18
- 状态：**已采纳**（实施：`main-world.js` 的 `pgcAttach` / `pgcGateProxy` / `pgcFallback` / `pgcFetch`；方案见 `docs/plans/2026-11-18-pgc-callback-takeover-plan.md`）
- 授权范围：仅 `src/content/main-world.js` 的 PGC 分支 —— 在 `createPlayer(config)` 返回前同步替换 `config.requestConfig.reqHttpPlayUrlInfo`、按门控取流 `/pgc/player/web/playurl`、把响应**合并进 SSR `__playinfo__` 骨架**后交回播放器、改写试看标记（ADR 0021）、对合并结果做 PCDN 候选改写（ADR 0038/0039，第 4 个调用点）
- 明确不改：`entrypoints/content.ts`（S4 才做「跳过 reload」）、`src/shared/constants/routes.ts` 白名单、`src/platform/http/dnr.ts`、`host_permissions`、活动页 / `/video` 页的全部既有路径
- 依据：`poc/probe/pgc/REPORT-sync-callback.md`（四模式对照 + 返回体形状）、`poc/probe/pgc/REPORT-dash-merge.md`（S0：dash 合并起播 / 必须删 prefetch / 门控窗口 p50 76ms）；另有一条姊妹结论（活动页 `REPORT-gate-window.md`，暂未入库）：事后 `updateRequestConfig` 结构上抢不到首波
- 关联：[ADR 0019](./0019-pgc-async-playurl-injection.md)（2026-11-18 归因更正：回调可用，真因是当年没抢到 `createPlayer`）、[ADR 0020](./0020-pgc-sync-injection-and-reload.md)（SSR 注入继续保留，双路径并存）、[ADR 0021](./0021-patch-pgc-preview-flags.md)、[ADR 0023](./0023-intercept-playview-durl-swap.md)、[ADR 0030](./0030-pgc-reload-guard-semantics.md)（reload 护栏，回调成功后 S4 不再触发）、[ADR 0038](./0038-filter-pcdn-candidates.md) / [ADR 0039](./0039-rewrite-pcdn-authority.md)

---

## 背景

### 一、SSR 注入路线的残余痛点

现行路线（ADR 0020）：首次进番剧页若 `sessionStorage` 缓存没有 / 被判定截断，
`content.ts` 的 `orchestratePgc()` → `prepareFullStream()` 取流写缓存 → `reloadWithGuard()`
（ADR 0030）→ **整页 reload** 让 `__playinfo__` setter 重新跑。用户先看到几秒 360s 试看画面、
再刷新纠正，且 reload 链路自带护栏与失败态。

### 二、回调路线的三个实测前提（违反任一条即静默失效）

S0 与上一轮探针（`REPORT-sync-callback.md`）用 Playwright `addInitScript` 定序 + 真机实测：

| # | 事实 | 后果 |
| --- | --- | --- |
| 1 | 必须在 `createPlayer` **返回前**同步写回调（首波取流在 `createPlayer` 里就排好队；事后的 `updateRequestConfig` 只影响 reload 后的那一波） | 晚一步 = 首波被播放器原生 XHR 抢走，与活动页同一个坑 |
| 2 | 必须**保留 `config.requestConfig` 原对象**（尤其 `reqHttpPlayUrlInfoScope`），只替换 `reqHttpPlayUrlInfo` 字段 | 整体替换 → `cbHits:0`，播放器转去 `/pgc/player/web/v2/playurl`（`enabled:false`），**静默失效、无任何报错** |
| 3 | 必须 `delete config.prefetch.playUrl`（保留则播放器直接用 prefetch 流，回调一次都不被调） | `cbHits:0`，同上静默失效 |

### 三、返回体只有合并进 SSR 骨架才能播

播放器吃的是 SSR 嵌套形状（`result.video_info.*`）。回调直接返回接口扁平 json、或
`{data:{code:0,data:{durl:[...]}}}` 都黑屏（`[flv.js] Non-FLV` / `MediaError.code=4`）。
S0 Q1 已在番剧 dash 路径验证：合并后 `readyState=4`、`duration` 跟 `timelength`、
`currentSrc=blob:`（MSE）。

---

## 决定

### 实现（`main-world.js`，仅在 `IS_PGC && PGC_CALLBACK_TAKEOVER` 时生效）

```
createPlayer(config)
  └─ orig.apply 之前：pgcAttach(config)
       ├─ 确定关（pgcReadProxyOff()===true 或 cfgEnabled===false）→ 什么都不碰，return false
       ├─ config.requestConfig 非对象 → 不接管、**不新建**，return false
       ├─ 捕获 pgcOrigReq = requestConfig.reqHttpPlayUrlInfo（原回调）
       ├─ requestConfig.reqHttpPlayUrlInfo = pgcGateProxy   ← 只换这一个字段
       └─ pgcStashedPrefetch = config.prefetch.playUrl; delete config.prefetch.playUrl
                ↓ 播放器首波调用
       pgcGateProxy(params, config)
       ├─ 门控开（cfgEnabled===true && pgcActive===true）→ pgcFetch
       ├─ 确定关 → pgcFallback
       └─ 未知 → 最多等 300ms（事件驱动队列），开 → pgcFetch；超时/变关 → pgcFallback
                ↓
       pgcFetch：cid 取 pgcCidOf(__playinfo__)（params 里全是 null）
         → nativeFetch('/pgc/player/web/playurl?cid=…&avid=0&qn=80&fnval=4048&fnver=0&fourk=1')
         → {code:0, result} → pgcMergeVideoInfo(SSR video_info, api result)（S1 纯函数）
         → outResult = Object.assign({}, ssrResult)，换 video_info → pgcPatchPreviewFlags(outResult)
         → pcdnFilterReady() && filterDashOf(outResult.video_info)，reportPcdnFilter(stats,'playurl')
         → 返回 { data: { code: 0, result: outResult }, headers: {}, status }
```

SSR `__playinfo__` 注入（ADR 0020 的 `pgcPatchPlayinfo`）**继续保留**：回调成功时两者内容一致
（双保险），回调失败时它就是兜底。

### 六条硬边界（缺一条就超出本授权）

| # | 边界 | 为什么 |
| --- | --- | --- |
| 1 | **保留 `config.requestConfig` 原对象**，只替换 `reqHttpPlayUrlInfo` 字段 | 整体替换丢掉 `reqHttpPlayUrlInfoScope` → `cbHits:0` 且静默回落 `enabled:false` 的 v2 路径，无任何报错（前提 2） |
| 2 | **必须摘 `config.prefetch.playUrl`，且先存后删**；兜底时还原 | S0 Q2：保留它回调一次都不被调；但摘掉不还原等于把页面数据永远弄丢——兜底正是"我们不接管"的时刻 |
| 3 | 合并**只搬** `STREAM_FIELDS` 白名单（唯一实现 `pgcMergeVideoInfo`），**不改** `dash` / `support_formats` / `quality` 的内容 | ADR 0020 硬约束 5 + ADR 0039：改写只换 authority、不增删候选、不碰画质字段 |
| 4 | **不碰 `watch_progress`**（以及 `arc` / `play_check` 的账号语义字段 / `user_status`） | PGC 进度来源是 SSR `watch_progress`（playurl `result` 里没有 `last_play_time`）；改它就是伪造进度 |
| 5 | **门控未知时不发任何请求**（fail-closed）；任何失败路径必须交还页面原回调 `pgcOrigReq`，绝不 reject | 门控未知时我方 fetch 会带主账号 Cookie 打到白名单路径；而 reject promise 会让播放器黑屏——没有原回调时返回「成功但无流」的壳 |
| 6 | 常量 `PGC_CALLBACK_TAKEOVER` 是**唯一回滚开关**，默认 `true` | 出问题改 `false` 即回到今天的 SSR 注入行为（`pgcAttach` 一个字都不碰 config），不需要 revert 提交 |

---

## 与既有 ADR 的关系

| ADR | 本 ADR 的处理 |
| --- | --- |
| [ADR 0019](./0019-pgc-async-playurl-injection.md) | 它否决回调路线的归因已在 2026-11-18 更正（真因是没抢到 `createPlayer`）。本 ADR 按其附录的硬前提实现：保留原对象 + 只换字段。决策「继续用 SSR 注入」仍成立——回调是加速与兜底，不是替代 |
| [ADR 0020](./0020-pgc-sync-injection-and-reload.md) | 双路径并存：回调成功时两路注入内容一致；回调失败 / 开关关时 SSR 注入照常 |
| [ADR 0021](./0021-patch-pgc-preview-flags.md) | 回调返回体**必须**调 `pgcPatchPreviewFlags(outResult)`：S0 实测合并成功后不调它播放器仍停 360s |
| [ADR 0023](./0023-intercept-playview-durl-swap.md) | SPA 切集走 `playview` 拦截，不经回调；两者互不影响 |
| [ADR 0030](./0030-pgc-reload-guard-semantics.md) | reload 护栏原样保留；S4（另一次变更）才让编排层在 `takeoverOk` 时跳过 reload |
| [ADR 0038](./0038-filter-pcdn-candidates.md) / [ADR 0039](./0039-rewrite-pcdn-authority.md) | `pgcFetch` 是候选改写的**第 4 个调用点**（`check-patch-scope` 已登记），标签 `'playurl'`、边界原样适用 |

---

## 风险与处置

| 风险 | 处置 |
| --- | --- |
| 整体替换 `requestConfig` → 静默失效 | 硬边界 1 + `pgcAttach` 实现注释 + 单测断言 `reqHttpPlayUrlInfoScope` 保留 |
| 页面形态变化（无 `requestConfig`）→ 新建空对象撑不起回调 | `pgcAttach` 遇非对象直接不接管，**不许新建** |
| 门控未知时发请求 → 主账号 Cookie 打到白名单路径 | 等待期间零请求（单测断言 `fetchCalls` 为空）；超时走 `pgcOrigReq` |
| 无原回调时 reject → 黑屏 | 返回「成功但无流」的壳（单测断言 resolve 形状），并 `lastSkip='no orig callback'` |
| 回调路径漏接候选过滤 → 一整类场景漏改写 | `check-patch-scope` 第 4 调用点登记（只加不减） |
| 行为回归 → 用户播放受损 | `PGC_CALLBACK_TAKEOVER=false` 单常量回滚；`installCreatePlayerProbe` 的分支条件直接判它 |

---

## 验证门

1. `npm run verify` 全绿（含 `check-patch-scope` 的四处调用点判据与 ADR 0041 存在性检查）
2. 单测：S2 三态（含"确定关着时零请求"）、S3 合并形状 / 无流交还 / 无原回调不 reject / PCDN 标签 `'playurl'`、开关关 = 零行为
3. 真机（S5 回归矩阵，另验）：首帧即完整流、无 `/pgc/player/web/v2/playurl`、`currentSrc` 为 dash、`watch_progress` 续播保持

---

## 边界（不做什么）

- 不删 SSR `__playinfo__` 注入，不做 S6（移除注入路径）
- 不改 `entrypoints/content.ts`（S4 才做「跳过 reload」）
- 不做进度还原（PGC 无此问题，见硬边界 4）
- 不动 DNR / 白名单 / 权限 / 活动页 / `/video` 页任何行为

---

## 相关

- 实施方案：`docs/plans/2026-11-18-pgc-callback-takeover-plan.md`（S0 结论 / S1 `pgcMergeVideoInfo` / S2 / S3 / S4 / S5）
- 探针：`poc/probe/pgc/REPORT-sync-callback.md`、`poc/probe/pgc/REPORT-dash-merge.md`
- 真机验收埋点：`window.__PLUMA_PGC__` 的 `attached` / `prefetchCleared` / `cbHits` / `tFirstCb` / `tGate` / `gateWaitedMs` / `gateTimeouts` / `takeoverOk` / `lastRespCode` / `lastSkip` / `errors`

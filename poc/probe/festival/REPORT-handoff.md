# 活动页流来源精确埋点：到底是谁把流喂进了播放器

> 日期：2026-11-18　执行：probe-festival-nano
> 环境：bsk 0.5.0（未升级）、独立 `--scope probe-handoff`、真实登录 Edge；每轮用完即 `bsk close`（qnhz / ovbj / hxek / tjpz 均已关闭）。
> 边界：**未改** `src/`、测试、守卫，**未 commit**；签名 URL / Cookie / 账号信息不写入正文。
> 原始证据：`poc/probe/festival/result-handoff-timeline.json`（URL 已脱敏）。

---

## 0. 一句话结论

**C（混合）**：首波取流**不保证接管**——COLMO 一次抢到 A（回调 fetch）、一次和 bnj 都是 B（播放器原生 XHR + DNR 换 Cookie）；门控晚到触发 `remounts=1` 后，**后续波次才稳定变成 A**。所以当前首波收益常常只有"DNR 换 Cookie 的官方线路 + 面板正确"，**画质解锁 / PCDN 改写首波未生效**（`rewritten=0`），要等重挂后的下一次取流才生效（`rewritten` 增长）。

---

## 1. 三条线怎么观测的（方法）

| 线 | 观测手段 | 为什么这样观测 |
| --- | --- | --- |
| ① 回调线 | `bsk evaluate --expect` 周期读 `window.__PLUMA_FESTIVAL__` 全字段；记录 `cbHits / lastStage / lastQuery / paramTypes / lastRespCode / lastStatus / remounts / rewritten / fallbacks` | 这是产品自带埋点（`main-world.js:648`）。`lastQuery` 只在 `festivalPlayUrl()` 里写（`:865`），`lastRespCode` 只在 `festivalNoteResp()` 里写（`:877`）——二者非空即证明回调走到了 fetch 并解析了响应。 |
| ② 网络线 | `performance.getEntriesByType('resource')` 过滤 `/x/player/wbi/playurl`，取 `startTime` / `duration` / **`initiatorType`** | 源码确认 `nativeFetch = window.fetch`（`:519`），回调用 `nativeFetch(url, {credentials:'include'})`（`:998`）。所以**我们的取流在 Resource Timing 里是 `initiator: fetch`**，播放器默认取流是 `xmlhttprequest`。这比 hook `window.fetch` 更可靠：hook 必须早于内容脚本捕获 `nativeFetch`，bsk 0.5.0 做不到 document_start 注入。 |
| ③ 播放器线 | `window.nano.createPlayer.toString()` 找产品包装特征；`__INITIAL_STATE__.player.getQuality()` / `video.videoHeight` / `readyState` / `currentSrc` | 确认 hook 真的装上了、以及最终播出来的是哪条流。`createPlayer` 源码片段含 `O.createCalls+=1,ye(arguments[0])`（压缩后的 `festivalAttach`），`__plumaProbed === true`。 |

> bsk debug 的 `debug start` 明确报告 `coverage: initial_load_not_recorded`，且本轮抓包**没有**录到任何 `/x/player/wbi/playurl`（只录到 `/x/player/online/total` 与 m4s）。所以网络线以 Resource Timing 为准，不用 debug capture 下结论。
> `createPlayer` 的精确时刻无法在 bsk 里前置探针取得；用 `createCalls=1` + 首条 playurl 的 `startTime` + 埋点状态反推。

---

## 2. 三条时间轴（相对 `performance.now()`，ms）

### 2.1 COLMO 第 1 次：首波就是 A（真接管）

| 时刻 | 线 | 事件 |
| --- | --- | --- |
| — | 播放器 | `nano.createPlayer` 已被产品包装（`__plumaProbed=true`，源码含 `festivalAttach` 特征） |
| **561 → 692** | 网络 | `/x/player/wbi/playurl`，`qn=120`、`fnval=4048`、**`initiator: fetch`**、无 `w_rid`（签名由播放器 params 传入，不是播放器 XHR 那条） |
| 首波后 | 回调 | `cbHits=1`, `lastQuery` 非空, `lastRespCode=0`, `lastStatus=200`, `lastStage='cb'`, **`remounts=0`**, `rewritten=4`, `fallbacks=0`, `errors=0` |
| 首波后 | 播放器 | `getQuality().newQ=120`, `videoHeight=2160`, `videoWidth=3840`, `duration=732`, `readyState=4`, `t=19` |
| **79732** | 网络 | 触发二次取流后再次 `initiator: fetch`，`qn=64` |
| 二次后 | 回调 | `cbHits=2`, `rewritten=10`, `lastStage='cb'` |

→ 只有 fetch、没有 XHR，且 `rewritten>0`（PCDN 过滤只在我们的回调里执行，`main-world.js:1014`）——首波就是 A。

### 2.2 COLMO 第 2 次：首波 B，重挂后 A

| 时刻 | 线 | 事件 |
| --- | --- | --- |
| — | 播放器 | hook 已装（`createCalls=1`, `nanoSets=1`），`nano.createPlayer` 同样是产品包装 |
| **1206 → 1335** | 网络 | `/x/player/wbi/playurl`，`qn=64`、`fnval=4048`、**`initiator: xmlhttprequest`**、`w_rid` 存在、`wts=1794943426` |
| 首波后 | 回调 | `cbHits=0`, `lastCid=''`, `lastQuery=''`, `lastRespCode=null`, `lastStatus=-1`, `lastStage='hooked'`, **`remounts=1`**, `rewritten=0`, `fallbacks=0`, `errors=0` |
| 首波后 | 播放器 | `newQ=64`, `videoHeight=720`, `duration=732`, `readyState=4` |
| **17220** | 网络 | `player.reload()` 后 `/x/player/wbi/playurl`，`qn=64`、**`initiator: fetch`**、`w_rid` 不存在 |
| 二次后 | 回调 | `cbHits=1`, `lastCid='42141027046'`, `lastQuery` 非空, `lastRespCode=0`, `lastStatus=200`, `lastStage='cb'`, `rewritten=6` |

→ 首波是播放器自己 XHR（DNR 换 Cookie 后的官方线路），我们的回调**一次都没被调**；门控到齐后 `remounts=1`，后续 reload 才走 A。

### 2.3 bnj2026：首波 B，重挂后 A

| 时刻 | 线 | 事件 |
| --- | --- | --- |
| — | 播放器 | hook 已装（`createCalls=1`, `nanoSets=1`），产品包装特征同上 |
| **2057 → 2200** | 网络 | `/x/player/wbi/playurl`，`qn=64`、`fnval=4048`、**`initiator: xmlhttprequest`**、`w_rid` 存在、`wts=1794943360` |
| 首波后 | 回调 | `cbHits=0`, `lastQuery=''`, `lastRespCode=null`, `lastStage='hooked'`, **`remounts=1`**, `rewritten=0`, `fallbacks=0`, `errors=0` |
| 首波后 | 播放器 | `newQ=64`, `videoHeight=720`, `duration=248`, `readyState=4` |
| ~24s | 回调 | 第一次 `player.reload()` 后 `cbHits=1`, `rewritten=2`；但 Resource Timing 缓冲已满（300 条），该次 fetch 未被记录（测量盲区，已用 `setResourceTimingBufferSize(2000)` 修正） |
| **52919** | 网络 | 再次 reload：`/x/player/wbi/playurl`，`qn=64`、**`initiator: fetch`**、`w_rid` 不存在 |
| 三次后 | 回调 | `cbHits=2`, `lastRespCode=0`, `lastStage='cb'`, `rewritten=3` |

---

## 3. 关键判据逐条对照

| 判据 | A 真接管应看到 | B DNR 原生应看到 | 实测 |
| --- | --- | --- | --- |
| `lastQuery` / `paramTypes` | 非空（回调走到 `festivalPlayUrl`） | 全空 | COLMO-A 非空；COLMO-2 / bnj 首波全空，重挂后非空 |
| `lastRespCode` / `lastStatus` | `0` / `200` | `null` / `-1` | COLMO-A `0/200`；COLMO-2 / bnj 首波 `null/-1`，重挂后 `0/200` |
| `cbHits` | ≥1 | 0 | COLMO-A `1`；COLMO-2 / bnj 首波 `0`，重挂后 ≥1 |
| `initiatorType` | `fetch`（回调用 `nativeFetch`） | `xmlhttprequest`（播放器默认） | COLMO-A `fetch`；COLMO-2 / bnj 首波 `xmlhttprequest`，重挂后 `fetch` |
| `w_rid` 在 URL 上 | 可能不在（播放器把签名 params 交给回调，回调按 params 拼串；本轮实测三次 fetch 都没有 `w_rid` 键） | 在（播放器自己拼的默认 URL） | 三次首波/二次观测与预期一致 |
| `rewritten`（PCDN 换 authority） | >0（只在回调解析完我们 fetch 的 json 后累加） | 0 | COLMO-A `4`；COLMO-2 / bnj 首波 `0`，重挂后 `6/3` |
| `lastStage` | 停在 `cb`（成功） | 停在 `hooked`（只装了空 requestConfig） | 完全一致；**`hooked` 会掩盖曾发生的竞争** |
| 画面 | 来自我们返回的 dash | 播放器原生取流 | 三次都是真实起播（readyState=4）；COLMO-A 2160p/qn120，B 首波 720p/qn64 |

---

## 4. 时序竞争验证（确认 team-lead 的推断，并补一条修正）

- **COLMO-A**：`remounts=0`、`cbHits=1`，首条 playurl 是 `fetch` → `cfgEnabled && rewriteGate` 在 `createPlayer` 之前就已成立，`festivalAttach` 第一次就挂上真回调。
- **COLMO-2 / bnj**：`remounts=1`、`cbHits=0`、`lastStage='hooked'`、首条 playurl 是 `xmlhttprequest` → `createPlayer` 先到，`festivalAttach` 因门控未开只建了空 `requestConfig` 并返回 `false`（`:1050-1053`）；播放器随后自己 XHR 取流；之后 `festivalMaybeActivate()`（`:1146`）补挂回调并把 `lastStage` **覆盖回 `hooked`**。所以最终埋点看起来"已接管"，但首波流其实不是我们的。
- **修正一条**：用户复验那次是 `cbHits:1 + lastQuery:''`，而我们这两轮 B 是 `cbHits:0 + lastQuery:''`——两种都指向"首波不是我们的流"，但 `cbHits` 是否为 1 取决于回调是否曾在门控关闭时被调过（若调到，`skip-gate-at-cb` → fallback 也会让 `cbHits=1`）。不要只用 `cbHits` 判接管，**必须同时看 `lastQuery`/`lastRespCode` 和 Resource Timing 的 initiator**。
- 触发 `player.reload()` 后，两轮 B 都立即变成 `initiator: fetch` + `cbHits` 增长，说明**重挂后的回调是有效的**，不是"永远接不上"。

---

## 5. 4K 登录态

- COLMO-A 首波：`qn=120`、`newQ=120`、`videoHeight=2160`、`rewritten=4`、`lastRespCode=0` → 我们 fetch 并解析的那份响应对应 4K 轨；`rewritten` 只有在回调内 `filterDashOf(json.data)` 执行后才会增长（`main-world.js:1014-1018`），这是"响应确实经过我们手"的最硬证据。
- B 首波：`qn=64`、`newQ=64`、`videoHeight=720`、`rewritten=0` → 播放器原生取流，未经过我们的 PCDN 改写。
- ⚠️ 局限：bsk debug 没抓到 playurl 响应体，所以**没有直接打印 `dash.video[].id=120`**；4K 结论由 `lastRespCode=0 + rewritten>0 + qn=120 + getQuality()/videoHeight` 间接成立。另外两轮请求的 `qn` 不同（120 vs 64），画质差异不能全部归因于接管与否；但 `rewritten` 的 0 vs 正值只由回调路径决定。

---

## 6. 对当前收益的直白表述

**当首波是 B 时（本轮 COLMO 第 2 次、bnj，以及用户复验那次的现象）：真接管未发生。** 此时的收益只有：

1. DNR 换 Cookie 换到的官方线路（视频能正常播、面板显示"已接管"）；
2. 面板/埋点链路正确（hook 装上了、`remounts=1`）。

而**画质解锁、PCDN 换 authority 在首波没有生效**（`rewritten=0`）。要等 `player.reload()` / 切集 / 播放器重试带来的后续取流，才轮到我们的回调（`rewritten` 增长、`initiator: fetch`）。

若要把 A 变成首波确定事件，方向不是"再挂一次回调"，而是**在 `festivalMaybeActivate` 补挂成功后主动触发一次取流刷新**（让首波被我们的请求取代）——本次未改产品代码，仅记录观测与方向。

---

## 7. 局限与未覆盖

- bsk 0.5.0 无法 `document_start` 注入，首波 `createPlayer` 没有独立时间戳；时序由 `createCalls` + 首条 playurl `startTime` + 埋点反推。
- `bsk debug` 抓包覆盖 `initial_load_not_recorded`，且未录到 playurl；网络线完全依赖 Resource Timing。
- Resource Timing 缓冲默认 300 条，bnj 第一次 reload 的 fetch 因此漏记；已用 `setResourceTimingBufferSize(2000)` 修正后复测。
- 二次/三次取流由 `player.reload()`（及一次 `requestQuality(64)`）人工触发，不是用户真实点清晰度；切集 SPA 场景本轮未重复测（上一轮 `REPORT-nano.md` 已覆盖回调重挂机制）。
- 没有直接抓到响应体中的 `dash.video[].id=120`，见 §5。
- 未改任何产品代码 / 测试 / 守卫，未 commit；三个 bsk 会话全部关闭。

---

## 8. 产物

- 报告：`poc/probe/festival/REPORT-handoff.md`
- 证据：`poc/probe/festival/result-handoff-timeline.json`
- 表达式：`expr/handoff-snapshot.js`、`expr/playurl-resource-timing.js`、`expr/resource-all-api.js`、`expr/trigger-quality.js`、`expr/trigger-reload.js`、`expr/reload-big-buffer.js`

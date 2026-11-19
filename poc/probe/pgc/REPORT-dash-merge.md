# PGC 番剧 dash 合并起播 + prefetch + 门控窗口（S0 补测）

> 日期：2026-11-18　执行：probe-festival-nano
> 环境：Q1/Q2 Playwright `addInitScript`（guest，无扩展）；Q3 bsk 0.5.0 + 真实登录 Edge + `.output/chrome-mv3`。
> 边界：**未改** `src/`、测试、守卫，**未 commit**。Cookie / mid / ep 号 / 番剧名 / 签名 URL 不写入正文。
> 页面：Q1/Q2「番剧 A」（`/bangumi/play/ss<已脱敏>`，SSR dash 2939s；登录态实测 quality 112，Q1 guest 实测 quality 32）；Q3 同页冷加载。
> 证据：`poc/probe/result-pgc-sync-merged-dash-keep.json`、`result-pgc-sync-merged-dash-keep-prefetch.json`、`poc/probe/pgc/result-pgc-gate.json`。

---

## 1. 结论

1. **Q1：通过。** 番剧 dash 合并后：`readyState=4`、`duration=3076s`（原片 2939s，我们给 `timelength/dash.duration` 加了 137s 标记，播放器跟着变成 3076s → 证明吃的是我们这份）、`currentSrc=blob:`（MSE/dash，不是 durl）、`MediaError=null`；`video_info` 中 `durl/durls` 已删除（`hasDurl=false`、`durlGroups=0`）。`videoHeight=360` 与 guest 基线一致，不能单独当证据，所以用 137s 时长标记做判据。
2. **Q2：必须清 `config.prefetch.playUrl`。** 保留它 → `cbHits=0`，播放器直接用 prefetch 的流（首条 m4s @911ms），我们的回调一次都没被调；删除它 → `cbHits=1`，回调 fetch 生效（首条 m4s @1179ms）。
3. **Q3：`tGate - tCreate` p50 76ms / p90 119ms / max 131ms（8 次冷加载）。** 同步回调约在 create+85ms 被调（Q1 实测），实际需要等待 p50 −9 / p90 34 / max 46ms。建议 `PGC_GATE_WAIT_MS=300ms`（约为 max 的 2.3 倍，且远早于播放器原生起播）。

---

## 2. Q1：番剧 dash 合并起播

### 2.1 探针写法

- Playwright `addInitScript` 拦 `window.nano` setter → 包住 `createPlayer`；
- **保留原 `config.requestConfig` 对象**（含 `reqHttpPlayUrlInfoScope`），只替换 `reqHttpPlayUrlInfo`；
- 回调 cid 取 `window.__playinfo__.result.arc.cid`（`params.cid` 是 null）；
- 自取 `/pgc/player/web/playurl?cid=…&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`；
- 以 SSR `result` 为骨架，只搬白名单字段；**有 dash 时 `delete video_info.durl` / `durls`**；
- 返回 `{data:{code:0,result:合并后的 result}, headers:{}, status:200}`。

### 2.2 结果（`result-pgc-sync-merged-dash-keep.json`）

| 观测 | 值 |
| --- | --- |
| `cbHits` | **1** |
| 接口 HTTP/code | 200 / 0 |
| 接口 `hasDash` | **true** |
| 接口 `dash.duration` | **2939** |
| 接口 `timelength`（原始） | 2,938,236ms |
| 接口 `dash` heights | `[480,480,480,360,360,360]` |
| 接口 `quality` | **32**（guest） |
| 接口 `durlGroups` | **0** |
| **我们加的时长标记** | `timelength +137,000`、`dash.duration +137` |
| 合并后 `video_info` 键 | `quality, timelength, format, dash, accept_quality, accept_description, support_formats, video_codecid, fnval` |
| 合并后 `hasDash` / `hasDurl` / `durlGroups` | true / **false** / **0** |
| 合并后 `timelength` / `dash.duration` / `dashVideoCount` | 3,075,236 / **3076** / 6 |
| `video.readyState` | **4** |
| `video.duration` | **3076s**（原片 2939s + 我们标记的 137s） |
| `video.videoHeight` / `videoWidth` | 360 / 640 |
| `video.currentSrc` | `blob:https://www.bilibili.com/<uuid>`（MSE/dash，不是 durl） |
| `video.error` | null |
| 控制台 | 只有若干 `ERR_CONNECTION_CLOSED`（媒体分片），无 `flv.js`/HLS 报错 |

**判定通过**。证明「播放器消费了我们这份」用的是**时长标记**：本页 guest 的 SSR 与接口都是 `quality=32`、播放高度也都是 360，单看高度分不清；把 `timelength` / `dash.duration` 从 2939 改成 3076 后，`video.duration` 跟着变成 **3076s**——播放器读的是我们合并后的元数据。（活动页当时 duration 不跟，PGC 这条跟，说明 PGC 的播放器确实按 `video_info.timelength/dash.duration` 建时长。）

### 2.3 失败/对照（同机制的历史证据）

上一轮电影 durl 页已实测：
- 直接返回接口扁平 json → `readyState=0`、`duration=null`；
- 用户提议的 `{data:{code:0,data:{durl:[...]}}}` → `readyState=0`、`MediaError.code=4`、`[flv.js] Non-FLV`。

→ 合并语义必须是 **SSR 骨架 + `video_info` 白名单字段**；durl 场景也是同一结论。

⚠️ 本页 SSR 自身 `durlGroups=0`，所以**「不删 durl 会不会回退到 360s 试看」在本页无法对照验证**（没有 SSR durl 可回退）。删除逻辑按方案实现并验证了结果 keys 中无 `durl/durls`；要验「不删」的反例，需要主账号无权益、SSR 为 preview durl 的页面，本轮没有。

---

## 3. Q2：`prefetch.playUrl` 会不会抢跑

同一部番剧、同一探针、同一回调，只改「是否 `delete config.prefetch.playUrl`」：

| 情形 | `prefetchPlayUrl` | `cbHits` | 回调 fetch | 播放结果 | 首条 m4s |
| --- | --- | --- | --- | --- | --- |
| **保留**（`KEEP_PREFETCH=1`） | true | **0** | 无（`fetchInfo=null`） | `dur=2939, h=360, ready=4` | **@911ms**（prefetch 流） |
| **删除**（`result-pgc-sync-merged-dash-q2-keep.json`，同样带 137s 标记） | true → 删除 | **1** | code=0、hasDash=true | `dur=3076, h=360, ready=4` | **@1179ms**（回调返回后） |

> 保留轮没加时长标记（原片 2939s）；删除轮加了 137s 标记（3076s）。两轮 `h=360`，但 `cbHits` 0 vs 1 是决定性的。

**结论：实现必须清 `config.prefetch.playUrl`。** 保留时回调完全不被调用，播放器直接吃 prefetch 数据；prefetch 那份也是 360p，无法保证是扩展账号的完整/更高质量流。

---

## 4. Q3：PGC 冷启动门控窗口

### 4.1 方法

- 同名弹窗 + 父页面 **Worker 5ms** 跨窗口轮询（普通 `setInterval` 后台会被节流到 1s）；
- 每轮 `location.replace()` 到带 nonce 的 PGC URL（新文档、硬加载；sessionStorage 空，`ssHit=false`，不会读缓存）；
- `tCreate` = `__PLUMA_PGC__.createPlayerCalls` 首次 >0；`tGate` 代理 = `cfgCount>0 && lastCfgEnabled===true` 首次成立（冷启动无缓存时，这条就是 `page/activate` 回包后的门控 cfg）；
- `tFirstCb` 未在 bsk 侧直接拿到（见 §5），用 Q1 实测的 **create→回调 85ms** 估算。

### 4.2 8 次原始数据（ms，子窗口 `performance.now()`）

| # | tCreate | tGate | tGate−tCreate | 估算 tFirstCb=tCreate+85 | 估算等待 |
| --- | --- | --- | --- | --- | --- |
| 0 | 582 | 284 | **−298** | 667 | 0 |
| 1 | 671 | 301 | **−370** | 756 | 0 |
| 2 | 457 | 311 | **−146** | 542 | 0 |
| 3 | 545 | 634 | **+89** | 630 | +4 |
| 4 | 553 | 636 | **+83** | 638 | −2 |
| 5 | 541 | 672 | **+131** | 626 | **+46** |
| 6 | 585 | 704 | **+119** | 670 | +34 |
| 7 | 454 | 530 | **+76** | 539 | −9 |

**分布**

| 量 | min | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| `tCreate` | 454 | **545** | 585 | 671 |
| `tGate` | 284 | **530** | 672 | 704 |
| **`tGate − tCreate`** | −370 | **76** | **119** | **131** |
| 估算同步回调等待 | 0 | **0（p50 −9）** | **34** | **46** |

> 负值 = 门控在 `createPlayer` 之前就已经到了；等待按 0 算。

### 4.3 建议 `PGC_GATE_WAIT_MS`

**300ms**。理由：
- 实测最大等待仅 **46ms**（p90 34ms），300ms 有约 6.5 倍余量；
- PGC 的 `createPlayer` 在 454–671ms，回调后自取流约 300ms，300ms 等待仍在播放器出首帧之前；
- 不建议再用 300ms 以下的紧值（例如 100ms）——虽然覆盖本次数据，但 PGC 的 `page/activate` 要解密凭据，SW 冷启动可能比本次更慢；300ms 是安全且无感的折中。

---

## 5. 测不出 / 有歧义

- **bsk 侧没拿到真实 `tFirstCb`**：尝试在父页面 255ms 给子窗口装 `nano` setter，`nanoHookAt=255` 成功，但页面 366ms 的 `createPlayer` 没有走我们的 accessor（`tCreateExact=null`、`cbInjected=false`）——页面/产品侧的 `nano` 引用不是我们能稳定劫持的那个对象。报告中的 `tFirstCb` 是 **tCreate + 85ms 的估算**（85ms 来自 Q1 在同一番剧 dash 页的实测 create 704ms → 回调 789ms）。
- **Q1 的「不删 durl」反例没测**：本页 SSR `durlGroups=0`，没有可回退的 durl；要验证删除必要性需要 preview durl 页面（主账号无权益 / 未购买），本轮没有。
- **Q2 的「保留 prefetch 时首条 m4s 来源画质」无法从高度判断**：保留时 `h=360`，但本页 guest 的 SSR 基线也是 360；只能说「回调没被调用 + 首条 m4s 更早」，不能证明 prefetch 的画质或身份。
- Q1 控制台有若干 `ERR_CONNECTION_CLOSED` 媒体分片错误，但播放正常（readyState=4）；未定位具体 CDN，不影响 dash 合并结论。

---

## 6. 产物

- 报告：`poc/probe/pgc/REPORT-dash-merge.md`
- 证据：
  - `poc/probe/result-pgc-sync-merged-dash-keep.json`（Q1 通过，带 137s 时长标记）
  - `poc/probe/result-pgc-sync-merged-dash-keep-prefetch.json`（Q2 保留 prefetch）
  - `poc/probe/result-pgc-sync-merged-dash-q2-keep.json`（Q2 删除 prefetch）
  - `poc/probe/pgc/result-pgc-gate.json`（Q3 8 次原始数据）
- 脚本：
  - `poc/probe/pgc-sync-inject.cjs`（新增 `merged-dash` / `KEEP_PREFETCH`）
  - `poc/probe/pgc/pgc-popup-install.js`、`pgc-popup-read.js`、`pgc-gate-runs.mjs`（Q3）
  - `poc/probe/pgc/pgc-popup-install-cb.js`（tFirstCb 精确劫持尝试，失败）
- bsk 会话 `rqag` 已关闭；未改产品代码 / 测试 / 守卫，未 commit。
- `node scripts/check-tools.mjs` 通过（315 个脚本全部有归属，`poc/probe/pgc/` 走目录级登记），本轮不需要新增登记。

# 番剧 / 国创（PGC）页：同步注入取流回调可行性

> 日期：2026-11-18　执行：probe-festival-nano
> 环境：Playwright `addInitScript`（Q1，guest 免费电影，无扩展）；bsk 0.5.0 + 真实登录 Edge + `.output/chrome-mv3`（Q2/Q3）。
> 边界：**未改** `src/`、测试、守卫，**未 commit**。Cookie / mid / 签名 URL / 番剧名 / cid·ep_id 数字均不写入正文。
> 页面：Q1 用「电影 B（ss<已脱敏>，游客可看试看）」；Q3 用「番剧 A（ss<已脱敏>）」。
> 证据：`poc/probe/result-pgc-sync-*.json`、`poc/probe/pgc/result-progress.json`。

---

## 1. 结论

1. **Q1：会被调用，但有前提。** 保留原 `config.requestConfig` 对象（尤其 `reqHttpPlayUrlInfoScope`），只同步替换 `reqHttpPlayUrlInfo` → stub 模式 `cbHits=4`、真实取流 `cbHits=1` 且正常起播；**若把整个 `config.requestConfig` 换成新对象（丢掉 scope），`cbHits=0`，播放器转去请求 `/pgc/player/web/v2/playurl`**。durl 响应必须按 SSR 骨架合并；直接返回接口扁平 json，或用户提议的 `{data:{code:0,data:{durl:[...]}}}` 都是黑屏。
2. **Q2：`/pgc/player/web/playurl` 在 DNR 白名单内。** `routes.ts:118-122` `enabled: true`；`dnr.ts:849-852` 的 `PLAYURL_PATH_BY_KIND.pgc` 就是它，标签页规则在 `dnr.ts:912-925` 按 `requestDomains: BILI_API_HOSTS` + `resourceTypes:['xmlhttprequest']` + `tabIds` 换 Cookie。真机 m4s 的 `mid` 与页面主账号不同 → 取到的是扩展账号身份。
3. **Q3：没有复现活动页那种进度回拽。** 番剧 A：SSR `watch_progress=1,035,000ms` → 首读 `video.currentTime≈1070s`；强制走产品缓存注入（扩展账号 quality 80 流）后，SSR 进度 `1,202,000ms` → 重载 10s 时 `currentTime≈1217s`，时长 1441s。PGC playurl 响应里**没有 `last_play_time` / `last_play_cid` 字段**，进度仍来自 SSR `watch_progress`，产品注入只搬 `video_info` 的流字段，不覆盖 `watch_progress`。

---

## 2. ADR 0019 当年的实验 vs 本次

ADR 0019 顶部写「hook `requestConfig.reqHttpPlayUrlInfo` → 回调从未被调用（`cbCalled:0`）」；但同一份 ADR 的 R4 又写 `poc-pgc-inject.cjs` 能起播。两者不矛盾——**失败的是产品实现的那次注入，不是播放器不支持回调**。

| 维度 | 2026-10-28 产品实现（`cbCalled:0`） | 本次 Q1 |
| --- | --- | --- |
| 注入通道 | `world:'MAIN'` 内容脚本 `document_start`，但仍可能晚于页面内联脚本（ADR 0019「注入方式三次修正」） | Playwright `addInitScript`，保证在页面任何脚本之前执行 |
| 写哪里 | 产品在 `__playinfo__` setter / `sessionStorage` 缓存链路里注入；`createPlayer` 包装只做计时 | **在 `createPlayer(config)` 返回之前**直接写 `config.requestConfig.reqHttpPlayUrlInfo` |
| 包装是否被真实调用 | 真机 `nano.__plumaPgcWrapped=true`，但 `[PGC] takeover` 日志没有 → **包装没被页面那次真实调用触发** | `createCalls=1`，随后回调被调用（stub 4 次 / real 1 次） |
| 对象处理 | — | 保留 `reqHttpPlayUrlInfoScope`；替换整个 `requestConfig` 会静默失效 |
| 结论边界 | 失败原因是「hook 没抢到那一次 `createPlayer`」 | 本次证明「抢到之后，同步替换回调会被播放器调用」 |

> 所以 ADR 0019 的否定结论**不能推广成「PGC 播放器不认异步回调」**；它只说明当时的注入时序没抢到。旧 `poc/verify/poc-pgc-inject.cjs`（R4）其实已经证明机制可行，本次只是把「同步 + 保留 scope」这个条件补全。

---

## 3. Q1 证据

### 3.1 config 形状（电影 B，`createPlayer #1 @886ms`）

```text
config keys: element, auxiliary, kind, enableAV1, enableHEVC, revision, i18n,
             featureList, seasonId, t, fromDid, replyDid, stats, prefetch, requestConfig
prefetch keys: playUrl
requestConfig keys: reqHttpPlayUrlInfoScope, reqHttpPlayUrlInfo
origCb: true
```

→ PGC 页确实有 `prefetch.playUrl` 和 `reqHttpPlayUrlInfo`；**`reqHttpPlayUrlInfoScope` 是必须保留的字段**。

### 3.2 两种同步写法对比

| 写法 | cbHits | 页面原生 playurl XHR | 结果 |
| --- | --- | --- | --- |
| `config.requestConfig = { reqHttpPlayUrlInfo: fn }`（整个对象替换） | **0** | `/pgc/player/web/v2/playurl` @954ms | 播放器走原生预览流（360s/358p），回调完全没被调用 |
| 保留原对象，只 `rc.reqHttpPlayUrlInfo = fn`（stub 抛错） | **4**（抛错后播放器每 5–8s 重试） | 0 | 证明回调被调用；黑屏是预期 |
| 保留原对象，只换函数（真实取流 + SSR 合并） | **1** | 0 | `t=19s, dur=360, h=358, w=855, readyState=4, err=null` |

### 3.3 回调 `params`（脱敏）

20 个键：

```text
avid, bvid, cid, qn, fnver, fnval, fourk, gaia_source, from_client,
is_main_page, need_fragment, season_id, isGaiaAvoided, cur_language,
cur_production_type, client_attr, version_name, app_id, session, drm_tech_type
```

值/类型要点：
- **`avid` / `bvid` / `cid` 全是 `null`**（不是数字）；**没有 `ep_id`**；
- `season_id` 是 number（`<已脱敏>`）；
- `qn=0`、`fnver=0`、`fnval=4048`、`fourk=1`、`drm_tech_type=2`；
- 类型是 number/boolean/object（`avid/cid` 为 object=null），不是全字符串。

→ PGC 回调**不能从 params 拿 cid**；必须用 SSR 的 `__playinfo__.result.arc.cid`（或 ep→cid 映射）。旧 PoC 正是这么做的。

### 3.4 返回体形状：只有 SSR 骨架能播

| 返回形状 | 结果 |
| --- | --- |
| 接口扁平 json：`{data: {code:0, result:{durls:[...], quality, timelength,...}}, headers, status}` | `readyState=0`, `duration=null`, 黑屏；m4s 有请求但 `<video>` 没起播 |
| 用户提议：`{data:{code:0, data:{durl:[...], quality, accept_quality, timelength}}}` | `readyState=0`, `MediaError.code=4`；控制台 `[flv.js] Non-FLV, Unsupported media type!` + `Cannot read properties of null (reading 'currentURL')` |
| **SSR 骨架合并**：以 `__playinfo__` 为骨架，把 `dash/durl/durls/quality/timelength/...` 搬进 `result.video_info` | ✅ `t=19s, dur=360, h=358, readyState=4, err=null`；接口返回 `durlGroups=4`, `timelength=6292774`, `quality=32`，播放器实际播 360s（试看） |

→ `{data:{code:0,data:{durl:[...]}}}` **不能**直接用；必须把 durl 放进 `result.video_info.durl/durls`（保留 SSR 嵌套形状）。

---

## 4. Q2 证据

- `src/shared/constants/routes.ts:42`：`BILI_API_HOSTS = [BILI_API_HOST, 'api.biliapi.net']`。
- `src/shared/constants/routes.ts:118-122`：

```ts
{ path: '/pgc/player/web/playurl', method: 'GET', label: '番剧 / 国创 / 电影取流（当前）', enabled: true, ... }
```

- `src/shared/constants/routes.ts:125-130`：`/pgc/player/web/v2/playurl` **enabled: false**（空壳，且开 DNR 会让流形态从 durl 变 dash 导致灰屏）。
- `src/platform/http/dnr.ts:849-852`：`pgc: '/pgc/player/web/playurl'`。
- `src/platform/http/dnr.ts:912-925`：标签页规则 `action.modifyHeaders.set cookie`，`condition.requestDomains = BILI_API_HOSTS`、`resourceTypes:['xmlhttprequest']`、`requestMethods:['get']`、`tabIds:[...]`。

真机核对：注入缓存后播放的 m4s 签名 URL 带 `mid`，与页面 `DedeUserID` **不同**（`anyM4sMatchMain=false`）→ 走的是扩展账号身份。响应 `quality=80`、`dash` 1080p、`timelength=1,440,083`、`is_preview=0`，说明该账号对这部有完整权益。

---

## 5. Q3：PGC 进度回拽

### 5.1 自然路径（主账号有权益）

| 项 | 值 |
| --- | --- |
| `play_video_type` | `whole`（不是 preview） |
| SSR `quality` / `timelength` | 112 / 1,440,083ms |
| SSR `watch_progress.current_progress` | **1,035,000ms** |
| `__PLUMA_PGC__` | `lastStage='boot'`, `patchedAt=-1`, `ssHit=false`, `cacheBytes=0` |
| `video.currentTime` 首读 | **1,070s**（差值 = 页面已播放约 35s） |

→ 主账号有权益时产品不接管，播放器用 SSR 的 whole 流，进度正常；这条不能暴露「扩展账号无观看记录」的问题。

### 5.2 强制走产品缓存注入（扩展账号完整流）

为了走到产品真实的注入路径（主账号有权益时它不会自然接管），把扩展账号的完整流按产品自己的 `sessionStorage` 格式写入 `pluma:pgc-vi:<cid>`，再 reload：

| 项 | 值 |
| --- | --- |
| 写入 | `bytes=92,070`；`apiQuality=80`；`timelength=1,440,083`；`dash` 1080p |
| reload 后 `__PLUMA_PGC__` | `patchedAt=432`, `lastStage='cfg-with-cache'`, `patchedInSetter=true`, `ssHit=true`, `cacheBytes=91,833`, `injectedFrom/To=1441` |
| SSR `watch_progress.current_progress` | **1,202,000ms** |
| `video.currentTime`（reload 后 10s） | **1,217s** |
| `video.duration` / `height` | 1441s / 1080 |
| m4s `mid` 与主账号 | 不同（扩展账号） |

→ **无回拽**：注入的是扩展账号的流（quality 80），但播放器仍从 ~20 分钟处起播。

### 5.3 为什么活动页会拽、PGC 不会

- 活动页：播放器自己发 `/x/player/wbi/playurl`，响应里有 `last_play_time`；取流账号没有观看记录 → `0`，播放器据此从头。
- PGC：`/pgc/player/web/playurl` 的 `result` 里**没有 `last_play_time`，也没有 `last_play_cid`**（实测 `resultKeys` 完整列表无这两个字段；`lastPlayTime=null`, `lastPlayCidPresent=false`）。进度在 SSR 的 `watch_progress.current_progress`，而产品注入只替换 `video_info` 的流字段（`main-world.js:2588-2605` 白名单：`dash/durl/durls/quality/timelength/accept_quality/...`），**不改 `watch_progress`**。

---

## 6. 测不出 / 有歧义

- **Q3 的自然 preview 场景没测到**：当前主账号是大会员，番剧 A 的 SSR 是 `whole`，产品不会自然接管；用产品自己的缓存格式强制注入来覆盖注入路径。真实「无权益 → preview → 扩展账号完整流」的场景需要非大会员主账号或未购买的付费内容，本次没有。
- **Q1 只测了 durl 路径**（电影 B，游客试看 4 组 durl）；番剧 dash 路径本轮未重跑（旧 `poc-pgc-inject.cjs` / ADR R4 已覆盖，但不在本次数据里）。
- **PGC 回调 params 缺 cid/ep_id** 是实测事实；要接实际集数必须依赖 SSR 的 `arc.cid` 或页面的 ep→cid 映射，不能只用 params。
- 替换整个 `config.requestConfig` 时播放器改走 `/pgc/player/web/v2/playurl`（该路径 `enabled:false`，不在 DNR 白名单）；这条只作为「丢 scope 会失败」的证据，不代表正常接管路径。
- 未直接读 Cookie 头（bsk 固定脱敏），身份用 m4s `mid` 代理；若流 URL 不带 `mid` 该判据失效。

---

## 7. 产物

- 报告：`poc/probe/pgc/REPORT-sync-callback.md`
- 证据：
  - `poc/probe/result-pgc-sync-stub.json`（整个 requestConfig 替换，cbHits=0）
  - `poc/probe/result-pgc-sync-stub-keep.json`（只换函数，cbHits=4）
  - `poc/probe/result-pgc-sync-merged-keep.json`（SSR 骨架合并，起播）
  - `poc/probe/result-pgc-sync-raw-keep.json`（扁平 json，黑屏）
  - `poc/probe/result-pgc-sync-wrapped-keep.json`（用户提议嵌套 data，黑屏 + MediaError 4）
  - `poc/probe/pgc/result-progress.json`（Q3 进度注入前后）
- 脚本：
  - `poc/probe/pgc-sync-inject.cjs`（Q1 四模式）
  - `poc/probe/pgc-facts.js`、`pgc-login-state.js`、`pgc-episodes.js`、`pgc-playurl-progress.js`、`pgc-seed-cache.js`（Q2/Q3）
- bsk 会话 `rpss` 已关闭；未改产品代码 / 测试 / 守卫，未 commit。

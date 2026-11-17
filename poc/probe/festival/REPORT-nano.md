# 活动页 `window.nano.createPlayer` 真接管流 —— 真机探针结论

> 探针对手：**ADR 0019 的否定结论是否适用于 `/festival/*`**。
> 日期：2026-11-18　执行：probe-festival-nano
> 环境：Playwright `playwright-core` + Chrome（`document_start` 注入，等价于 MV3 MAIN world 脚本），全新上下文（游客身份）；另用 bsk 0.5.0 在**登录态真实 Edge**做只读事实核对（未升级 bsk，会话已关闭）。
> 边界：**未改** `src/` 任何产品代码、测试、守卫，**未 commit**。所有签名 URL 均不写入正文；证据 JSON 中的 URL 已脱敏。
> 目标页：`https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn`（有真 4K）；对照 `bnj2026?bvid=BV1eoZ7BnEGy`。

---

## 0. 一句话总判断

**方案 B（nano 钩子真接管流）在活动页「可行，但需额外条件」**：`document_start` 挂 `window.nano` setter 能包住 `createPlayer`，在 config 上**新增** `requestConfig.reqHttpPlayUrlInfo` 后播放器确实调用它、并用它返回的 dash 起播（`videoHeight` 从 480 变成我们喂的 360）；但**原生 config 里没有任何 `prefetch` / 回调可改**（这是与 PGC 的根本差异），SPA 换 bvid 不会再次调用 `createPlayer`（必须改用 `player.updateRequestConfig` 重挂），且 `duration` 不随喂流数据变化。

> 所以：ADR 0019 当年"hook createPlayer 后 `cbCalled:0`"的否定结论**不能照搬到活动页**——但也不能照搬它的实现（`prefetch.playUrl` 那条路在这里根本不存在）。

---

## 1. 逐问实测结论

### Q1. 钩子点：`window.nano` setter 能否包住活动页的 `createPlayer`？

**结论：能，而且是同步抢到的。**

实测时序（`result-nano-shape.json` / `result-nano-shape-reads.json`）：

```text
660ms   nano set #1 = obj{}
660ms   createPlayer 已包装 (trackReads=true)
1134ms  createPlayer #1 called (this=nano)
1134ms  INITIAL_STATE.videoInfo.cid=42141027046 bvid=BV1ydeX65Edn
```

汇总计数：`nanoSets=1`、`createCalls=1`、`nano.createPlayer.__wrapped=true`、`window.nano` 的描述符存在、`cbHits`（原样透传轮）=0、`errors=[]`。
另一轮（`result-nano-inject-mark-timelength.json`）为 `884ms` 包装 / `2107ms` 调用；说明不同网络条件下绝对时刻会漂移，但**"赋值 → 包装 → 调用"的先后顺序稳定**。

播放器内核仍是 `s1.hdslb.com/bfs/static/player/main/core.61de1491.js`；`nano.createPlayer` 在 `nano` 的**原型**上，setter 收到的 `v` 自身 `Object.keys(v)` 为空——这与 PGC 一致，所以 hook 写法可复用。

---

### Q2. `createPlayer(config)` 的形状：有没有 `prefetch.playUrl` / `requestConfig.reqHttpPlayUrlInfo`？

**结论：都没有。这一条是活动页与 PGC 最大的结构差异。**

顶层键（实测，共 15 个）：

```text
aid, cid, bvid, stats, revision, featureList,
enableAV1, enableWMP, enableHEVC, hideBoxShadow,
t, kind, element, auxiliary, iid
```

其中 `kind=0`、`iid='LargeEventsPlayer'`、`element` 与 `auxiliary` 都是真实 DOM `<div>`；`cid=42141027046` 与 `__INITIAL_STATE__.videoInfo.cid` 一致（可直接从 config 取 cid，不必读 SSR）。

用顶层 Proxy 记录播放器实际读取的键（`READS=1`，`result-nano-shape-reads.json`）：

```text
config.aid, config.cid, config.bvid, config.stats, config.revision,
config.featureList, config.enableAV1, config.enableWMP, config.enableHEVC,
config.hideBoxShadow, config.t, config.kind, config.element,
config.auxiliary, config.iid
```

**没有**任何 `prefetch` / `playUrl` / `requestConfig` 读取。

```text
prefetch=undefined:undefined
prefetch.playUrl=undefined:undefined
requestConfig=undefined:undefined
reqHttpPlayUrlInfo=undefined:undefined
!! 没有 requestConfig.reqHttpPlayUrlInfo
```

⚠️ 探针踩坑（如实记录）：给 `element`/`auxiliary` 这两个 DOM 节点再套一层 Proxy 会让播放器报 `Maximum call stack size exceeded` 且不装载；去掉嵌套 Proxy 后播放正常。**这只影响探针写法，不是产品结论。**

内核静态佐证（`core.61de1491.js`）：

```js
// getPlayUrlConfig
requestFunc: this.configStore?.requestConfig?.reqHttpPlayUrlInfo
// requestDefault 的替代分支
r = t.requestFunc;
i = omit(t, ['requestFunc']);
return (r ? r(e, t) : this.requestDefault(e, i)).then(e => this.parse(e));
```

→ 播放器**支持** `requestConfig.reqHttpPlayUrlInfo`，只是活动页页面代码没有提供它。

---

### Q3. 删掉 `prefetch.playUrl` 会不会回退到回调？

**结论：这个问题在活动页不成立——没有 prefetch 可删；"默认就走网络取流"，而新增回调会被优先采用。**

- 原样透传轮（`result-nano-deep.json`）：播放器在 `2147ms` 自己发 XHR：

```text
XHR playurl /x/player/wbi/playurl qn=0 fnval=4048 fourk=1
stack: XMLHttpRequest.open → core.61de1491.js:259:2743
       → xhr (:259:1744) → e.Ge (:259:5282)
```

页面侧只发这一次 playurl；随后 `2359ms` 起才拉 `.m4s`。播放器 `duration=733 / height=480 / readyState=4`。

- 注入轮：`cbHits=1`，且 `net.playurlXHR=1`（**只有我们回调里的那一次 fetch**，没有第二次播放器原生 XHR）。回调签名被调用时携带的 params：

```text
avid,bvid,cid,qn,fnver,fnval,fourk,gaia_source,from_client,
is_main_page,need_fragment,season_id,isGaiaAvoided,cur_language,
cur_production_type,client_attr,version_name,app_id,session
```

→ 取流参数（含 `w_rid`/`wts` 等签名）由播放器生成并作为参数交给我们，**无需扩展自己算签**。
→ PGC 的 R3（删 prefetch → `hits 0→1`）在这里的等价命题是 **"补 requestConfig → 默认 XHR 被替换成回调"**，已验证成立。

---

### Q4. 喂流能不能播？`duration` / `videoHeight` 是否来自我们喂的数据？

**结论：能播；`videoHeight` 明确来自我们喂的数据，`duration` 明确不来自我们改的元数据字段。**

回调实现：`fetch('https://api.bilibili.com/x/player/wbi/playurl?' + URLSearchParams(params), {credentials:'include'})` → `await r.json()` → 返回 **`{ data: j, headers: {}, status: r.status }`**（`data` 这一层不能少，与内核 `requestDefault` 形状对齐）。

三轮实测（证据文件见末尾）：

| 轮次 | 我们改动 | 回调/网络 | 播放状态 | 判据 |
| --- | --- | --- | --- | --- |
| 仅标记 `timelength` | `732309 → 869309` | `cbHits=1`, code=0, `net.playurlXHR=1`, m4s=44 | `t=21, dur=733, h=480, ready=4, err=null`, errors=[] | 起播成功 |
| 标记 + 裁画质 | `timelength→869309`、`dash.duration 733→870`、`dash.video 6→3 (<=360)`、`quality=32` | `cbHits=1`, `net.playurlXHR=1`, m4s=37 | `t=20, dur=732, h=360, w=640, ready=4, err=null`, errors=[] | **高度跟数据走** |
| 加查嵌套 `result` | 同上 + 尝试改 `data.result` | `resultKeys=['0','1','2','3']`（是数组，无 timelength） | `t≈20, dur=732, h=360, ready=4`, errors=[] | 排除嵌套字段 |

**高度证据**：过滤前后同一页面 `videoHeight` 由 **480 → 360**，`videoWidth` 由 **852 → 640**，`dash.video` 由 6 条 → 3 条；无任何 console error / pageerror。足以证明播放器消费了我们返回的 dash。

**时长证据（否定项）**：把 `timelength` 加 137 秒、`dash.duration` 加 137 秒后，`video.duration` 仍是 **732/733 秒**，没有跟随。实测 SSR `__INITIAL_STATE__.videoInfo.pages[0].duration = 733`；登录态同一页也是 `duration=732`、3840×2160。结论：**duration 由 SSR 分 P 时长 / MPD 分段决定，不由我们喂的这两个元数据字段决定**。若方案 B 依赖"换流后改变总时长"（例如 PGC 试看→完整集那种），活动页上这一点不能指望。

**登录态 / 4K 限定（如实说明）**：bsk 在真实登录 Edge 上只读实测到 `login=true`、`vipStatus=1`、`3840×2160`、`quality.newQ=120`、`supportedQuality` 6 档含 120；`nano.prefetch` 是 `function Mn(e,t)` 型的 promise 缓存（`prefetchOwnKeys=[]`），**不是** SSR 预置流数据。但本次注入实验用的是 Playwright 全新上下文（游客，dash 高度仅 480/360）：bsk 0.5.0 不能在 `document_start` 注入 init script，而复制 Edge `Cookies` 文件时被运行中的浏览器独占而失败，因此**4K 登录态下的回调注入未直接跑通**。机制与身份无关，但这条限定不能隐去。

---

### Q5. SPA 换 bvid：是否复用同一 nano 实例？`createPlayer` 会不会再调？

**结论：复用同一实例，`createPlayer` 不再调用；注入过的回调也不会自动重挂，但 `player.updateRequestConfig` 可以补挂并生效。**

活动页 DOM 中没有可用的 `/festival/...?bvid=` 链接（`links=[]`），因此用 `history.pushState` + `dispatchEvent(popstate)` 做**合成 SPA 切换**（页面状态确实随之变化，故可作为路由行为证据，但不是用户点链接的原生路径）。

`result-nano-spa.json`：

```text
before: createCalls=1, cb1=1, cid=42141027046, dur=733, h=480
arm:    player.updateRequestConfig({reqHttpPlayUrlInfo: cb2}) → ok
after:  createCalls=1, cb1=1, cb2=1,
        nanoSets=1, nanoStillWrapped=true, samePlayer=true,
        cid=36059286363, bvid=BV1eoZ7BnEGy,
        dur=248, h=360, t=12, readyState=4

events:
  1278ms createPlayer #1 cid=42141027046
  1330ms ★ cb1 被调用 #1
  1669ms cb1 自取流 code=0 cid=42141027046
 14126ms ★ cb2 被调用 #1
 14227ms cb2 自取流 code=0 cid=36059286363
```

即：换集后新 cid 的取流确实走了我们后挂的回调；**若不补挂，播放器会用默认 XHR 取新流**（cb1 没有第二次触发）。

两个诚实的负面观测：
- 切换后页面报 `pageerror: undefined` 与 `Uncaught (in promise) undefined`（`result-nano-instance.json` 同样出现）。播放器仍正常出画（readyState=4），但 SPA 路径不能说"零错误"。
- `updateRequestConfig` 在**原生未注入**的页面上调用会抛 `TypeError: Cannot convert undefined or null to object`（内核实现是 `Object.assign(this.primary.requestConfig, e)`，而原生页面 `requestConfig` 为 undefined）。它能成功，是因为我们先前在 `createPlayer` 里创建了 `config.requestConfig`。→ **重挂只能在"首次已注入"的前提下成立**。

---

## 2. 活动页 vs 当年 PGC：同一问题的差异对照

| 问题 | 活动页 `/festival/*`（本次实测） | 当年 PGC `/bangumi/play/*`（ADR 0019 / `poc/verify/`） | 为什么不同 |
| --- | --- | --- | --- |
| 取流形态 | **仅 dash**（m4s），COLMO 登录态有 4K | SSR `prefetch` 是 **durl 试看**（360s）；有权益时接口才给 dash | 页面类型不同：活动页是 UGC 活动承载页，走标准 UGC playurl |
| 数据来源 | 无 `__playinfo__`；播放器自己 XHR `/x/player/wbi/playurl`（签名参数自带） | `playurlSSRData` 写进 HTML，`prefetch.playUrl` 同步灌给播放器 | 活动页 SSR 不提供 playinfo，取流必须走网络 |
| `config.prefetch.playUrl` | **不存在**（Proxy 读键里也没有） | 存在，是唯一入口 | 活动页没有 SSR 流可预取 |
| `config.requestConfig.reqHttpPlayUrlInfo` | 原生**不存在**，但可以新增；新增后被调用 1 次 | 存在；替换后被调用（R3） | 播放器内核同一份，都读 `configStore.requestConfig`；只是页面没填 |
| "删 prefetch 才回退" | **不适用**：默认就走网络；补回调即替换默认 XHR | 成立：保留 `hits=0`，删掉 `hits=1` | 一个没有 prefetch，一个有 |
| `createPlayer` 时机 | 包装 660–884ms、调用 1134–2107ms；SPA 换集**不再调用** | 调用极早且只有一次（409ms），无 SPA 复调问题 | 活动页有 SPA 路由，切集走同一 player 实例 |
| 注入后画面 | dash 高度随数据变（480→360），**duration 不变** | `poc-pgc-inject` 里 dur=360/h=358 来自注入的 durl | 活动页时长被 SSR 分 P 时长 / MPD 锁定 |
| ADR 0019 的否定 | **不适用**：`cbCalled=0` 的原因是 PGC 的 prefetch 短路，活动页没有这层 | 成立并导致方案废弃 | 结论的前提不同，不能跨页照搬 |

---

## 3. 若实施：时机与形状的要点（不写产品代码）

1. **注入时机**：必须在 `document_start` 的 MAIN world 用 `Object.defineProperty(window,'nano',{get,set})` 抢在页面赋值前挂上；setter 里**同步**替换 `v.createPlayer`。实测 `nano` 赋值到 `createPlayer` 调用之间只有约 0.5–1.2 秒，异步取配置会错过。
2. **形状**：`createPlayer(config)` 里若 `config.requestConfig` 不存在就新建，再赋 `reqHttpPlayUrlInfo`。回调签名是 `(params, config)`；用 `params` 原样构造 URL（含签名），`fetch(..., {credentials:'include'})`；返回 **`{data: <完整 json>, headers: {}, status}`**，不能只返回 json 本身。
3. **防御**：活动页目前没有 `prefetch.playUrl` / `config.playUrl`，但站点改版可能加上；稳妥做法是同时清掉这两个键，避免预取短路（PGC 当年的坑）。
4. **SPA 重挂**：换 bvid 时 `createPlayer` 不会再来；需在路由变化后调用 `player.updateRequestConfig({reqHttpPlayUrlInfo: fn})`（前提：首次注入已创建 `requestConfig`），并用回调拿到的 `params.cid` 校验是否新集，避免旧 cid 的数据串场。
5. **不要指望 duration**：`video.duration` 不随 `timelength` / `dash.duration` 变化；画质/流切换的验证判据请用 `videoHeight` / `getMediaInfo()`。
6. **不要在 config 上套深层 Proxy**：`element` / `auxiliary` 是 DOM 节点，代理会触发 `Maximum call stack size exceeded` 并让播放器不装载。
7. **身份仍由 DNR 负责**：本探针用页面自己的身份（游客）取流；正式实现沿已有白名单路径 `/x/player/wbi/playurl` 做扩展账号 Cookie 替换即可，不需要新 DNR 规则。4K 登录态注入未直接实测，实施时应补一次真机回归。

---

## 4. 改动与产物清单

新增（仅在 `poc/probe/festival/`，无产品代码改动）：

- 探针脚本：`nano-shape.cjs`、`nano-deep.cjs`、`nano-instance.cjs`、`nano-inject.cjs`、`nano-spa-inject.cjs`
- 表达式：`expr/nano-logged-in-facts.js`、`expr/nano-prefetch.js`、`expr/core-shape.js`、`expr/live-inject-install.js`
- 证据：`result-nano-shape.json`、`result-nano-shape-reads.json`、`result-nano-deep.json`（已删栈中 URL）、`result-nano-instance.json`、`result-nano-spa.json`、`result-nano-inject*.json`（3 轮标记实验）、`result-nano-logged-in.json`
- 本报告：`REPORT-nano.md`

**未改**：`src/`、测试、守卫、文档既有内容；**未 commit**。bsk 会话 `jmrr` 已关闭。

### 验证失败 / 未覆盖项（不掩饰）

- 嵌套 Proxy 导致栈溢出的一轮探针作废，已去掉后重跑。
- 登录态 4K 下的回调注入未跑通（bsk 无 document_start 注入；复制 Cookies 被浏览器独占）。
- SPA 切换是合成 `popstate`，不是原生链接点击；切换后有两个 `undefined` 类 pageerror。
- `duration` 标记实验为阴性结果，原因只定位到"不由这两个字段驱动"，未进一步追到具体代码行。

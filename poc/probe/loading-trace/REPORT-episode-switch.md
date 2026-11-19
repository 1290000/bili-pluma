# 番剧（PGC）换集时的三个时序/数值实测报告

> **探针任务，只读。** 未改 `src/` 任何代码、未改测试、未 commit。
> 所有脚本在 `poc/probe/loading-trace/`，所有落盘数据在仓库内 `.tmp/`（不含 query）。
>
> 本报告只回答三个问题，不给修改建议。

---

## 0. 实测环境

| 项 | 值 | 来源 |
| --- | --- | --- |
| 仓库 | `D:\Projects\Pluma` | — |
| bsk | `0.5.0` | `bsk --version` |
| 浏览器 | Edge `157.0.0.0` | `bsk status --json` |
| 扩展协议 / 扩展版本 | `1.9` / `0.5.0` | 同上 |
| 扩展 buildProof | `{probeVersion:2, swStartedAt:1795026893404}` | `ep-probe-bgtypes.js` 走 `streaming-probe` 桥读 `storage.local` |
| session / tab | `mglh` / `1673243194` | `bsk sync --json` |
| 页面 `performance.timeOrigin` | `1795026058990` | `ep-probe-pagestate.js` |
| 页面 | `www.bilibili.com/bangumi/play/ep341217` ⇄ `ep341218` ⇄ `ep341219` | 见下 |
| 内容 | 《魔女之旅》第 10 / 11 / 12 话，12 话全部带「会员」标记 | 选集区 `link "1 会员" … "12 会员"` |
| 画质 | 1080P（`video.height = 1080`），Pluma 显示「已接管」 | VOM + 快照 `video` |

**URL 只写骨架**（无 `upsig` / `deadline` / 任何签名 query）：

```
www.bilibili.com/bangumi/play/ep341217
www.bilibili.com/bangumi/play/ep341218
www.bilibili.com/bangumi/play/ep341219
```

**测量时间点**（`date -r <落盘文件>`，未自行推算）：

| 落盘文件 | 墙钟时间（+0800） | 内容 |
| --- | --- | --- |
| `.tmp/ep-switch-2.json` | 2026-11-19 02:29:04 | 轮 2 换集（→ ep341219） |
| `.tmp/ep-switch-3.json` | 2026-11-19 02:32:03 | 轮 3 换集（→ ep341218） |
| `.tmp/ep-switch-5.json` | 2026-11-19 02:43:47 | 轮 5 换集（→ ep341217） |
| `.tmp/ep-switch-6.json` | 2026-11-19 02:45:38 | 轮 6 换集（→ ep341218） |
| `.tmp/ep-panel-gap.json` | 2026-11-19 02:56:50 | 面板在空窗期打开的那一轮 |
| `.tmp/ep-reset-fine-1.json` | 2026-11-19 02:59:22 | **精细轮**（30ms 标记 × 40 + 20ms `hosts` 采样） |
| `.tmp/ep-switch-8.json` | 2026-11-19 03:01:03 | 轮 8 换集（干净轮） |
| `.tmp/ep-switch-9.json` | 2026-11-19 03:05:15 | 轮 9 换集（面板开着） |
| `.tmp/ep-clean-before/after.json` | 2026-11-19 03:03:30 / 03:03:54 | ext-patch 口令对照（无效样本，见 §5） |
| `bsk sync` 快照 | 2026-11-19 03:11–03:2x | 问题 3 的面板文案 |

**本表之后新加的测量**（03:11 之后，用于问题 2 的对照与问题 3 的复核）：

- ext-patch 口令复核：`ep-probe-extpatchtest.js`，`t = 3043694.3`
- hash-only 导航对照：`ep-probe-navigate-only.js`，`pushT = 4110565.0`
- 面板取数计数：`ep-probe-quiet.js` + `ep-probe-quiet-read.js`

---

## 1. 结论速览

| 问题 | Lead 的假设 | 实测判定 |
| --- | --- | --- |
| **1. reset 是否晚于新集首波 `.m4s`** | 是（reset 把已记的 `seg-req`/`hosts` 清掉） | **不成立，方向相反。** reset 恒在 `pushState` 后 **28.0–49.2ms**；新集首波 `.m4s` 恒在 **577.1–848.1ms** 之后 ⇒ reset 早于首波分片 **532.5–798.9ms**，不会清掉新集的 `seg-req`/`hosts` |
| **2. 换集后 `streamingProxied` 是否变回 `false`** | 是（只有 `refreshProxiedFlagAfterNavigation()` 会写，而它只在 `navigate` 事件里调；`pushState` 不触发 `navigate`） | **不成立。** Navigation API 的 `navigate` **确实**为 `pushState` 触发（`navigationType: 'push'`，比 `pushState` 晚 **0.6–1.6ms**）。换集后 `ext-patch` 会重新出现 ⇒ `streamingProxied === true` |
| **3. 时间轴首行 `t` 的量级** | 应是「页面加载后经过的时间」而非「本集内时间」 | **成立。** 首行 `t` 是**相对页面 `timeOrigin` 的绝对毫秒**；面板自己的尾注把它换算成 `时:分:秒` 直说 |

---

## 2. 问题 1：reset 在首波 `.m4s` 之前还是之后

### 2.1 六轮换集的完整时序（单位：ms，相对页面 `timeOrigin`）

| 轮 | 点击 t | `pushState` t | `navigate` t (type) | reset t（`hosts` 掉到 0） | **reset − push** | 新集首个 `.m4s` `startTime` | **m4s − push** | 首个 `seg-req` 事件 t | 空窗结束（`hosts` 回非空） | `seg-req` 进 state 滞后 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 439039.5 | 439070.1 | 439070.9 (push) | **439114.7** | **+44.6** | **439647.2** ¹ | **+577.1** | 439647.0 | 439711.8 | +64.8 |
| 3 | 643796.0 | 643836.2 | 643837.3 (push) | **643877.9** | **+41.7** | **644443.8** | **+607.6** | 644444.5 | 644521.7 | +77.2 |
| 5 | 1003269.4 | 1003306.6 | 1003308.2 (push) | **1003355.8** | **+49.2** | **1004154.7** | **+848.1** | 1004154.7 | 1004241.8 | +87.1 |
| 6 | 1456827.1 | 1456870.9 | 1456872.5 (push) | **1456913.2** | **+42.3** | **1457587.8** | **+716.9** | 1457587.8 | 1457694.7 | +106.9 |
| 8（干净） | 2390069.2 | 2390104.4 | 2390105.3 (push) | **2390132.4** | **+28.0** | **2390695.6** | **+591.2** | 2390695.6 | 2390768.1 | +72.5 |
| 9（面板开） | 2635711.7 | 2635734.8 | 2635735.4 (push) | **2635764.0** | **+29.2** | **2636402.4** | **+667.6** | 2636403.4 | 2636696.3 | **+292.9** |

¹ 轮 2 的探针是 v2 版，只留 `mediaFirst`（前 40 条），`media` 字段不存在。取「`path` 里 `cid` 属于新集（`268138564`）」的第一条：`s=439647.2`。核对：该值同时就是这一轮首个 `seg-req` 的 `t`（439647），两条路径一致。

**判定：reset 早于首波 `.m4s`。** 差值区间：

- `reset − pushState` = **28.0 … 49.2ms**（6/6 轮正值）
- `首个 .m4s − pushState` = **577.1 … 848.1ms**（6/6 轮正值）
- 每一轮里 `m4s − reset` 恒为正：532.5 / 565.9 / 798.9 / 674.6 / 563.2 / 638.4ms
- 最小的一对（轮 8）：reset 早于首波分片 **563.2ms**

⇒ **reset 不可能清掉新集的 `seg-req` / `hosts`** —— 那些事件在 reset 之后 0.53–0.80 秒才产生。

### 2.2 精细轮：reset 到底发生几次、在哪一刻

`ep-reset-fine-1.json`（`pushState` 后每 30ms 发一条无参 `/x/player/playurl` 标记，共 40 条；同时 20ms 采样 `hosts`/`nEvents`）：

```
pushStates: [{n:"pushState", t:2297284.9, to:"www.bilibili.com/bangumi/play/ep341217"}]
hostSegs:
  {tFrom:2289450.1, tTo:2297188.6, hostsLen:2, nEvents:4}   ← 换集前
  {tFrom:2297317.5, tTo:2297317.6, hostsLen:0, nEvents:0}   ← 空窗，跨度 0.1ms = 1 个采样点
  {tFrom:2297329.6, tTo:2298012.2, hostsLen:1, nEvents:23}
  {tFrom:2298050.8, tTo:2298050.8, hostsLen:2, nEvents:39}
  {tFrom:2298083.0, tTo:2303472.0, hostsLen:3, nEvents:85}
markers: 40 条，tSched 2297328.2 → 2298499.4，**全部 http=200**
```

原始数字：

- **reset = 2297317.5**（= pushState **+32.6ms**）
- **空窗只存在一个 20ms 采样点（2297317.5–2297317.6）**，即 <20ms 后 `hosts` 就已经重新非空
- 40 条标记覆盖 2297328.2 … 2298499.4（1.17s），**没有一条被清掉** ⇒ **1.2 秒内只发生了一次 reset**

### 2.3 空窗期面板会显示「还不知道走哪条线路」—— 但成因不是 reset 清数据

**先声明观测边界：** 我**没有**在任何一次 VOM 快照里直接抓到「还不知道走哪条线路」这七个字（`grep -l "还不知道走哪条线路" .tmp/*.json` 全部无命中）。原因见 §5.3 —— 面板入口按钮在换集后 200ms 内还没重建，用 `bsk click` 抢不进那 600–900ms 的空窗。

所以下面这段是**代码路径 + 实测数字**推出来的，不是直接看到的：

`describeSnapshotLine()`（`loading-pane.ts:287-293`）：

```ts
if (snapshot.actual !== null) return describeLine(snapshot.actual);
const unknownCount = snapshot.hosts.filter((h) => h.cls === 'unknown').length;
if (unknownCount === 0) return describeLine(null);      // → TITLE_UNKNOWN = '还不知道走哪条线路'
return { title: describeUnknownSource(unknownCount), tone: 'muted', marker: 'dashed' };
```

而空窗期的快照**实测**是 `hosts: []`、`actual: null`（见 §2.1 的 `edges[].events`、§2.2 的 `hostSegs`）⇒ `unknownCount = 0` ⇒ 走 `describeLine(null)` ⇒ `TITLE_UNKNOWN`（`:144`）。

**实测到的是「空窗期 `hosts` 为空」与「空窗期分片已在传输」这两件事实本身：**

**机制 A：`seg-req` 的 `t` 是 `startTime`，但事件要等 `responseEnd` 才进入 state。**

`loading-trace.ts:678-689`（`recordResource`）：

```ts
pushEvent(state, { t: entry.startTime,   stage: 'seg-req', host: resolved.host, kind: resolved.cls });
pushEvent(state, { t: entry.responseEnd, stage: 'seg-res', host: resolved.host, kind: resolved.cls });
```

`PerformanceObserver` 的回调**在资源完成后才触发** —— 所以一条 `seg-req` 的 `t` 可以远早于它「进入 `state`」的时刻。实测滞后量：

| 轮 | 首个 `seg-req` 的 `t` | 它进入 state（空窗结束） | **滞后** |
| --- | --- | --- | --- |
| 3 | 644444.5 | 644521.7 | 77.2ms |
| 5 | 1004154.7 | 1004241.8 | 87.1ms |
| 6 | 1457587.8 | 1457694.7 | 106.9ms |
| 8 | 2390695.6 | 2390768.1 | 72.5ms |
| **9** | **2636403.4** | **2636696.3** | **292.9ms** |

**机制 B（轮 9 的直接证据）：空窗期内新集分片已在传输，但 `hosts` 仍是 0。**

轮 9 的空窗是 `[2635764.0, 2636696.3)`（932.3ms）。这期间探针自己记录到的 `*.bilivideo.com` 请求（`media[]`，`startTime`/`responseEnd` 两条独立字段）：

```
s=2636403.4  e=2636690.7  cn-jsnt-ct-01-06.bilivideo.com/upgcxcode/08/82/265438208/265438208_nb2-1-30280.m4s
s=2636402.4  e=2636709.9  cn-jsnt-ct-01-06.bilivideo.com/upgcxcode/08/82/265438208/265438208_hr1-1-30125.m4s
```

即：**2636402.4 起新集的视频/音频分片已经在发、字节已经在流**，而在 2636402.4 → 2636690.7 这 **288ms** 里 `hosts` 长度仍然是 **0**。

同一现象在其它轮次一致（空窗内已发出的 `*.bilivideo.com` 条数）：

| 轮 | 空窗区间 | 空窗内发起的 `*.bilivideo.com` 请求 |
| --- | --- | --- |
| 3 | [643877.9, 644521.7) | 2 条（audio 644444.5 / video 644443.8） |
| 5 | [1003355.8, 1004241.8) | 2 条 |
| 6 | [1456913.2, 1457694.7) | 4 条 |
| 8 | [2390132.4, 2390768.1) | 2 条 |
| 9 | [2635764.0, 2636696.3) | 2 条 |

⇒ 在空窗里，**视频确实在播、分片确实在发，而快照里 `hosts` 是空的**。这是**实测**。由此推出「面板此刻渲染的是『还不知道走哪条线路』」是**代码路径推理**（`describeSnapshotLine()` 的三态判据），不是我直接看到的文案。

**机制 C（附加观察，样本不足）：播放器会预取下一集分片。**

精细轮里有一条 `seg-req` 的 `t = 2297156.1`，**比 `pushState`（2297284.9）早 128.8ms**。说明播放器在用户点击之前就已经在为下一集取流。**仅 1 次观测，未复现足够多次，不能定量。**

### 2.4 补充：reset 挂在什么信号上

`handlePlayPageNavigation()`（`entrypoints/content.ts:2702-2717`）先算 `playPageIdentity(destUrl)`，与当前 identity 相同就 `return false`（不 reset）。所以 reset 既不是"任何 `navigate`"，也不只是"任何 `pushState`"。

**对照实验**（`ep-probe-navigate-only.js`，03:2x 跑于 `ep341218`）：

```
pushT = 4110565.0  ← history.pushState(null, '', pathname + search + '#epa-hash-probe')

navigations:
  {t: 4110565.6, type: "push",     hash: "changed"}   ← 同 pathname，hash-only
  {t: 4111553.8, type: "traverse", hash: "changed"}   ← history.back() 撤销

hostSamples（每 120ms 采一次，共 10 次）:
  baseline / after-push / poll0..poll7 / after-back  **hostsLen 恒为 2，nEvents 恒为 4**
resetHappened: false
```

⇒ **`navigate` 事件触发了，但没有 reset。** 因为 `playPageIdentity` 没变（pathname 相同）。这与 `:2710` 的短路判据一致。

⇒ reset 的真实触发链是：**`navigate`（`navigationType: 'push'`）→ `handlePlayPageNavigation` → identity 变化 → `resetLoadingTrace()`**。

---

## 3. 问题 2：换集后 `streamingProxied` 是否变回 `false`

### 3.1 `navigate` 确实会为 `pushState` 触发

六轮里 `navigations[0]` 全部是 `type: 'push'`，且与 `pushStates[0]` 几乎同时：

| 轮 | `history.pushState` t | `navigate` t | **差** |
| --- | --- | --- | --- |
| 2 | 439070.1 | 439070.9 | **+0.8ms** |
| 3 | 643836.2 | 643837.3 | **+1.1ms** |
| 5 | 1003306.6 | 1003308.2 | **+1.6ms** |
| 6 | 1456870.9 | 1456872.5 | **+1.6ms** |
| 8 | 2390104.4 | 2390105.3 | **+0.9ms** |
| 9 | 2635734.8 | 2635735.4 | **+0.6ms** |

⇒ Lead 假设的前提（"`pushState` 不触发 `navigate`"）**在 Edge 157 / 本页实测中不成立**。`navigate` 监听（`entrypoints/content.ts:2821-2831`）会跑到 ⇒ `handlePlayPageNavigation()` 会跑到 ⇒ `refreshProxiedFlagAfterNavigation()` 会跑 ⇒ `setLoadingTraceProxied(res.activated === true)`。

### 3.2 换集后 `ext-patch` 重新出现

`LoadingSnapshotLite` **没有** `streamingProxied` 字段（`loading-trace.ts` 的 `LoadingSnapshotLite` 只有 `present` / `confidence` / `actual` / `hosts` / `events` / `truncated` / `filter` / `video`），所以只能走它唯一可观测的后果：`recordPlayurl()` 命中时补一条 `stage='ext-patch', note='接管取流'`（`:487`）。

**精细轮里出现的那条 `ext-patch`**（`.tmp/ep-reset-fine-1.json` 的 `liveStages`）：

```
["seg-req",   2297156.1]   ← 换集前
["seg-res",   2297286.6]
["playurl-req", 2297328.6]   ← pushState(2297284.9) 后 +43.7ms
["playurl-req", 2297403.1]
["ext-patch",  2297403.1, "接管取流"]   ← reset(2297317.5) 之后 +85.6ms、pushState 之后 +118.2ms
["playurl-req", 2297407.3]
...（后续约 70 条 playurl-req/res，全部无 ext-patch —— extPatchRecorded 已去重）
```

**⚠️ 归因必须写清楚：这些 `playurl-req` 是「精细轮探针自己发的 30ms 标记」，不是页面流量。**
`ep-probe-reset-fine.js:97` 的注释就是「pushState 到另一条 pathname 之后，每 30ms 一条，共 40 条」。
标记 `markers[0].tSched = 2297328.2` 与 `playurl-req t = 2297328.6` 对得上（差 0.4ms）。

**★ 这里还夹着一个观察：第 1 条标记（`2297328.6`）没有产出 `ext-patch`，第 2 条（`2297403.1`）才产出。**

`recordPlayurl()` 里 `ext-patch` 的判据只有一个 —— `state.streamingProxied`（`:487`）。所以表面上可以读成「reset 之后有一小段 `streamingProxied` 还是 `false` 的窗口」。**但我不把这条当结论**，因为它有两种同样可能的解释，我无法区分：

| 解释 | 机制 | 能否排除 |
| --- | --- | --- |
| A. `streamingProxied` 短暂为 `false` | reset 是同步的；`refreshProxiedFlagAfterNavigation()` 要等 `page/activate` 消息往返才 `setLoadingTraceProxied(true)`，所以有一段 `false` 窗口 | 不能排除 |
| B. 观察器回调批处理顺序 | `recordPlayurl()` 在**观察器回调**里跑，而回调在 `responseEnd` 之后才触发。第 1 条的 `responseEnd = 2297547.2`、第 2 条的 `= 2297548.8` —— 两条回调只隔 **1.6ms**。"谁先被投递"决定了谁占用 `extPatchRecorded` 那唯一一条；而 `ext-patch` 的 `t` 记的是 `startTime`（`2297403.1`），不是回调时刻 | 不能排除 |

⇒ **能确凿说的只有：`ext-patch` 在换集后重新出现了**（这一点不依赖上面 A/B 之争 —— 只要有任何一条 `/playurl` 在 `streamingProxied === true` 时被处理，它就会出来；而它确实出来了）。

⇒ **换集后 `ext-patch` 会重新出现**（reset 把 `extPatchRecorded` 也清掉了，所以能以"新的一条"的形式再出现）。

### 3.3 口令复核（主动制造一次 `/playurl`）

`ep-probe-extpatchtest.js` 发一次**无参** `GET https://api.bilibili.com/x/player/playurl`（`credentials:'omit', cache:'no-store'`，不带任何 query，因此不可能带出 `upsig`/`deadline`），然后比对快照 `ext-patch` 条数。

**本次（03:11 之后，`t = 3043694.3`）原始输出：**

```json
{
  "ok": true,
  "tRequest": 3043694,
  "tDone": 3043959.8,
  "fetchOutcome": "http=200",
  "before": {
    "nEvents": 4,
    "stages": {"seg-req":1,"seg-res":1,"canplay":1,"playing":1},
    "extPatch": [], "playurl": [], "hostsLen": 1
  },
  "after": {
    "nEvents": 7,
    "stages": {"seg-req":1,"seg-res":1,"canplay":1,"playing":1,"playurl-req":1,"ext-patch":1,"playurl-res":1},
    "extPatch": [{"t":3043694.3,"note":"接管取流"}],
    "playurl": [{"stage":"playurl-req","t":3043694.3},{"stage":"playurl-res","t":3043952.9}],
    "hostsLen": 1
  },
  "extPatchDelta": 1,
  "playurlDelta": 2
}
```

`extPatchDelta = +1` ⇒ 换集后 `streamingProxied === true`。

**更硬的证据：reset 把旧的 `ext-patch` 清掉后，新口令又能生成一条新的。**

从 `ep-switch-5.json` 的 `runs[]`（每个 run 是 20ms 采样里"签名相同"的一段）逐段取出 `ext-patch`，只在它变化处切换：

```
run tFrom  990229.4   ext-patch = [893199]      hostsLen=2   ← 换集前
run tFrom 1003355.8   ext-patch = []            hostsLen=0   ← ★ reset 这一刻（= push 1003306.6 + 49.2ms）
run tFrom 1101969.4   ext-patch = [1101743.9]   hostsLen=2   ← 换集后新长出来的一条
```

`ep-switch-6` 是同一个形态（原始 `runs[]`，只在 `ext-patch` 变化处切换）：

```
run tFrom 1446842.7   ext-patch = [1101743.9]   hostsLen=2   ← 换集前
run tFrom 1456913.2   ext-patch = []            hostsLen=0   ← ★ reset 这一刻（= push 1456870.9 + 42.3ms）
run tFrom 1469423.6   ext-patch = [1469325.3]   hostsLen=2   ← 换集后新长出来的一条
```

⇒ 两条结论同时成立：
1. `resetLoadingTrace()` **确实清掉了 `extPatchRecorded`**（旧的 `ext-patch` 事件不在了）
2. reset 之后新来一条 `/playurl` 就能长出**新的** `ext-patch` ⇒ **`streamingProxied` 是 `true` 而不是 `false`**

| 时刻 | `ext-patch` 事件 | 说明 |
| --- | --- | --- |
| `t = 893199` | 换集前那条 | 被轮 5 的 reset（1003355.8）清掉 |
| `t = 1101743.9` | 轮 5 reset 之后新长出来的 | 口令触发 |
| `t = 1469325.3` | 轮 6 reset（1456913.2）之后新长出来的 | 口令触发 |
| `t = 3043694.3` | 本轮 §3.3 口令 | `extPatchDelta +1` |

### 3.4 面板自己也印证了

03:0x 的一张面板卡片时间轴上读到了 **「扩展介入 1101.74s / 接管取流」**（VOM 的 `StaticText`）。

`1101.74s = 1101740ms` —— 与 §3.3 表里 `t = 1101743.9` 那条 **`ext-patch`（口令触发）只差 3.9ms**。也就是说面板画的那一行「扩展介入」正是那次口令在采集器里留下的那条事件，**它出现在 reset 之后**（`1101743.9 > 1003355.8`，见 §2.1 轮 5 的 reset）。

**判定：换集后 `streamingProxied === true`，Lead 的假设不成立。**

---

## 4. 问题 3：换集后时间轴第一行 `t` 的量级

### 4.1 面板文案与原始数字对照（实测，VOM 直读）

`pageOriginAnchor()`（`loading-pane.ts:665-671`）在「无 `nav` 且未 `truncated`」时，把**首条事件的绝对 `t`** 写进尾注：

```ts
return `本集开始于页面加载后 ${clockText(first.t)}`;
```

实例（全部来自 `bsk sync --json` 的 VOM `StaticText`，以及 `ep-switch-*` 的 `edges[].events`）：

| 观测时刻 | 面板「开局」行 | 面板尾注「本集开始于页面加载后 …」 | 末注换算成 ms | 面板时间轴首行（文字） | 快照里首条 `seg-req` 的 `t`（原始） |
| --- | --- | --- | --- | --- | --- |
| 03:1x（ep341217，第 10 集） | `开局 3683.79s` | `1:01:22.86` | **3682860** | `3682.86s → 3683.20s · 0.33s` | `3682864.5`（`ep-before-switch10` 的 `firstEvent.t`） |
| 03:11（ep341219，第 12 集） | `开局 3230.37s` | `53:49.65` | **3229650** | `3229.65s → 3229.74s · 0.09s` | 同左（面板文字已是 2 位小数） |
| 02:5x（ep341218，第 11 集） | `开局 2563.49s` | `42:42.76` | **2562760** | — | `2562758.4`（`ep-clean-after` 的 `firstEvent.t`） |
| 02:3x（ep341218，第 11 集） | `开局 1802.80s` | `30:02.33` | **1802330** | — | `1802328.8`（轮 7 的 `seg-req`） |
| 02:2x（ep341217，第 10 集） | `开局 1004.62s` | `16:44.15` | **1004150** | — | `1004154.7`（轮 5 的 `seg-req`） |
| 02:5x（ep341218，第 11 集） | `开局 2637.39s` | `43:56.40` | **2636400** | `2636.40s → 2636.69s · 0.29s` | `2636403.4`（轮 9 的 `seg-req`） |

**三列互相对得上**：尾注换算 / 面板首行文字 / 快照 `firstEvent.t`，三者差异都在 5ms 内 —— 即 `clockText` 的百分之一秒取整误差（`3682.86s` vs `3682864.5ms`；`2562.76s` vs `2562758.4ms`；`2636.40s` vs `2636403.4ms`）。

**判定：第一行 `t` 就是「相对页面 `timeOrigin` 的绝对毫秒数」，不是「本集内的时间」。**

直接验算（03:11 那次，`ep341219`）：

```
页面 performance.timeOrigin          = 1795026058990
面板时间轴首行                        = 3229.65s = 3229650ms   ← 首条 seg-req 的 t
面板「开局」                          = 3230.37s = 3230370ms   ← playing 事件的 t
面板尾注「本集开始于页面加载后 …」      = 53:49.65 = 3229.65s   ← 与首行 t 同一个数
```

**关键点：`3229.65s` 与「页面已运行多久」是同一个量。** 若 `t` 是「本集内时间」，它只能是 `video.currentTime` 量级 —— 而本集 `video.duration = 1441s`（24 分整），**实测 3229.65s 是它的 2.24 倍**，不可能是本集内时间。

同一结论在 6 次换集上重复成立：`t` 单调递增、逐次累积（1004.15 → 1802.33 → 2562.76 → 2636.40 → 3229.65 → 3682.86），与"页面从头到尾没刷新（`timeOrigin` 恒定 `1795026058990`）"这一事实一致。

### 4.2 面板自己把这件事说清楚了

尾注原文（VOM）：

> 时间从页面开始加载算起（**本集开始于页面加载后 53:49.65**）；+x.xxs 是比上一条多花的时间，两条在同一刻发生的标「同一刻」。下载视频片段那几行给的是请求到返回的耗时。只列出每次线路类别变化后的第一段，其余片段未逐段列出。

即：面板文案层面**已经**把「页面加载后 X」和「本集」区分开了。数字确实是「页面加载后经过的时间」。

---

## 5. 附加观察：面板不会跟随 SPA 换集自动重取

这一节不是三个问题之一，但它决定了「那句『还不知道走哪条线路』会挂多久」，所以一并给出实测。

### 5.1 代码判据

- `panel.ts` 全文件**没有** `locationchange` / `popstate` / `navigate` 监听
- 加载卡取数只有两条路：`refreshLoading()`（`panel.ts:1251-1270`），被调用于
  - 挂载时（`entrypoint` 的 `loadOnce()`）
  - 点 ⟳（`loadingDetailPane({refresh: …})` → `:1553`）
  - 每次「收起 → 展开」（`mountSidebar({onOpen: () => cycler.open()})`，`entrypoints/content-panel.content.ts:959`）
- 进入加载详情浮层**不重取**（`panel.ts:1532-1545` 的注释明确写了"不在这里取数"）

### 5.2 实测：静默后按标记切段计数 `loading-snapshot` 请求

**第一版计量被污染，已查明根因**：`ep-probe-snapcount.js` 读到 `nReqs: 281`（≈140/s）不是面板行为 —— **是我自己的主探针** `ep-probe-install.js` 的 `P.poll` 每 20ms 发一次 `loading-snapshot`（`:278-298`）。这个污染必须如实记录，那组数据**不作为证据**。

**重测**（`ep-probe-quiet.js` 先停掉所有探针定时器、再把纯监听器装成 `__EP_QUIETCOUNT__`；`ep-probe-quiet-read.js` 按标记切段读）：

```
安装后 1.2s 自检：{"nQuiet":0, "quietRate":0}       ← 静默成功，0 次/秒
```

**完整分段表（`__EP_QUIETCOUNT__` 累计 16 条，截至 `now = 4796413.2`）：**

| 段 | 区间（ms） | 跨度 | 请求数 | 该窗口里我做了什么 | 请求可归因于 |
| --- | --- | --- | --- | --- | --- |
| `quiet` | 3203582.7 – 3346025.1 | 142.4s | 1 | 打开过一次面板 | **面板**（`onOpen`） |
| `mark1-before-switch` | 3346025.1 – 3372772.6 | 26.7s | **0** | 只打标记 | — |
| `mark2-after-switch-before-open` | 3372772.6 – 3402443.0 | 29.7s | 1 | 点「打开面板」 | **面板**（`onOpen`） |
| `mark3-after-open` | 3402443.0 – 3510904.7 | 108.5s | **0** | 面板开着，读 VOM | — |
| `mark4-reset-for-navtest` | 3510904.7 – 3574436.4 | 63.5s | **0** | 只打标记（面板开着） | — |
| `markA-pre-switch-10` | 3574436.4 – 3681731.2 | 107.3s | **0** | 只打标记（面板开着） | — |
| `markB-pre-realswitch` | 3681731.2 – 3740022.5 | 58.3s | 1 | 点第 10 集（真换集，面板被收起→再开） | **面板**（重开） |
| `markC-pre-race` | 3740022.5 – 4012131.1 | 272.1s | 1 | 跑 `ep-probe-snap.js` | **探针** |
| `markD-pre-open` | 4012131.1 – 4030349.0 | 18.2s | **0** | 只打标记 | — |
| `markE-post-switch` | 4030349.0 – 4045518.6 | 15.2s | **0** | 点第 11 集（**真换集**）后立刻打标记 | — |
| `markF-pre-open2` | 4045518.6 – 4193475.9 | 148.0s | 12 | 跑 `ep-probe-navigate-only.js`（它自己采 10 次快照） | **探针**（见下核对） |
| `markG-pre-race2` | 4193475.9 – 现在 | **602.9s** | **0** | 只打标记（面板开着） | — |

**逐段归因核对（每条都要能对上具体动作）：**

1. **`markF` 的 12 条全部是探针自己发的。** 时刻 `4110564.4 / 4110568.3 / 4110689.8 / 4110815 / 4110937.2 / 4111058.5 / 4111183.8 / 4111304.9 / 4111426.2 / 4111547.7 / 4111870.2` 与 `ep-probe-navigate-only.js` 自己的 10 次采样时刻（`baseline 4110564.9` / `after-push 4110568.5` / `poll0..7 4110690…4111547.8` / `after-back 4111870.4`）**逐条一一对应，误差 ≤0.5ms**。第 12 条 `4045892.4` 是 `markE` 之前那次 `ep-probe-snap.js`。
2. **`markC` 的 `3894990.4` 也是探针自己发的。** 同一次 `ep-probe-snap.js` 返回 `nowMs: 3894991`（差 1ms）。
3. **`mark2` / `quiet` / `markB` 三条是「打开面板」触发的** —— `mountSidebar({onOpen: () => cycler.open()})`（`entrypoints/content-panel.content.ts:959`）→ `loadOnce()`（`:700-770`）。**这是"打开触发"，不是"换集触发"。**

**⇒ 扣掉全部可归因到探针自己的 13 条，剩下的 3 条全部落在「打开面板」那一刻。换集本身一条都没产生。**

**三条可判定的结论：**

- **换集（`navigate` + reset）不触发面板取数。** `mark1`（换集前 26.7s，**0**）+ `markE`（换集后立刻 15.2s，**0**）。
- **面板打开后不会自己刷新。** `mark3`(108.5s) + `mark4`(63.5s) + `markA`(107.3s) + `markD`(18.2s) + **`markG`(602.9s)** —— 面板一直开着，合计 **900.4 秒，0 次取数**。
- **只有两种动作能让它重新取数**：点 ⟳，或「收起 → 再展开」。

**⚠️ 一个曾经写错、在此更正的说法：** 我原先想用「`mark3` 时卡片首行 `3229.65s` 而 `performance.now() ≈ 3402443`，差 172.8 秒 ⇒ 快照陈旧」来佐证。
**这个论证是错的** —— `3229.65s` 是**本集的加载时刻**，在本集内它本来就不会变（见 §4）。卡片显示的是**正确**数据，不是陈旧数据。

⇒ 面板「不刷新」这件事，**只能靠上面那张计数表证明，不能靠"卡里的数字看着旧"证明。**

而「不刷新」的后果有两种可能形态，**我无法区分**（§6.2 已列为未确认）：

| 形态 | 前提 | 是否实测到 |
| --- | --- | --- |
| 停在**旧集**的数据上（`hosts` 是上一集的线路） | 面板在换集前就已经挂了卡 | ❌ 没做到「面板开着跨换集」的 VOM 对比 |
| 停在**空数据**上（「还不知道走哪条线路」） | 面板恰好在 reset 之后、首条 `seg-req` 进 state 之前的空窗里取数/挂载 | ❌ §5.3 合成点击 `found:false` |

两条都只能靠代码路径推断。**本次实测确凿的只有「面板没有自动刷新通道」这一件事本身。**

### 5.3 「空窗期挂载面板」这条路径**未能实测到**

试过 `ep-probe-panelrace.js`（在页面侧等 `pushState` 后 `DELAY_MS = 180ms` 合成点一下 `[aria-label^="打开 Pluma 面板"]`）：

```
{"tag":"auto-open@180ms","t":3682435.6,"sincePush":201.9,"found":false,"tagName":null,"aria":null}
```

`found: false` —— 180ms 时那个入口按钮在 `document` 里还没出现（换集时面板 host 被移除，重建晚于 180ms）。

⇒ 「面板恰好在空窗里挂载 ⇒ 显示『还不知道走哪条线路』」这条因果链，**我只有代码路径 + 空窗时长 + 面板不自动重取三条事实，没有一次干净的实测**。必须按「推断」记，不能按「实测」记。

---

## 6. 无法确认的部分（明确区分「实测」与「推断」）

### 6.1 实测到但原因未定

| 现象 | 实测到什么 | 未确认的是 |
| --- | --- | --- |
| `pgc-playview-stream` 消息**从未出现** | 轮 5/6/8/9 的 `posted` 钩子（拦截了所有 `window.postMessage`）只捕获到 **2 条 `sb-ok`**，`pgc-playview-stream` **0 条** | `main-world.js:5140-5165` 只在「换流成功（dash 存在且完整）」时才发它。本次所有换集**都无需换流**（同一 `cid` 的 dash 已缓存），所以可能是"没触发"而非"漏发"。**无法区分**这两种解释 |
| 换集的 `flow[]` 只有 `/ogv/player/playview` | 轮 9：`{s:2635831.5, e:2636026.9, h:"api.bilibili.com", p:"/ogv/player/playview", init:"fetch", status:200}` | PGC 取流走 `playview` 而不是 `/x/player/playurl`，所以 `recordPlayurl()`（判据是 pathname 含 `/playurl`）**永远不会命中** 这条路径。这是**代码可读出的结论**，但"是否所有 PGC 换集都不走 `/playurl`"未做统计 |
| 播放器预取下一集分片 | 精细轮 1 次：`seg-req t = 2297156.1`，比 `pushState`(2297284.9) **早 128.8ms** | **仅 1 次观测**。不足以定量（提前多久、什么条件下发生） |

### 6.2 只有推断、没有实测

| 推断 | 支撑事实 | 缺的那一环 |
| --- | --- | --- |
| 「面板在空窗期挂载 ⇒ 显示『还不知道走哪条线路』」 | ① 空窗期快照实测是 `hosts: []` / `actual: null`（6/6 轮 + 精细轮都有），② `describeSnapshotLine()` 在 `actual===null && unknownCount===0` 时返回 `TITLE_UNKNOWN` | **没有一次干净的"面板恰好在空窗里挂载"实测**（§5.3 的合成点击 `found:false`）；也没有一次 VOM 直接抓到那七个字 |
| 「面板停在换集前的快照上 ⇒ 显示的是**旧集**的线路，而不是空」 | §5.2 实测：面板开着累计 900.4 秒、0 次取数 ⇒ 换集后不重取；`resetLoadingTrace()` 只清**采集器**的 state，**不改面板已渲染的 DOM** | **没有一次实测对比"换集前 vs 换集后面板卡片文字"**。而且这条推断与上一行**互相矛盾**（一个说停在旧数据、一个说停在空数据），我无法判定哪个是用户真正看到的 —— **要看这一条，必须补一次"面板开着跨换集"的 VOM 对比**，本次因 §5.3 的合成点击失败而没做到 |

### 6.3 探针自身的副作用（必须披露）

1. **`ep-probe-quiet.js` 的 interval 兜底清扫**：为杀掉残留的 20ms 采样器，脚本执行了
   `for (let i = 1; i <= topId; i += 1) clearInterval(i)`，`topId = 231174`，`killCount = 231174`。
   但这**会清掉页面上所有 `setInterval`**，包括 B站 播放器自己的 —— 这是本任务中唯一有实际侵入性的动作，必须明写。
   执行后复核：`video.readyState = 4`、`paused = false`、`currentTime` 继续增长 ⇒ 未观察到播放中断。
   影响范围：本次结论依赖的 6 轮换集数据**全部在它执行之前**（`3203582` 之前；最晚的轮 9 是 `2635711–2656705`），所以 §2–§4 不受影响。§5.2 的计数在它之后，但清定时器**只会让计数变少**（少掉我自己那 20ms×50 次/秒的采样），不会凭空造出面板的请求。
2. **`ep-probe-snapcount.js` 的 281 次计数**：污染数据，已弃用（§5.2）。
3. **`ep-probe-extpatchtest.js`**：会往采集器里补一条 `playurl-req`/`playurl-res`（可能还有一条 `ext-patch`）。只在测量收尾跑，且请求**无任何 query**，不可能产生 `upsig`/`deadline`。
4. **`ep-probe-navigate-only.js`**：改了一次 `location.hash` 再 `history.back()` 撤销。hash 变化不影响播放页路由，`video` 未中断。

### 6.4 一次失败的测量（记录在案）

`.tmp/ep-clean-before.json` / `.tmp/ep-clean-after.json`（03:03:30 / 03:03:54）本意是 ext-patch 前后对照，但落盘结果显示 `eventsLen` 都是 4、`stages` 里**都没有 `ext-patch`** —— 说明那一次 `/playurl` 口令**没被采集器吃进去**（可能 `state` 刚被 reset，或请求在 reset 之前发出）。

⇒ 这组数据**不能作为「`streamingProxied === true`」的证据**。有效证据是 §3.3 的 `3043694.3` 那次（`extPatchDelta: +1`）与 §3.2 精细轮的 `2297403.1`（**那一轮是我自己的 30ms 标记触发的，不是页面流量** —— §3.2 已明写）。

---

## 7. 复现命令

```bash
# 上下文（0.5.0 起 evaluate 必须带 --context + --expect）
bsk sync --session mglh --tab-id 1673243194 --json      # 取 "ctx": "cN"

# 主探针（hook click / pushState / navigate / 所有 __PLUMA__ 消息 / 自装资源观察器 / 20ms 采样）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-install.js cN
# 读出（§2.1 的表全部来自这里）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-read.js cN

# 精细轮（判定 reset 发生几次）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-reset-fine.js cN
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-reset-fine-read.js cN

# 单次快照（问题 2 / 3 的原始值）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-snap.js cN

# ext-patch 口令判定（问题 2）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-extpatchtest.js cN

# hash-only 导航对照（证明 reset 挂在 identity 变化而非"任何 navigate"）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-navigate-only.js cN

# 静默 + 面板取数计数（§5.2）
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-quiet.js cN
sed 's/MARK_LABEL/<你的标签>/' poc/probe/loading-trace/ep-probe-mark.js > .tmp/m.js
node poc/probe/bsk-eval.mjs mglh 1673243194 .tmp/m.js cN
node poc/probe/bsk-eval.mjs mglh 1673243194 poc/probe/loading-trace/ep-probe-quiet-read.js cN
```

> `bsk-eval.mjs` 的参数顺序是 **位置参数**：`<session> <tabId> <file> [context] [expectJson]`。
> `[expectJson]` 必须是 **JSON 数组**（例如 `'[{"target":"body","field":"exists","equals":true}]'`），
> 默认值就是这个，所以通常省略即可。

---

## 8. 本次新增/使用的探针清单

| 文件 | 作用 | 写盘 |
| --- | --- | --- |
| `ep-probe-install.js`（v5） | 主探针：click(捕获) / `history.pushState`·`replaceState` / `navigate` / **所有 `__PLUMA__` 消息收发** / 自装 `PerformanceObserver({buffered:false})` / 20ms 快照采样（按签名压段 + 空↔非空边界全留） | 只读 |
| `ep-probe-read.js` | 读出主探针全部累计数据 | 只读 |
| `ep-probe-snap.js` | 单次问 `loading-snapshot`，按 stage 分组输出 `{n, t[]}` + `firstEvent` | 只读 |
| `ep-probe-reset-fine.js` / `-read.js` | `pushState` 后每 30ms 一条标记 ×40 + 20ms `hosts` 采样，直接数出「重置几次、各在哪一刻」 | 只读 |
| `ep-probe-extpatchtest.js` | 判定 `streamingProxied`：before 快照 → 一次无参 `GET /x/player/playurl` → 700ms → after 快照，看 `ext-patch` delta | 只读（1 次无参 GET） |
| **`ep-probe-navigate-only.js`**（新） | 同 pathname 的 hash-only `pushState` 对照：`navigate` 会触发、但不 reset | 只读（改 hash 再 back） |
| **`ep-probe-quiet.js`**（新） | 停掉所有已知探针定时器 + interval 兜底清扫，然后装**纯监听**的 `loading-snapshot` 计数器 | 只读 |
| **`ep-probe-quiet-read.js`**（新） | 按标记切段读 `__EP_QUIETCOUNT__` | 只读 |
| **`ep-probe-mark.js`**（新） | 给静默计数器打标记（`MARK_LABEL` 由调用方 `sed` 替换） | 只读 |
| **`ep-probe-panelrace.js`** / `-read.js`（新） | 尝试在空窗期合成点击面板入口（**本次 `found:false`，未成功**） | 只读 |
| **`ep-probe-snapcnt2.js`** / `-read.js` / `-mark.js`（新） | 有标记/可清零的 `loading-snapshot` 计数器（被静默版取代） | 只读 |
| `ep-probe-pagestate.js` | 一次读 `video` 状态 / URL 骨架 / `timeOrigin` / `__PLUMA_MAIN__` / `__PLUMA_PGC__` | 只读 |
| `ep-probe-bgtypes.js` | 走 `streaming-probe` 桥读 `storage.local` 的 `pluma:build-proof` / `pluma:probe-types` | 只读 |
| `ep-probe-panel-gap.js` | 检测 pathname 变化后 700ms 点「打开 Pluma 面板」，记录 `hosts` 条数变化 | 只读 |
| `ep-probe-marker.js` / `ep-probe-reset-count.js` `-read.js` | 早期版本（被 `-fine` 取代） | 只读 |
| `ep-probe-snapcount.js` | 早期计数版（**污染，弃用**，见 §5.2 / §6.3） | 只读 |
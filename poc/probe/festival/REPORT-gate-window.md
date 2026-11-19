# 活动页门控窗口与同步注入可行性

> 日期：2026-11-18　执行：probe-festival-nano
> 环境：bsk **0.5.0**（`bsk --version` 实测；未升级）、真实登录 Edge、扩展总开关开、`.output/chrome-mv3` 当前构建。
> 边界：**未改** `src/`、测试、守卫，**未 commit**；Cookie / 账号 mid / 签名 URL 不写入正文。
> 目标页：`https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy`（与上一轮验收一致）。

---

## 1. 结论（先看这三行）

1. **未知 1：会。同步注入被调用。** 在 `createPlayer(config)` 返回前 `config.requestConfig = { reqHttpPlayUrlInfo: fn }`，播放器首波就调用 `fn`（stub 模式 `cbHits=4`，真实 fetch 模式 `cbHits=1` 且成功起播、`videoHeight` 从 480 变成我们裁的 360）。
2. **未知 2：门控只比 `createPlayer` 晚约 50ms（p50 50 / p90 66 / max 68ms）；同步回调大约在 create+65ms 被调，所以需要等的窗口 p50≈-15ms、p90≈1ms、max≈3ms。** 建议 `T=300~400ms`（理由见 §3.3）。**关键修正：即使门控在首波 playurl 之前就开了，晚到的 `updateRequestConfig` 也救不了首波——9/10 次首波仍是原生 XHR，因为首波请求在 `createPlayer` 里就被排好了。**
3. **未知 3：没有看到首波走主账号。** 20/20 次冷加载（10 次前台弹窗 + 10 次后台新标签）首波 m4s 的签名 `mid` 都与页面主账号 `DedeUserID` 不同 → 命中的是播放账号。判据是 m4s URL 的 `mid` 代理，不是直接读 Cookie 头（bsk 把 Cookie 固定脱敏）。

---

## 2. 未知 1：同步注入会不会被调用？

### 2.1 实测设计

Playwright + `addInitScript`（等价 MAIN world `document_start`），拦截 `window.nano` setter → 包住 `createPlayer` → **在 `orig.call(this, config)` 之前** 无条件写：

```js
config.requestConfig = config.requestConfig || {};
config.requestConfig.reqHttpPlayUrlInfo = fn;   // 不判任何门控
```

三种模式：
- `MODE=stub`：`fn` 记录 params 后立刻 `throw` → 只为证明它被调用；
- `MODE=real`：`fn` 用播放器给的 params 自己 `fetch` playurl，返回 `{data, headers:{}, status}`，并把 `dash.video` 裁到 ≤360；
- `MODE=off`：不注入，只 hook `XMLHttpRequest.open` 记录原生首波参数作对照。

### 2.2 结果

| 模式 | createPlayer | 首波回调/请求 | cbHits | 播放状态 |
| --- | --- | --- | --- | --- |
| stub | 1500ms | **callback @1552ms**（+52ms） | **4**（抛错后播放器每 5–8s 重试一次） | 无流（预期） |
| real（`FORCE_Q=360`） | 1745ms | **callback @1813ms**（+68ms） | **1** | `t=20s, h=360, w=640, readyState=4, err=null`；`fetch` 成功 code=0；`dash.video 6→3` |
| off（对照） | 1605ms | **原生 XHR @2724ms**（+1119ms） | 0 | `t=19s, h=480, w=852, readyState=4` |

**→ 同步注入不仅被调用，而且比原生 XHR 早约 0.45–1.1 秒拿到控制权。**
`real` 模式下 `videoHeight` 由 480 变 360、宽度 852→640，且 `xhr=[]`（播放器没发原生 playurl）——播放器消费的就是我们返回的 dash。

### 2.3 回调 params vs 原生 XHR 参数

回调收到的 `params`（19 键，值有类型）：

```text
avid(number)=117294734775639  bvid(string)=BV1ydeX65Edn
cid(number)=42141027046       qn(number)=0
fnver(number)=0               fnval(number)=4048
fourk(number)=1               season_id(object/null)
gaia_source='' from_client='BROWSER' is_main_page=true need_fragment=false
isGaiaAvoided=false client_attr=0 version_name='4.9.88' app_id=100
session(string) voice_balance=1
```

原生 XHR 的 query（23 键，全部字符串）：

```text
同上 + web_location, dm_img_list, dm_img_str, dm_cover_img_str, dm_img_inter, w_rid, wts
```

结论：
- **关键参数一致**：`avid / cid / qn=0 / fnver=0 / fnval=4048 / fourk=1` 完全相同；
- 回调 params **少 4 个 `dm_*`/`web_location` 和 `w_rid`/`wts` 签名**；但用它直接拼 URL `fetch` 在游客身份下实测 `code=0`（说明签名不是服务端硬要求，或 B站对网页端宽松）；
- 类型不同：回调是 number/boolean/object，原生是 string。**必须按回调给的值原样序列化**（尤其 `season_id` 可能是 null、数组要保持原样），不能假定全是字符串。

---

## 3. 未知 2：门控比首波晚多少？

### 3.1 怎么拿到 tGate（这次拿到了精确值）

bsk 不能 document_start 注入，但**同名弹窗**可以：
1. 在 B站首页用一次可信点击打开命名弹窗 `probeWin`（`window.open` 无手势会被拦）；
2. 父页面持有句柄后，用 **Web Worker 每 5ms** 触发一次跨窗口读（父页面是后台 tab，普通 `setInterval` 会被节流到 1s；Worker 不受影响，10 次运行 `workerSamples≈1700/8s`）；
3. 每轮把弹窗 `location.replace()` 到带 nonce 的活动页 URL，父页面在子窗口 `performance.now()` 坐标系里记录：
   - `tCreate` = `__PLUMA_FESTIVAL__.createCalls` 首次 >0
   - `tGate` = `__PLUMA_FESTIVAL__.hookInstalled` 首次 true（同时 `remounts` 变 1）
   - `tFirstPlayurl` = 子窗口 Resource Timing 里首条 `/x/player/wbi/playurl` 的 `startTime`（`initiatorType` 区分 fetch/XHR）

### 3.2 10 次前台硬加载原始数据（单位 ms，子窗口 `performance.now()`）

| # | tCreate | tGate | tGate−tCreate | tFirstPlayurl | 首波类型 | tGate−(tCreate+65) | remounts | cbHits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1071 | 1071 | 0 | 993* | fetch（A） | −65 | 0 | 1 |
| 1 | 962 | 1012 | 50 | 1458 | xmlhttprequest | −15 | 1 | 0 |
| 2 | 1033 | 1101 | 68 | 1647 | xmlhttprequest | +3 | 1 | 0 |
| 3 | 1042 | 1079 | 37 | 1562 | xmlhttprequest | −28 | 1 | 0 |
| 4 | 943 | 1009 | 66 | 1467 | xmlhttprequest | +1 | 1 | 0 |
| 5 | 903 | 964 | 61 | 1360 | xmlhttprequest | −4 | 1 | 0 |
| 6 | 857 | 890 | 33 | 1353 | xmlhttprequest | −32 | 1 | 0 |
| 7 | 944 | 991 | 47 | 1388 | xmlhttprequest | −18 | 1 | 0 |
| 8 | 1026 | 1092 | 66 | 1602 | xmlhttprequest | +1 | 1 | 0 |
| 9 | 916 | 975 | 59 | 1471 | xmlhttprequest | −6 | 1 | 0 |

\* 第 0 轮首波 fetch 的 `startTime` 比采样到的 `tCreate` 早 78ms；这是 A 情况下主线程繁忙导致 5ms 采样滞后，不代表真实先后。tCreate 的采样误差上限约几十 ms。

**统计（10 次）**

| 量 | min | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| `tCreate`（相对导航） | 857 | **944** | 1042 | 1071 |
| `tGate` | 890 | **1009** | 1092 | 1101 |
| **`tGate − tCreate`** | 0 | **50** | **66** | **68** |
| **同步回调需等待（`tGate − (tCreate+65)`）** | −65 | **−15** | **1** | **3** |
| `tFirstPlayurl` | 993 | **1458** | 1602 | 1647 |
| `tFirstPlayurl − tCreate` | −78 | **496** | 576 | 614 |

> 65ms 是 Playwright 同步注入实测的「createPlayer → 回调被调」延迟（stub 52ms / real 68ms）。

### 3.3 建议等待上限 T

- 前台实测：门控在 createPlayer 后 **p50 50ms / p90 66ms / max 68ms** 就绪；同步回调在 create+约 65ms 被调，**实测需要等的最大只有 3ms**。
- 回调比播放器原生 XHR 早 **约 450–600ms**（`tFirstPlayurl − tCreate` p50 496ms）。因此即使等 300ms，也不会比现状更晚出首帧。
- **建议 `T=300ms`（保守可 400ms）**：是实测 p90 的 ~300 倍、max 的 ~100 倍，仍在原生 XHR 之前；超时兜底必须谨慎（见 §4 的身份风险）。
- ⚠️ 这是**前台、SW 已热**的条件（弹窗复用同一浏览器）。**真正的浏览器冷启动 / SW 首次唤醒没有测到**；如果门控可能 >300ms，T 要相应调大，且不能盲目 fallback 到主账号。

### 3.4 关键修正：晚到 `updateRequestConfig` 救不了首波

10 次里有 **9 次**满足 `tGate < tFirstPlayurl`（门控在主世界已经打开，比首波 playurl 还早 200–500ms），但首波仍然是 **xmlhttprequest**、`cbHits=0`、`remounts=1`。
→ 说明 `createPlayer` 时播放器已经把首波取流**排好队**（`requestFunc` 在那一刻被捕获/缓存），之后再 `updateRequestConfig` 只影响后续 `reload`，不影响首波。
→ 这也解释了上一轮「remounts=1 但首波是 B」：不是门控晚，而是**补挂本身结构上就晚了**。**同步注入是这个方案不可替代的一环。**

---

## 4. 未知 3：首波有没有可能走主账号 Cookie？

**结论：本次 20/20 次都没有命中主账号。**

判据：播放器最终拉的 `.m4s` 签名 URL 带 `mid=`；把它的 `mid` 与页面 `document.cookie` 里的 `DedeUserID` 比较（只输出布尔关系，不输出数字）：

| 场景 | 次数 | 首波类型 | m4s mid 与主账号相同 | m4s mid 与主账号不同 |
| --- | --- | --- | --- | --- |
| 前台弹窗 10 次 | 10 | 1 fetch / 9 XHR | **0** | **10** |
| 后台新标签 10 次（bsk open） | 10 | 1 fetch / 9 XHR | **0** | **10** |

→ 即使首波是播放器原生 XHR（回调没接管），DNR 的标签页规则也已经在首波请求前装好，请求走的是**播放账号**。没有观察到「首波用主账号、过期后掉 720P」的现象。

⚠️ 两条限定：
1. 这是 `m4s mid` 代理，不是直接读首波请求的 Cookie 头（bsk 把 `cookie` 固定显示为 `[redacted]`，无法取 `DedeUserID` 明文）。若以后 m4s URL 不带 `mid`，这条判据会失效。
2. 两个账号当前都是大会员，所以不能用「首波有没有 4K」反推身份；`mid` 比较是更强的那条。

---

## 5. 后台新标签的补充数据（与前台对照）

10 次 bsk `open` 新标签（Agent Window，后台/无焦点）：
- 首波 playurl 时刻 `p50 2059 / p90 2075 / max 2079ms`，9 XHR + 1 Fetch；
- 首次观测到页面时 `hookInstalled` 已为 true（10/10），但首波已经是 XHR；
- `observe − tFirstPlayurl` = p50 1518 / p90 1678 / max 2184ms → 只能给出 `tGate` 的**上界**，不能当点估计；
- 身份 10/10 播放账号。

后台标签的首波比前台弹窗晚约 600ms（2.05s vs 1.45s），说明后台节流会拉长时序；**不要把后台新标签的数字直接当作用户前台体验**。

---

## 6. 测不出 / 局限（不拿推断填）

- **真正的浏览器冷启动 / 扩展 SW 首次唤醒**没测到：复用同一个浏览器进程，弹窗只做硬导航（新文档，但 SW 热）。所以 `T` 的 300ms 只对「SW 已热」有实测支撑。
- **首波 Cookie 头没直接读到**：bsk debug 的 `headers` 对 `cookie` 固定脱敏；未知 3 用 m4s `mid` 代理。
- **首波响应体没抓**：bsk debug capture 明确 `initial_load_not_recorded`，且未录到 playurl；4K/quality 只能用 `lastRespCode=0 + rewritten + getQuality()/videoHeight` 间接佐证。
- **后台新标签的 `tGate` 没有点估计**：只能确定在「首波之后、首次观测之前」这个 1.3–2.2s 的区间内。
- `tCreate` 由 5ms Worker 采样，主线程繁忙时可能滞后几十 ms（第 0 轮出现 −78ms 的顺序倒挂）。
- 弹窗方案依赖一次可信点击打开命名窗口；`window.open` 无手势会被拦（实测 `blocked:true`）。

---

## 7. 产物

- 报告：`poc/probe/festival/REPORT-gate-window.md`
- 证据：
  - `result-sync-off.json` / `result-sync-stub.json` / `result-sync-real-q360.json`（未知 1 三模式）
  - `result-gate-popup.json`（未知 2 前台 10 次精确时序 + 身份）
  - `result-gate-cold-starts.json`（后台新标签 10 次首波时序 + 身份）
- 脚本：
  - `nano-sync-inject.cjs`（未知 1）
  - `gate-popup-runs.mjs` + `expr/popup-probe-install2.js` / `expr/popup-probe-read.js`（未知 2 精确门控）
  - `gate-cold-starts.mjs` + `expr/identity-compare.js`（后台冷启动与身份）
  - `expr/install-gate-poller.js`、`expr/open-popup.js`、`expr/grab-popup.js`、`expr/inject-popup-link.js`（辅助）
- 使用的 bsk 会话：`exnt`（首页 + 命名弹窗）、`probe-gate2` 多次 open/close；已全部 `bsk close`。daemon 保持运行。

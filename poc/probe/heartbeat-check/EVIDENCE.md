/**
 * 证明「跨分区心跳写没写过」—— task-45 ① 的取证记录与结论。
 *
 * 只读。两个脚本：
 *   `verify-heartbeat-key.cjs`  带三个对照组的判定器（唯一权威判据）
 *   `read-heartbeat.cjs`        早期版本，只打印命中上下文（保留作对照）
 *
 * ```
 * node poc/probe/heartbeat-check/verify-heartbeat-key.cjs
 * ```
 */

# 结论（2026-11-15）

**`pluma:login-window-alive` 从来没被写入过。** 不是「写过但跨分区读不到」，
而是**写入方一次都没有执行到 `chrome.storage.local.set`**。

## 实测原文（`verify-heartbeat-key.cjs` 输出）

```
FILES: 000066.log(873167B), 000068.ldb(34298B)

target                 pluma:login-window-alive       nameHits=    0 valueHits=    0 range=- .. -
controlWritten         pluma:build-proof3             nameHits= 5549 valueHits= 5549 range=2026-11-14T07:59:40.432Z .. 2026-11-15T11:32:01.167Z
controlCrossPartition  pluma:login-ready              nameHits=    5 valueHits=    0 range=- .. -
controlNever           pluma:__definitely-not-a-real-key__ nameHits=    0 valueHits=    0 range=- .. -

判定：从没被写过（storage 里连键名都不存在）
```

三个对照组的用途（**没有它们，上面那行 0 不能当判据**）：

| 对照 | 期望 | 实测 | 证明什么 |
| --- | --- | --- | --- |
| `pluma:build-proof3` | 大量命中（SW 每次启动写） | 5549 / 5549 带 JSON 值 | 本脚本读得到、判据有真阳性 |
| `pluma:login-ready` | 命中（无痕实例写的键） | 5 处 | 本文件**确实记录跨实例写入**，「样本期没有无痕实例活动」这个辩解不成立 |
| 编造键 | 0 | 0 | 判据没有假阳性 |

## 为什么不能是「跨分区读不到」

`pluma:login-ready` 是**无痕实例**写、普通实例读的键（`login-handshake.ts`）。
它在**普通分区的** `storage.local` 文件里留下了 5 处记录 ⇒ 跨分区写入在
`storage.local` 里是可见的。既然同类键写得进来，心跳键为 0 就只能解释成
**没写**，不能解释成「写了但看不见」。

## 写入方的一次性调用也执行了

心跳 effect 的**第一句**是同步的 `beat()`（`entrypoints/login-window/main.tsx:130`），
`setInterval` 只是续命：

```ts
beat();                                                     // 立刻写一次
const timer = window.setInterval(beat, LOGIN_HEARTBEAT_INTERVAL_MS);
```

`.output/chrome-mv3/chunks/login-window-BoHJ4jQr.js`（构建产物，非源码）里
这段确实没有被摇掉：

```js
t(()=>{let e=!1,t=`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
  n=()=>{e||c(t)}; n(); let r=window.setInterval(n,s);
  return()=>{e=!0,window.clearInterval(r),l()}},[])
```

（`c` = `writeLoginHeartbeat`，`s` = `15e3`，`l` = `clearLoginHeartbeat`）

⇒ 只要这个 `useEffect` 跑过一次，第一句同步 `beat()` 就会写一个值。
值为 0 ⇒ **effect 根本没跑**。

## 旁证（不是判据，方向一致）

1. **同一个页面的其它 effect 是有结果的**：`login-ready` 在两次点击时刻
   各有一条记录（`10:51:02.313Z`、`10:53:12.373Z`，正好是 `login/open` 的
   下一秒），而 `qr/poll` 一条都没有 ⇒ 页面能起、能发消息，但**后半段没跑到**。
2. **诊断日志里扫码窗口侧完全没有记录**（`qr/` 前缀 0 条，`probe/` 只有普通实例
   那一条 `incognito=false`）⇒ 无痕侧 SW 的 `qr/poll` handler 没有产生过可观测记录。

## 取证时间窗（用来排除「样本期太短」）

- storage 文件覆盖 `2026-11-14T07:59:40.432Z .. 2026-11-15T11:32:01.167Z`
- 两次点击（`10:51:02.302Z` / `10:53:12.36Z`）分别落在此窗口内，且点击后
  还有 **495 次** `build-proof3` 写入（SW 在持续写 storage，通道是活的）

# 🟡 未证的部分（不要当成结论）

**页面后半段为什么没跑到，本卡没有证明。** 已知候选：

- (a) 无痕分区里 `chrome.runtime.sendMessage({type:'qr/poll'})` 失败后，
  某个 effect 抛错导致后续 effect 不执行；
- (b) 二维码没有生成（`qr/generate` 失败），后续 effect 因早退条件跳过；
- (c) 页面在 `main-world` / CSP 层面被阻断（历史上有过 `ERR_BLOCKED_BY_CLIENT`）。

三条都需要**真机**：在扫码窗口里读控制台 / 看二维码是否显示。
按裁决，本卡不改心跳。

# 对 `probeExistingLoginWindow()` 的含义

心跳这条路**今天没有失效，是从来没有生效过**（写入方没跑）。
⇒ 在这个状态下，把「已开着」的判断改到心跳之外（例如
`chrome.windows.getAll({populate:true})`）**不可能解决多开窗口**：
`login-window.ts:366-369` 已实测 `windowsAfter === windowsBefore` 恒成立
（跨分区不可见），`getAll` 看到的永远是没有变化。

多开窗口的**直接成因**是另一条独立事实：
`openLoginWindow()` 在第一次点击后落到 `assumed` 兜底
（`login-window.ts:410`），没有记住任何窗口身份；
第二次点击时心跳为 null ⇒ 又 `create()` 一次 ⇒ 第二个窗口。

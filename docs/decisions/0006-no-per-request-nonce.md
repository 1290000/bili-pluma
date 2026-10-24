# ADR 0006. 不用 per-request nonce，改为按路径的常驻 DNR 规则

日期：2026-10-25
状态：已采纳（**基于 Q2 实测**）
风险等级：低 —— 这是简化，不是新增风险
取代：[ADR 0002](./0002-dnr-to-replace-cookie-header.md) 中「nonce 化 urlFilter + 规则 ID 池」那一节

## 背景

ADR 0002 定下用 DNR 的 `updateSessionRules` 去 `set` 请求的 `Cookie` 头。当时为了防止"规则错配给别的请求"，设计成**每请求一条规则**：

- `urlFilter` 里带一次性 nonce，精确锁定单个 URL
- 规则 ID 从预分配的池里轮转
- 请求完成立刻 `removeRuleIds`

这个设计的复杂度不低：要管 ID 回收、要管清理失败、要管规则泄漏、要担心并发撞车。而它存在的前提是"规则可能错配"——这个前提在 Q2 之前**没有任何实测支撑**。

## 决策

**去掉 per-request nonce。改为按白名单路径各建一条常驻 session 规则，值全局固定。**

```ts
// 一个路径一条规则，ID 由路径索引固定分配
await chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [ruleIdFor(path)],
  addRules: [{
    id: ruleIdFor(path),
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: playbackCookieString }],
    },
    condition: {
      urlFilter: `||api.bilibili.com${path}`,   // 没有 nonce
      resourceTypes: ['xmlhttprequest'],
    },
  }],
});
```

请求方照常 `fetch(url, { credentials: 'omit' })` 即可，URL 上**不需要**加任何参数。

## 理由（实测数据）

`poc/q2-dnr-concurrency/` 在 Edge 上跑 20 并发 × 3 轮：

| 策略 | 对号 | 串号 | 无回显 | 判定 |
| --- | --- | --- | --- | --- |
| S1 每请求 nonce + 规则池 | 60/60 | 0 | 0 | PASS |
| S2 规则常驻 + nonce | 60/60 | 0 | 0 | PASS |
| S3 全局单条规则反复改写 | 3/60 | 0 | 57 | 每轮仅 1 个拿到凭据 |
| **S4 常驻规则、无 nonce、值固定** | **60/60** | **0** | **0** | **PASS** |
| L1 功能探测（`omit` / `include`） | — | — | — | 两种模式都能改 |
| L3 回收 | — | — | — | 0 条残留 |

**关键推理：nonce 解决的是"这条规则该给哪个请求"的问题。而 Pluma 根本没有这个问题** —— 白名单里的所有请求都该用同一个播放账号，凭据值在整个会话内是全局一致的。既然只有一个目标，就不需要区分目标。

S3 的失败方式也印证了这一点：nonce 被并发覆盖后规则对不上任何请求，于是 19/20 的请求**什么凭据都没拿到**，而不是拿错。**nonce 让"串号"结构上不可能发生，代价是规则被覆盖时静默降级。** 而我们既然不需要区分，也就不会去改写同一条规则。

## 被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| S1 每请求 nonce + 规则 ID 池 | 实测能过，但为不存在的问题付出复杂度：ID 回收、清理失败、泄漏、并发上限 |
| S2 规则常驻 + nonce | 同上，nonce 部分多余 |
| S3 全局单条规则 | 实测每轮 19/20 请求拿不到凭据，静默降级 |

## 后果

**变简单的部分：**

- `dnr.ts` 从"规则池 + 生命周期管理"降为"路径 → 规则 ID 的映射 + 值更新"
- 没有每请求的 `updateSessionRules`，就没有 add/remove 的竞态，没有清理失败
- 没有规则泄漏问题（规则本来就该常驻），L3 那类判据只在"路径被移出白名单"时才需要
- 不需要 `try/finally` 包住每次请求

**新增的约束：**

1. **必须有总开关。** 规则常驻意味着播放账号的凭据一旦失效，所有白名单路径会一起变成"未登录"。需要能在 popup 里一键停用（停用 = 删掉所有规则），并且失败时能自动降级。
2. **SW 启动时要自愈。** `sessionRules` 在浏览器重启后清空，SW 启动时必须重建。要防"规则不存在但代码以为存在"。
3. **规则数量按路径数计**（个位数），远低于 `MAX_NUMBER_OF_SESSION_RULES`，不是问题。
4. **不能给不同请求不同凭据。** 将来若要做"多播放账号"（比如按分区选不同账号），必须回到 per-request 方案。

## 这次实测没有证明的事

不要拿这个 ADR 当"已经全验过了"：

- **没测页面发起的请求**（PoC 的 fetch 全来自 SW）。DNR 匹配与发起方无关，理论上等价，但没实测。
- **没测真实 B站 接口**（无登录态、无 WBI、无 POST）。
- **没测"值在请求飞行途中被改"**。凭据刷新时改值会不会影响在途请求，没测。这一条要在 P1-c 补测。
- **`/ogv/player/playview` 不受本 ADR 覆盖**：它是 POST 且 `csrf` 在请求体里，DNR 改不了 body，必须 JS 层拦截重建。见 `docs/01-architecture.md` §4.2。

## 相关

- 实测工具：`poc/q2-dnr-concurrency/`（**保留为常驻回归测试，改 `dnr.ts` 必跑**）
- 实测数据：`docs/03-open-questions.md` §2
- 被修正的决策：[ADR 0002](./0002-dnr-to-replace-cookie-header.md)
- 架构说明：`docs/01-architecture.md` §4.2
- 代码位置：`src/platform/http/dnr.ts`（本决策的唯一实现点）

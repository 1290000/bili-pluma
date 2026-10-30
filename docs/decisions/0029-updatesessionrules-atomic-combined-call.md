# ADR 0029：`updateSessionRules` 的组合形式是原子的（实测）

- 日期：2026-10-30
- 状态：**已实测**（真机 Edge，2026-10-30；此前为推演）
- 弥补：[ADR 0006](./0006-no-per-request-nonce.md) 之后「规则怎么装」这件事缺一条 API 语义事实
- 相关：[ADR 0010](./0010-page-proxy-via-tab-ids.md)（标签页规则同样用组合形式）、
  [ADR 0002](./0002-dnr-to-replace-cookie-header.md)（DNR 是唯一改写手段）

---

## 要回答的问题

O1（`dnr.ts` 删白名单中间项留残留）的修法被拍板为「**add 前先清空整个 ID 段**」，
落地成 `installPathRules()` 的**两次调用**：

```ts
await removeAllPathRules();                 // 调用 1：删
await updateSessionRules({ addRules });     // 调用 2：加
```

中间存在规则表为空的窗口。另一条更干净的写法是**一次调用**：

```ts
await updateSessionRules({ removeRuleIds, addRules });   // 组合形式
```

**如果组合形式严格原子，窗口就不存在，`installPathRules()` 可以收敛成一次调用。**

这条语义在 2026-10-30 之前**从未实测**，一直以推演形式挂在那里
（`.workbuddy-ai/plans/2026-10-30-refactor-plan-v2.md` §O1「开工前置」）。
本 ADR 记录实测结论。

> ⚠️ 组合形式**不是新东西**：`installTabRule()`（`src/platform/http/dnr.ts`）从 ADR 0010
> 落地起就在生产里用它（同 ID 换 Cookie）。所以本条实测同时是对**存量行为**的核查。

---

## 实测方法

新脚本 `poc/verify/dnr-updatesessionrules-atomicity.cjs`（不需要登录态，临时 profile，
假 cookie，约 20 秒）。四条判据，每条都自带对照组，不依赖「改代码让它变红」。

探测手段是**密集轮询 `getSessionRules()`**，每次记录「旧 ID 在不在 / 新 ID 在不在」。
轮询器与 `updateSessionRules` 调用**并行**跑，不在调用完成后才读 —— 否则看不见中间态。

---

## 结论（实测数据）

| # | 问题 | 观测 | 结论 |
| --- | --- | --- | --- |
| A1 | 组合形式、**同 ID 换 Cookie**（`installTabRule` 的形态） | 返回后规则是新 Cookie，不是空 | ✅ 返回即生效，中间无「没有规则」状态 |
| A2 | 组合形式里夹一条**非法规则**（`priority: -1`） | Chrome 报 `Rule with id 10001 has an invalid value for priority`，**旧规则原封不动、新 ID 不存在** | ✅ **整批回滚**，不留半成品 |
| A3 | 组合形式、**删旧 ID 加新 ID**（收敛后的 `installPathRules` 形态） | 201 个样本，**空窗 0**，仅旧 1 / 仅新 200 | ✅ 未观测到「两者都不存在」 |
| B1 | **两次调用**（当前写法）、中间人为插延迟 | delay=0ms 空窗 1/412；5ms 空窗 24/401；50ms 空窗 246/664 | ⛔ 两次调用**确实有窗口**，且窗口长度与延迟成正比 |

**A3 与 B1 互为对照**：同一套采样器，组合形式 0 空窗、两次调用有空窗且随延迟线性增长 →
空窗是两次调用**真实存在的**，不是采样器噪声。

### 采样器可信性自检

第一版脚本里 B1 只采到 3 个样本、A3 采到 201 个 —— 采样数差两个数量级，
**这本身就可疑**（轮询器可能被两次 `await` 饿死）。所以补了
`poc/verify/dnr-atomicity-sampler-selftest.cjs`：把两组调用之间插入 0 / 5 / 50ms
人为延迟，看空窗样本数是否随之增长。

结果：**1 → 24 → 246**。空窗随人为延迟单调增长，说明采样器能看见窗口。
自检通过后 A3/B1 的对照才算成立。

---

## 决策

**确认：`updateSessionRules({ removeRuleIds, addRules })` 组合形式是原子的，可以采用。**

据此：

1. `installPathRules()` **可以**收敛成一次组合调用，消除「删完还没加」的窗口。
   **本次不立即改** —— `dnr.ts` 是最高风险文件，收窄它需要单独的一次改动 + 重跑两个
   DNR 回归脚本（`AGENTS.md` §4.3）。本 ADR 只负责把事实钉住。
2. `installTabRule()` 的存量用法**经核查是安全的**（A1/A2 覆盖了它：
   同 ID 换 Cookie 返回即生效，非法输入整批回滚）。
3. **不把「组合形式原子」当成「换 Cookie 无窗口」的证明。** 两者不是一回事：
   同 ID 换 Cookie 时旧规则在，请求最坏拿到旧 Cookie；收敛后的 `installPathRules` 删的是
   **整个 ID 段**（含残留 ID），那一段在调用期间仍然是「旧规则还在」而不是「空的」——
   这正好消除了当前写法里真实存在的空窗。

---

## 后果

**好的**：
- O1 的「开工前置」从推演变成事实，`installPathRules()` 有了收敛的依据。
- `updateSessionRules` 失败时**整批回滚**（A2）意味着不存在「删成功、加失败」的半成品状态 ——
  这一点此前也没人验证过，而它是「规则表被改坏」这类事故的前提。

**代价 / 边界**：
- 实测只覆盖 Edge（Chromium 内核）。Firefox 不在 v1 支持范围（`AGENTS.md` §3 决策 9）。
- 探测精度是 `getSessionRules()` 一次往返（毫秒级）。理论上一段短于此的中间态测不出来 ——
  但 A3 在 200+ 样本上零空窗，而 B1 在同等条件下能稳定测出窗口，
  所以「测不出来」这个解释对 A3 不成立。

---

## 被否的方案

| 方案 | 为何不选 |
| --- | --- |
| 维持两次调用 + 加请求重试兜底 | 增加一条需要维护的容错链路，而组合形式本身就能消掉窗口 |
| 每请求 add/remove 规则 | [ADR 0006](./0006-no-per-request-nonce.md) 已否，且与本条无关 |
| 靠「规则 ID 池」避免碰撞 | [ADR 0006](./0006-no-per-request-nonce.md) 与 `ruleIdForPath()` 已否 |

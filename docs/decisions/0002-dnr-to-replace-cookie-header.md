# ADR 0002. 用 DNR 规则替换 Cookie 请求头，而非 chrome.debugger

日期：2026-10-24
状态：已采纳（Q2 已验证通过，2026-10-25）· **实现细节已被 [ADR 0006](./0006-no-per-request-nonce.md) 修正：去掉 per-request nonce**
风险等级：高 —— 这是唯一可能推翻整体方案的决策

## 背景

Dual Account Helper 作为油猴脚本，用 `GM_xmlhttpRequest` 的 `anonymous: true` 排除浏览器自带的主账号 Cookie，再手动指定副账号 Cookie。**MV3 扩展没有这个能力**：

- Service Worker 的 `fetch` **禁止**设置 `Cookie` 请求头（forbidden header）
- `credentials: 'include'` 会带上主账号 Cookie
- `credentials: 'omit'` 又完全不带 Cookie

需要找到"发一个不带主账号 Cookie、而带副账号 Cookie 的请求"的办法。

## 决策

使用 **`chrome.declarativeNetRequest` 的动态规则**（`updateSessionRules`）来 `set` 请求的 `cookie` 头。

模式：

```ts
// 1. 生成一次性 nonce，写一条精确匹配的规则
await chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [ruleId],
  addRules: [{
    id: ruleId, priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'set', value: playbackCookie }],
    },
    condition: {
      urlFilter: `||api.bilibili.com${path}*nonce=${nonce}`,
      resourceTypes: ['xmlhttprequest'],
    },
  }],
});

// 2. 立刻发请求（fetch 用 credentials: 'omit' 保证不带主账号 Cookie）
const res = await fetch(`${url}${sep}nonce=${nonce}`, { credentials: 'omit' });

// 3. 在 finally 里删规则
```

## 理由

1. **官方文档确认可行**：`cookie` 在 `modifyHeaders` 的 `append` 白名单内，`set` / `remove` 亦支持。
2. **不触发调试提示条**，不受商店政策限制（对比 `chrome.debugger`）。
3. **规则条件可精确到 URL**，比"整个域替换 Cookie"安全得多。

## 被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| `chrome.debugger` + CDP `Fetch.continueRequest` | 完全可控，但会显示"Pluma 正在调试此浏览器"提示条，用户体验灾难，且商店政策限制用途 |
| 在页面 MAIN world 里 hook fetch 自己发请求 | 页面发 XMLHttpRequest 必然带主账号 Cookie（同源），无法排除；且跨域限制 |
| 整个域替换 Cookie（不分路径） | 会让页面所有请求都用副账号身份，等于放弃"主账号管社交"的核心设计 |
| `webRequestBlocking` | MV3 已移除该能力（仅企业策略例外） |

## 已知风险（Q2）

> **本节已由实测更新。** 原设计的缓解措施（规则 ID 池、nonce、定时回收）在 [ADR 0006](./0006-no-per-request-nonce.md) 中被整体撤掉——实测证明不需要 per-request 区分。下面保留原始记录，作为"当初担心什么"的存档。

**MV3 的 DNR 规则是全局的，不是 per-request 的。** 潜在问题：

1. **规则 ID 冲突**：多条规则不能同时用同一个 ID
2. **nonce 碰撞**：如果 nonce 可预测或复用，可能命中错误规则
3. **规则泄漏**：`fetch` 抛异常未删规则，残留规则会影响后续请求
4. **并发容量**：规则数有上限（`MAX_NUMBER_OF_SESSION_RULES`），并发高时可能触顶

**原缓解设计**（已废弃，见 ADR 0006）：

- ~~规则 ID 池（预分配 32 个，轮转复用）~~
- ~~nonce 用 `crypto.randomUUID()`~~
- ~~加规则 → 请求 → 删规则整段包在 `try/finally` 里~~
- ~~每条规则带时间戳，定时回收超时规则~~
- ~~池满时降级：排队等待，或直接退回主账号身份~~

## 验证结果

**Q2 已通过（2026-10-25）。** 180 个并发请求，串号数 0，规则残留 0。数据见 [`docs/03-open-questions.md`](../03-open-questions.md) §2，工具见 `poc/q2-dnr-concurrency/`。

**退路不再需要**：串行化 / `chrome.debugger` / 本地服务三条备选方案均未启用。

## 相关

- 技术方案：`docs/01-architecture.md` §4.2
- 待确认问题：**Q2（已实测通过）**
- 实现细节修正：[ADR 0006](./0006-no-per-request-nonce.md)
- 代码位置：`src/platform/http/dnr.ts`（本决策的唯一实现点）
- 目录规范：`docs/04-project-structure.md` §5

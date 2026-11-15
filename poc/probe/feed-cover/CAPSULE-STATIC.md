# 胶囊不渲染 —— 静态对比报告（account/summary vs streaming/status）

> **日期**：2026-11-11
> **范围**：纯静态。**未开浏览器、未改代码。**
> **前置**：A 半（UI 语义树）已在 `CAPSULE-BUG.md` 取证完毕，分类 = **missing control**

---

## 0. 结论

# 静态对比**没有找到**两条消息的任何结构差异。**两者完全对称。**

**已静态排除 5 类假设**（见 §5）。
**剩下只能是运行时**（`sendMessage` 实际 reject 或 content script 未跑到那行）。

---

## 1. background.ts 里的注册形式 —— **完全对称**

### `account/summary`（`background.ts:195`）

```ts
if (type === 'account/summary') {
  const { recheck } = message as { recheck?: boolean };
  handleAccountSummary(recheck === true)
    .then(sendResponse)
    .catch(() => sendResponse({ type: 'account/summary:err', code: 'UNKNOWN', detail: null }));
  return true;
}
```

### `streaming/status`（`background.ts:359`）

```ts
if (type === 'streaming/status') {
  readStreamingIdentity()
    .then((identity) => sendResponse({ type: 'streaming/status:ok', identity }))
    .catch(() => sendResponse({ type: 'streaming/status:ok', identity: 'extension' }));
  return true;
}
```

| 对比项 | account/summary | streaming/status | 差异 |
| --- | --- | --- | --- |
| 在同一个 `onMessage` listener 里 | ✅ `:143` | ✅ `:143` | 无 |
| `if (type === ...)` 分支 | ✅ | ✅ | 无 |
| 异步 + `sendResponse` | ✅ | ✅ | 无 |
| `return true` | ✅ | ✅ | 无 |
| `.catch` 兜底 | ✅ 返回 `err` | ✅ 返回 **`ok`**（更强的兜底） | streaming 更稳 |

**唯一区别**：`account/summary` 在 catch 里回 `:err`，`streaming/status` 在 catch 里回 **`:ok` + `identity:'extension'`**。
**后者更不可能导致 `null`。**

---

## 2. messages.ts 里的类型定义 —— **完全对称**

```
messages.ts:34  | { type: 'account/summary'; recheck?: boolean }
messages.ts:193 → type: 'account/summary:ok'

messages.ts:72  | { type: 'streaming/status' }
messages.ts:289 → | { type: 'streaming/status:ok'; identity: 'extension' | 'page' }
```

**机制扫描**（`probe-static-msg2.mjs` §A）：`streaming` 相关联合成员共 5 条，**没有重复定义**，
`'streaming/status:ok'` 只出现一次（`:289`）。

---

## 3. 发送方 —— **完全对称**

### `account/summary`（`content-panel.content.ts:136`）

```ts
const readAccountMid = async (): Promise<AccountSnapshot> => {
  const res = (await chrome.runtime
    .sendMessage({ type: 'account/summary' })
    .catch(() => null)) as { ... } | null;
  const mid = res?.type === 'account/summary:ok' ? (res.account?.profile?.mid ?? null) : null;
  return { mid: typeof mid === 'number' ? mid : null };
};
```

### `streaming/status`（`content-panel.content.ts:284`）

```ts
const readStreamingIdentity = async (): Promise<StreamingIdentity | null> => {
  const res = (await chrome.runtime
    .sendMessage({ type: 'streaming/status' })
    .catch(() => null)) as { type?: string; identity?: StreamingIdentity } | null;
  return res?.type === 'streaming/status:ok' && res.identity ? res.identity : null;
};
```

| 对比项 | account/summary | streaming/status |
| --- | --- | --- |
| API | `chrome.runtime.sendMessage` | 同 |
| `.catch(() => null)` | ✅ | ✅ |
| 判应答类型 | `=== ':ok'` | 同 |
| 失败返回 | `{ mid: null }` | `null` |

**同一种写法、同一个 API、同一个失败模式。**

### 发送时机（Lead 特别关注的「会不会根本没执行」）

| 消息 | 何时发 |
| --- | --- |
| `account/summary` | ① `loadOnce()` 里（面板挂载后 / 每次展开）② 轮询每 3s ③ `readAccountMid()` 扫码轮询 |
| `streaming/status` | **仅一次**：`ensureStreamingIdentityRead()`，在 `:449` `await` |

**这是唯一的实质差异**（见 §4.2），但它不影响"**第一次**能不能发出去"。

---

## 4. 控制流核查（Lead 点名）

### 4.1 `:437-450` 有没有提前 return —— **没有**

```ts
437 |     enabled = await readPanelEntryEnabled();
...
449 |     await ensureStreamingIdentityRead();
450 |     paint();
```

**机械扫描 `main()` 内 `:437` 之前的所有顶层 `return`：0 处。**

```
--- main() 里 :437 之前的所有 return（会跳过 :449 的）---
  ✅ 没有顶层 return 会跳过 :449
```

`main()` 从 `:110` 开始，`:437` 之前只有函数定义与变量声明，**没有任何 `if (...) return` 在顶层**。

### 4.2 `paint()` 内部的 return —— 三处，都在预期位置

| 行 | 代码 | 含义 | 会不会吞胶囊 |
| --- | --- | --- | --- |
| `:380` | `return;` | `!enabled` 时摘面板 | ❌ 不会（用户开着面板才看得到，而面板在） |
| `:383` | `if (sidebar !== null) return;` | 已挂载就不重建 | ⚠️ **只在第二次调用时命中，首次挂载必过** |
| `:431` | `return;` | `shadow === null` 时清句柄 | ❌ 不会（面板正常渲染，shadow 不为 null） |

**`:383` 不是问题**：`paint()` 首次调用时 `sidebar === null`，必然走到 `ensurePanelHost(...)` 的 build 回调，那里用 `streamingIdentityCache ?? null` 画胶囊。

### 4.3 `readPanelEntryEnabled()` 会不会抛

`enabled = await readPanelEntryEnabled()` 在 `:437`，位于 `:449` **之前**。
若它抛错，`main()` 中断，`:449` 不执行 → 面板也不会挂载。
**但实测面板挂载了**（A 半证据）→ **`:437` 必然成功执行** → **`:449` 必然被执行。**

> ✅ **这条把「根本没跑到 :449」的假设 C 收窄了**：
> 面板能出现 ⇒ `paint()` 被调用过 ⇒ `:449` 在它之前且未中断 ⇒ `readStreamingIdentity()` **一定被 await 过一次**。

---

## 5. 已静态排除的假设（逐条）

| # | 假设 | 排除依据 |
| --- | --- | --- |
| 1 | `streaming/status` 没注册 handler | `background.ts:359` 有，且发送/接收差集为空（机械扫描） |
| 2 | 消息类型没定义 | `messages.ts:72` / `:289` 都有，无重复 |
| 3 | handler 返回空 `identity` | `.then` 给 `readStreamingIdentity()` 的返回值（**必为 `'extension'|'page'`**）；`.catch` 给 `'extension'` |
| 4 | `readStreamingIdentity()` 抛错 | 实现是 `chrome.storage.local.get` + `normalizeStreamingIdentity()`；后者 `return raw === 'page' ? 'page' : DEFAULT` —— **纯表达式，不可能抛**；有 `storage` 权限，`get` 不会 reject |
| 5 | 控制流跳过了 `:449` | 面板已挂载 ⇒ `paint()` 执行过 ⇒ `:449` 在其之前且无顶层 return |
| 6 | 构建产物缺代码 | `.output/chrome-mv3`（14:06）：`streaming/status` 在 content-panel.js + background.js；两条胶囊文案都在 |

> ⚠️ **第 4 条尤其强**：`normalizeStreamingIdentity` 是
> `raw === 'page' ? 'page' : DEFAULT_STREAMING_IDENTITY`，**任何输入都返回合法值**。
> 所以 background 侧**不可能**产出 `identity: undefined`。

---

## 6. Lead 提的 `incognito: "split"` 假设 —— **静态可排除**

`wxt.config.ts:88` `incognito: 'split'` 确认存在。但：

1. **`split` 下扩展在普通窗口和无痕窗口各有一个 SW 实例**，二者独立。
2. **`chrome.runtime.sendMessage` 路由到"发送者所在的实例"**，不是随机的。
3. 用户在**普通窗口**打开 B 站 → content script 属于普通实例 → 消息发到**普通实例的 SW**。
4. 即使无痕实例挂了，也不影响普通实例的应答。

**而且**：`account/summary` 走的是**完全相同的路由**，它通了 → 说明普通实例的 SW 正常 → `streaming/status` 发到的是同一个正常的 SW。

> **所以 `incognito: split` 不是本 bug 的原因。** 证据等级：**推理**（基于 Chromium 消息路由语义），但 §1–§3 的对称性使它成为很强的推理。

---

## 7. 剩下只有运行时

静态已排除 §5 的 6 类。**逻辑上只剩下**：

| # | 可能 | 为什么静态排不掉 |
| --- | --- | --- |
| **R1** | `chrome.runtime.sendMessage({type:'streaming/status'})` 在运行时 reject（SW 未就绪 / 上下文失效），`.catch(() => null)` 吞掉 | 运行时状态，静态不可见 |
| **R2** | 应答到了但 `res` 形状不符（例如跨 world 结构化克隆丢了字段） | 静态不可见 |
| ~~R3~~ | content script 没跑到 `:449` | **已被 §4.3 排除**（面板挂载了） |

**注意 R1 有一个强佐证**：`content-panel.content.ts:361` 的缓存是永久的：

```ts
if (streamingIdentityCache !== undefined) return;
streamingIdentityCache = await readStreamingIdentity().catch(() => null);
```

**首次 reject → 缓存 `null` → 本页生命周期内永不重试。**
这解释了为什么"刷新后仍不出现"只在**新页面首次也 reject** 时才成立 ——
而实测刷新后也不出现，说明**每次新页面加载的首次读取都失败**。

> 如果只是偶发（SW 冷启动慢），刷新几次应该有一次成功。
> **每次必败**更像 R2（形状不符）或某条稳定的 reject 路径。

---

## 8. 我的建议（两条，都不需要我改代码）

### 建议 A：让 engineer-a 修的时候顺带把 `null` 变成可见状态
按 skill 3b 条：`null` 应该渲染一个**可见的未知态**（例如「取流：未知」灰胶囊），
而不是整块消失。这既修了 bug，也**让下次再看一眼就知道是 null**。

### 建议 B：要拿 B 半，最短的一行（人工，30 秒）
在 background SW 的 DevTools console：
```js
chrome.runtime.sendMessage({type:'streaming/status'}).then(r => console.log('STATUS', r))
```
- 打出 `{type:'streaming/status:ok', identity:'extension'}` → **B 半正常，问题在 content script 侧**（R1/R2）
- 打出 `undefined` / 报错 → **问题在 SW 侧**

---

## 附：本报告用到的脚本

| 文件 | 内容 |
| --- | --- |
| `probe-static-compare.mjs` | §1–§4：两个 handler / 类型 / 发送方 / 控制流 |
| `probe-static-msg2.mjs` | §2 / §6：messages.ts 机制扫描 + `readStreamingIdentity` 实现 |

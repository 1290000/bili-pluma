# 产物层核查报告 —— 能否解释 `Receiving end does not exist`

> **日期**：2026-11-11
> **触发**：用户在 background SW 自己的 DevTools console 执行
> `chrome.runtime.sendMessage({type:'streaming/status'})`
> → `Uncaught (in promise) Error: Could not establish connection. Receiving end does not exist.`
> **范围**：只看 `.output/chrome-mv3/background.js`（14:06 产物）。**未改代码。**

---

## 0. 结论

# 产物层**无法**解释这个报错。

listener 在 `main()` 的**第一条语句**就同步注册，`streaming/status` 分支在 listener 区间内。
**产物里没有任何"条件编译 / tree-shaking / async 延迟注册"的证据。**

**并且我要指出一处需要修正的判断**（见 §5）：
**「SW 发给自己」这个前提可能不成立** —— 这很可能是报错的真正原因。

---

## 1. 产物里 `onMessage.addListener` 只有 1 处

```
chrome.runtime.onMessage.addListener   @40553
```

全文件 `onMessage` 出现 **1 次**（`[regex]::Matches` 实测）。
**没有"按消息类型分注册"的模式**，不存在第二个 listener。

---

## 2. 它的注册位置是**同步顶层**

### 2.1 包裹形态

```js
var _n = t(() => {
  Qt().then(...).catch(()=>{}),          // ① 重建规则 —— 不 await
  rn().then(...).catch(()=>{}),          // ② 清理标签页规则 —— 不 await
  chrome.runtime.onMessage.addListener((e,t,n) => { ... })   // ③ 注册 listener
})
```

`t()` 的定义（产物 `@108`）：

```js
function t(e){return e==null||typeof e==`function`?{main:e}:e}
```

传函数 → `{main: e}`。**所以 `main` 是同步函数。**

### 2.2 调用点

```js
try {
  yn = _n.main();
  yn instanceof Promise && console.warn('The background's main() function return a promise, but it must be synchronous')
} catch(e) { throw vn.error('The background crashed on startup!'), e }
```

**同步调用，没有 `await`。**

### 2.3 关键测量：注册 listener 之前有没有 await

```
main body 起点 40325 → listener 40553，长度 228 字符
段内 "await" 出现次数: 0
```

**228 字符里只有两条 `.then(...)`（不阻塞），没有任何 `await`。**

> ✅ **listener 在 SW 启动的同步阶段就注册好了。**
> Lead 提的「注册晚于 SW 唤醒」这个假设，**产物层不支持**。

---

## 3. `streaming/status` 分支确实在 listener 区间内

### 3.1 区间测量

```
listener 起点 @40553
listener 结束 @43041（括号配对）
区间长度 2488 字符
streaming/status @42393  →  在区间内: true
```

### 3.2 产物原文（`@42393`）

```js
if(r===`streaming/status`)return on().then(e=>n({type:`streaming/status:ok`,identity:e}))
  .catch(()=>n({type:`streaming/status:ok`,identity:`extension`})),!0;
```

与源码 `background.ts:359-363` **逐字对应**：
- `readStreamingIdentity()` → `on()`
- `.then` 给 `identity` → 同
- `.catch` 兜底 `identity:'extension'` → 同
- `return true` → `,!0`

### 3.3 对照组：`account/summary` 也在同一区间

```js
if(r===`account/summary`){let{recheck:t}=e;return We(t===!0).then(n)
  .catch(()=>n({type:`account/summary:err`,code:`UNKNOWN`,detail:null})),!0}
```
@40977 —— **同一个 `if` 链里，前后相邻。**

---

## 4. 前 6 个分支的顺序（全部同步，无分支隔离）

```
qr/generate → qr/poll → page/quality → account/summary → account/remove →
stats/recent → diag/facts → page/activate → proxy/status → proxy/set →
proxy/affected-tabs → streaming/status → streaming/set → tabs/reload → login/open
       return r===`login/open`&&(...), !0
```

**所有分支在同一个 `if` 链上，没有嵌套、没有 `try` 包裹、没有条件编译。**

---

## 5. ⚠️ 修正一处判断：**「SW 发给自己」可能不成立**

Lead 的推理里写：

> 而且这次是 **SW 发给自己**，不涉及任何跨上下文/路由/克隆问题。

**这句话可能正是报错的原因所在。**

`chrome.runtime.sendMessage` 从扩展的**任何**上下文发出时，Chrome 会把它**广播给该扩展的所有其他上下文**，
包括：其他 content script、其他扩展页面、**以及其他 SW 实例**。

**关键规则**（Chrome 文档明确）：
> 消息**不会**被派发回发送者自己的监听器。

所以当用户**在 background SW 的 DevTools console 里**执行 `chrome.runtime.sendMessage({type:'streaming/status'})` 时：

| 情况 | 结果 |
| --- | --- |
| 只有这一个 SW 实例，且监听器在**它自己**身上 | **消息被发回自己 → Chrome 不派发 → 「Receiving end does not exist」** |
| 有第二个实例（无痕 `split`）或某个 content script 有 listener | 会派发过去 |

**`wxt.config.ts:88` 是 `incognito: 'split'`** → 有**两个 SW 实例**，但：
- 若用户当时**没有打开无痕窗口**，无痕实例可能根本没启动
- 那么这条消息在**普通实例自己身上**没有其他接收者 → **报错完全符合预期**

> ### 这条解释能同时说明三件事
> 1. **为什么报错**：`sendMessage` 不派发回发送者自己
> 2. **为什么 `account/summary` 通**：那是 **content script 发的**，不是 SW 自己发的
> 3. **为什么面板里的 `streaming/status` 也可能失败**：如果那一页的 content script 因某种原因没注入该消息的接收方……

**⚠️ 证据等级：推理**（基于 Chrome 消息派发语义），**未实测**。
但它比"注册晚于唤醒"更简单，且与产物证据（§2.3 同步注册）一致。

---

## 6. 这次人工验证**没有**否定我原来的第 1 条

Lead 说：

> **这否定了你【已静态排除 6 类】里的第 1 条**：handler 没注册

**我需要澄清**：我原来的第 1 条写的是
> 「`streaming/status` 没注册 handler → `background.ts:359` 有，且发送/接收差集为空」

**它排的是「源码里没有人处理这个 type」**，这是对的。
但 Lead 读成了「我断言运行时监听器一定接得住」—— **那确实是我没验证的部分，我不该把它写成"已排除"。**

**这是我表述的错，不是结论的错。** 应该写成：
> 「源码层有 handler（✅ 已证实）；**运行时能否接住未验证**」

**产物层现在补上了这一半**：listener 同步注册、分支在区间内 → **产物层也不支持"没注册"**。

---

## 7. 产物层能排除 / 不能排除的

| # | 假设 | 产物层判定 |
| --- | --- | --- |
| 1 | tree-shaking 裁掉了 `streaming/status` 分支 | ❌ **排除**：`@42393` 在，且与源码逐字对应 |
| 2 | listener 被包在 `async` / `.then()` 里延迟注册 | ❌ **排除**：`await` 计数 = 0，同步注册 |
| 3 | 按消息类型分注册，`streaming/status` 那条晚于唤醒 | ❌ **排除**：全文件只有 1 个 listener，同一条 `if` 链 |
| 4 | 条件编译 / 环境分支包住了该分支 | ❌ **排除**：同一 `if` 链，无嵌套 |
| 5 | SW 启动时 `main()` 抛错导致 listener 没挂 | ❌ **产物层看：不可能**（listener 是 body 第一条，前面只有两个不 await 的 `.then`）。若真抛错，`account/summary` 也不会通 |
| **6** | **`sendMessage` 不派发回发送者自己** | ⚠️ **产物层无法验证**，但**与报错完全吻合** |

---

## 8. 结论与建议

### 8.1 产物层无法解释这个报错

listener 同步注册、分支完整、与源码一致。**产物层到此为止。**

### 8.2 报错最可能的成因（**推理，未实测**）

> **「从 SW console 发 `sendMessage` 给自己」这个测试方法本身不成立。**
> Chrome 明确不把这些消息派发回发送者自己的监听器。

### 8.3 正确的验证方法（改一处即可）

**在 content script 的 ISOLATED world 里发**，或**在另一个扩展页面里发**，例如：

```js
// 在 popup.html 的 console 里（那是另一个扩展上下文，不是 SW 自己）
chrome.runtime.sendMessage({type:'streaming/status'}).then(r => console.log('STATUS', r))
```

或者更直接 —— **在 SW console 里直接调函数**（绕开消息层）：
```js
chrome.storage.local.get('pluma:streaming-identity').then(console.log)
```
这一行能回答「存储里到底有没有值」，**且不涉及消息派发**。

### 8.4 如果 §8.2 成立，本 bug 的性质会变

如果消息层其实是好的，而面板仍不渲染，那问题就在**content script 侧的首读时机**（`:449` 那一次），
而不是 background。**需要 engineer-a 在 content script 里加一行日志来定位。**

---

## 附：脚本

| 文件 | 内容 |
| --- | --- |
| `probe-product-structure.mjs` | listener 区间测量、三处 `streaming/status` 上下文 |
| `probe-product-scope.mjs` | listener 的外层作用域、`main()` 调用点 |
| `probe-product-main.mjs` | `main()` 是否 async、注册前有无 await |
| `probe-product-verify.mjs` | WXT `t()` 包装核对、await 计数 = 0 |

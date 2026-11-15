# 取流身份胶囊不渲染 —— 配对取证报告

> **日期**：2026-11-11 14:xx
> **症状**：用户重载扩展后，面板「账号」Tab 里的「取流：扩展账号 / 取流：浏览器账号」二态胶囊**仍然不出现**
> **环境**：bsk 0.3.3 / Edge 157（用户日常实例）/ 扩展 ID `fgmggjhdbgaclcbeaopajghpnhgkmfnf` / 产物 14:06
> **纪律**：只读。不点视频、不发写请求、不改设置、不重启浏览器。

---

## 0. 分类（先填这格）

# **missing control**

按 `field-path-alarm-triage` 的分类表：

| Class | 判据 | 本次是否符合 |
| --- | --- | --- |
| wrong label | 控件在但文案错 | ❌ 控件根本不在树里 |
| **missing control** | **控件不在任何 Tab** | ✅ **符合**（见 §1） |
| missing input | 控件在但点不动 | ❌ 控件不在 |
| missing data | 有状态显示但派生值全空 | ❌ 无关 |

---

## 1. A 半：UI 语义树（**实测**）

### 1.1 方法

`bsk snapshot`（辅助功能树，可穿透 `mode:'closed'` 的 Shadow DOM）。
**逐 Tab 扫描**（技能要求：声称"不存在"前必须扫遍每个 Tab）。

### 1.2 四个 Tab 的完整结果

| Tab | `取流：扩展账号` | `取流：浏览器账号` |
| --- | --- | --- |
| 初始（未点 Tab） | ❌ false | ❌ false |
| 画质 | ❌ false | ❌ false |
| 净化 | ❌ false | ❌ false |
| 显示 | ❌ false | ❌ false |
| **账号** | ❌ **false** | ❌ **false** |

整棵树里**没有任何 `取流：` 字样**（`/取流：/` 零命中）。

### 1.3 账号 Tab 的实际内容（原文）

```
StaticText "Pluma"
  button "收起面板"
  navigation
    tab "画质"   tab "净化"   tab "显示"   tab "账号"
StaticText "主"
StaticText "{{主账号昵称}}"
StaticText "收藏 · 点赞 · 评论 · 历史"
StaticText "LV6"
StaticText "播"                          ← 取流账号卡确实渲染了
StaticText "{{取流账号昵称}}"
StaticText "仅取流 · 6 个月后到期"
StaticText "21 小时前校验"
StaticText "年度大会员"
button "重新登录"
button "退出取流账号"
@pwarning geometry incomplete
```

### 1.4 关键观察

> **取流账号卡（`{{取流账号昵称}}`）正常渲染了 —— 说明 `account/summary` 这条消息是通的。**
> 卡片上唯独缺了本该挂在它上面的身份胶囊。

这**排除了"整个面板消息通道全挂"**的可能，问题收窄到 `streaming/status` 这一条。

---

## 2. B 半：底层真实数据

# ⚠️ **拿不到。本机工具链无法进入 ISOLATED world。**

按技能第 1 步要求，我不推理补全。以下是我**试过的全部四条路**及其失败原因：

| # | 路径 | 结果 |
| --- | --- | --- |
| 1 | `bsk evaluate` 在页面 main world 调 `chrome.runtime.sendMessage` | ❌ `{"chromeExists":true,"storageExists":false,"runtimeExists":false,"runtimeId":null}` |
| 2 | `bsk evaluate --world isolated` | ❌ **`bsk evaluate` 没有 `--world` 参数**（查 `--help`：只有 `--json` / `--session` / `--tab-id` / `--await-promise` / `--return-by-value` / `--timeout`） |
| 3 | `bsk debug pages` 列执行上下文 | ❌ 只返回主框架一个 page；`coverage` 明确含 `"worker_targets_not_captured"` / `"manual_main_frame_only"` |
| 4 | `bsk console` 读 content script 报错 | ❌ content script（ISOLATED）的 console **不进入页面 console**；读到的 24 条里只有 B 站自己的 400 / ERR_FAILED |

**另一条被排除的假设**（实测）：**不是刷新时序问题**。
我 reload 页面让 content script 重跑（`performance.now()=31955ms`，`loadEventEnd=2008ms` → 确认是同一份新加载），
再点开面板切到账号 Tab —— **胶囊仍然不出现**。

---

## 3. 能拿到的静态证据（**代码侧，不是运行时**）

### 3.1 消息链两侧完全对齐（**实测：机械扫描**）

```
发送侧（content-panel.content.ts）：
  ["account/summary", "login/open", "account/remove", "streaming/set", "streaming/status"]

接收侧（background.ts）：
  ["qr/generate","qr/poll","page/quality","account/summary","account/remove","stats/recent",
   "diag/facts","page/activate","proxy/status","proxy/set","proxy/affected-tabs",
   "streaming/status","streaming/set","tabs/reload","login/open"]

差集（发了但没人接）：[]    ← 空
```

**所以"消息没注册"这个假设被机械排除。**

### 3.2 构建产物完整（**实测**）

```
.output/chrome-mv3/  时间戳 2026/11/11 14:06

streaming/status     -> content-panel.js, background.js     ✅
取流：扩展账号        -> content-panel.js                    ✅
取流：浏览器账号      -> content-panel.js                    ✅
```

产物里的实际代码（`content-scripts/content-panel.js`，压缩后）：

```js
m = async () => {
  let e = await chrome.runtime.sendMessage({ type: `streaming/status` }).catch(() => null);
  return e?.type === `streaming/status:ok` && e.identity ? e.identity : null
},
v = async () => { _ === void 0 && ( _ = await m().catch(() => null)) }   // ← 缓存
```

**与源码一致，没有构建优化破坏。**

### 3.3 渲染守卫（原文引用）

`src/content/panel/tabs.ts:557`：
```ts
if (actions.streamingIdentity !== null) {   // ← null 就整块不渲染
```

`entrypoints/content-panel.content.ts:395`：
```ts
streamingIdentity: streamingIdentityCache ?? null,
```

`entrypoints/content-panel.content.ts:361-362`（缓存）：
```ts
if (streamingIdentityCache !== undefined) return;
streamingIdentityCache = await readStreamingIdentity().catch(() => null);
```

`entrypoints/content-panel.content.ts:383`（面板不重建）：
```ts
if (sidebar !== null) return;
```

### 3.4 background 侧不可能返回空 identity（**读码**）

`entrypoints/background.ts:359-364`：

```ts
if (type === 'streaming/status') {
  readStreamingIdentity()
    .then((identity) => sendResponse({ type: 'streaming/status:ok', identity }))
    .catch(() => sendResponse({ type: 'streaming/status:ok', identity: 'extension' }));
  return true;
}
```

**两条分支都给出非空 `identity`**（`.catch` 兜底 `'extension'`）。
所以 `:286` 的 `res.identity ?` 判断**不会**把它变成 `null`。

---

## 4. 结论：**卡在哪一层，我无法确定**

### 4.1 可以确定的（实测）

1. ✅ 控件在**所有 Tab** 都不存在 → 分类 = **missing control**
2. ✅ `account/summary` 通（账号卡正常渲染）→ 不是整条通道挂
3. ✅ 消息两端都对得上（发送方 5 条 / 接收方 15 条 / 差集空）
4. ✅ 产物包含完整代码（14:06，`streaming/status` + 两条胶囊文案都在）
5. ✅ 页面 reload 后仍不出现 → **不是首次读取时序问题**

### 4.2 无法确定的（**未验证，不推断**）

剩下的可能只有三种，**我用现有工具无法区分**：

| # | 可能 | 为什么无法验证 |
| --- | --- | --- |
| A | `chrome.runtime.sendMessage({type:'streaming/status'})` 在运行时 reject，`.catch` 变 `null` | 进不了 ISOLATED world，看不到那次调用的结果 |
| B | 响应到了但 `res.type !== 'streaming/status:ok'`（例如 background handler 没匹配到这行） | 同上 |
| C | content script 根本没跑到 `:449` 的 `await ensureStreamingIdentityRead()`（例如更早的地方抛错） | 同上，且 content script 的报错不进页面 console |

**注意**：静态分析已经**排除**了「handler 返回空 identity」和「消息未注册」。所以 A/B/C 里更可能是 **A（sendMessage reject）** 或 **C（根本没跑到）**。

> ⚠️ **这是推理，不是实测。按纪律不作为结论。**

---

## 5. 拿到 B 半需要什么（给 Lead 的下一步建议）

| 方案 | 可行性 | 代价 |
| --- | --- | --- |
| **在 background SW 的 DevTools console 手动执行** `readStreamingIdentity()` | ✅ 最直接 | 需人操作（`chrome://extensions` → Service Worker → Console）；bsk 进不去内部页 |
| **给 content script 加一条临时 console.log** 打 `readStreamingIdentity()` 的结果 | ✅ 可行 | 要改代码 + 重新构建 + 重载（我不做，只读） |
| 用 Playwright 起独立 profile 加载扩展（`poc/probe/dnr-initiator` 的做法） | ✅ 能进扩展上下文 | 但**没有用户登录态**，复现不了这个 bug 的前置（有账号卡） |

**我的建议：方案 1**。只需在 SW console 打一行：
```js
chrome.storage.local.get('pluma:streaming-identity').then(console.log)
```
如果这行有值 → 问题在消息传递；如果报错 → 问题在 storage API。

---

## 6. 一个顺带的代码观察（**不是结论，供修的人参考**）

`entrypoints/content-panel.content.ts:361` 的缓存是**永久的**：

```ts
if (streamingIdentityCache !== undefined) return;
streamingIdentityCache = await readStreamingIdentity().catch(() => null);
```

一旦首次读到 `null`，**这一页生命周期内永远不会重试**。
结合 `:383`（`if (sidebar !== null) return;` 面板不重建），
**用户不刷新页面就永远看不到胶囊**。

这是"读不到就缓存 null"的设计，与 `"不猜默认值"` 一致，但**代价是没有任何恢复路径**。
按技能的 `3b` 条：`null` 守卫把整个入口吞掉，而"未获取"与"未知"在这条链上不可区分。

---

## 附：证据文件

| 文件 | 内容 |
| --- | --- |
| `probe-a-half.mjs` | A 半：逐 Tab 扫面板树，断言胶囊字符串 |
| `probe-b-half.mjs` | B 半尝试：reload 后复查（排除了时序假设） |
| `check-capsule.mjs` | 单次胶囊状态检查（可反复跑） |
| `probe-b-static.mjs` | 消息链静态对账（发送方 vs 接收方差集） |
| `probe-chrome-api.mjs` | 证明 main world 无 `chrome.runtime` |

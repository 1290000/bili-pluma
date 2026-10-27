# 跨环境消息协议

> 状态：**已实现**（v0.9.0）
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

**现行协议是单向的**：MAIN 只上报，ISOLATED 只在 `hello` 时下发一次配置。
**没有请求-应答**——DNR 在网络层换 Cookie，不需要把请求交给扩展重发
（[ADR 0010](../decisions/0010-page-proxy-via-tab-ids.md)）。

### 防护做了什么、没做什么

| 机制 | 状态 | 说明 |
| --- | --- | --- |
| 命名空间标记 `__ns` | ✅ 双向都验 | 挡住"不知道 NS 的"旁观脚本 |
| token（ISOLATED → MAIN） | ✅ 已做 | MAIN 在第一个 `cfg` 里锁定 token，之后每条都校验 |
| token（MAIN → ISOLATED） | ❌ **未做** | ISOLATED 侧只验 `__ns`，不验 token |

**未做的那一格为什么现在可接受**：MAIN 上报的内容只影响**画质显示**（徽章、主账号基线）。
ISOLATED **从不向 MAIN 发送凭据**，凭据只存在于 background，换 Cookie 由 DNR 在网络层完成。
所以页面伪造上报最多让 popup 显示错误的画质数字，**拿不到任何凭据**。

> ⚠️ **不要照旧草案实现"req / res + 8 秒超时"那套。** 它假设"MAIN 把请求交给 ISOLATED 重发"——
> 那才会泄露凭据，而且这条路早已废弃。完整消息清单看 `entrypoints/content.ts` 的 `listenMainWorld()`。

### 现行消息里两个容易搞混的

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
| `proxy/status` | UI→SW | — | 总开关状态（只读） |
| `proxy/set` | UI→SW | `{ enabled }` | 切换总开关 |
| `proxy/affected-tabs` | UI→SW | — | 已打开的视频页里还有几个是旧画质（→ `{ count, tabIds }`） |
| `tabs/reload` | UI→SW | `{ tabIds }` | 刷新指定标签页（用户点"全部刷新"） |
| `stats/recent` | UI→SW | — | 最近 1 小时成功率时序（12 桶） |
| `page/activate` | content→SW | `{ bvid, p, deviceCookies, primaryMid }` | 视频页报到，装 tab 规则 |
| `page/quality` | content→SW | `{ height, note? }` | 诊断日志 |

### 响应形状：判别联合，不是 `{ ok, data }`

成功与失败是**两个不同类型**，靠 `type` 后缀区分：

```ts
| { type: 'account/summary:ok'; configured: boolean; account: AccountSummary | null; needsRecheck: boolean }
| { type: 'account/summary:err'; code: ErrorCode; detail: string | null }
```

**为什么不用 `{ ok: boolean; data?: T }`**：那样调用方要先看 `ok` 再判断 `data` 是否为 undefined；
判别联合让 TS 直接窄化，漏处理 `:err` 分支会编译报错。

### 错误码

权威位置是 `src/shared/types/errors.ts` 的 `ERROR_CODES`（8 个，UPPER_SNAKE）。
**本文不抄第二份**——抄一次漂移一次。当前清单：
`NOT_CONFIGURED` / `CREDENTIAL_EXPIRED` / `PATH_NOT_ALLOWED` / `RULE_POOL_EXHAUSTED` /
`UPSTREAM_REJECTED` / `NETWORK_ERROR` / `TIMEOUT` / `UNKNOWN`。

**错误码是 UI 与业务的契约**：新增失败原因时先加错误码，再改 UI，再改实现。
反过来做会让 UI 出现"未知错误"这种无信息量的提示。

### SW 休眠

MV3 的 SW 在 30 秒无事件后休眠，`sendMessage` 可能抛 `Could not establish connection`。

**当前没有统一封装层**（`platform/runtime/messaging.ts` 从未创建）——
只有 3 个 UI 页面，页面里直接调 `chrome.runtime.sendMessage`。
真要处理冷启动失败，原则是**只重试一次**：重试多次会掩盖 handler 没注册这类真 bug。

---

## 通道 C：UI ↔ Service Worker

UI 有三个入口：popup、options、login window。

### 关键约束

1. **凭据永不下发给 UI。** UI 只能拿到 `AccountSummary`（`src/shared/types/account.ts`）：
   `{ profile: { mid, uname, avatarUrl }, vipLabel, expireAt, health: { healthy, checkedAt, reason } }`，
   拿不到 `sessdata`。**这是嵌套结构，不是扁平字段**——别按旧文档写 `{ uname, mid, healthy }`。
2. **popup 失焦即销毁。** 任何"等用户操作"的长流程都不能在 popup 里跑（见 `docs/02-ui-spec.md` §1）。
3. **扫码走独立窗口。** `chrome.windows.create({ type: 'popup', width: 420, height: 600, incognito: true })`。
   窗口关闭时通知 SW 清理扫码会话。

### 状态推送 vs 轮询

popup 存活时间很短，用**拉取**（打开时查一次）比**推送**简单可靠。

```
popup 打开 → send({ type: 'account/summary' }) → 渲染对应状态
（不需要 SW 主动 push，因为 popup 生命周期太短，push 没有意义）
```

> ⚠️ **options 页也没有推送机制，用的是同一套拉取式 `account/summary`。**
> 不存在 `account/health` 之类的广播类型——`messages.ts` 里没有它。
> 如果将来要实时更新，得**新增**一条消息类型，而不是假设它已经存在。

---

## 协议演进规则

1. **现行没有版本号字段**，只有命名空间标记 `__ns`（防误收别人的消息）。
   所以改消息形状必须**两边同时改**（`public/main-world.js` ↔ `entrypoints/content.ts`），
   没有兼容层兜底。真要引入版本号，等第一次不兼容改动时再加。
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

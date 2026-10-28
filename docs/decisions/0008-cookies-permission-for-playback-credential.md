# ADR 0008. 申请 `cookies` 权限（推翻 Q5 的"不需要"）

日期：2026-10-25
状态：已采纳

## 背景

[Q5](../03-open-questions.md) 原本的结论是"技术上可能**完全不需要**申请 `cookies` 权限"，理由是：
- 设备 Cookie（`buvid3` 等）可从 `document.cookie` 借
- 主账号的 `SESSDATA` 由浏览器自动带，扩展不用读
- 主账号身份对比靠同源 fetch

这个分析**只覆盖了主账号**，漏了播放账号。

2026-10-25 实测扫码登录成功后（探针脚本当时一次性使用，未入库）：

```
data.url   → https://passport.biligame.com/x/passport-login/web/crossDomain
             参数只有 ticket, gourl, first_domain      ← 不含任何凭据
响应头     → Set-Cookie: SESSDATA=...
```

**凭据只通过 `Set-Cookie` 下发，`data.url` 里没有。**

而浏览器的 `fetch` 读不到 `Set-Cookie`（forbidden response header），`document.cookie` 读不到 httpOnly。**扩展没有任何纯 JS 手段能拿到播放账号的 `SESSDATA`。**

## 决策

**申请 `cookies` 权限**，但严格限定：

| 限定项 | 内容 |
| --- | --- |
| 域名 | `host_permissions` 只写 `*://*.bilibili.com/*`，警告范围限定在 B站 |
| 用途 | ① 扫码登录成功后读取播放账号的 `SESSDATA` / `bili_jct` / `DedeUserID`；② 可选的主账号画质对比 |
| 时机 | 只在登录那一刻读一次，之后走加密存储，不再读 |
| 不读 | 不读其他任何网站的 cookie，不读主账号的 `SESSDATA`（用不上） |

## 被放弃的方案

| 方案 | 为什么不用 |
| --- | --- |
| 从 `data.url` 解析 | **实测证伪**：url 里只有 `ticket`/`gourl`/`first_domain` |
| `document.cookie` | `SESSDATA` 是 httpOnly |
| `chrome.webRequest.onHeadersReceived` 读 `Set-Cookie` | 能做，但 `webRequest` 权限的警告（"读取你的浏览记录"）比 `cookies` 更宽，且要监听所有请求 |
| `chrome.debugger` + CDP | [ADR 0002](./0002-dnr-to-replace-cookie-header.md) 已否决（会弹"正在调试"提示条） |
| 用 DNR 把 `Set-Cookie` 复制到别的响应头 | DNR 的 `modifyHeaders` 只能写静态值，无法"复制另一个头的值" |

## 后果

1. **manifest 加 `cookies` 权限**。安装时的权限提示会包含"读取和更改你在 bilibili.com 上的数据"。
2. **README / onboarding 必须解释这件事**，否则用户看到 `cookies` 权限会直接不装。措辞方向：*"只在你扫码登录播放账号的那一刻，读取一次该账号的登录凭据，加密保存在本地。不读取主账号，不读取其他网站。"*
3. **`03-open-questions.md` Q5 的结论要改**：从"不需要"改为"需要，但用途与域名受限"。
4. **凭据读取必须集中在 `platform/storage/cookies.ts`**，`core/` 不许碰 `chrome.cookies`（分层铁律）。
5. **读取后立即加密存储**，内存中的明文用完即弃，不进日志、不进错误详情。

## 相关

- 可复跑的登录验证：`poc/verify/e2e-login.cjs`（当时的探针脚本未入库，只留结论）
- 原分析：[`03-open-questions.md`](../03-open-questions.md) Q5
- 凭据类型：[`src/shared/types/account.ts`](../../src/shared/types/account.ts) 的 `Credential`

# 0009. 页面代理采用 tabIds 限定 + 长驻规则

日期：2026-10-25
状态：已采纳

## 背景

P1 第 6 步要把能力接到真实视频页。原设计（`platform/http/dnr.ts`）是"临时规则 + 精确 URL 匹配"，用于 background 自己发一次请求。

但页面场景完全不同：

| | background 自己发请求 | 页面发请求 |
| --- | --- | --- |
| 请求方 | 扩展 SW | B站播放器 JS |
| URL 是否已知 | 是，可精确匹配 | **否**，播放器自己拼参数（含实时 `wts`/`w_rid`） |
| 数量 | 1 次 | 每次进页面/切P 各 1 次 |
| 生命周期 | 毫秒级 | 整个页面存活期 |

**所以不能沿用"临时规则 + 精确 URL"**：我们预测不到播放器拼出的完整 URL（`w_rid` 是实时算的），无法用 `urlFilter` 精确匹配。

## 关键验证

`RuleCondition` 支持 **`tabIds`**（Chrome 92+，**仅 session 规则可用**）。实测：

```js
await chrome.declarativeNetRequest.updateSessionRules({
  addRules: [{ id: 8888, condition: { urlFilter, resourceTypes, tabIds: [999999] } }],
});
// getSessionRules() 返回的 condition 里能看到 tabIds: [999999]
```

**规则被接受且被持久化。** 这解决了"规则全局生效会波及所有标签页"的问题。

## 决策

**页面代理用「长驻规则 + tabIds 限定」，不用临时规则。**

规则形态：

```js
{
  id,                                  // 每个标签页一条
  priority: 1,
  action: { modifyHeaders: { requestHeaders: [{ header: 'cookie', operation: 'set', value }] } },
  condition: {
    urlFilter: '||api.bilibili.com/x/player/wbi/playurl',
    resourceTypes: ['xmlhttprequest'],
    tabIds: [tabId],                   // ← 只对这个标签页生效
    requestMethods: ['get'],
  },
}
```

生命周期：

| 时机 | 动作 |
| --- | --- |
| content script 报到（视频页） | 建规则 |
| 标签页关闭 / 导航离开视频页 | 删规则 |
| SW 启动 | 用 `chrome.tabs.query` 校正：清掉不属于任何视频页的规则 |

## 为什么不用 hook `fetch`

技术上可行（MAIN world 包 `window.fetch`，把 playurl 转给 background 再 `__playinfo__` 注入），但：

1. **要跨 world 通信**：页面 fetch 是同步返回 Promise，跨 world 是异步 postMessage，必须做 Promise 桥接，复杂度高
2. **改动页面运行环境**：包装 `window.fetch` 会和 B站自己的 polyfill / 其他扩展冲突
3. **DNR 已经能做到**：既然 `tabIds` 可用，就没有理由去动页面 JS

**请求级代理（DNR）比代码注入更接近项目本意**，也更稳。

## 但页面侧仍必须做两件事（2026-10-25 补充）

参考 **Bili Dual Account Helper** 的实现后确认：**光有 DNR 不够**。

### 1. 必须藏起 SSR 的 `__playinfo__`

B站把播放数据 SSR 进 HTML 的 `window.__playinfo__`。播放器**直接读这个变量，
根本不发 playurl 请求** → DNR 没有请求可改。

需要 MAIN world 脚本用访问器属性拦截：

```js
Object.defineProperty(window, '__playinfo__', {
  get: () => hidden ? undefined : value,
  set: (v) => { value = v; },
});
```

隐藏后播放器只能走 playurl API，DNR 才有机会生效。

### 2. 必须伪装本地的会员状态

播放器用 `__INITIAL_STATE__.user.vipStatus` 判断能否选高清。
主账号不是会员 → **直接弹「开通大会员」，连请求都不发**。

这把 `vipStatus` / `vipType` 改成本地会员状态，让播放器愿意去请求。
**只改本地显示状态，不伪造任何服务端权益**：能否拿到 4K 仍取决于 DNR 换 Cookie 后
服务端的真实响应。播放账号不是真会员的话，照样拿不到。

### 3. 必须改写播放器信息接口的响应体（2026-10-25 追加）

只改 `__INITIAL_STATE__` 不够：播放器**切画质时**会重新读 `/x/player/wbi/v2`
（或旧版 `/x/player/v2`）响应里的 `vip` 字段，主账号不是会员就弹「开通大会员」，请求不发。

所以实际实现还会改写这两个接口响应体的 `vip.status` / `vip.type` / `vip.due_date`。
**这是对 Q12「不做伪装会员标识」的例外，单独记录在 [ADR 0013](./0013-patch-player-info-response.md)**，
授权范围精确到接口与字段，不得顺手扩大。

### 与 Bili Dual 的差异

| | Bili Dual（油猴） | Pluma（MV3） |
| --- | --- | --- |
| 换 cookie | 沙箱 `GM_xmlhttpRequest` 重发请求 | **DNR 网络层换请求头** |
| 需要 hook fetch/XHR | 是（没有网络层能力） | **否**（DNR 已覆盖） |
| 需要藏 `__playinfo__` | 是 | **是**（同一个原因） |
| 需要伪装 vipStatus | 是 | **是**（同一个原因） |

**结论：网络层用 DNR，页面状态用 MAIN world 脚本。两者互补，不能互相替代。**

实现：`src/content/main-world.ts`（注入到主世界）+ `entrypoints/content.ts`（注入 + 通信）。

## 已知风险与缓解

| 风险 | 状态 |
| --- | --- |
| Cookie 值里有**逗号**（SESSDATA 真实格式）被 DNR 截断 | ✅ **已排除**。P1 第 4 步实测 `code: 0` / `maxHeight: 4320`，用的正是含逗号的真实 SESSDATA，通过 DNR 注入成功 |
| 规则数 = 打开的标签页数 | 低风险。单标签页一条，实际并发很低 |
| 标签页崩溃导致规则残留 | 用 `chrome.tabs.query` 校正 |
| 页面先发 playurl、我们后加规则 | content script 用 `runAt: 'document_start'` |
| **DNR 只对 `host_permissions` 内的域生效** | ⚠️ 实测：`127.0.0.1` 不在 host 权限内时规则被**静默忽略**（不报错，也不生效）。测试必须打在 `*.bilibili.com` 上 |

**最后一条是排查时踩的坑，值得记住**：DNR 规则对权限外域名不生效，且**没有任何错误提示**。测试靶子必须落在 host 权限覆盖的域名里。

## 实现

| 文件 | 职责 |
| --- | --- |
| `src/platform/http/dnr.ts` | 新增 `installTabRule()` / `removeTabRule()` / `reconcileTabRules()`，与临时规则池并存 |
| `src/background/handlers/page.handler.ts` | 报到 → 读凭据 → 拼 Cookie → 装规则 |
| `entrypoints/content.ts` | `document_start` 报到，`DOMContentLoaded` 补报一次 |
| `src/shared/utils/video-page.ts` | URL 解析 + 设备 Cookie 筛选（纯函数，可单测） |

**为什么解析逻辑放 `shared/` 而不是 content script**：content script 依赖 WXT 全局
（`defineContentScript`），在 Node 里 import 会直接失败，测不了。抽出来后纯逻辑可测，
content script 只剩"读 → 调 → 发消息"三行。

**为什么 `document_start` 还要 `DOMContentLoaded` 补报一次**：`document_start` 时设备
Cookie 可能还没写全。重复上报是安全的——同一个 tabId 会覆盖同一条规则。

**为什么 content script 不碰 MAIN world**：DNR 在网络层换 Cookie，不需要改页面 JS。
这是本方案相对"hook fetch"的最大优势——不入侵页面运行环境。

## 相关

- DNR 字段文档：Chrome `declarativeNetRequest` 官方文档
- 实测脚本：`poc/verify/probe-tabids.cjs`
- 原 DNR 实现：[`src/platform/http/dnr.ts`](../../src/platform/http/dnr.ts)

# ADR 0007. v1 只支持普通视频，番剧留作 v1.5 实验性功能

日期：2026-10-25
状态：已采纳

## 背景

[Q4](../03-open-questions.md) 原本假设"番剧走 `/ogv/player/playview`，代理这个请求就能解锁画质"。

2026-10-25 实测推翻了它：番剧页**不发任何取流请求**。服务端在渲染 HTML 时就把取流结果内嵌进去：

```js
const playurlSSRData = {...}                                   // 22KB，写死在 HTML
window.__playinfo__ = playurlSSRData.data
reqHttpPlayUrlInfo: () => Promise.resolve(playurlSSRData)      // 永不发请求
```

大会员打开番剧页实测 `reqs: []`，但能播 3840×2160。**DNR 改的是请求头，这里没有请求可改。**

## 决策

**v1 只支持普通视频（投稿视频）。番剧作为 v1.5 的实验性功能，默认关闭。**

## 理由

1. **普通视频的方案是稳定的**：`/x/player/wbi/playurl` 是真实的客户端请求，DNR 换 Cookie 即可。一条规则、一个白名单、改版也能维护。
2. **番剧的唯一可行方案极其脆弱**。已验证注入点存在（hook `window.__playinfo__` 的 setter 能改播放器用的数据），但它依赖三件随时会变的事：`window.__playinfo__` 的赋值方式、`prefetch.playUrl` 同步消费的时机、播放器不调 `reqHttpPlayUrlInfo` 的行为。
3. **失败模式是静默的**。番剧 hook 失效时，用户看到的是"又变回 3 分钟试看"，不会知道是扩展坏了——这比普通视频"画质没提升"更难排查。
4. **复杂度是 3–5 倍**。需要预取缓存 + 二次加载 + 解析 76KB HTML，而普通视频只需要一条 DNR 规则。
5. **不把 v1 的稳定性押在一个内部实现细节上**。v1 的目标是"证明请求级代理这条路能走通"，不是"覆盖所有内容形态"。

## 被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| 代理番剧页 `main_frame` 换 Cookie | 整页变成播放账号的身份（头像/评论/历史/收藏全变），直接违背 [ADR 0004](./0004-request-level-identity-proxy.md) |
| 替换 `reqHttpPlayUrlInfo` 为延迟 Promise | PoC 实测播放器**从不调用**该回调（hits=0），直接吃 `prefetch.playUrl` |
| 覆盖 `playurlSSRData` 变量 | 它是块级 `const`，播放器闭包已捕获，覆盖 `window` 变量无效 |
| 改 SSR 里的 `is_preview` / `quality` | 未登录的 `durls` 四个画质组**每组都只有 3 分钟**，改字段绕不过时长 |

## 后果

- `01-architecture.md` §4.1 的 3 个番剧路径标注为无效；§4.4「OGV POST + WBI 重签」整节作废
- `core/wbi/signer.ts` **仍需要**（普通视频的 `/x/player/wbi/playurl` 也要签名）
- README 的定位措辞需明确"支持投稿视频"，不能让人以为覆盖全站
- v1.5 若做番剧，走"预取 + localStorage 同步注入"路线，必须带实验性开关与失效提示
- 直播（2 个路径）未测，不在此决策范围内，需在 P2 前单独验证

## 相关

- 实测数据：[`poc/verify/RESULT.md`](../../poc/verify/RESULT.md)
- 注入点 PoC：`poc/verify/poc-hook-playinfo.cjs`

---

## 2026-10-27 补充：本 ADR 的"不支持番剧"已被 ADR 0019 取代

**本文的实测事实仍然成立**（页面确实零请求、`playurlSSRData` 确实写死在 HTML），
但由它推出的"代理架构碰不到 → v1 不做"这个结论**过强了**：

1. **`/pgc/player/web/playurl` 接口本身有效** —— 页面不调用它 ≠ 接口不存在。
   实测：无 cookie 直连 HTTP 200 / `code:0`，只要 `cid` 就能调通，番剧返 `dash`、电影返 `durl`。
2. **播放器的异步取流回调可以被替换** —— 删掉 `config.prefetch.playUrl` 后，
   播放器会回退调用 `requestConfig.reqHttpPlayUrlInfo`，且视频照常播放。
   这条路比本文设想的"预取 SSR + localStorage 同步注入 + 二次加载"轻一个数量级。
3. **"番剧只有 durl 没有 dash"是误读** —— 那是**无权益**时的形态。
   番剧免费集返回 `whole` + dash；电影试看返回 `preview` + 4×6min durl。

因此本文的"## 决策"与"## 后果"中关于「v1 不支持番剧」的部分**不再有效**，
以 [ADR 0019](./0019-pgc-async-playurl-injection.md) 为准。本文保留，作为"当时为什么这么判断"的记录。

另外：本文与 Q4 的实测样本 `ep3854821` 是《凡人修仙传》，**属于国创分区**。
所以准确表述是"实测覆盖国创"，番剧（日本）与电影当时是同模板外推。

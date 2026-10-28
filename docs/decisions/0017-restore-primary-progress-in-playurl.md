# 0017. 把主账号的观看进度写回 playurl 响应（修复续播）

日期：2026-10-26
状态：已采纳（**对「响应体只改会员字段」的第二类例外授权**，第一类是 [ADR 0013](./0013-patch-player-info-response.md)）

## 背景

用户报告：**看到一半的视频，重新打开后从 0:00 开始**。不是偶发，稳定复现；参考实现（Bili Dual）没有这个现象。

### 根因（实测，不是推断）

`/x/player/wbi/playurl` 是被 DNR 换成**播放账号**凭据的那一条请求，所以响应里的观看进度字段
也是播放账号的。同一页面、同一时刻，两个接口给出的值完全不同：

| 接口 | 身份 | `last_play_time` | `last_play_cid` |
| --- | --- | --- | --- |
| `/x/player/wbi/playurl` | 播放账号 | **0** | **0** |
| `/x/player/wbi/v2` | 主账号 | 15000（15 秒） | 43047783888（= 当前 cid） |

播放器（`player/main/core.*.js`）的续播判定是：

```js
var y = (p.lastPlayTime || 0) / 1e3;
var m = (cid === p.lastPlayCid);                       // ← 0 永远不等于 cid
m && duration > 30 && y >= 5 && y < duration - 5 && seek(y)
```

`p` 就是 **playurl 响应体**。播放账号从没看过这个视频 → `m` 恒为 `false` → **永远不续播**。

失败方式是静默的：不报错、不降级、画质正常，只是从开头放。所以从 P2 验收到现在一直没被发现。

### 为什么不是"上报坏了"

上报链路是好的，`/x/click-interface/web/heartbeat` 不在白名单 → 用主账号 cookie → 历史记到主账号。
实测主账号历史里 `progress` 一直有值（352s / 175s / 317s 等）。
**坏的是"读回"这一步**，不是"记录"。

## 决策

**允许在 playurl 响应体上改写且仅改写两个字段：`last_play_time`、`last_play_cid`。
值来自主账号自己的 `/x/player/wbi/v2` 响应。除此之外一个字段都不动。**

```
允许改写的接口：  /x/player/wbi/playurl、/x/player/playurl
                （仅 https、仅 api.bilibili.com）
允许改写的字段：  last_play_time、last_play_cid
数据来源：        /x/player/wbi/v2（不在代理白名单 → 天然主账号身份）
禁止改写的字段：  其它一切，尤其 dash / support_formats / quality —— 那些是播放账号真实取到的流
```

授权集落在 `src/content/main-world.js` 的 `PROGRESS_PATCH_PATHS`，由 `scripts/check-patch-scope.mjs` 校验。

### 为什么这不算"伪造"

改写后的值是**这个浏览器用户本来就有的数据**，只是被身份代理换成了另一个账号的（0）。
本 ADR 做的事是把它换回来，不是无中生有：

- 不伪造观看记录——没看过就是 0，不续播，行为与不带扩展时一致
- 不伪造权益——`dash` / `quality` / `support_formats` 全部来自播放账号的真实响应，一个字节不改
- 不读取、不接触主账号的 SESSDATA——请求用浏览器自己的 cookie 发（`credentials: 'include'`），
  与「主账号 = 浏览器当前登录态」这条决策一致（[ADR 0004](./0004-request-level-identity-proxy.md)）

## 实现要点（都带失败降级，绝不阻断取流）

| 点 | 做法 | 失败时 |
| --- | --- | --- |
| 数据从哪来 | `open()` 时**并行**预取一次 v2，按 `aid|cid` 缓存 | 取不到 → 不改写，退化成"这次不续播" |
| 为什么必须提前 | XHR 的 `readystatechange` 是同步回调，里面没法 `await` | — |
| 改在哪 | XHR 实例上遮蔽 `responseText` / `response`；`responseType === 'json'` 时直接改对象 | `defineProperty` 抛错 → 不改写 |
| 类型闸门 | 只在 `responseType` 为 `''` / `'text'` / `'json'` 时动手 | arraybuffer / blob 一律不碰 |
| 已播起来 | `<video>.currentTime > 3` 时跳过 | 防止切清晰度时被拽回旧进度 |
| fetch 兜底 | 若哪天 playurl 改走 fetch，同样还原；**没有进度要还原时走零额外延迟路径** | 读文本失败 → 原样返回原响应 |

实测结果（BV1xjnS6MEym，主账号进度 240s）：修复前 `currentTime = 9.5s`（从 0 开始），
修复后 `currentTime = 264s`（从 240s 续播），同时 `videoHeight = 2160`（4K 未受影响）。

## 被放弃的方案

| 方案 | 放弃原因 |
| --- | --- |
| 把 playurl 改成用主账号身份请求 | 等于放弃功能本身。高画质正是靠播放账号的凭据换来的 |
| 让 DNR 只对部分字段生效 | DNR 只能改请求头，改不了响应体（Web 平台能力边界） |
| 接管整个 playurl XHR（`emulateXhr`） | 用 fetch 重发主视频取流请求，任何一处模拟不到位就是**视频直接不出来**。风险等级远高于收益 |
| 不隐藏 `__playinfo__`，靠 SSR 数据续播 | SSR 的 `__playinfo__` 实测**不含** `last_play_time` / `last_play_cid`（已抓原文确认） |
| 让播放器改用 v2 的进度 | 播放器的判定读的是 playurl 响应体，改不了它的代码；能改的只有数据 |
| 拿本地存储自己记进度 | 与 B站跨设备续播冲突，会出现两个真相源 |

## 后果

- `AGENTS.md` §3 决策 5 需要补一句：响应体改写现在有**两类**授权（会员字段 / 观看进度字段），
  各有各的 ADR 与路径常量，**不许合并成一个清单**。
- `scripts/check-patch-scope.mjs` 增加对 `PROGRESS_PATCH_PATHS` 的校验：代码集必须与本文一致。
- 每个视频页会多出**一次** `/x/player/wbi/v2` 请求（页面自己也会发一次，无法复用——它晚于 playurl）。
  按 `aid|cid` 缓存，同一页面重复拉取 playurl（切清晰度）不再重复请求。
- 若 B 站将来把进度搬到别的接口，本 ADR 需要重新评估，**不要顺手往 `PROGRESS_PATCH_PATHS` 里加路径**。

## 相关

- [ADR 0004](./0004-request-level-identity-proxy.md)：请求级身份代理（本 ADR 的成因）
- [ADR 0013](./0013-patch-player-info-response.md)：第一类响应体改写例外（会员字段）
- [ADR 0014](./0014-quality-compare-from-page-data.md)：主账号基线取自 SSR —— 与本 ADR 无关，别混
- `src/content/main-world.js`：`PROGRESS_PATCH_PATHS` / `prefetchProgress` / `patchPlayurlXhrProgress`

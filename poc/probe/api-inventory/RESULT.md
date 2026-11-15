# 真实接口盘点 · 账号职责可配置化的可行性取证

> **日期**：2026-11-11
> **取证者**：engineer-api（只读取证，未改任何 `src/` / `docs/` / `scripts/` / `package.json`）
> **仓库**：`main`，取证时工作区干净（仅新增本目录）
>
> ## ⚠️ 先读这一节：证据等级怎么读
>
> | 等级 | 含义 | 本文件怎么标 |
> | --- | --- | --- |
> | **L1** | 真实登录态下**实测**，有原始输出 | 附采样数据 |
> | **L2** | 无登录态 / 只观测到请求存在 | 附观测方式 |
> | **L3** | 只读源码或文档，**没有实测** | 附文件与行号 |
> | **推理** | 从已知事实推出，**没有直接证据** | 显式写 `推理，未验证` |
>
> **本文件里凡是标"推理，未验证"的行，都不足以作为决策依据。**宁可说"不知道"。

---

## 0. 取证环境（可复现）

| 项 | 值 |
| --- | --- |
| bsk | 0.3.3（`BSK_HOME=C:\Users\i1290\.bsk`，`BSK_AUTO_START=0`） |
| 浏览器 | Edge 157，扩展 browser-skill 0.3.3 |
| 登录态 | **已登录，单个真实账号**（`isLogin:true`，`vipStatus:0` = **非大会员**） |
| 被测页面 | `https://www.bilibili.com/`（首页）、`https://www.bilibili.com/video/BV1beNcz2ECq`（视频页） |
| 脚本 | 本目录 `probe-a-feed.mjs` / `probe-a-feed-ssr.mjs` / `probe-b-counts.mjs` / `probe-b4-csrf.mjs` / `probe-c-dnr.mjs` / `probe-d-hosts.mjs` |

**⚠️ 重要局限：本机只有 1 个已登录账号，无法做"同一请求换另一个账号 Cookie 再发"的 A/B 对比。**
所有涉及"换 Cookie 后 X 会怎样"的结论，要么有先例（playurl），要么标为推理。

**⚠️ 全程未读取、未打印任何凭据值。** 只记录字段名与"是否随身份变化"。

---

## 1. 主表

| # | 行为 | host | path | method | 身份载体 | 签名/CSRF 约束 | 等级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | 首页推荐（wbi 版，**页面实际调用**） | `api.bilibili.com` | `/x/web-interface/wbi/index/top/feed/rcmd` | GET | **Cookie**（响应回显 `data.mid`） | **wbi 签名不被校验**（坏 `w_rid` 也 code 0） | **L1** |
| A2 | 首页推荐（旧版兜底） | `api.bilibili.com` | `/x/web-interface/index/top/rcmd` | GET | Cookie（回显 `data.mid`） | 无签名 | **L1** |
| A3 | **首页首屏推荐（SSR）** | `www.bilibili.com` | `/`（HTML） | GET | **Cookie（整页渲染时）** | — | **L1** |
| A4 | 视频页首屏取流（SSR） | `www.bilibili.com` | `/video/BV*`（HTML） | GET | Cookie | — | **L1**（当前版本**无** `__playinfo__`） |
| B1 | 播放历史上报 | `api.bilibili.com` | `/x/click-interface/web/heartbeat` | **POST**（GET→405） | Cookie + **csrf** | **POST-only；csrf 详见 §3** | **L1**（405 实测） |
| B2 | 播放历史读取 | `api.bilibili.com` | `/x/web-interface/history/cursor` | GET | Cookie | 无 | **L1** |
| B3 | 播放进度（读） | `api.bilibili.com` | `/x/player/wbi/v2` | GET | Cookie（回显 `login_mid`） | wbi（不被校验） | **L1** |
| B4 | 播放进度（写） | 同上 heartbeat | — | POST | Cookie + csrf | 见 §3 | **L3**（ADR 0017 已确认 `progress` 字段） |
| B5 | 点赞 | `api.bilibili.com` | `/x/web-interface/archive/like` | **POST**（GET→**405**） | Cookie + csrf | POST-only | **L1** |
| B6 | 投币 | `api.bilibili.com` | `/x/web-interface/coin/add` | **POST**（GET→**405**） | Cookie + csrf | POST-only | **L1** |
| B7 | 收藏 | `api.bilibili.com` | `/x/v3/fav/resource/deal` | **POST**（GET→**405**） | Cookie + csrf | POST-only | **L1** |
| B8 | 评论发布 | `api.bilibili.com` | `/x/v2/reply/add` | **POST**（GET→**405**） | Cookie + csrf | POST-only | **L1** |
| B9 | 关注 | `api.bilibili.com` | `/x/relation/modify` | **POST**（GET→**405**） | Cookie + csrf | POST-only | **L1** |
| C1 | 私信/消息未读 | **`api.vc.bilibili.com`** | `/x/im/web/msgfeed/unread` | GET | Cookie | — | **L1**（观测到） |
| C2 | 顶栏消息同步 | **`message.bilibili.com`** | `/pages/nav/header_sync` | GET | Cookie | — | **L1**（观测到） |
| C3 | 登录态探活 | **`passport.bilibili.com`** | `/x/passport-login/web/cookie/info` | GET | Cookie | — | **L1**（观测到） |
| C4 | 行为埋点 | **`data.bilibili.com`** | `/log/web`、`/v2/log/web` | GET/POST | Cookie | — | **L1**（观测到） |
| C5 | 广告 | **`cm.bilibili.com`** | `/cm/api/*` | GET | Cookie | — | **L1**（观测到） |
| C6 | 直播推荐 | **`api.live.bilibili.com`** | `/xlive/web-interface/v1/webMain/getMoreRecList` | GET | Cookie | — | **L1**（观测到） |

**现有 `BILI_API_HOSTS`** = `['api.bilibili.com', 'api.biliapi.net']`（`src/shared/constants/routes.ts:42`）。
→ **C1–C6 全部不在这两个域内。**

---

## 2. A 组实测原始数据（首页推荐）

### A1/A2 两个接口都能用，且**都回显当前身份**

```
old: {"status":200,"code":0,"itemLen":10,"dataMid":{{主账号mid}},
      "dataKeys":["item","business_card","floor_info","user_feature","abtest",
                  "preload_expose_pct","preload_floor_expose_pct","mid"]}
wbi: {"status":200,"code":0,"itemLen":12,"dataMid":{{主账号mid}},
      "dataKeys":["item","business_card","floor_info","user_feature",
                  "preload_expose_pct","preload_floor_expose_pct","mid"]}
```

`dataMid` === 当前登录用户的 `mid`（`nav` 给出同一个值）。
**这是"响应按请求身份定制"的直接证据**：Cookie 换成谁，`data.mid` 就是谁，`item` 就是谁的推荐。

### A1 关键：**rcmd 不校验 wbi 签名**

```
good: {"status":200,"code":0,"msg":"OK"}   ← 正常
bad:  {"status":200,"code":0,"msg":"OK"}   ← w_rid 传 32 个 0，照样 code 0
```

对照组 playurl 同样：

```
noSig:  {"code":0,"hasDash":true}
badSig: {"code":0,"hasDash":true}
```

**结论（L1）**：至少 rcmd 与 playurl 这两条，服务端**不校验 `w_rid`**。
→ 「换了 Cookie 导致 wbi 签名失效 → 412」这个担心，**在这两条接口上不成立**。

> ⚠️ 但这**不等于所有 wbi 接口都不校验**。本结论的适用面只到实测过的路径，
> 不要外推成"B站所有 wbi 接口都不校验签名"。

### A3 **关键结论：首页首屏推荐是 SSR，写死在 HTML 里**

同一时刻对比"HTML 里的推荐"和"接口返回的推荐"：

```
ssrBvCount:   14      ← HTML 里出现的不同 BV 号
apiBvCount:   20      ← 接口返回的条数
overlapCount: 1       ← 两者重合只有 1 条
```

HTML 里 10 张真实卡片（`bili-video-card__info--tit`），形如：

```html
<h3 class="bili-video-card__info--tit" title="胎教级AI小游戏变现">
<a href="https://www.bilibili.com/video/BV1HbJR66Egi?trackid=web_pegasus_0.router-web-pegasus-247951">
```

并且内联脚本里直接有**当前身份的 mid**：

```js
...preload_expose_pct:dP, preload_floor_expose_pct:dP, mid:{{主账号mid}}}
head:{recommend:[{track_id:h, freshIdx:f, goto:i, title:bn, aid:R, cid:bl, bvid:bk, ...}]}
```

**结论（L1）：首页首屏推荐由服务端按"当前 Cookie 身份"渲染进 HTML。**
→ **只给 `/x/web-interface/wbi/index/top/feed/rcmd` 换 Cookie 对首屏无效**，
因为首屏数据根本不来自那条接口。要改首屏，只能改**整页 HTML 请求**的身份（`main_frame` 级），
而这会让整页（头像/未读/历史）都变成另一个账号 —— 见 §5 的判定。

> 补充（L1）：`document.__INITIAL_STATE__` 在首页**不存在**（`hasInitialState:false`），
> 说明首页走的是 pinia + 内联 script，不是经典的 `__INITIAL_STATE__` SSR。
> 这不改变"HTML 里已有服务端渲染的推荐数据"这个事实，只影响**怎么改**（改 HTML 比改 `__INITIAL_STATE__` 更麻烦）。

### A4 视频页 SSR（当前版本）

```
{"htmlLen":184229,"hasPlayinfo":false,"hasPlayurlSSR":false,"hasInitialState":false,"bvCount":17}
```

**本账号（非大会员）的视频页 HTML 里没有 `__playinfo__`。**

> ⚠️ 这条**不能**推翻 `poc/verify/RESULT.md` §一.2 的旧结论（"`document_start` 时刻 `__playinfo__` 是 SSR 的且是主账号身份"）。
> 两者测的不是同一个条件：旧结论来自**双账号真机**，本次是**单账号非大会员**。
> 按 AGENTS.md §1.5「某条数据是否存在 → 抓当前这个场景的真实响应」，
> 本次结果只证明「非大会员单账号下没有」，**不证明**"大会员页也没有"。
> **判"视频页要不要换整页身份"，必须另有大会员真机采样**（本轮拿不到）。

---

## 3. B 组：写接口的 CSRF 约束（**这一段决定 B 类能不能做**）

### B-0 六个写接口全是 POST-only —— 实测

```
like:      {"status":405}    coin:  {"status":405}    fav:     {"status":405}
reply:     {"status":405}    relation: {"status":405}  heartbeat: {"status":405}
```

`405 Method Not Allowed` = 服务端明确拒绝 GET。**这六个接口在本机（Edge 157 / bsk 0.3.3）实测确认是 POST。**
取证方式是 GET 探测（不会落任何数据），因此**没有产生任何真实写入**。

### B-1 CSRF 的值从哪来 —— 官方前端源码（L1，最强证据）

从 `s1.hdslb.com/bfs/seed/overseas-transform/overseas-transform.umd.js` 与
`.../laputa-home/assets/index-26d16214.js` 两个官方 bundle 里都拿到了同一段拦截器：

```js
c = ei("bili_jct", {decode: !1})          // ← 值：从 cookie 读 bili_jct
p = l.key || "csrf"                        // ← 键名：csrf（可被调用方改名）
h = function(M) {
  if (M === "params") {                    // ① 放 query
    if (r.request.params) r.request.params[p] = c;
    else r.request.params = {[p]: c};
    return;
  }
  if (s) {                                 // ② 否则 append 到 FormData/body
    ... s.append(p, c) ...
  }
}
```

**语义明确**：`csrf` 的值**就是** Cookie 里 `bili_jct` 的值；放 query 还是 body 取决于调用点传的参数。

补充实测（L1）：`document.cookie` 里可读的 cookie 名共 31 个，其中

```
bili_jct_readable:  true      ← 可读
DedeUserID_readable: true     ← 可读
SESSDATA_readable:   false    ← httpOnly，读不到
```

### B-2 会不会因「csrf 与 Cookie 不一致」被拒 —— **本机无法实测，给判据**

**没有实测。** 原因：本机只有一个登录账号，无法构造"A 的 Cookie + B 的 csrf"。

**但可以把结论推到位（以下是推理，已标未验证）**：

| 事实（已实测） | 推出的结论 |
| --- | --- |
| csrf 值 = cookie 里 `bili_jct` 的值（官方源码） | 这是 **double-submit** 型 CSRF 防护：服务端比对「请求里的 csrf」与「Cookie 里的 bili_jct」 |
| DNR 只能改请求头，不能改 body | 换 Cookie 后请求体里的 `csrf` 仍是**原账号**的 |
| 因此 | **POST 请求若带 body csrf，换 Cookie 后必然不一致 → 预期被拒** |

**这一条如果成立，就直接否掉"用 DNR 让另一个账号代为点赞/投币/收藏/评论/关注"。**
但它是**推理**。要变成 L1，需要一个最小复现：拿两个账号 A/B 的真实 `bili_jct`，
构造 `Cookie=B 的` + `csrf=A 的` 的请求（**用不存在的资源 id**），看返回的是
"csrf 校验失败"还是别的错。**本轮没做，因为需要第二个账号。**

### B-3 一个已确定的硬事实：**DNR 目前根本不代理 POST**

`src/platform/http/dnr.ts:241`：

```ts
requestMethods: ['get'],
```

全局路径规则与标签页规则（`dnr.ts:468`）**都**写死了 `['get']`。
所以即便 CSRF 问题不存在，**当前 DNR 实现也无法接管任何 POST 写接口** —— 这是代码事实（L3/L1 均有）。

---

## 4. C 组：host 归属（决定"能不能按路径接管"）

首页真实加载时观测到的 API 类请求，按 host 归组（`performance.getEntriesByType('resource')`，只读）：

| host | 是否在 `BILI_API_HOSTS` | 观测到的 path 举例 |
| --- | --- | --- |
| `api.bilibili.com` | ✅ 在 | `/x/web-interface/nav`、`/x/web-interface/wbi/index/top/feed/rcmd`、`/x/web-interface/history/continuation`、`/x/web-interface/index/ogv/rcmd` … |
| `api.vc.bilibili.com` | ❌ **不在** | `/x/im/web/msgfeed/unread`、`/link_setting/v1/link_setting/get` |
| `message.bilibili.com` | ❌ **不在** | `/pages/nav/header_sync` |
| `passport.bilibili.com` | ❌ **不在** | `/x/passport-login/web/cookie/info` |
| `data.bilibili.com` | ❌ **不在** | `/log/web`、`/v2/log/web`（埋点） |
| `cm.bilibili.com` | ❌ **不在** | `/cm/api/receive/content/pc`（广告） |
| `api.live.bilibili.com` | ❌ **不在** | `/xlive/web-interface/v1/webMain/getMoreRecList` |
| `i0/i2.hdslb.com`、`s1.hdslb.com` | ❌ | 静态资源 |

**结论（L1）**：现有白名单的域名集合**只覆盖 `api.bilibili.com` 这一条主线**。
任何"跨账号可配置"的方案，只要碰到消息/登录态/埋点，就必须**先扩域名**，
而扩域名在 `AGENTS.md` §5.5 与 `routes.ts:37-41` 都写着「加主机必须同步三处」且属扩大越权范围。

---

## 5. 关键结论汇总

### 5.1 三类身份各自能不能用「改 header 换 Cookie」实现

| 需求 | 能否用 DNR 改 header 实现 | 卡在哪 | 等级 |
| --- | --- | --- | --- |
| **取流身份可配置** | ✅ **能，已有先例** | 现存实现已做到；但"任意账号都能当取流账号"需要 UI + 凭据存储支持，不是协议问题 | L1（现有功能） |
| **首页推荐流身份可配置** | ⚠️ **首屏不能，滚动加载可以** | 首屏推荐 SSR 进 HTML（§2 A3），改接口 Cookie 影响不到首屏；要改首屏必须代理 `www.bilibili.com` 的 `main_frame` HTML → 整页变另一身份（违背 ADR 0004） | L1 |
| **计数类行为身份可配置** | ❌ **不能（当前架构下）** | ① 六个写接口全是 **POST**，DNR 规则写死 `requestMethods:['get']`（`dnr.ts:241`）② csrf 必须与 Cookie 里 `bili_jct` **值相等**，改 Cookie 不改 body 必被拒 —— **已由 §8 补充实测转为 L1** | ① L1 ② **L1（2026-11-11 补充）** |

### 5.2 可行性红绿灯

| 身份类型 | 灯 | 一句话 |
| --- | --- | --- |
| 取流身份 | 🟢 **绿** | 现状即是；可配置化是 UI/存储工作量，无协议障碍 |
| 首页推荐身份 | 🟡 **黄** | 滚动加载能换；**首屏是 SSR，换接口 Cookie 无效**；改首屏=整页换身份 |
| 计数写入身份 | 🔴 **红** | POST-only + DNR 只改 header + csrf 绑定 cookie，**任一条都足以否掉** |

### 5.3 必须说明的两处「我不知道」

> ⚠️ **2026-11-11 补充实测后，第 1 条已解决** —— 见 §8。此处保留原记录以便对照。

1. ~~**「csrf 与 Cookie 不一致会不会被拒」是推理，不是实测。**~~ → **已由 §8 转为 L1 实测**：
   靠"格式同长但值不同"的伪造 csrf 即可证明，**不需要第二个账号**（原判断有误）。
2. **「大会员视频页是否 SSR `__playinfo__`」本轮未测。** 本次账号 `vipStatus:0`，
   页内无 `__playinfo__`，这与 `poc/verify/RESULT.md` §一.2 的双账号结论并不矛盾
   （场景不同），但**不能**用本次结果去否定它。

---

## 6. 与已有 ADR / 文档的对应

| 本文件结论 | 已有依据 | 是否一致 |
| --- | --- | --- |
| 计数类天然归主账号、不需要干预 | `docs/decisions/0004-request-level-identity-proxy.md` §3「副产品」 | ✅ 一致，且本次给出了机制解释（POST + csrf） |
| heartbeat 是历史/进度的真实上报点 | `docs/decisions/0017-restore-primary-progress-in-playurl.md` §「为什么不是上报坏了」 | ✅ 一致 |
| 换 Cookie 不影响 playurl 成功 | `poc/verify/RESULT.md` §一（Q1 对比数据） | ✅ 一致；本次补充了"签名不被校验"这一机制 |
| DNR 只改 header 不改 body | `docs/decisions/0017` §「被放弃的方案」 | ✅ 一致 |

---

## 7. 复现方式

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;C:\Users\i1290\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:PATH
bsk daemon start --foreground          # 后台任务里起，别起第二个
bsk session start --no-focus --json    # → session_id
bsk navigate --session <sid> "https://www.bilibili.com/"

node poc/probe/api-inventory/probe-a-feed.mjs     --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-a-feed-ssr.mjs --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-b-counts.mjs   --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-b4-csrf.mjs    --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-c-dnr.mjs      --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-d-hosts.mjs    --session <sid> --tab <tab>

# ── 2026-11-11 补充（见 §8）──
node poc/probe/api-inventory/probe-e-csrf.mjs          --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-e-csrf.mjs          --session <sid> --tab <tab> --endpoint https://api.bilibili.com/x/web-interface/coin/add
node poc/probe/api-inventory/probe-e2-csrf-binding.mjs --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-f-write-hosts.mjs   --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-g-mixed-feed.mjs    --session <sid> --tab <tab>
```

⚠️ 这些脚本**全部只读**：不发写请求、不改任何数据、不打印任何凭据值。

> §8 的 E/E2 组会发 `POST`，但全部指向**不存在的资源 id**（aid/cid = `2000000000`），
> 且已事后核验未写入历史（见 §8.4）。

---

## 8. 【2026-11-11 补充】三项追加取证

> 本节回应 Lead 的三项追加要求，并把 §5.3 的「推理，未验证」升级为 **L1 实测**。
> 环境同上（bsk 0.3.3 / Edge 157 / 单账号已登录 / `vipStatus:0`）。

### 8.1 补充实测：CSRF 一致性 —— **结论已从推理升级为 L1**

#### E 组：形态矩阵（`/x/web-interface/archive/like`，aid=2000000000 不存在）

| 形态 | csrf 值 | status | code | message | 说明 |
| --- | --- | --- | --- | --- | --- |
| ① 正确 | 当前 `bili_jct` | 200 | **-400** | 请求错误 | **走到业务层**（假 aid 不存在） |
| ② 空串 | `""` | 200 | **-111** | CSRF 校验失败 | 被拦 |
| ③ 全零 | `000…`(32) | 200 | **-111** | CSRF 校验失败 | 被拦 |
| ④ 不带 | — | 200 | **-111** | CSRF 校验失败 | 被拦 |

**反向对照成立**：① 返回 `-400`（业务层），②③④ 返回 `-111`（校验层）。
两者 code 不同 → 判据**有区分力、不是恒真**（满足 AGENTS.md §1.5 反例要求）。
`-412` 风控**未触发**，每组连发 2 次结果稳定。

#### E2 组：**关键实验** —— csrf 是否与 Cookie **值绑定**

E 组只证明了"必须带 csrf"，**没证明"必须和 Cookie 一致"**。E2 补上这一步：
用**同格式（32 位 hex）但值不同**的伪造 csrf。

| 组 | Cookie | csrf | code | message |
| --- | --- | --- | --- | --- |
| **X** | 当前登录（真） | 真实 `bili_jct` | **-400** | 请求错误 |
| **Y** | 当前登录（真） | **随机 32 hex**（值不同） | **-111** | CSRF 校验失败 |

**X 与 Y 的唯一差别是 csrf 的值**（长度、格式完全相同，`forgedSameFormat:true`）。
Y 被拒 → **服务端执行的是 double-submit 校验：比对 body 里的 csrf 与 Cookie 里的 `bili_jct`。**

> **这一条不需要第二个账号就能测** —— 原 §5.3 的判断（"需要 A/B 两账号"）是错的，
> 伪造一个同格式不同值的 csrf 即可。此处记录这次判断失误。

#### 跨接口复验（不是 like 的特例）

| 接口 | ①真 csrf | ②空 | ③全零 | ④不带 | 校验 csrf？ |
| --- | --- | --- | --- | --- | --- |
| `/x/web-interface/archive/like` | -400 | -111 | -111 | -111 | ✅ **是** |
| `/x/web-interface/coin/add` | -400 | -111 | -111 | -111 | ✅ **是** |
| `/x/v3/fav/resource/deal` | -400 | -111 | -111 | -111 | ✅ **是** |
| `/x/v2/reply/add` | **12066**（不可发送空白内容） | — | — | **-111** | ✅ **是** |
| `/x/click-interface/web/heartbeat` | **0** | — | — | **0** | ❌ **否** |
| `/x/relation/modify` | — | — | — | — | **未测（有副作用风险，跳过）** |

> ⚠️ **`heartbeat` 是例外**：带不带 csrf 都返回 `code:0`，**不校验 csrf**。
> 原因合理：heartbeat 是高频心跳上报，加 CSRF 会拖累播放。
> 但这**不改变结论**——heartbeat 仍是 POST，DNR 的 `requestMethods:['get']` 依然拦不到。

#### 8.1 结论（三个字级别）

**`csrf 一致性` → 必需。**
（除 `heartbeat` 外，写接口全部要求 csrf 且**必须等于 Cookie 里 `bili_jct` 的值**。
DNR 只改请求头、不改 body → 换 Cookie 后 body 里的 csrf 必然失配 → `-111`。
**"改 header 换 Cookie 就能让另一个账号代为点赞/投币/收藏/评论"不可行。**）

#### 8.2 反向对照的自证（AGENTS.md §1.5 要求）

| 形态 | 期望 | 实测 | 通过 |
| --- | --- | --- | --- |
| ① 真 csrf（已知会走到业务层） | 业务错误（非 csrf 类） | `-400` / `12066` | ✅ |
| ③④ 无有效 csrf（已知会被拦） | csrf 错误 | `-111` | ✅ |
| 两者 code 不同？ | 是 | `-400 ≠ -111` | ✅ 判据非恒真 |
| Y 伪造同格式 csrf | 若绑定 → `-111` | `-111` | ✅ 绑定成立 |
| 若服务端只看格式 | Y 应为 `-400` | 实际 `-111` | ✅ 排除"只看格式" |

### 8.2 只读确认 1：写接口的完整 host 清单

#### 方法

1. 对 6 个写接口在 **两个候选 host** 上各发一次 `GET`（只读）：`405` = 该 host 上存在且只收 POST
2. 从官方 bundle 里找调用形态
3. 从已发生的资源条目里看真实 host

#### F1 结果：**两个 host 上都存在**

| 写接口 path | `api.bilibili.com` | `api.biliapi.net` |
| --- | --- | --- |
| `/x/click-interface/web/heartbeat` | 405 | **405** |
| `/x/web-interface/archive/like` | 405 | **405** |
| `/x/web-interface/coin/add` | 405 | **405** |
| `/x/v3/fav/resource/deal` | 405 | **405** |
| `/x/v2/reply/add` | 405 | **405** |
| `/x/relation/modify` | 405 | **405** |

**结论（L1）**：6 个写接口**全部落在 `BILI_API_HOSTS` 覆盖范围内**（两个 host 都在），
且 `api.biliapi.net` 上**同一套接口同样存在**——与 `routes.ts:17-41` 记录的 playurl 双发**同构**。
→ **写接口 host 面本身不是障碍**（障碍在 method 与 csrf，不在 host）。

#### F2 官方源码：写接口用**相对路径**，host 由请求库 base 决定

从 `s1.hdslb.com/bfs/seed/jinkela/short/watchlater-pip/watchlater-pip.umd.js`：

```js
Ge = ({bvid:n, like:t}) => $({url:"/x/web-interface/archive/like", method:"POST",
                                  headers:{"Content-Type":"application/x-www-form-urlencoded"}, ...})
ze = ({bvid:n, multiply:t}) => $({url:"/x/web-interface/coin/add", method:"POST", ...})
Ke = ({aid:n, collect:t, type:e}) => $({url:"/x/v3/fav/resource/deal", method:"POST", ...})
He = ({fid:n, act:t}) => $({url:"/x/relation/modify", method:"POST", ...})
```

该 bundle 内**不含** `api.bilibili.com` / `api.biliapi.net` 字面量（`marks` 全 false）——
host 来自请求库的 base 配置（在别处）。
→ 「页面到底打哪个 host」**只能靠真实流量确认**，不能从该 bundle 断言。

#### F3 真实流量观测（只读）

本次会话已发生的 bilibili 域名请求计数：

```
api.bilibili.com: 62    data.bilibili.com: 54    cm.bilibili.com: 20
api.vc.bilibili.com: 4  api.live.bilibili.com: 1 message.bilibili.com: 1
passport.bilibili.com: 1  le3-api.game.bilibili.com: 1
```

**未观测到 `api.biliapi.net`** —— 但这是因为**本次会话没触发切画质**（该域名由播放器容灾时启用），
**不能**据此说"写接口不会双发"。F1 已证明该 host 上接口存在，是否双发**未观测**。

#### 8.2 结论（三个字级别）

**`写接口 host` → 全部在 BILI_API_HOSTS（0 个不在）。**
但补一句：`api.biliapi.net` 上存在同一套接口，**写接口是否真的双发未观测**
（需真实触发点赞/投币时抓包才能确认，本轮为避免写数据未做）。

### 8.3 只读确认 2：首页首屏「混合态」是否用户可察觉

#### 问题设定

若**只**把 `/x/web-interface/wbi/index/top/feed/rcmd` 加进白名单换 Cookie：
- 首屏 10 条 = SSR（账号 A，写死在 HTML）
- 往下滚动 = rcmd（账号 B）
- → 「首屏 A、后续 B」

#### G 组实测（L1）

| 观测 | 值 |
| --- | --- |
| 首屏 SSR 卡片 BV 数 | 8（正则精确匹配 video-card，`cardMatched:true`） |
| rcmd 连续 3 页（ps=30） | 90 条，`rcmdUnique:90`，**内部零重复** |
| **首屏 SSR ∩ rcmd 3 页** | **0** |
| rcmd 回显 mid | `dataMid === navMid` ✅ 确认按请求者定制 |

#### 关键补充观测：**首屏自己每次都不一样**

同一账号连续两次拉首页 HTML（间隔 1.2 s）：

```
aCount:13, bCount:14, overlap:2      ← 首屏推荐自身波动极大
aFirst: BV15tnC6iEQ5, BV1RuWJ63EBy, BV1fcJS6WEQm …
bFirst: BV1ieJX6bEQb, BV1FdeA6wEzg, BV1qoH36JEHU …
```

**所以"重复"不能当判据** —— 首页推荐本来就是高度随机的实时流，
「首屏 A + 后续 B」不产生可识别的重复。

#### 结构层面：两套数据的**结构完全一致**

首屏 SSR 的卡片与 rcmd 的 item **字段集相同**（都含 `rcmd_reason`、`track_id`、`pos`、`av_feature`）：

```js
// 首屏 SSR 内联脚本
owner:{mid:aM,name:aN,face:aO}, stat:{view:aP,…}, av_feature:c,
is_followed:a, rcmd_reason:{reason_type:a}, track_id:i, pos:a, room_info:c, …

// rcmd 接口 item
itemKeys: [av_feature, business_info, bvid, cid, …, rcmd_reason, stat, title, track_id, uri, …]
```

→ 从渲染结果看不出「这批来自 A，那批来自 B」。

#### 8.3 结论（三个字级别）

**`首屏混合态` → 不可察觉（从重复/结构角度）。**

但必须补一句诚实的限定：
- **"不可察觉"指的是"不产生重复卡片、结构不异常"**，这是实测支撑的（重合 0/90、字段集相同）
- **不等于"内容上也没差别"**。换账号后推荐内容会明显偏向另一账号的兴趣
  （`rcmd_reason` 会出现不同的理由），用户**可能主观感到"下半页风格变了"**。
  这一层是**主观判断，本轮未测，也无法在单账号环境测**。
- 若要真正验证，需要双账号 + 逐屏对照，**本轮不具备条件**。

### 8.4 副作用核验（本轮 POST 探针的安全性证明）

E 组/E2 组/跨接口复验都发了 `POST`，全部指向 `aid=cid=2000000000`（不存在的资源）。
事后**只读**核验播放历史：

```
listLen: 19, fakeAidFound: 0        ← 历史里没有 2000000000 的条目
```

**确认零污染**。附带得到一条事实：`heartbeat` 对**不存在的 aid 静默返回 `code:0`**
（不报错、不写入）—— 这与 ADR 0017「上报链路是好的」一致，也说明
**不能用 `code:0` 判断 heartbeat 是否真的写入了历史**。

### 8.5 本节对原结论的修正汇总

| 原结论（§5） | 修正后 | 依据 |
| --- | --- | --- |
| csrf 不一致会被拒 = **推理** | **L1 实测成立** | §8.1 E2 组（伪造同格式 csrf → -111） |
| 需要第二个账号才能测 csrf | **不需要**，伪造同格式值即可 | 同上 |
| 写接口 host = 未单独确认 | **全部在 `BILI_API_HOSTS`**，且 `api.biliapi.net` 同构 | §8.2 F1 |
| 首屏混合态 = 未测 | **重复/结构上不可察觉**；内容层面主观、未测 | §8.3 G 组 |
| 六个写接口都校验 csrf（隐含） | **heartbeat 例外，不校验 csrf** | §8.1 跨接口复验 |

**红绿灯不因本节改变**：取流 🟢 / 首页推荐 🟡 / 计数写入 🔴。
计数写入那条从"②是推理"变成"②是 L1"，结论方向不变，**依据更硬**。

---

## 9. 【2026-11-11 补充二】能否绕过 csrf —— 第三类路径审查

> **本节全程静态判定 + 已有 bundle 证据，未发任何改 body 的写请求。**
> 所有结论若拿不准都标 `未确定`，不拍。

### 9.0 先确认能力边界（读码结论，不实测）

#### `src/content/main-world.js` 到底改不改请求体？—— **今天不改请求，只改响应**

| 检查点 | 结论 | 行号 |
| --- | --- | --- |
| `fetch` hook 怎么发请求 | `var p = origFetch.apply(self, args)` —— **原样发**，`args` 一个字节不动 | `main-world.js:2525` |
| `fetch` 的改写发生在哪 | 全部在 `p.then(...)` 之后 = **响应侧** | `:2595` 起 |
| `XHR.open` 做了什么 | 只记录 `__plumaUrl` / `__plumaMethod` / `__plumaHeaders` + 注册 `readystatechange` 观测 | `:2284`–`:2331` |
| `XHR.send` 改 body 吗 | **不改**。未接管时 `origSend.apply(this, arguments)` 原样发（`arguments` 含原 body） | `:2371`–`:2373` |
| `XHR.send` 有"接管"吗 | **有**，但接管的**目的不是改请求**，而是"不执行原请求、自己发一遍再改**响应**" | `:2361`–`:2411` |
| 接管重发时带 body 吗 | **不带**。`nativeFetch.call(window, url, {method, headers, credentials})` —— **没有 body 字段** | `:2381`–`:2386` |
| 接管范围 | 只在 `enabled && matchPath(url, PATCH_PATHS)`（会员状态接口） | `:2368` |
| 是否碰过凭据 | **没有**。全文无 `sessdata` / `biliJct` 读取；只有 `credentials:'include'` 让浏览器自己带 | 全文检索 0 命中 |

**明确结论：`main-world.js` 今天"只改响应，不改请求"。**
`AGENTS.md` §5.5 的四类授权（`PATCH_PATHS` / `PROGRESS_PATCH_PATHS` / `PGC_PREVIEW_FLAGS` / `PGC_TOAST_ITEM`）
**全部是响应体改写**，无一涉及请求体。

> ⚠️ **不要因为"`XHR.send` 里有接管代码"就推断"改请求已经能做"。**
> 那段接管的语义恰恰相反：它是**放弃原请求、发一个不带 body 的新请求**，专为只读的
> 会员状态接口设计。把它改成"带改过的 body 重发"是**新增一类能力**，不是现有能力的延伸。

#### 新增一条路径要做什么？—— `routes.ts:65-85`

| 动作 | 依据 |
| --- | --- |
| `PROXY_ROUTES` 加一项，`enabled: true` | `routes.ts:101-157` |
| `ROUTES_REVISION` +1 | `routes.ts:66`「只在**路径字符串**或 `enabled` 开关变化时 +1」 |
| `AGENTS.md` §5.5 表里若是**响应体改写**，还要同步 ADR + `check-patch-scope.mjs` | `scripts/check-patch-scope.mjs:86-143`（四组常量逐个对账） |
| 若涉及**新主机**，同步三处：`BILI_API_HOSTS` / `PATCH_HOSTS` / 跑 `run-q2-auto.cjs` | `routes.ts:37-41` |
| DNR 回归两个脚本 | `AGENTS.md` §4.3 |

⚠️ **注意**：若只是给 DNR 加一条 **POST 路径**，`check-patch-scope.mjs` **不管**（它只管响应体改写）。
但 `dnr.ts:241` 的 `requestMethods: ['get']` 必须同时放开 —— 而那一改会让 DNR 开始代理 POST，
**这是架构级变更**，需要自己的 ADR。

---

### 9.1 Q1：「主世界改请求体」这条链路，技术上成立吗？

设想链路：主世界 hook `fetch`/`XHR.send` → 发出前把 body 里 `csrf=` 改成目标账号的 `bili_jct`
→ 同时靠 DNR 换 Cookie → double-submit 一致。

**逐环检查：**

#### 环节 1：主世界拿得到目标账号的 `bili_jct` 吗？—— **卡死，这环会断**

| 判据 | 内容 |
| --- | --- |
| `AGENTS.md` §5.2 | 「**不许把凭据下发给 UI**——UI 只能拿到 `AccountSummary`」 |
| `messages.ts:279-281`（原文） | 「`AGENTS.md §5.2`：**任何 `*:ok` 消息都不得携带凭据**……**绝不带 SESSDATA / bili_jct / 完整 Cookie**」 |
| 主世界算不算"UI"？ | **算，而且比 popup 更危险。** 主世界脚本跑在**页面自己的 JS 上下文**里，任何页面脚本（含 B站自家代码、任何第三方脚本）都能读到它 `window` 上的东西。把 `bili_jct` 交给主世界 = **把播放账号凭据泄露给 B站页面** |
| 现有凭据流向 | 凭据只存在于 background（vault 解密），DNR 在**浏览器网络层**替换 Cookie 头，**凭据从不进入任何页面上下文** |

**这一环是硬约束，不是工程难度：让主世界拿到 `bili_jct` 就等于放弃"凭据不出 background"这条架构基石。**

> 注：`bili_jct` 是**当前浏览器账号**的（`document.cookie` 可读，§3 B-1 已实测）。
> 但这里需要的是**播放账号/目标账号**的 `bili_jct` —— 那个只在 vault 里，主世界拿不到。

#### 环节 2：能安全改 body 吗？—— **本场景可以**（形态已确认）

| 判据 | 实测/证据 |
| --- | --- |
| like / coin / fav / reply / relation 的 body 形态 | **全部 `application/x-www-form-urlencoded`**（官方 bundle，`probe-h`）|
| 出现次数统计 | `urlencoded: 6`、`json: 0`、`multipart: 0`、`new FormData: 0` |
| 原始调用形态 | `Ge=({bvid,like})=>$({url:"/x/web-interface/archive/like",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},data:{bvid:n,like:t}})` |
| 改 body 的难度 | urlencoded 是字符串，`body.replace(/csrf=[^&]*/, ...)` 即可，**不涉及 FormData/流/上传进度** |
| `withCredentials` 影响 | 改 body 不影响 `withCredentials`；但**主世界重发会丢 `withCredentials` 语义**——现有接管代码用的是 `credentials: xhr.withCredentials ? 'include' : 'same-origin'`（`:2385`），这条已覆盖 |

**环节 2 不构成障碍**（前提是环节 1 能过）。

#### 环节 3：CORS / `Sec-Fetch-Site` 等连带影响 —— **改 body 本身不引入新问题，但要注意两点**

| 项 | 判断 |
| --- | --- |
| `Sec-Fetch-Site` | 由**浏览器按发起方 origin 自动填**。主世界脚本与页面同源 → 仍是 `same-origin`，**改 body 不影响它**。✅ 无影响 |
| CORS 预检 | `application/x-www-form-urlencoded` 是 **CORS-safelisted** Content-Type → **不触发预检**。✅ 无影响 |
| 若改成 JSON body | 会触发预检 + 需要服务端放行 → **不要这么做**（也没必要） |
| ⚠️ 真正的风险 | 主世界 hook 一旦失败（异常、页面重写 `fetch`、SPA 竞态），**写请求带着错 csrf 发出去 → `-111`**。用户表现为"点赞没反应"，且**静默无提示** |

#### Q1 结论

> ### **不可行（卡在环节 1：主世界拿不到目标账号的 `bili_jct`）**

三道拦路，按硬度排序：

| # | 拦路点 | 性质 |
| --- | --- | --- |
| 1 | 主世界**不能**拿凭据（`AGENTS.md` §5.2 + `messages.ts:279-281`）；它跑在页面上下文，等于把凭据交给 B站页面 | **架构红线，不能绕过** |
| 2 | 现有 `main-world.js` **只改响应不改请求**（`:2525`、`:2371`、`:2381`）—— 改 body 是**新增第五类能力**，要新 ADR + 扩 `check-patch-scope` 语义 | 需新决策 |
| 3 | 即使前两条都放开，POST 还要放开 `dnr.ts:241` 的 `requestMethods:['get']` | 架构级变更 |

> **补充一个"就算全放开也不划算"的理由**：主世界 hook 要覆盖 `fetch` + `XHR` 两条路径、
> 要处理 FormData/Blob/stream 各种 body 形态、要在 SPA 竞态下保持可靠。
> 而收益只是"点赞记到另一个账号"—— 这恰好是 ADR 0004 当初**刻意让问题消失**的那类需求
> （§3「副产品：D/E 需求免费解决」）。为它打破凭据边界，成本收益完全倒挂。

---

### 9.2 Q2：若 Q1 不可行，"记录身份"的红灯边界在哪

#### ① heartbeat（历史 + 进度）—— 拆开看，`写` 与 `读` 是两件事

**关键验证（L1，本轮实测）**：

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| 读历史 `/x/web-interface/history/cursor` 是 GET 吗？ | **是**（实测 GET 返回 200 / code 0） | `probe-i` 本轮 |
| 它随身份变吗？ | **完全随身份变**：登录态 `code:0` + 2 条记录；游客态 **`code:-101`（未登录）** | 本轮实测 |
| 写历史（heartbeat）需 csrf 吗？ | **不需要**（§8.1 已实测，带不带都 `code:0`） | §8.1 |
| 写历史能用 DNR 吗？ | **不能**——POST-only，`dnr.ts:241` 只放 GET | 代码事实 |

**所以"用 A 号取流、在 B 号看自己的历史列表"这个拆分是真的：**

| 动作 | 身份归属 | 能否用 DNR 换 | 灯 |
| --- | --- | --- | --- |
| **看**历史列表 | 由 Cookie 决定 → 换成谁就看谁的历史 | ✅ **能**（GET，已在 `api.bilibili.com`） | 🟢 |
| **写**历史 / 进度 | 永远是页面当前身份（heartbeat 带页面 Cookie，DNR 够不到） | ❌ 不能 | 🔴 |

> ⚠️ 口径：这不是"看别人的隐私"——换 Cookie 后看到的是**用户自己另一个已登录账号**的历史。
> 且该账号的历史在**别的浏览器里本来就能看到**，不是新泄露面。

#### ② 点赞 / 投币 / 收藏 / 评论 —— **红灯**

| 接口 | 方法 | csrf | 结论 |
| --- | --- | --- | --- |
| `/x/web-interface/archive/like` | POST | 必需且绑定 | 🔴 |
| `/x/web-interface/coin/add` | POST | 必需且绑定 | 🔴 |
| `/x/v3/fav/resource/deal` | POST | 必需且绑定 | 🔴 |
| `/x/v2/reply/add` | POST | 必需且绑定 | 🔴 |
| `/x/relation/modify` | POST | **未测**（有副作用风险，跳过） | 🔴（按同族推定，`推理`） |

三条独立拦路：**POST-only** + **csrf 绑定** + **DNR 只改 header**。任一条足以否掉。

#### ③ 纯读取类社交数据 —— **逐条实测分类**

判据：同一 GET 接口，`credentials:'include'`（登录）vs `'omit'`（游客）比对。

| 接口 | 登录 vs 游客 | 数据性质 | 换 Cookie 后看到谁的 | 灯 |
| --- | --- | --- | --- | --- |
| `/x/web-interface/view`（视频信息） | 都 `code:0`；仅 `user_garb` 字段不同 | **公开 + 个位数性化字段** | 同一个视频，内容一致 | 🟢 无意义但无害 |
| `/x/web-interface/history/cursor`（历史） | 登录 `code:0` 有数据；游客 **`-101`** | **纯私有** | **换谁就是谁的历史** | 🟢 可换（见 ①） |
| `/x/v3/fav/folder/created/list-all`（收藏夹列表） | 都 `code:0`；游客 `data` 只有 4 字节（`null`），登录 6016 字节含 `list`/`count`/`season` | **纯私有** | 换谁就是谁的收藏夹 | 🟢 可换 |
| `/x/v2/reply`（评论区） | 都 `code:0`；`replies`/`page`/`config`/`upper`/`control` 等字段变 | **混合**：评论主体公开，但 `config`/`control` 含身份相关权限（能否发评/发弹幕） | 评论内容相同，**权限字段变成另一账号的** | 🟡 慎换 |
| `/x/relation/followings`（关注列表） | 登录 `code:0` 有 `list`/`total`；游客 **`-101`** | **纯私有** | 换谁就是谁关注的人 | 🟢 可换 |
| `/x/v3/fav/resource/list`（收藏夹内容） | 两态都 `code:0` 但 `data` 仅 4 字节 | **空/无效输入**（media_id=1 不存在或非本人） | **未确定** | ⬜ 未确定 |

> ⚠️ `reply/list` 的「混合」要单独说：换 Cookie 后**评论内容不变**，但
> `config`（是否可评论）、`control`（发言限制）会变。对"只看不写"的场景无害，
> 但如果 UI 依据这些字段决定是否显示"发评论"按钮，会显示成**另一个账号的权限**。
> → **不推荐**把评论接口放进白名单。

**③ 的总结（三字级别）**：**大部分可换，评论接口慎换。**

---

### 9.3 Q3：按接口族的可行性矩阵

| 行为 | 方法 | 需 csrf | DNR 可达 | 需改 body | 灯 |
| --- | --- | --- | --- | --- | --- |
| **取流（playurl）** | GET | 否 | ✅ 已在白名单 | 否 | 🟢 **已实现** |
| **首页推荐（rcmd）** | GET | 否（wbi 不校验） | ✅ 路径可达 | 否 | 🟡 **首屏 SSR 换不了**；滚动加载可换 |
| **历史读（history/cursor）** | GET | 否 | ✅ 路径可达 | 否 | 🟢 **可换**（换谁看谁的历史） |
| **历史写（heartbeat）** | POST | **否**（已实测） | ❌ POST-only | — | 🔴 但卡点仅在方法，**不在 csrf** |
| **进度写（heartbeat）** | POST | 否 | ❌ POST-only | — | 🔴 同上 |
| **点赞（archive/like）** | POST | **是（绑定）** | ❌ POST-only | 是 | 🔴 |
| **投币（coin/add）** | POST | **是（绑定）** | ❌ POST-only | 是 | 🔴 |
| **收藏（fav/resource/deal）** | POST | **是（绑定）** | ❌ POST-only | 是 | 🔴 |
| **评论（reply/add）** | POST | **是（绑定）** | ❌ POST-only | 是 | 🔴 |
| **关注（relation/modify）** | POST | **未测**（副作用风险跳过） | ❌ POST-only | 是 | 🔴（`推理`） |
| **收藏夹读（fav/folder、fav/resource/list）** | GET | 否 | ✅ `api.bilibili.com` | 否 | 🟢 folder/list-all 可换；resource/list **未确定** |
| **关注列表读（relation/followings）** | GET | 否 | ✅ `api.bilibili.com` | 否 | 🟢 可换 |

#### 矩阵的读法（三条结论）

1. **所有 GET 都能换，所有 POST 都不能换。**
   这不是巧合 —— DNR 的 `requestMethods:['get']`（`dnr.ts:241`）是这条界的物理原因。
2. **csrf 只在 POST 上有意义**，所以"绕 csrf"这条路，目标其实是"绕 POST 限制"。
   而 Q1 已证明：绕 POST 需要主世界拿凭据 → **架构红线**。
3. **唯一有条件可做的是 heartbeat**（不需 csrf），但它是 POST。
   → 若将来愿意为它单独放开 POST（不改 body），**"写入也换身份"是可做的**。
   这是整个矩阵里**唯一一盏不是纯红的写接口** —— 值得单独立项评估。

### 9.4 本节新增的「未确定」项（不拍）

| 项 | 为什么未确定 |
| --- | --- |
| `/x/relation/modify` 是否校验 csrf | 副作用风险（会真改关注状态），本轮**未测** |
| `/x/v3/fav/resource/list` 的身份敏感性 | 用 `media_id=1` 两态都返回空 `data`（4 字节），**输入无效**导致测不出差异 |
| heartbeat 若放开 POST，DNR 换 Cookie 后能否成功写入目标账号 | **未测**（要真发一次写请求），但 csrf 障碍已排除 |

---

### 9.5 复现方式（本节新增）

```powershell
node poc/probe/api-inventory/probe-h-body-encoding.mjs                                   # 纯静态，无需 bsk
node poc/probe/api-inventory/probe-i-read-identity.mjs --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-i2-field-diff.mjs   --session <sid> --tab <tab>
```

⚠️ 三个脚本**全部只读**，无任何 POST。

---

## 10. 【2026-11-11 补充三】首页首屏数据的**确切落点**

> 本节钉死一件事：首屏那 8–10 条到底从哪来。它决定"首屏能不能用别的办法换"。
> 环境同上（bsk 0.3.3 / Edge 157 / **单个真实账号** / `vipStatus:0`）。
>
> ⚠️ **替代实验声明**：本机只有一个登录账号，凡涉及"另一个账号"的对比，
> 一律用 **游客态（`credentials:'omit'`）vs 登录态（`'include'`）** 替代，均已在对应行标注。

### 10.0 ⚠️ 先更正 §2 A3 的一个**错误判据**

§2 A3 当时写：

> 「HTML 里的 BV 与 `feed/rcmd` 接口返回的 BV **重合只有 1/14** → 接口不是首屏数据来源」

**这个推理是错的。** §8.3 已经证明：**首屏推荐每次刷新都完全不同**
（同账号间隔 1.2s 拉两次首页，overlap = 2/13）。本轮 M1 复核更极端：

```
M1 连拉两次首页 HTML：aCount 9, bCount 8, overlap 0
```

**overlap=0 在"两次都是同一机制"的情况下也会出现。**
→ **"跨请求比较 overlap"根本不能用来判断数据来源**。A3 那个 1/14 的判据**作废**。

本节改用**不依赖跨请求比较**的判据：类名标记 + 请求时序 + 点击因果。

### 10.1 Q1. 首屏 8 条的真正数据源 —— **SSR 初渲 + 接口整体替换**

#### 判据 1：SSR 卡片与接口卡片**用的是同一个组件类名**

纯 HTML（无 JS 执行）里的首屏卡片：

```html
<div class="bili-video-card is-rcmd enable-no-interest" style="--cover-radio:56.25%;">
  <a class="bili-video-card__image--link" href="https://www.bilibili.com/video/BV…?trackid=web_pegasus_…">
<h3 class="bili-video-card__info--tit" title="…">
```

实测计数（L1）：

| 来源 | `bili-video-card is-rcmd` 出现次数 | 标题节点数 |
| --- | --- | --- |
| 登录态 HTML（`include`） | **10** | 10 |
| 游客态 HTML（`omit`） | **10** | 10 |

→ **SSR 直出的就是 rcmd 卡片本身**，不是"另一套首屏组件"。这排除了"SSR 和接口是两套不同数据源"的可能。

#### 判据 2：终态 DOM 里**全部**是 rcmd 渲染的卡片

页面加载完成后（`readyState: complete`）逐张检查（L1）：

```
i=0  cls="bili-video-card"                          bv=null   hasTitle=false   ← 骨架
i=1  cls="bili-video-card"                          bv=null   hasTitle=false   ← 骨架
i=2  cls="bili-video-card is-rcmd enable-no-interest" bv=BV1jsnn6uEG5  hasTitle=true
i=3  ... is-rcmd enable-no-interest ...
i=5  cls="bili-video-card is-rcmd"                   bv=null   hasTitle=true    ← 广告卡，无 BV
...  (共 39–48 张，全部 is-rcmd)
```

- 前两张是**骨架占位**（无标题、无 BV）
- 其后**每一张真实卡片都带 `is-rcmd`**
- 终态 DOM 里**找不到任何"非 is-rcmd"的真实卡片**

#### 判据 3：请求时序（L1）

```
navStart 0 → loadEventEnd 2265ms
rcmd 请求1: startTime 2181ms, duration 330ms
rcmd 请求2: startTime 3046ms, duration 363ms
```

第一次 rcmd 在 **2181ms** 才发出，而 `loadEventEnd` 是 2265ms —— 说明**页面先有内容（SSR），rcmd 是后到的**。

#### 判据 4：**点击"换一换"能整批换掉首屏**（因果证明，L1）

这是最硬的一条 —— 它直接证明"首屏那些位置的数据由接口提供"：

| 轮次 | 点击前首屏 5 条 | 点击后首屏 5 条 | rcmd 请求数 | overlap |
| --- | --- | --- | --- | --- |
| 第 1 轮 | `BV19aWE6iEs4, BV132pz69Exo, BV1iw4B6zEQj, BV152Jf6yEUz, BV1gj446hEbu` | **`BV1YHnq6LEgX, BV1Y3W76wECX, BV1La4t6uEKb, BV1pLWu64EX6, BV17Gx46gEx8`** | 2 → **3** | 15 |
| 第 2 轮（reload 后复现） | `BV1Depy6TEEq, BV1Sznu6FEHG, BV1UFxM6vEpj, BV1arnV65EHL, BV1Vzxc6dEwp` | **`BV1QxHV6EE2T, BV1mtnc6vEJh, BV1J3ec6WEgp, BV1NDWu6YEgM, BV19T446iEoJ`** | 2 → **3** | 16 |

- 点一次"换一换"→ **恰好 +1 次 rcmd 请求**
- **首屏前 5 条全部换新**（一条不剩）
- 总卡片数 23→24 / 24→25（只是补了 1 张，**不是替换整个列表**）
- `overlap` 15–16 条保留 → 是**尾部保留、头部替换**

**所以首屏那 8–10 条的位置，数据来源是 `/x/web-interface/wbi/index/top/feed/rcmd`。**

#### Q1 结论

> ### **首屏数据源 = SSR 初渲 + 接口（`feed/rcmd`）整体替换**

- **① 纯 SSR**：部分成立 —— SSG/SSR **确实**直出了首批 10 张卡片（判据 1、3）
- **② 接口替换**：**成立** —— 加载后 rcmd 到达，首屏位置被整批覆盖（判据 2、4）
- **③ 接口追加**：**否** —— 终态没有"留在前面的 SSR 卡"，前两张是骨架不是 SSR 内容
- **④ 别的机制**：未发现

**⚠️ 我先前 §2 A3 的"首屏 SSR，换 Cookie 无效"结论方向要修正**：
首屏**初始渲染**是 SSR 的（这一时刻确实换不了），
但**加载完成后首屏是 rcmd 接口的数据 → 换 Cookie 后首屏会变**。

这个修正对方案的意义很大，见 §10.4。

### 10.2 Q2. 首屏 SSR 由哪个请求产生 / 是否由 Cookie 决定 —— **是（L1，替代实验）**

#### 主文档请求的特征

首页主文档：`GET https://www.bilibili.com/`（无 `?spm_id_from`、方法 GET）。
`Sec-Fetch-*` 由浏览器自动填，不是页面可控参数。

#### **决定性实验：同一 URL 带/不带 Cookie**（替代实验：游客态 vs 登录态）

```
登录态 (include): status 200, len 178839, cards 10, titles 10, midEcho ["mid:{{主账号mid}}"], uniqBv 17
游客态 (omit):    status 200, len 153423, cards 10, titles 10, midEcho [],               uniqBv 13
```

| 判据 | 结果 |
| --- | --- |
| HTML 长度不同 | ✅ 178839 vs 153423（差 25 KB） |
| **mid 回显** | ✅ **只在登录态出现** `mid:{{主账号mid}}`；游客态**完全没有** |
| BV 数量 | 17 vs 13 |
| 卡片数 | 都是 10（**条数相同，内容不同**） |

**结论（L1）：首页主文档的 HTML 内容由 Cookie 决定。**
服务端按请求携带的身份渲染 `mid` 与推荐内容。

**但有一个重要的反直觉点**：**卡片条数在两种身份下都是 10**，
变化的只是"哪 10 条"。所以"游客态首屏是空的"是**错的**——
游客也能看到满屏推荐（只是推荐内容不含个性化）。

#### Q2 结论

> ### **HTML 是否由 Cookie 决定 → 是（mid 回显只在登录态出现 + 长度差 25 KB）**

含一个限定：**SSR 的"是否出现/条数"不随身份变**（都 10 条），
**内容与 `mid` 才随身份变**。所以"不登录就没有首屏"不成立。

### 10.3 Q3. 有没有第二条首屏通道 —— **无有效通道**（只有旁路页签流）

逐条探测（L1）：

| 候选 | 结果 | 判定 |
| --- | --- | --- |
| `www.bilibili.com/index/ding.json`（老接口） | **404**（5633 字节） | ❌ **已废弃** |
| `api.bilibili.com/x/web-interface/ding` | **404** | ❌ 不存在 |
| `api.bilibili.com/x/web-interface/rcmd` | **404** | ❌ 路径不对（真实是 `/wbi/index/top/feed/rcmd`） |
| `app.bilibili.com/x/v2/feed/index`（App 侧） | **网络不通**（跨域/不存在） | ❌ 网页端拿不到 |
| `api.bilibili.com/x/web-interface/popular`（热门） | 200, code 0, 有数据 | ✅ 可用（旁路） |
| `api.bilibili.com/x/web-interface/ranking/v2`（排行榜） | 200, code 0, 109 KB | ✅ 可用（旁路） |
| `.../index/ogv/rcmd`（番剧推荐） | 200 但 **`code:-400`** | ⚠️ 需要额外必填参数，**未确定** |
| `api.live.bilibili.com/.../getMoreRecList`（直播） | 200 但 **`code:-400`** | ⚠️ 同上，**未确定** |

#### 旁路页签流**是否随身份变**（决定它们能不能当"可换身份的入口"）

| 流 | 登录 vs 游客 | 是否随身份变 |
| --- | --- | --- |
| **热门** `popular` | 都 `code:0`，各 10 条 BV，**overlap 1** | ⚠️ **几乎不变**（1/10 是随机波动） |
| **排行榜** `ranking/v2` | 登录 `code:0` 108 条 BV；游客 **`code:-352`（风控拦截）** | 游客被拦，**登录态内部是否个性化未测** |
| **rcmd 流** | 都 `code:0`，各 10 条，**overlap 0** | ✅ **完全随身份变** |
| 历史 | 登录 `code:0`；游客 `code:-101` | ✅ 完全随身份变 |

#### Q3 结论

> ### **有无第二条首屏通道 → 无**

- `ding.json` 已 404 废弃
- App 侧接口网页端拿不到
- **热门/排行榜不是"推荐"**：热门 `overlap 1/10` 说明它**基本与身份无关**，换 Cookie 没意义
- 唯一随身份变的是 `feed/rcmd` —— **就是那条已经在用的**

> ⚠️ **注意与任务预设的偏差**：任务问"若某个页签是接口驱动的，那'推荐账号'的可行边界更宽"。
> 本轮结果是 **不是更宽，而是更窄**：热门/排行榜**不随身份变**，做不了"换推荐账号"。

### 10.4 Q4. 最贴近用户预期的替代设计 —— **能力判定**

#### (a) "首屏不动、往下滚已是另一账号的流" —— **技术上成立，且无断层**

| 判据 | 实测 |
| --- | --- |
| 滚动触发点 | 滚到 **1527 px** 时触发第 1 次新 rcmd（视口高 1081，文档高 2608） |
| 卡片高度 | 平均 **166 px** |
| 换算 | 1527 px ≈ **第 9–10 张卡**之后（首屏约 6–7 张可见） |
| 此时首屏是否被重请求 | **否** —— 首屏卡片原地不动，只追加新卡 |
| 是否产生重复 BV | §8.3 已测：连翻 3 页 90 条与首屏 **overlap 0** |
| 字段集是否一致 | ✅ 同一组件（`is-rcmd`），渲染无差别 |

→ **能做**，且用户看到的是"滚到第二屏时内容换了个风格"，**没有重复、没有断层、没有骨架闪**。
唯一能察觉的线索是**内容倾向变化**（§8.3 已说明这是主观层面，未测）。

#### (b) **"用户主动点一次「换一换」→ 整页推荐变成目标账号"** —— **成立，这是最优入口**

本节 O2 组的实验**已经完整证明了这条链**：

| 环节 | 实测 |
| --- | --- |
| 首页有该入口吗 | ✅ **有**：`.feed-roll-btn button.roll-btn`「换一换」、`.flexible-roll-btn`「刷新内容」 |
| 点了会发请求吗 | ✅ rcmd 请求数 **2 → 3**（连跑 2 轮都稳定） |
| 首屏会换吗 | ✅ **前 5 条全部换新**（两轮均如此） |
| 换的是整个列表吗 | ❌ 不是：总卡数 23→24，尾部 15–16 条保留 |
| 数据来自哪个接口 | ✅ `/x/web-interface/wbi/index/top/feed/rcmd` |

**关键洞察**：
「换一换」把**当前身份**的推荐**整批换成同一身份的另一批**。
若 DNR 把这条路径换成目标账号 Cookie，那么点一次「换一换」= **整页首屏变成目标账号的推荐**。

→ **这就是"有入口、用户可理解、主动触发"的那个入口**，比"滚下去才生效"强得多。

#### 但有一个**必须先验证的前提**（本轮未做）

> 「换一换」之后，**首屏会不会在某个时刻被 SSR 数据写回**？

本轮的证据只覆盖"点击后 3–3.5 秒"，**没有覆盖**：
- 用户点完换一换再刷新页面 → 刷新会让 SSR 重新介入，回到 A 身份（**这是确定的**）
- 换一换之后长时间停留，是否会有其它接口回填首屏（**未测**）

**所以完整能力表述应是**：
> 「换一换」让**当前页面会话内**的推荐变成目标账号；
> **刷新页面会退回**页面身份的 SSR 初渲，需要再点一次。

这不是缺陷 —— 它恰好是**用户可理解**的行为（"点一下换一批"本来就只影响这一次）。

#### Q4 结论

> ### **替代入口是否存在 → 有（首页「换一换」/「刷新内容」按钮 + 滚动加载）**

两条都成立：
- **滚动加载**：第 2 屏起即是目标账号的流，无重复无断层
- **「换一换」**：主动触发，**首屏整批换新**，是更干净的入口

### 10.5 本节对前面结论的修正（重要）

| 原结论 | 修正后 | 依据 |
| --- | --- | --- |
| §2 A3「首屏是 SSR，改接口 Cookie 对首屏无效」 | **方向要改**：首屏**初渲**是 SSR（这一刻无效），但**加载完成后首屏是 rcmd 数据** → 换 Cookie **会**变 | §10.1 判据 2/4 |
| §2 A3「HTML BV 与接口 BV 重合 1/14 → 接口不是首屏来源」 | **判据作废**：overlap 跨请求比较对首页无意义（M1 同机制 overlap=0） | §10.0 |
| §8.3「首屏混合态不可察觉」 | **仍然成立**，但机制更清楚了：不是"SSR 一批 + 接口一批"，而是**接口整批替换 SSR** | §10.1 |
| §5.1「首页推荐 🟡 首屏不能」 | **升级为可用**：有「换一换」这个主动入口 | §10.4(b) |

### 10.6 本轮新增的「未确定」

| 项 | 为什么未确定 / 需要什么 |
| --- | --- |
| 「换一换」之后是否有其它接口回填首屏 | 只观察了 3.5 秒，**需要更长的 MutationObserver 观测窗口** |
| 换 Cookie 后点「换一换」是否真的整页变目标账号 | **需要跨账号实测**（本机单账号做不了；游客态不能代表另一账号） |
| 排行榜在登录态内部是否个性化 | 游客被 `-352` 风控拦，测不出差异 |
| 番剧推荐 / 直播推荐的正确调用参数 | 实测 `code:-400`，缺必填参数，未继续 |

### 10.7 复现方式（本节新增）

```powershell
node poc/probe/api-inventory/probe-j-firstscreen.mjs    --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-k-replace-vs-append.mjs --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-l-ssr-survival.mjs   --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-m-verify.mjs         --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-n-cookie-scroll.mjs  --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-o2-switch.mjs        --session <sid> --tab <tab>   # 含点击"换一换"
node poc/probe/api-inventory/probe-p-switch-source.mjs  --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-q-alt-channels.mjs   --session <sid> --tab <tab>
node poc/probe/api-inventory/probe-r-tabs-identity.mjs  --session <sid> --tab <tab>
```

⚠️ 全部只读，无任何写请求。`probe-o2` 会**点击首页的「换一换」按钮**（用户可做的只读交互）。

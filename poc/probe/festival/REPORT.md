# B站「活动专区页」（`/festival/*`）播放器接管可行性调查

> 调查日期：2026-11-18　调查人：probe-festival
> 环境：bsk 0.5.0（未升级）、Edge 157、扩展 Pluma 1.3.0（总开关 `true`、取流身份 `extension`）
> 边界：**只读**。未改任何 `src/` 产品代码、测试、守卫，未 commit。所有签名 URL 一律脱敏。
> 探针表达式在 `poc/probe/festival/expr/`，原始 HTML 快照落在 `.tmp/festival-*.html`（gitignored，不入库）。

---

## 0. 一句话结论

**DNR 层的身份代理可以原样复用（活动页的取流走的正是白名单里的 `/x/player/wbi/playurl`，与页面 URL 无关）；但 `content.ts` 的"接管"逻辑不能原样复用——必须新增一条活动页路径。** 原因不是网络接口变了，而是**活动页没有 `window.__playinfo__`**，且现有注入入口与页面判据都不认 `/festival/*`。

---

## 1. `BV1eoZ7BnEGy` 对应的活动页 URL

直接打开 `https://www.bilibili.com/video/BV1eoZ7BnEGy` 会被站点重定向（页面 URL 最终为活动页）：

| 项 | 值 |
| --- | --- |
| 最终 URL | `https://www.bilibili.com/festival/bnj2026?bvid=BV1eoZ7BnEGy` |
| 页面标题（`<title>`） | `2026哔哩哔哩拜年纪` |
| 稿件名 | `年年对对【2026拜年纪单品】` |
| 对照：另一个例子 | `https://www.bilibili.com/festival/COLMO2026?bvid=BV1ydeX65Edn`，标题 `COLMO高阶空气科技` |

两页的 URL 形态一致：**路径决定活动，bvid 只出现在 query（`?bvid=`）里**。这一点对"扩展如何解析出 pageKey"是关键——现有 `parseVideoPage()` 只从路径取 BV 号。

---

## 2. 两个活动页的逐项实测

对照组：`https://www.bilibili.com/video/BV1beNcz2ECq/`（普通 `/video/` 播放页，扩展已注入，`window.__PLUMA_MAIN__` 存在）。

### 2.1 取流接口

两页一致。脱敏后的请求样本（`bsk network` / `bsk debug requests` 实抓）：

```text
GET https://api.bilibili.com/x/player/wbi/playurl
    ?avid=<数字>&bvid=<BV号>&cid=<数字>
    &qn=120&fnver=0&fnval=4048&fourk=1
    &gaia_source=&from_client=BROWSER&is_main_page=true
    &need_fragment=false&isGaiaAvoided=false&client_attr=0
    &version_name=…&app_id=100&session=<hex>
    &voice_balance=…&web_location=…
    &dm_img_list=…&dm_img_str=…&dm_cover_img_str=…&dm_img_inter=…
    &w_rid=<32位签名，已脱敏>&wts=<时间戳>
→ 200 application/json
```

| 观测项 | bnj2026 | COLMO2026 | 普通 `/video/` 对照 |
| --- | --- | --- | --- |
| path | `/x/player/wbi/playurl` | `/x/player/wbi/playurl` | `/x/player/wbi/playurl` |
| host | `api.bilibili.com` | `api.bilibili.com` | `api.bilibili.com` |
| 是否白名单路径 | ✅ 是（`routes.ts` 第 1 条） | ✅ 是 | ✅ 是 |
| 关键 query | `qn=120`, `fnval=4048`, `fourk=1`, `w_rid`, `wts` | 同左 | 同左，另多 `x-bili-device-req-json` / `x-bili-locale-json` 两个 B站指纹字段 |
| 另发接口 | `/x/player/wbi/v2`、`/x/player/online/total` | 同左 | `/x/player/wbi/v2` |

**结论：取流请求就是白名单里的那条 `/x/player/wbi/playurl`，没有新接口、没有新 host。** 不需要为活动页新增 DNR 路径规则。

### 2.2 `window.__playinfo__`

| 观测 | bnj2026 | COLMO2026 | 普通 `/video/` 对照 |
| --- | --- | --- | --- |
| `typeof window.__playinfo__` | `undefined` | `undefined` | `undefined`（**被 Pluma 主动藏起**） |
| `Object.getOwnPropertyDescriptor(window,'__playinfo__')` | `null`（页面上根本没有这个属性） | `null` | `get/set` 均存在、`configurable: true`（Pluma 的 hook 描述符） |
| 原始 HTML 字符串 `__playinfo__` 出现次数（约 1.1 MB 全文） | **0** | **0** | — |

⚠️ 对照组那句 `undefined` **不能**读成"普通页也没有"：普通页有 Pluma 安装的 getter/setter 描述符，这是扩展"藏 SSR playinfo 逼播放器发 playurl"的证据。活动页`描述符为 null`，是**连被藏的对象都不存在**——两种情况本质不同。

活动页改由 `window.__INITIAL_STATE__` 承载页面数据（运行时对象，原始 HTML 里也搜不到 `INITIAL_STATE` 字面量，是页面 JS 填的），其中：
- `isVideo: true` / `isLive: false` / `isModern: true`
- `videoInfo: { aid, cid, bvid, title, pages, … }`（bnj 的 cid=36059286363，COLMO 的 cid=42141027046）
- `player`、`userInfo`、`sectionEpisodes` 等键存在

**结论：扩展在 `/video/` 页上赖以接管的 `__playinfo__` 门（藏 SSR 数据 / 主世界注入）在活动页上完全落空。**

### 2.3 响应形态与 4K

用页面自身发出的那条 playurl 请求（原样 URL，只做一次只读 GET 复取）解析响应：

| 项 | bnj2026（`BV1eoZ7BnEGy`） | COLMO2026（`BV1ydeX65Edn`） |
| --- | --- | --- |
| HTTP / code | 200 / 0 | 200 / 0 |
| 请求 `qn` | 120 | 120 |
| 响应 `quality` | **112**（高清 1080P+） | **120**（超清 4K） |
| `accept_quality` | `[112,80,64,32,16]` | `[120,112,80,64,32,16]` |
| 流形态 | **仅 `dash`**，`durl` 不存在 | **仅 `dash`**，`durl` 不存在 |
| `dash.video` 清晰度 id | `[112,80,64,32,16]`，无 120 | `[120,112,80,64,32,16]`，**id=120 有 3 个编码档** |
| `dash.audio` | 3 档 | 3 档 |
| 实际媒体分段 | `*.bilivideo.com/upgcxcode/…/*.m4s` (206) | 同类 `*.m4s` |

说明：两页**都按 qn=120 请求**，所以"请求 qn=120"不等于"拿到 4K"。bnj 这个稿件自身最高只给到 112；COLMO 确实返回了 4K。两页都是 DASH + m4s，**没有 durl/FLV**。

### 2.4 播放器初始化 / `createPlayer` 钩子

两页一致：

- 加载同一个播放器内核 `s1.hdslb.com/bfs/static/player/main/core.61de1491.js`；
- `typeof window.nano === 'object'`，且 `typeof window.nano.createPlayer === 'function'`（位于 `nano` 的原型上）；
- 但 **`window.__PLUMA_MAIN__ === undefined`**：`content.ts` / `main-hook.content.ts` 的 `matches` 只有 `/video/*` 与 `/bangumi/play/*`，活动页**根本没注入**；
- 因此活动页上不存在 Pluma 的任何钩子：没有 `__playinfo__` setter、`createPlayer` 计时探针、fetch/XHR 响应改写、诊断桥 `streaming-probe` 也没有。

源码侧对应关系：
- `src/content/main-world.js:598` `IS_PGC = location.pathname.indexOf('/bangumi/play/') === 0`；`installCreatePlayerProbe()` 第 631 行 `if (!IS_PGC) return`。**即使把活动页加进 matches，`/festival/` 仍然走不到 `createPlayer` 探针。**
- `/video/` 分支不靠 `createPlayer`，靠"藏 `__playinfo__` + path-based fetch/XHR 改写"（`main-world.js:519`、`PATCH_PATHS` / `PROGRESS_PATCH_PATHS`）。活动页没有 `__playinfo__`，这条链缺了起点。
- 好消息：fetch/XHR 的改写判据是**请求 path**（`isPlayurlPath()` / `matchPath()`），不是页面 path，注入后 `/x/player/wbi/playurl` 会被同样识别。

**结论：播放器有 `nano.createPlayer` 这个可用钩子点，但现有钩子一个都没装；而且"标准视频页那套"依赖 `__playinfo__` 的前提在这里不成立。**

### 2.5 设备 Cookie 可见性 / 同源

| Cookie | bnj2026 | COLMO2026 | 普通 `/video/` |
| --- | --- | --- | --- |
| `buvid3` / `buvid4` / `buvid_fp` / `b_nut` / `_uuid` / `bili_ticket` / `bili_ticket_expires` | 全部可见 | 全部可见 | 全部可见 |
| `bili_jct` / `DedeUserID` / `sid` | 可见 | 可见 | 可见 |
| `SESSDATA` | `document.cookie` 中不可见（httpOnly，三页一致） | 同左 | 同左 |

- 三个页面同属 `www.bilibili.com`，**同源**；活动页 `document.cookie` 共 31 项，与普通页同一批名字。
- 页面 SSR 的 `userInfo.isLogin === true`、`vipStatus === 1`、`vipType === 1`（两个活动页）。
- 因此 `readDeviceCookies()` / `readPrimaryMidFromCookie()` 在活动页**可以原样工作**，无需改 Cookie 读取逻辑。
- 实例嘴上说"登录可享"、播放器 UI 有"为TA充电后即可观看"字样，但取流已经返回 dash，与 Cookie 可见性结论无关。

---

## 3. DNR 层：是否依赖标签页 URL？

查 `src/platform/http/dnr.ts` 的 `buildPathRule()`（528–570）与 `tabRuleSpec()` / `installTabRule()`（898–1009）：

| 规则类型 | ID 段 | 条件 | 是否看页面 URL |
| --- | --- | --- | --- |
| 全局路径规则 | 10000–10999 | `urlFilter: path` + `requestDomains: [api.bilibili.com, api.biliapi.net]` + `resourceTypes: ['xmlhttprequest']` + `requestMethods: ['get']` | **不看**。只看请求本身的 host/path |
| 标签页限定规则 | 20000–29999 | 上述条件 + `tabIds: [...]` | **不看页面 URL**，但**依赖 content.ts 调 `page/activate` 把 tabId 报上来** |

`ENABLED_ROUTE_PATHS` 已含 `/x/player/wbi/playurl` 与 `/x/player/playurl`（`routes.ts` 前两条，均 `enabled: true`）；`BILI_API_HOSTS` 含 `api.bilibili.com`。本次实测该实例的 `proxyEnabled === true`、`identity === 'extension'`（经标准页 `streaming-probe` 桥读到 `buildProof: {swStartedAt, probeVersion: 2}`）。

**回答：身份代理的 Cookie 替换靠 `urlFilter` 匹配取流接口，与页面 URL 无关。活动页播放器的 `/x/player/wbi/playurl` 已经被现有全局规则覆盖，不需要新 DNR 规则。**

但有两个必须分开说清的限定：

1. **wire 上的 Cookie 值没能直接看到**：`bsk debug request … --part headers` 把 `cookie` 字段固定显示为 `[redacted]`。所以"规则确实命中"是从源码条件 + 代理状态 + 请求 path 三者推得，不是从抓到的 Cookie 头直接读到。
2. **标签页规则那条链在活动页是断的**：`entrypoints/content.ts` 的 `report()` 第 2045 行 `const info = parsePlayPage(location.href); if (!info) return;`，活动页解析为 `null` → 不发 `page/activate` → 不装该 tab 的 20000 段规则、也不登记 `pageState`（这就是面板显示"未生效"的直接原因）。注意 `page/activate` 的 `kind` 只接受 `'video' | 'pgc'`，活动页若走视频分支，`kind: 'video'` 是适用的。

---

## 4. 总判断与改造含义

> **活动页能否复用现有 `content.ts` 接管逻辑？——不能原样复用，必须写新路径。**
> 准确地说：**DNR/网络层已可复用且无需新规则；页内接管链（注入 → 判据 → `__playinfo__` 钩子 → 状态上报）必须新增活动页分支。**

若后续决定支持，最小改造面（本次**未**实施）：

1. **注入面**：`entrypoints/content.ts` 与 `entrypoints/main-hook.content.ts` 的 `matches` 要加 `/festival/*` 字面量（WXT 静态分析不能引用常量）；`scripts/check-page-gate.mjs` 的 `MANIFEST_MATCHES` / `REQUIRED_MATCH_PATTERNS` / `PATH_LITERAL_ALLOWED` 与 `NON_PLAY_PAGE_ENTRIES` 登记要同步，否则守卫红。host permission `*://*.bilibili.com/*` 已够，不用扩。
2. **判据**：`src/shared/utils/video-page.ts` 的 `parsePlayPage()` / `PLAY_PAGE_URL_PATTERNS` 要认 `/festival/<key>?bvid=BV…`（BV 号在 query，不在路径）；`page-state-client.ts` 的 `tabs.query` 与 `content-panel.content.ts` 的 `detectPageKind()` 走同一真相源，改一处即可让面板不再报"未生效"。`pageKey` 可沿用 bvid。
3. **主世界策略**：不能照抄 `/video/` 的"藏 `__playinfo__`"——活动页没有这个属性。可选：
   - (a) 只让 DNR 完成身份替换，主世界仅做诊断/进度/响应观测（改动最小）；
   - (b) 若要做流改写/诊断基线，改用 `window.nano.createPlayer`（已实测存在），同时放宽 `main-world.js` 的 `IS_PGC` 判据——但 `createPlayer` 现在只做**计时观测**，真正注入流的 PGC 链路仍绑在 `__playinfo__` 上，需要重新设计数据入口（可从 `__INITIAL_STATE__.videoInfo.cid` 取 cid）。
4. **不要动的部分**：`routes.ts` 的路径白名单、`dnr.ts` 的规则构造、`readDeviceCookies()` —— 实测和活动页兼容。

### 未直接验证 / 卡点

- bsk 把请求头的 `cookie` 值固定脱敏为 `[redacted]`，无法直接读到 DNR 改写后的 Cookie 明文；本报告对"规则命中"的结论基于源码条件与代理状态，不声称看到了实际 Cookie 头。
- `bsk navigate` / `reload` 在弹幕持续变化的页面上会因严格观测失效而拒执行，因此本次用"开新标签 + 页面自身请求 + 页内只读复取"取证，未做"刷新后自动化重放"的对照。
- 未验证活动页的 SPA 切视频（换 `?bvid=` 不刷新）是否复用同一个 `nano` 实例；这会影响方案 (b) 的时机设计。

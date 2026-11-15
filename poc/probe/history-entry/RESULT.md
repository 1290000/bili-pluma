# B 站首页「历史」入口的结构探测结果

> 任务：判定 H4 生死线。**全程只读**：未点击任何会改变状态的元素（未点视频、未点删除、未发写请求）。
> 环境：Edge 157 / bsk 0.3.3 / 真实登录态 / `https://www.bilibili.com/`。
> 浏览器侧无残留：探测用的两个标签页已关闭，页面内未安装任何持久钩子。

---

## 🚦 H4 结论（第一行就要的答案）

> **浮层是普通 DOM，不是 Shadow DOM。**
> `openShadowHostsInsidePanel: []` + `closedShadowSuspectsInPanel: []`，两法交叉一致。
> **按钮可以插入。功能在 DOM 层面可行。**

---

## A. H1：历史入口在哪

**原始输出（`h1-find-entry.mjs`）**

```json
{"historyLinks":[{"href":"//www.bilibili.com/history","cls":"right-entry__item-trigger",
  "text":"历史","parentCls":"v-popover-wrap history-entry right-entry__item","shadow":false}],
 "headers":[{"cls":"bili-header bili-header--large","rect":{"x":0,"y":0,"w":1130,"h":255},"hasShadow":false},
            {"cls":"bili-header__menu is-zh bili-header__bar","rect":{"x":0,"y":0,"w":1130,"h":64},"hasShadow":false}],
 "openShadowHosts":[{"tag":"BROWSER-SKILL-OVERLAY","isBskOverlay":true}],
 "openShadowHostCount":1,
 "customElements":["browser-skill-overlay"]}
```

**结论**

| 项 | 值 |
| --- | --- |
| 入口选择器 | **`.v-popover-wrap.history-entry`**（外层）/ `.right-entry__item-trigger`（可点击的 `<a>`） |
| 位置 | `x=998, y=21, w=25, h=22`（右上角，顶栏 `bili-header__bar` 内，高 64px） |
| href | `//www.bilibili.com/history` |
| 顶栏有没有 shadow | **没有**（`bili-header` / `bili-header__bar` 都是 `hasShadow:false`） |
| 全页 open shadow host | **只有 bsk 自己的 `browser-skill-overlay`**（已排除） |
| 自定义元素 | **只有 `browser-skill-overlay`** → **页面没有用 web component** |

---

## B. H4：浮层是不是 Shadow DOM（生死线，两法交叉）

### B.1 探测方法（纪律：不许只凭 `shadowRoot===null` 判"没有 shadow"）

| 方法 | 做什么 |
| --- | --- |
| **法 1（找 open）** | `document.querySelectorAll('*')` 遍历，收 `el.shadowRoot !== null` 的 |
| **法 2（排 closed）** | 排除 void 元素（`img/br/hr/input…`）与 bsk overlay 后，找「`shadowRoot===null` **且** `childNodes.length===0` **且** 有渲染尺寸 **且** `display/visibility` 可见」的容器 —— closed shadow host 必然满足这一组特征（外部看不见其内容） |

> ⚠️ 第一轮我把 `img` 也算进了"疑似 closed host"（`closedShadowSuspects` 里全是 `img`），那是**假阳性** —— `img` 本来就没有子节点。第二轮加了 void 元素排除后重跑，见 B.3。

### B.2 法 1 结果（浮层已展开时）

**原始输出（`h4-hover-shadow.mjs`）**

```json
{"entrySelector":".v-popover-wrap.history-entry",
 "beforeHover":{"children":1,"childCls":["right-entry__item-trigger"]},
 "triggerRect":{"x":998,"y":21,"w":25,"h":22},
 "openShadowHosts":[{"tag":"browser-skill-overlay","isBskOverlay":true}],
 "openShadowHostCountExcludingBsk":0,
 "entryChildrenAfterHover":["right-entry__item-trigger","v-popover is-bottom"],
 "candidates":[
   {"how":"entry-child","tag":"div","cls":"v-popover is-bottom","childCount":1,
    "innerHTMLLen":84825,"rect":{"x":775,"y":43,"w":372,"h":557},"position":"absolute","shadow":false},
   {"cls":"v-popover-content","rect":{"w":372,"h":542},"position":"relative","shadow":false},
   {"cls":"history-panel-popover","childCount":2,"rect":{"w":370,"h":540},"position":"static","shadow":false},
   {"cls":"header-tabs-panel","childCount":3,"rect":{"w":370,"h":56},"shadow":false},
   {"cls":"header-tabs-panel__content","childCount":4,"rect":{"w":370,"h":480},"shadow":false}],
 "hoveredSuccessfully":true}
```

**关键读数**：`openShadowHostCountExcludingBsk: 0` —— **页面里除了 bsk 自己的 overlay，一个 open shadow host 都没有。**

### B.3 法 2 结果（排除 void 元素后）

**原始输出（`h4b-closed-exclusion.mjs`，浮层内容区）**

```json
{"openShadowHostsExcludingBsk":[],
 "closedShadowSuspectsAfterVoidExclusion":[
   {"tag":"div","cls":"taper-line","w":1130,"h":100},
   {"tag":"div","cls":"carousel-footer-mask","w":495,"h":790},
   {"tag":"div","cls":"v-inline-player","w":237,"h":134},
   {"tag":"div","cls":"layer","w":212,"h":221}],
 "popover":{"cls":"v-popover is-bottom","childCount":1,"childCls":["v-popover-content"],
            "innerHTMLLen":867,"innerOpenShadowHosts":0,"renderedDescendants":0}}
```

> ⚠️ 这一轮 `innerHTMLLen` 从 84825 掉到 867、`renderedDescendants: 0` —— 说明**浮层内容已被卸载**（上一轮的 hover 状态没有维持）。所以这一轮的 `closedShadowSuspects` 是**在浮层关闭状态下**扫全页的，命中的 `taper-line` / `carousel-footer-mask` / `v-inline-player` / `layer` 都是**首页自己的装饰/占位元素**（无子节点但有尺寸的遮罩层），不是 shadow host。
> **必须重测一次"浮层打开时"的 closed 排查** → 见 B.4。

### B.4 决定性的第三轮（浮层**确实打开**时）

**原始输出（`h4c-panel-structure.mjs`）**

```json
{"panel":{"cls":"history-panel-popover","childCount":2,
          "childCls":["header-tabs-panel","header-tabs-panel__content"],
          "innerHTMLLen":84728,"renderedDescendantCount":369,
          "rect":{"x":776,"y":59,"w":370,"h":540}},
 "openShadowHostsInsidePanel":[],
 "closedShadowSuspectsInPanel":[],
 "historyItems":[{"tag":"A","href":"//www.bilibili.com/video/BV1beNcz2ECq/?",
   "cls":"header-history-card header-history-video","parentCls":"",
   "grandParentCls":"header-tabs-panel__content"}, …],
 "historyItemCount":17,
 "listContainers":["header-tabs-panel__content"],
 "viewAllLinks":[{"tag":"a","cls":"view-all-history-btn","text":"查看全部",
                  "href":"//www.bilibili.com/history"}],
 "tabs":[{"text":"视频","cls":"header-tabs-panel__item--active header-tabs-panel__item"},
         {"text":"直播"},{"text":"专栏"}]}
```

**决定性读数**：

| 判据 | 值 | 含义 |
| --- | --- | --- |
| `innerHTMLLen` | **84728** | 浮层内容真实存在于**普通 DOM**（85KB 的 innerHTML 能读到 = 不是 shadow 内部） |
| `renderedDescendantCount` | **369** | 浮层内有 369 个真正的渲染后代 |
| `openShadowHostsInsidePanel` | **`[]`** | 浮层内**没有** open shadow host |
| `closedShadowSuspectsInPanel` | **`[]`** | 排除 void 后，浮层内**没有**任何"空壳但占位"的候选容器 |

### B.5 H4 最终结论

> **浮层 = 普通 DOM，不是 shadow DOM（既不是 open 也不是 closed）。**
>
> **决定性证据**：浮层内容区 `history-panel-popover` 的 `innerHTML` 长度 84728，且能从外部读到 369 个渲染后代与 17 个历史条目 —— **如果它在 closed shadow 里，外部 `innerHTML` 只会是一个空壳**。
>
> **按钮可以正常插入。DOM 层面无障碍。**

---

## C. H2：浮层结构（为后续注入用）

| 项 | 值（实测） |
| --- | --- |
| 浮层根 | `.v-popover-wrap.history-entry > .v-popover.is-bottom`（`position: absolute`），尺寸 **372×557**，位置 `x=775, y=43` |
| 内容层 | `.v-popover-content`（`position: relative`，372×542） |
| 面板主体 | **`.history-panel-popover`**（370×540） |
| 顶部分区 tab | `.header-tabs-panel` → `.header-tabs-panel__item` × 3：**视频 / 直播 / 专栏**（第一个 `--active`） |
| 列表容器 | **`.header-tabs-panel__content`** |
| 日期分组标题 | `.header-tabs-panel__content--date`（`<p>`） |
| **单个历史条目** | **`<a class="header-history-card header-history-video" href="//www.bilibili.com/video/BV1beNcz2ECq/?">`**，父节点 `header-tabs-panel__content` |
| BV 号位置 | **条目自身的 `href`** 里（`/video/BV…/`） |
| 条目数量 | **17** |
| 「查看全部」 | **`.view-all-history-btn`**，文本「查看全部」，`href=//www.bilibili.com/history` |

> ⚠️ 注：`.v-popover.is-bottom` 是**常驻壳**（浮层关闭后仍在 DOM 里，只是内容被清空）。真正判断"浮层是否打开"的判据是 **`.history-panel-popover` 是否存在 / 其内是否有条目**，不是 `.v-popover` 在不在。

---

## D. H3：hover 打开还是 click 打开 + 关闭时机

**原始输出（`h3h6-open-trigger-net.mjs`）**

```json
{"initialOpen":true,"afterMoveAway":true,"afterMouseenterOnly":true,
 "h3_verdict_hover_opens":true,
 "closeDelayMs":null,"closeMode":"not-auto-closed-within-4s",
 "panelOpenedForNet":true,"h6_requestCount":0,"h6_renderedItemsOnFirstOpen":17}
```

**结论**

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| hover 能打开吗 | **能** | 只发 `mouseenter`（**没有 click**）→ 浮层展开 |
| 是 click 打开吗 | **不是必需**（hover 即可） | 全程未 click |
| 移出后多久关闭 | **4 秒内未自动关闭** | `closeDelayMs: null` |

> ⚠️ **这一轮的 `initialOpen:true` 说明状态是脏的**（上一轮探测留下的浮层一直开着），所以本轮的"关闭时机"与"hover 打开"**可能受持久打开态干扰**。
> **不受干扰的决定性证据是 D 段的复测（干净页面）** —— 见 §E：干净页面上**只发 hover、0 请求、无浮层 → hover 后出现 17 条**，同样证明 hover 能开。
> **关闭时机这一项我判定为「未完全测清」**：真实鼠标的 `mouseleave` 行为与 `dispatchEvent` 模拟不同（真实移出会触发 `mouseleave`/`mouseout` 且 Vue 的 `v-popover` 常带 ~100ms 延迟关闭）。**若要精确测关闭延迟，需用 `bsk` 的真实鼠标移动（`mouse move` 命令）而不是 `dispatchEvent`。**

---

## E. H6：首次打开时有没有网络请求 —— **决定性发现**

### E.1 干净页面的复测（关键）

上一轮的 `initialOpen:true` 让数据不可信，所以**新开标签页**、**浮层从未打开过**，再 hover：

**原始输出（`h6b-clean-page-net.mjs`）**

```json
{"step0_neverOpened":{"panelExists":false,"itemCountInPanel":0},
 "firstHover":{"opened":true,"itemCount":17,"requestCount":3,
   "requests":[
     {"m":"GET","host":"api.bilibili.com","path":"/x/web-interface/history/cursor"},
     {"m":"post","host":"data.bilibili.com","path":"/v2/log/web"},
     {"m":"POST","host":"cm.bilibili.com","path":"/cm/api/fees/pc"}],
   "historyRequests":[
     {"m":"GET","host":"api.bilibili.com","path":"/x/web-interface/history/cursor"}]}}
```

### E.2 结论

> **浮层首次打开会发 `GET https://api.bilibili.com/x/web-interface/history/cursor`。**
>
> **数据不是预取的，是打开时才拉的。** `step0_neverOpened.panelExists: false` + `itemCountInPanel: 0` → hover 后出现 17 条 + 1 条 `history/cursor` 请求。

**这条对"历史切换按钮"的意义（事实，不是方案）**：

- 换身份 = 让**这条请求**带另一个 Cookie。
- 这条请求是**页面自己发的**（B 站 Vue 组件里的 `fetch`/`XHR`），host 是 `api.bilibili.com`，path 是 `/x/web-interface/history/cursor`。
- 它**不在**现有 DNR 白名单里（`src/shared/constants/routes.ts:101-157` 只有 playurl）。
- 我上一轮报告里说的"background 直连不存在"，本轮**已被本条数据间接印证**：数据必然来自页面这个请求，而页面请求的 Cookie 只能靠 DNR 在**网络层**改。

---

## F. H5：历史详情页

### F.1 是独立页面还是 SPA 路由 —— **独立页面**

**方法**：先在首页 `window.__HIST_MARKER__ = 12345`，导航到 `/history` 后再读。

**原始输出（`h5-detail-page.mjs`，导航后）**

```json
{"href":"https://www.bilibili.com/history","title":"历史记录",
 "hasOldMarker":false,
 "videoAnchorCount":32,
 "listContainers":["win","history-record","main-content","history-list",
   "timeline history-timeline","timeline-item history-timeline-item",
   "timeline-item__content history-section","section-cards grid-mode"],
 "pagination":["v-popover-wrap left-entry__item home-page-panel-entry"],
 "scroll":{"docHeight":3082,"viewportHeight":1081,"bodyHeight":3082}}
```

> **`hasOldMarker: false`** → 导航后 marker 消失 = **页面整体重载，是独立页面**（不是 SPA 路由）。`title` 也从首页标题变成「历史记录」。

### F.2 列表结构

**原始输出（`h5b-detail-structure.mjs`）**

```json
{"listCls":"history-list",
 "directChildren":[{"tag":"div","cls":"timeline history-timeline"},
                   {"tag":"div","cls":"the-tail-block"},
                   {"tag":"div","cls":"fixed-label-con"}],
 "groupCount":3,
 "groupHeadings":[{"cls":"timeline-item__content history-section","heading":"最强版本【4K+8K 120FPS HD"},
                  {"cls":"timeline-item__content history-section","heading":"魔女之旅"},
                  {"cls":"timeline-item__content history-section","heading":""}],
 "itemCount":18,
 "sampleItem":{"cls":"bili-video-card video-card",
   "innerCls":["bili-video-card__wrap","bili-video-card__cover",
               "bili-cover-card bili-cover-card--frozen","bili-cover-card__thumbnail",
               "bili-cover-card__tags","bili-cover-card__tag fav-tag",
               "bili-cover-card__stats","bili-cover-card__stat","bili-cover-card__progress"],
   "hasDeleteBtn":true},
 "infiniteScroll":{"beforeCount":18,"afterCount":39,"beforeHeight":3082,"afterHeight":4957,"grew":true},
 "hasPaginationControl":[]}
```

| 项 | 值 |
| --- | --- |
| 列表容器 | **`.history-list`** |
| 结构 | `.history-list > .timeline.history-timeline`（时间轴），分组是 `.history-section` |
| 分组数（首屏） | 3 |
| 条目 | `.bili-video-card.video-card`（内含 `bili-video-card__wrap` / `__cover` / `bili-cover-card__progress`） |
| **分页/滚动** | **无限滚动**，无分页控件：滚到底后条目 **18 → 39**、页高 **3082 → 4957**（`grew: true`，`hasPaginationControl: []`） |
| 删除按钮 | 条目内**有**（`hasDeleteBtn: true`）—— ⚠️ 全程**未点击** |

### F.3 详情页打哪些接口

**原始输出（`h6c-detail-endpoints.mjs`，`performance.getEntriesByType('resource')`）**

```json
{"totalResourceEntries":66,
 "historyEndpoints":[
   {"host":"api.bilibili.com","path":"/x/web-interface/history/cursor"},
   {"host":"api.bilibili.com","path":"/x/v2/history/shadow"}],
 "apiBilibiliEndpoints":[
   {"path":"/x/web-interface/nav"},
   {"path":"/x/web-interface/wbi/search/default"},
   {"path":"/x/vip/ads/materials"},
   {"path":"/x/kv-frontend/namespace/data"},
   {"path":"/x/web-show/wbi/res/locs"},
   {"path":"/x/web-interface/history/cursor"},
   {"path":"/x/v2/history/shadow"},
   {"path":"/x/web-interface/dynamic/entrance"}]}
```

**结论**：详情页与浮层**打同一个接口** `api.bilibili.com/x/web-interface/history/cursor`（外加一条 `/x/v2/history/shadow`）。滚动加载会继续打它。

---

## G. 汇总（事实表，不含建议）

| # | 问题 | 答案 | 证据类型 |
| --- | --- | --- | --- |
| H4 | 浮层是否 shadow DOM | **否，普通 DOM**（既不是 open 也不是 closed） | 实测：`innerHTMLLen=84728` + 369 渲染后代 + 两个方向扫描均为空 |
| H1 | 容器选择器 | 壳 `.v-popover-wrap.history-entry > .v-popover.is-bottom`；面板 **`.history-panel-popover`**；列表 `.header-tabs-panel__content` | 实测 |
| H2 | 条目结构 | `<a class="header-history-card header-history-video" href="//www.bilibili.com/video/BV…/">`，17 条，含「全部/直播/专栏」三个 tab | 实测 |
| H3 | 打开方式 | **hover 可开**（未 click）；移出后 4 秒内未自动关（**关闭延迟未测清**，需真实鼠标事件） | 实测（部分） |
| H5 | 详情页 | **独立页面**（marker 消失）；`.history-list` + `.timeline`；**无限滚动**（18→39），无分页控件 | 实测 |
| H6 | 首次打开有请求吗 | **有**：`GET api.bilibili.com/x/web-interface/history/cursor`。数据是打开时才拉的，**不是预取** | 实测（干净页面） |

---

## 附：复现方式与约束

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;C:\Users\i1290\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:PATH
bsk daemon start --foreground            # 后台任务里起
bsk session start --no-focus --json      # → session_id
bsk navigate --session <sid> "https://www.bilibili.com/"

node poc/probe/history-entry/h1-find-entry.mjs            # H1
node poc/probe/history-entry/h4-hover-shadow.mjs          # H4 法1
node poc/probe/history-entry/h4b-closed-exclusion.mjs     # H4 法2
node poc/probe/history-entry/h4c-panel-structure.mjs      # H4 决定性 + H2
node poc/probe/history-entry/h3h6-open-trigger-net.mjs    # H3 + H6（受持久打开态干扰）
node poc/probe/history-entry/h6b-clean-page-net.mjs       # H6 干净页面（决定性）
node poc/probe/history-entry/h5-detail-page.mjs           # H5
node poc/probe/history-entry/h5b-detail-structure.mjs     # H5 结构 + 无限滚动
node poc/probe/history-entry/h6c-detail-endpoints.mjs     # 详情页接口
```

**脚本用法**：`BSK_SESSION=<sid> BSK_TAB=<tabId> node <脚本>`。
**⚠️ `bsk evaluate` 的表达式是位置参数**，不是 `--expr`；脚本里用 `spawnSync(..., {shell:false})` 传数组，避免 `!` / 引号被 shell 吃掉（`poc/probe/history-entry/h1-find-entry.mjs:18-26` 有记录）。

**只读保证**：
- 未点击任何视频卡片、未点击「删除」、未发任何写请求。
- 唯一"触发"的动作是 `dispatchEvent('mouseenter'/'mousemove')` 与 `window.scrollTo`，均不改变账号状态。
- 网络钩子只记录 `host` / `path` / `method`，**不记录响应体、不记录 cookie**。
- 探测标签页已全部关闭。

---

## 附：我明确"没测清"的项

| 项 | 为什么 | 怎么补 |
| --- | --- | --- |
| 浮层**关闭延迟**的精确值 | `dispatchEvent` 模拟的 hover 与真实鼠标的 `mouseleave` 行为不同；本轮还受"上一轮浮层一直开着"干扰 | 用 `bsk` 的真实鼠标移动命令（而不是 dispatchEvent）做移入/移出，量关闭耗时 |
| 浮层在各种视口宽度下是否换布局 | 只在 1130×1081 视口测过 | 换 2–3 个视口重测 |
| `/x/v2/history/shadow` 是什么 | 只看到它被请求，未看响应（受只读约束不读响应体） | 后续若需要，单独评估 |

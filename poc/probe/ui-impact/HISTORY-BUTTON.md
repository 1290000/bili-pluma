# 「历史浮层切换按钮」实现可行性判定

> 基线 `main` = `9d18154`。**只读，未改任何已跟踪文件。**
> 结论先行：**在"不改请求身份"的前提下，这个需求的第 2 条（点按钮 → 秒切换数据）是死路。** 理由与依据见 §D。

---

## 速览

| 判定 | 结果 |
| --- | --- |
| 仓库内有无 B 站历史浮层 DOM 结构知识 | **无**（仓库只有首页推荐流与视频页的选择器实测，历史浮层一处都没有）→ 需实测 |
| `www.bilibili.com` 首页是否已在 content `matches` 里 | **是**（两个入口都覆盖）→ **不需要新增入口**，这是好消息 |
| 自洽的方案 | **甲（按钮 + B站自己的列表）只能做"提示"不能做"切换"；乙（自绘列表）技术上可行但代价高；丙 不可能** |
| 「不破坏风格」能否机械判定 | **对方案乙不能**（要复刻 B 站 DOM，没有像素基线就无法验收）；对方案甲能（只有一个按钮，可用 computed style 比对） |

---

## A. B 站历史浮层的 DOM 结构 —— 仓库内**没有**，需实测

### A.1 仓库里能查到的全部 B 站页面结构知识（穷举）

| 文件 | 覆盖范围 | 与"历史浮层"的关系 |
| --- | --- | --- |
| `src/content/site-clean/home-selectors.ts:51-58` | `.feed2` / `.recommended-container_floor-aside` / `.floor-single-card` / `.recommended-swipe` | **首页推荐流**，与顶栏历史入口无关 |
| `src/content/site-clean/ad-selectors.ts:38-105` | 广告位选择器（`.feed-card`、`.ad-report`、`.gg-pic`…） | 无关 |
| `src/content/site-clean/ad-selectors.ts:86` | `.bili-header-m .nav-menu .nav-con .nav-item .text-red` | **唯一一条涉及顶栏的选择器，但它是"红字推广"，是旧版 `bili-header-m` 结构**；且只在广告判据里，**不含历史图标** |
| `src/content/main-world.js:1557-1599` | 播放器 toast：`.bpx-player-toast-item` + `[class*="PromptBar"]` | 播放器内部，无关 |
| `poc/verify/e2e-dual.cjs:181` | `.header-entry-mini`、`.bili-avatar-img` | **顶栏头像区**，接近但**不是历史图标**；且这是 e2e 脚本里的探测，不是结构知识 |
| `poc/probe/api-inventory/RESULT.md:106-133` | 首页 HTML 里的推荐卡结构 `bili-video-card__info--tit`、`__INITIAL_STATE__` 不存在 | 首页内容区，不含顶栏浮层 |

**结论：仓库内没有任何一处记录了「B 站首页右上角历史图标」的类名、浮层容器、或浮层内列表的结构。** 唯一沾边的是 `.header-entry-mini` 与旧版 `.bili-header-m`，都不足以定位历史浮层。

### A.2 需要的实测（必须由 lead 派真机 / bsk 任务）

| # | 探测项 | 具体命令（只读） | 要拿到什么 |
| --- | --- | --- | --- |
| H1 | 顶栏历史入口的元素 | `bsk` 打开 `https://www.bilibili.com/` → `evaluate` 取 `document.querySelectorAll('[class*=header]')` 的 outerHTML 摘要 | 历史图标的选择器 + 它挂在哪个容器下 |
| H2 | 浮层是否"悬停即出现" | 对 H1 拿到的元素 `dispatchEvent(new MouseEvent('mouseenter'))` **或** `bsk` 的 hover，然后等 500ms | 浮层容器的选择器；**以及它是 hover 触发还是 click 触发**（用户说"悬停"，需证实） |
| H3 | 浮层内列表结构 | 浮层出现后 dump 其 `innerHTML`（截断 4KB）+ 列表项选择器 | 列表项类名、每项的字段结构、是否有"查看更多"入口 |
| H4 | 浮层是否 Shadow DOM | 检查浮层容器的 `shadowRoot` 是否非 null | **这条决定能不能注入**：closed shadow 无法从 content script 进入 |
| H5 | 浮层的 mount/unmount 时机 | 悬停进→出，观察节点是被 `remove()` 还是 `display:none` | 决定监听策略（见 §B.3） |
| H6 | 详情页 `/account/history` 的结构 | 打开该页，dump 列表容器选择器 + 分页/滚动加载方式 | 决定详情页注入点 |

> ⚠️ **H4 是本需求的第一道生死线**：若历史浮层是 B 站自绘的 **closed shadow DOM**，content script **无法**把按钮插进去（`mode:'closed'` 的 `shadowRoot` 对外部完全不可见）。这一条不测出来，后面所有方案都是空的。

---

## B. 与现有注入机制的复用面

### B.1 现有页内注入点（`matches` 全部列在这里）

| 入口 | `matches`（行号） | `runAt` | 职责 |
| --- | --- | --- | --- |
| `entrypoints/content.ts:1859` | `*://*.bilibili.com/video/*`、`*://*.bilibili.com/bangumi/play/*` | `document_start`（`:1863`） | 取流 + 角标 |
| `entrypoints/main-hook.content.ts:51` | 同上 | — | 主世界 hook |
| **`entrypoints/content-home.content.ts:81`** | **`*://www.bilibili.com/*`** | `document_start`（`:87`） | 视觉清理（广告 + 首页净化） |
| **`entrypoints/content-panel.content.ts:104`** | **`*://www.bilibili.com/*`、`*://live.bilibili.com/*`** | `document_idle`（`:107`） | 侧栏面板 |
| `entrypoints/content-live.content.ts:27` | `*://live.bilibili.com/*` | — | 直播页水印 |

### B.2 关键答案：**首页已在 matches 里，不需要新增入口**

这是本任务最重要的好消息。`www.bilibili.com/*` 已被**两个**入口覆盖（`content-home` 与 `content-panel`），且都不限播放页。

**但有一个硬约束必须先说清**（`AGENTS.md` §4.3 + `scripts/check-page-gate.mjs`）：

| 入口 | 边界（文件头明文） | 加"历史按钮"是否越界 |
| --- | --- | --- |
| `content-home.content.ts:1-27` | 「本入口只管『改页面长什么样』，**绝不**做取流相关的事：不读 cookie、不发请求、不改响应」+ 硬约束「**新增作用面必须先改 ADR**」（`:22-26`） | ⚠️ **越界**：历史按钮要**发消息取另一个账号的历史**（发请求）→ 违反"不发请求"，且属"新增作用面" |
| `content-panel.content.ts:22-26` | 「本入口只负责『画壳』，不做取流」+ 「**不碰** `parsePlayPage()`、**不发消息**、不读 cookie」 | ⚠️ **越界**：要把按钮插到**页面自己的浮层**里，不是画自己的壳 |

**所以：虽然 `matches` 不用改，但两个现有入口的职责边界都不允许它发展成"往页面浮层里插按钮并发消息"。** 这是 ADR 层面的判断，需要用户裁决扩展哪个入口的边界，或新开第三个 `www` 入口。**代码层面 `matches` 白得，ADR 层面不免。**

### B.3 动态浮层注入有没有先例 —— **有，而且很直接**

| 先例 | 位置 | 复用价值 |
| --- | --- | --- |
| **`PGC_TOAST_ITEM` 的动态隐藏** | `src/content/main-world.js:1596-1651` | **最接近的模板**：`MutationObserver` 观察 `document.documentElement` + `{childList:true, subtree:true}`（`:1641`），每次变动重新扫描并按需处理，用**内联样式**而不是 `<style>`（`:1608-1611` 已记录"注入 `<style>` 会误伤同层"） |
| **广告清理的 MutationObserver** | `src/content/site-clean/ads.ts:144-152`、`:217-221` | 同样是 subtree 观察 + 防抖 |
| **首页净化观察器** | `src/content/site-clean/home-clean.ts:110-124` | 同上 |
| **播放器重建追踪** | `src/content/isolated/badge.ts:313`（注释） | 记录了"同一元素反复重建"的坑 |

**所以"动态挂载/销毁"这件事项目已有成熟套路**：`MutationObserver(document.documentElement, {childList, subtree})` + 幂等判据（避免重复插入）+ 内联样式。**这一环不是难点。**

**真正的难点是浮层所有权**：按钮要插进**B 站自己的节点里**，而 B 站会重建浮层 → 我们插的节点被销毁 → 必须每轮 MutationObserver 补插。`PGC_TOAST_ITEM` 的先例只**隐藏**节点（不改 B 站结构），**插入节点是更强的侵入**，没有先例。

---

## C. 「不破坏 B 站现有弹窗风格」的可判定标准

### C.1 项目有没有"抓 B 站实际样式"的先例 —— **没有**

| 查了哪里 | 结果 |
| --- | --- |
| `src/design/tokens.css:1-54` | 全部是**硬编码的 Pluma 自己的值**（`--pluma-accent: #378add` 等）。文件头（`:4-5`）明确写「用信息蓝而不是 B站粉」——**设计上是刻意与 B 站区分的**，不是仿 B 站 |
| `src/content/site-clean/*` | 只有选择器与 CSS 变量（`--pluma-ad-card`），**不读 B 站 computed style** |
| `src/content/main-world.js:1557-1595` | 记录了 B 站 toast 的**实测颜色**（`rgba(25,25,25,0.88)`），但**只作为注释依据**用于"藏节点"，没有拿来做样式复用 |

**结论：项目从未抓取过 B 站页面的实际样式值，`tokens.css` 是刻意与 B 站区分的。要求"不破坏 B 站现有弹窗风格"与项目现有设计取向**方向相反**。**

### C.2 有没有视觉验收先例 —— **有，但只是截图，没有像素比对**

| 先例 | 位置 | 能力 |
| --- | --- | --- |
| `poc/probe/popup-inspect.mjs:148-160` | 用 `bsk screenshot --json` 对 popup 截图 | **能截图，返回图，但没有像素比对逻辑** |
| `docs/guides/team-workflow.md:246` | 截图是 tester 的职责 | 人工看图 |
| `docs/guides/team-workflow.md:138` | 「`getComputedStyle` 读不到 —— 不报错。要看有没有留痕」 | 说明项目知道 computed style 是脆弱判据 |

**所以：有截图能力，但项目从未做过像素级比对；现有"视觉验收"是人工看图。**

### C.3 可执行的判定标准

**分两种情况，能判定的程度完全不同：**

#### 对方案甲（只加一个按钮，列表仍是 B 站的）—— **能机械判定**

```js
// 判据：我们的按钮与 B 站同类元素的关键样式**数值相等**
const theirs = document.querySelector('<B站浮层里同类按钮的选择器>');
const ours   = document.querySelector('#pluma-history-toggle');
const keys = ['fontFamily','fontSize','fontWeight','lineHeight','color',
              'backgroundColor','borderRadius','padding','height'];
const cs = (el) => getComputedStyle(el);
const diff = keys.filter(k => cs(theirs)[k] !== cs(ours)[k]);
// 通过条件：diff.length === 0
```

**这个判定是确定的、可自动化的、能进 verify 的**（作为一条 poc 脚本）。前提是 H1–H3 测出了"同类按钮"的选择器。

⚠️ 但要提醒：`AGENTS.md` §1.5 的教训是"能实测就不要推理"。**`getComputedStyle` 相等 ≠ 看起来一致**（阴影、伪元素、字体渲染、hover 态都不在里面）。**所以这个标准能证明"不低于/不高于"，不能证明"看起来一样"。**

#### 对方案乙（自绘列表）—— **不能机械判定，且我不认为能达成**

要复刻 B 站历史列表的 DOM，需复刻：列表项结构、缩略图容器、标题/时间/UP 主三级排版、hover 态（B 站会显示"删除"按钮）、分组头（今天/昨天/更早）、滚动条样式、骨架屏。
**上面那个 9 个 key 的比对只能覆盖单个元素**，覆盖不了整体排版。**做像素比对需要一张"B 站原版历史浮层"的基线图** —— 而那张图**随 B 站改版会立刻过期**，且 `poc/` 里没有任何基线图机制。

**结论：方案乙的"不破坏风格"无法写成可执行判定，只能变成一句永久的主观标准。** 这本身就说明方案乙不该做。

---

## D. 「秒切换」在技术上意味着什么 —— **这是死路**

### D.1 问题：切换时数据从哪来

用户要的效果是「用网页账号的历史 ↔ 用扩展账号的历史」。**这两份数据分别存在 B 站服务器上，靠请求时的 Cookie 决定返回谁的历史**（`poc/probe/api-inventory/RESULT.md:640-653` 实测：`history/cursor` 随身份完全变，游客态返回 `-101`）。

所以要拿到"扩展账号的历史"，只有三条路：

### D.2 三条路的逐条判定

#### 路 ①：DNR 换 Cookie（项目现有唯一机制）—— **不可用**

| 判据 | 内容 |
| --- | --- |
| `history/cursor` 在不在 DNR 白名单 | **不在**。`routes.ts:101-157` 的 `PROXY_ROUTES` 只有 playurl 三条 + 两条禁用的 PGC + 两条禁用的直播，**没有 `history/cursor`** |
| 要加进去需要什么 | `routes.ts:101-157` 加一项 + `ROUTES_REVISION` +1（`:66` 规则）+ **ADR**（`AGENTS.md` §5.5「加路径 = 扩大越权，先改 ADR 再改代码」）+ `check-patch-scope.mjs` 对账 |
| ⚠️ **致命点** | DNR 的规则是**常驻 session 规则、按路径白名单全局生效**（`dnr.ts:150-167` 的 `enableProxy`）。加一条 `history/cursor` 意味着**任何页面、任何时候**这条请求都会带播放账号 Cookie —— 而不是"只在点按钮时"。要"秒切换"就得**动态 add/remove 规则**，而那正是 `AGENTS.md` §5.4 明文禁止的：「不要每请求 add/remove，也不要规则 ID 池」（ADR 0006） |
| 结论 | **路 ① 与 ADR 0006 直接冲突**，不是工程量问题 |

#### 路 ②：background 用 vault 凭据自己发请求 —— **技术上行不通，且越权**

用户/lead 猜想："`nav` 探活已经在这么做了"。**这是误读，必须纠正。**

| 判据 | 内容 |
| --- | --- |
| `nav.ts` 到底怎么发的 | `src/platform/http/nav.ts:43-54`：`fetch(NAV_URL, { credentials: 'include' })` —— **让浏览器带上当前分区的 cookie**，**不是**用 vault 凭据拼 Cookie 头 |
| 为什么不拼 Cookie 头 | `nav.ts:4-17` 原文：「`Cookie` 是 **forbidden request header**——脚本设置它会被浏览器静默丢弃（Web 平台硬限制，和 MV3 无关）。结果请求以'未登录'身份发出，返回 `-101`」 |
| 那 background 能拿到播放账号的历史吗 | **不能**。`credentials:'include'` 带的是**当前分区**的登录态；播放账号的 cookie 只在**扫码时的无痕分区**，窗口一关就销毁（`account.handler.ts:192-201` 原文记录了这个事实） |
| 唯一"能用 vault 凭据发请求"的地方 | **DNR 的网络层**（`dnr.ts`）。浏览器网络层替换 Cookie 头不受 forbidden header 限制 —— 这就是本项目**为什么必须用 DNR** 的原因 |
| 结论 | **路 ② 不存在**。background 无法以播放账号身份直接发 HTTP 请求。`nav` 能"探活"只是因为它在无痕分区里跑，且那只是**核对 mid**，不是取数据 |

> 这条纠正很重要：**"background 直连 `history/cursor`"不是一个"更简单"的方案，它是一个不存在的方案。** 阻止它的是浏览器平台限制，不是项目决策。

#### 路 ③：主世界 hook 改请求 —— **架构红线**

| 判据 | 内容 |
| --- | --- |
| 主世界能拿凭据吗 | **不能**。`messages.ts:277-281` 原文：「`AGENTS.md §5.2`：任何 `*:ok` 消息都不得携带凭据……**绝不带 SESSDATA / bili_jct / 完整 Cookie**」。主世界跑在页面 JS 上下文，把凭据交给它 = **交给 B站自己的页面脚本** |
| `api-inventory/RESULT.md:584` | 「把 `bili_jct` 交给主世界 = **把播放账号凭据泄露给 B站页面**」 |
| 结论 | **路 ③ 是架构红线，不可绕** |

### D.3 所以：三个方案哪些自洽

| 方案 | 能否切换数据 | 自洽性 |
| --- | --- | --- |
| **甲**：只加按钮，列表仍由 B 站渲染 | ❌ **不能**。B 站浮层里的列表是 B 站自己发 `history/cursor` 渲染的，我们改不了它的 Cookie（路 ①禁止、路 ②不存在），也就改不了它的数据 | ⚠️ **只能做"提示"不能做"切换"**：按钮可以存在，但点了只能提示"当前列表是你网页账号的历史"，**做不到切换** |
| **乙**：按钮 + 扩展自绘列表 | ✅ 能 —— **但只能显示"网页账号"的历史**，除非走路 ①，而路 ① 被 ADR 0006 禁 | ⚠️ **能显示，不能切换**：因为拿不到扩展账号的数据。**除非**允许动态 add/remove DNR 规则（改 ADR 0006） |
| **丙**：按钮触发 B 站自己重新请求 | ❌ **不可能**。我们无法改变 B 站请求带的 Cookie（同路 ①②③ 全断） | ❌ 死路 |

### D.4 死路的准确表述

> **"点按钮秒切换成扩展账号的历史"需要让某条 `history/cursor` 请求以扩展账号身份发出。三条可能的实现路径全部被现有架构/平台限制封死：DNR 动态规则被 ADR 0006 禁止、background 直连受 forbidden header 限制而做不到、主世界改请求违反凭据红线。**
>
> **因此：在"不改请求身份"（用户已裁决）+"不放开 DNR 动态规则"（ADR 0006）两个前提下，这个功能的数据部分做不出来。**

**唯一能自洽的退化形态**（供 lead 判断是否值得做）：

| 退化形态 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| **甲-退化**：按钮只是一个"说明入口" | 点一下显示"这个列表是你当前登录账号的历史；扩展账号的历史请在无痕窗口查看" | 切换数据 |
| **乙-退化**：扩展在**自己的侧栏面板**里显示扩展账号的历史 | 需要路 ①（DNR 加 `history/cursor`）→ **必须改 ADR 0006** | 做不到"在 B 站浮层里" |

---

## E. 详情页 `/account/history` 同理

| 维度 | 与浮层的差别 |
| --- | --- |
| 页面性质 | **独立页面**，不是悬停浮层 → 无需 hover 监听，注入简单得多 |
| 分页/滚动加载 | 大概率是无限滚动或分页 → `MutationObserver` 套路同 §B.3；但**每次加载都是一次新请求**，而请求的 Cookie 同样改不了（§D 结论完全相同） |
| 数据来源 | 与浮层**同一个接口** `history/cursor` → **§D 的判定原样适用** |
| 结论 | **详情页与浮层的技术死结是同一个**（都卡在"改不了请求 Cookie"）。详情页不会因为"是独立页面"而变得可行 |

**额外一条**：详情页有"删除历史"按钮。若我们在那个页面注入按钮，用户可能误以为扩展能操作数据 —— 而 D2/D3 已裁决不碰写入，**这会造成"按钮暗示了不存在的能力"**。

---

## F. 结论与建议（不是决策）

1. **第 1 条（浮层加按钮）**：技术可行，但**只能做"说明"不能做"切换"**；且需先实测 H1–H6（尤其 **H4 是否 closed shadow**）。
2. **第 2 条（秒切换）**：**死路**。三条实现路径全部封死，其中一条（background 直连）是**平台限制导致的不存在**，不是工程量问题。**lead 上一封信里"background 直连比 DNR 更简单更不越权"的假设，需要按 `nav.ts:4-17` 的原文推翻。**
3. **第 3 条（详情页）**：与第 2 条同一个死结，不会因为"独立页面"而不同。
4. **第 4 条（面板开关控制按钮显隐）**：简单，复用 `readPanelEntryEnabled()` 同款模式（`ui-prefs-store.ts`），但**它控制的是一个做不到的功能**。
5. **「不破坏风格」**：方案甲能机械判定（9 个 computed style key 等值），方案乙不能（需像素基线，项目无此机制且基线会随改版过期）。

### 若要往前走，必须先回答的一个问题

> **是否允许为 `history/cursor` 开一条"按标签页限定、点按钮时才装、离开就卸"的 DNR 规则？**
>
> 这会**修改 ADR 0006 的"不要每请求 add/remove"**，且新增一条白名单路径（扩大越权面，`AGENTS.md` §5.5 要求先改 ADR）。**它是这个需求唯一的活路，但它本身是一个架构决策，不是实现细节。** 在用户回答这个问题之前，这个功能无法开工。

---

## 附：本轮明确"不知道"的项

| 项 | 为什么不知道 | 怎么补 |
| --- | --- | --- |
| 历史浮层的 DOM 结构 | 仓库无记录，只在仓库内读码无法得知 | §A.2 的 H1–H6 实测 |
| 浮层是否 closed shadow DOM | 同上，**但这条决定功能能否注入** | H4 |
| `/account/history` 的分页方式 | 同上 | H6 |
| B 站浮层"同类按钮"的选择器 | 同上（方案甲判定标准的前提） | H1–H3 |
| 历史列表的字段结构（用于方案乙自绘） | 仓库里有 `history/cursor` 的**响应结构**线索（`api-inventory/RESULT.md:640-653`），但没有渲染结构 | H3 |

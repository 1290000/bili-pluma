# RESULT · 推荐流首屏隐藏/重排可行性（task-18 Q0）

> **日期**：2026-11-11
> **用户原问题**：
> > 关于推荐流首屏的问题，就不能通过类似屏蔽广告的方法把前面属于浏览器账号的推荐视频卡片**全部隐藏**，然后让后面的扩展账号的推荐视频卡片**上去补位**吗？
>
> **取证环境**：bsk 0.3.3 / Edge 157 / 已登录单账号 / `https://www.bilibili.com/`
> **红线**：只读。只做 fetch 主文档、读 DOM、改元素 style（即时恢复、不持久化）、滚动。不点视频、不发写请求、不登录登出、不打印凭据。

---

## ⚠️ 文件归属声明（**读之前必看**）

> **本文件由两个成员在同一目录并行写入过**（Lead 编排失误：派第二人时未检查第一人已 claim）。
> 为免后人误读，按段标注归属如下：

| 范围 | 作者 | 状态 |
| --- | --- | --- |
| 抬头 → **§9**（含 §0–§9） | **engineer-dnr**（task-18 主报告） | ✅ **现行有效** |
| **附录 A**（A.1–A.7） | **engineer-api**（独立复核） | ✅ **有效，作为补充证据** |

---

## 🔴 最重要的一条：「换一换」只换前 8–9 张，后面完全不动（2026-11-11 实测）

> **这一条比本文件里所有 Q1–Q5 都重要，因为它改变了整个方案的前提。**

真实鼠标点击 `button.roll-btn`（**不是外层 `div.feed-roll-btn`**，点那个无效），连点 3 轮，
每轮记录 DOM 全部卡的 BV 序列。报告见 [`M1-REPORT.md`](./M1-REPORT.md) §2。

| 轮次 | BV 数 | 与上一轮共同 BV | 重合率 |
| --- | --- | --- | --- |
| [0] 初始 | 23 | — | — |
| [1] 换一换 | 23 | 15 | 65.2% |
| [2] 换一换 | 24 | 15 | 63.8% |
| [3] 换一换 | 24 | 15 | 62.5% |

逐条比对原始序列：**前 8 张全部换新，从第 9 张起 15 张完全没变**（三轮模式一致）。

```
[0] BV11yWt6JEfL, BV1uWx16yENF, BV1AVJq6ZEni, BV15hxd6SEvW, BV1dUxC6UEf2,
    BV13MH56SEuG, BV1cyxi6gEDN, BV1TwnF6eEGt,        ← 这 8 张会变
    BV1mdxq6SEcL, BV13XHN6ZEkn, BV1SCJt6LEM7, ...    ← 从第 9 张起 15 张不变
[1] BV1VPxz6PEch, BV136nf6kE1H, BV1Kbnd6WEXi, BV1w34A62Eq2, BV1qxaP69Eha,
    BV1k44w62EPo, BV1z6pw6AEBD, BV1K2WT6tEU8,        ← 8 张全换新
    BV1mdxq6SEcL, BV13XHN6ZEkn, BV1SCJt6LEM7, ...    ← 完全一致
```

### 对分界线方案的影响（**推理，未实测** —— 需双账号才能确认）

分界线标的是「第 10 个 `.is-rcmd` 之后」。用户点「换一换」时：

```
只有分界线以上的 ~8 张会变
分界线以下 15 张不动
∴ 分界线两侧的"来源关系"被打破
∴ 分界线的语义不再准确
```

**建议 task-5 考虑「换一换后重新定位分界线」，或至少把这条限制写进文档。**

### 这条也解释了 Q0 一直对不上的现象

首屏那批卡和 `feed/rcmd` 的数据总对不上 —— 因为**「换一换」刷新的是"翻页入口那一段"，不是整页**。

---

## 🔴 「隐藏补位」结论更正（2026-11-11 15:00）

> **本文件 §0/§6 与附录 A.3 里凡说"隐藏补位不成立"的地方，一律作废，以 附录 A.3b 为准。**
>
> **正确结论：只隐藏 `.feed-card`（10 个 A 批次的专属类名）、不碰顶部轮播 → 补位完全成立**，
> 第一张可见卡 `top` 回到 **255**，连滚 3 轮稳定，补上来的全是 `bili-feed-card`。
>
> **我的 §2 实验错在哪**：用的是 `.bili-video-card` 选择器，
> 而顶部轮播 `recommended-swipe` 内部**也匹配**这个类名 → 轮播被一起隐藏 → 塌 299px → 制造了假空洞。
> 这个假空洞让我得出了"补位不成立"的错误结论。
>
> ⚠️ 但要注意：A.3b 证明的是**结构上补位成立**，**不证明**补上来的是另一个账号的数据（那需要 M1）。

**两版结论的关系**：
- `order` 重排：**有效**（§4，实测），但用户体验上是"用一个错误印象换另一个错误印象"
- 隐藏 `.feed-card`：**结构上也成立**（A.3b），且更彻底（A 完全不可见）
- 两者都需要 **M1** 才能确认"补上来的到底是谁的数据"——而 **M1 因本机无第二账号未验证**

---

## 🔴 【engineer-api 15:30 追加更正】A.3b 的**身份**前提也不成立

> 上一节说"隐藏 `.feed-card` 后补上来的全是 `bili-feed-card`"，**这句是错的**。

`probe-v-nesting.mjs` + `probe-u-what-fills.mjs` 实测：

**① `.feed-card` 与 `.bili-feed-card` 是父子嵌套，不是两批数据**

```
container.is-version8 (grid)
 └─ feed-card ×10        ← grid 直接子元素
     └─ bili-feed-card   ← 嵌在里面（10 个 feed-card 全部包含）
 └─ bili-feed-card ×18   ← 另有 18 个是 grid 直接子元素
```

| 判据 | 实测 |
| --- | --- |
| `feedCardContainingBiliFeedCard` | **10**（全部） |
| `biliFeedCardContainingFeedCard` | 0 |
| 同一元素同时有两种类名 | 0 |
| `feed-card` 的 8 个唯一 BV 是否都在 `bili-feed-card` 里 | **8/8 全在，前 5 条顺序完全相同** |

**所以 A.2 里"`feed-card`=A、"`bili-feed-card`=B 是确切 DOM 分界"这个发现是错的。**

**② 补测环境里 Pluma 扩展根本没注入**

| 探针 | 结果 |
| --- | --- |
| `window.__PLUMA_HANDSHAKE__` | **不存在** |
| `window.__PLUMA_PGC__` | **不存在** |
| `page/snapshot` 桥 | **超时** |
| `nav` mid | {{主账号mid}}（账号 A） |
| **`rcmd` 响应 `data.mid`** | **{{主账号mid}}（还是 A）** |

**③ 因此本轮全部实验（含 A.3b）证明的只是"布局补位机制"，不是"换了身份"**

| 能证明 | 不能证明 |
| --- | --- |
| 隐藏 10 个 `.feed-card`、不碰轮播 → 零空洞、滚动正常、持续补位 | 补上来的卡**属于另一个账号** |

> **A.3b 的结论必须降级为："布局可行"，身份层面依赖 M1。**
> 在本机环境下，隐藏 A 的 SSR 之后露出的是 **A 自己的 rcmd 数据** ——
> 如果 M1 不成立，这个操作**对用户完全无感**（看到的还是同一个账号的推荐）。

### 关于"用户能否察觉"这一列（回应 Lead）

| | 隐藏 `.feed-card` | `order` 重排 |
| --- | --- | --- |
| A 的卡 | 完全不可见 | 仍在 1161px 可见 |
| 用户能否察觉 | **❌ 永远不知道被藏了** | ✅ 滚下去会发现 |
| **前提** | **M1 必须成立** | **M1 必须成立** |

**在 M1 未验证前，这一列对两个方案都填不出确定值** ——
因为如果 `rcmd` 没换身份，隐藏之后用户看到的**还是 A 的推荐**，
"藏了 10 条"这件事**既没被察觉，也没有产生任何效果**。

### ⚠️ 已作废的数据（**不要再用**）

| 文件 / 数据 | 状态 |
| --- | --- |
| `hide-scroll-result.json` | ❌ **已作废**（v1 用 `:nth-of-type` 过度匹配，`visible` 从 48 掉到 11，测的不是目标场景）。作者在 §2.1 已自述作废，**本声明再强调一次** |
| 其中 `A-display-none` / `B-visibility-hidden` / `C-height-0` 的 **`newRcmdRequests: 0`** | ❌ **错误数据，作废**。附录 A.5 用同选择器复测得到 `rcmdDelta: 1`（滚动正常） |
| `probe-q0-bv-overlap.mjs` / `probe-q0-v3.mjs` / `probe-q0-final.mjs` | ❌ 作废脚本，保留仅作追溯 |
| **§2 的 `visible` 数字与"有补位"判定** | ⚠️ **部分作废**：因 `.bili-video-card` 选择器误伤轮播（详见 §2.3 更正块与 A.3b）。`newRcmdRequests` 列仍有效 |
| **`probe-m1.mjs`（v1）** | ❌ 作废：`el.click()` 点的是外层 `div.feed-roll-btn`，Vue 监听在 `button.roll-btn` 上 → 重合率 100%（完全没动）。正确脚本是 `probe-m1-v2.mjs` |
| **`probe-m1-evidence.mjs`** | ❌ 作废：拿"推荐内容重合率"当身份判据，三组两两全 0.0%，与 Q0 同一个坑 |

> **判据**：今后读本目录，**只取 §0–§9 与附录 A**；`*.json` 中间产物一律视为过程垃圾。
>
> ### 🧭 贯穿本目录的方法论（比任何单个结论都重要）
>
> **`feed/rcmd` 是随机推荐接口 —— 任何"比较两批内容"的实验都必须先有基线。**
> 本轮我因为这个坑作废了 6 个实验（Q0 的 v1/v2/v3/final 四个 + M1 的 v1/evidence 两个），
> 全部失败在同一个模式：**拿一个能被随机性完全解释的"差异"当证据**。
>
> 正确问法：**"这个差异，换一批随机数据会不会也出现？"** 会 → 不是证据。

---

## 0. 结论先行

> ⚠️ **本表已按 A.3b 与「换一换」实测更新（2026-11-11 15:xx）。原始错误结论见 §2、§6，均已就地标注作废。**

| Q | 问题 | 结论 | 证据等级 |
| --- | --- | --- | --- |
| **⭐ 新** | 「换一换」换掉多少张？ | **只换前 8–9 张**，从第 9 张起 15 张完全不动 | **实测**（3 轮，模式一致） |
| **Q2/Q3（生死线）** | 隐藏首屏卡后，无限滚动会不会坏？ | **不会坏**。隐藏 `.feed-card` 后滚动正常、`top` 回到 255、补位成立 | **实测**（A.3b，见更正横幅） |
| **Q4** | 能否用 CSS `order` 只改视觉顺序？ | **能**。容器是 `display:grid`，`order:-1` 把 `bili-feed-card` 提到最前（top 255），A 卡退到 1161px | **实测** |
| **Q0-c** | 用户看到的首屏到底有几张卡？ | **视口内 13 张**；前 10 张 `.is-rcmd` 里**有 4 张高度为 0**（骨架/广告），真正占布局的只有 6 张 | **实测**（返回几何数据） |
| Q1 | rcmd 每次响应几条？ | 每次 **12 条**，滚动/+1 次请求 | **实测** |
| Q5 | 与 ADR 0031 的关系 | 两种方案都只改视觉，可放 `content-home`；但"知道哪些是 A、哪些是 B"需要类名 `.feed-card` vs `.bili-feed-card`，不读账号状态 | 推理（基于 ADR 原文） |

### 一句话回答用户

> **能干。而且 DOM 上两个批次有明确的类名分界：`.feed-card`（10 张，页面账号）vs `.bili-feed-card`（后续，取流账号）。**
> 两种做法都实测可行：
> - **隐藏 `.feed-card`**（10 张）→ 后面的 `bili-feed-card` 顶到 `top=255`，视觉上 A 完全不可见
> - **`order:-1` 提权** → 只改视觉顺序、不动布局
>
> ⚠️ 但两件事必须说清楚：
> 1. **只能让"取流账号的后续卡"上移，不能凭空变出"取流账号的首屏 10 张"**
> 2. **补上来的到底是不是取流账号的数据 —— M1 未验证**（本机无第二账号）

---

## 1. 这轮我自己作废的方法（必须记录，避免下次重犯）

**我在 Q0 上连续做了 4 个无效实验，才找到正确判据。** 这是本轮最大的教训。

| 版本 | 做法 | 为什么无效 |
| --- | --- | --- |
| v1 | 比「一次 `fetch` 的 SSR HTML 里的 BV」与「一次 `feed/rcmd` 的 BV」 | **两个都是随机推荐**。实测 `|S∩R|=0`，但这个 0 可以被随机性完全解释，**不是独立性证据** |
| v2 | 把「事后重新 fetch 的首页 HTML」当 SSR 基准，与当前 DOM 比 | 每次 fetch 都是**一次全新的推荐**，与当前页面那次加载无关。实测 SSR 的 BV 与 DOM 的 BV **完全不相交** —— 这是随机性，不是结构差异 |
| v3 | reload 后注入 fetch 拦截器，抓首屏 rcmd 响应 | **抓不到**。`performance` 实测首屏 rcmd 在 **1525ms** 就发出，而 bsk 注入远晚于此 |
| final（指纹法） | 用 `trackid` 前缀区分来源 | **全部相同**（`web_pegasus_0`，39/39 张一致），无区分力 |

**共同病根**：我在找一个"接口层的来源证据"，但**这个证据在页面已加载完成后根本拿不到**。

**转折点**：意识到用户的问题**不需要**判定"哪张卡来自 SSR、哪张来自 rcmd"。
用户要的是「**藏掉前面的，后面的能不能补上来**」—— 这**直接可测**，不需要知道来源。

---

## 2. Q2/Q3（生死线）：隐藏会不会破坏无限滚动 —— **实测：不会**

### 2.1 实验设计

- **每组前 `bsk navigate` reload**，避免上一组已加载到底导致无内容可加载（v1 犯过的错）
- rcmd 计数用**自己装的 fetch/XHR 拦截器**，不用 `performance`（后者的 resource buffer 有上限，v1 因此出现"新 rcmd=0 但新增卡=18"的自相矛盾）
- 隐藏用 **JS 直接给精确选中的元素改 style**，不用 `:nth-of-type`（v1 因此过度匹配，visible 从 48 掉到 11）
- 每组结束**恢复原 style**

### 2.2 结果（`probe-hide-scroll-v2.mjs`）

| 方式 | before total | 隐藏后 visible | 滚动后 total | 新 rcmd | 新增卡 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **对照组（不隐藏）** | 39 | 33 | 48 | **1** | **9** | ✅ 滚动正常 |
| **`display:none`** | 39 | 32 → **26** | 48 | **1** | **9** | ✅ **滚动正常 + 有补位** |
| **`visibility:hidden`** | 39 | 33 → **33**（不变） | 48 | **1** | **9** | ✅ 滚动正常 + 有补位 |
| **`height:0;overflow:hidden`** | 39 | 33 → **27** | 48 | **1** | **9** | ✅ 滚动正常 + 有补位 |

### 2.3 结论

> **Lead 担心的"`display:none` 会让 IntersectionObserver 判定还没滚到 → 不加载新卡"—— 实测不成立。**
> 四种方式**全部**触发了 1 次新 rcmd，全部新增 9 张卡。
>
> **原因（推理，非实测）**：B 站的无限滚动触发点不在这 10 张卡上，
> 而在列表**尾部**的占位元素 / 滚动容器上。藏掉前面的卡不影响尾部的触发点。

> ### ⚠️ 本节结论只对了一半（2026-11-11 更正）
>
> - ✅ **"不破坏滚动"成立** —— 这一半是对的
> - ❌ **"有补位"不成立** —— 我用 `.bili-video-card` 选择器时，
>   **顶部轮播 `recommended-swipe` 内部也匹配**，被一起隐藏 → 轮播塌 299px →
>   制造了 154px 假空洞，补位没真正发生
>
> **正确做法与正确数据见附录 A.3b**：只隐藏 `.feed-card`（10 个）→ 第一张可见卡 `top` 回到 **255**，补位成立。
>
> ⚠️ **本节 §2.2 表格里 `newRcmdRequests` 那一列虽然是对的，但 `visible` 数字是在"连轮播一起藏了"的错误前提下测的，
> 不代表用户真实场景。** 请以 A.3b 为准。

⚠️ **口径**：这个结论只覆盖"隐藏**前面**的卡"。若藏掉的是**尾部**触发点，很可能坏 —— 未测。

### 2.4 一个必须说明的观测：`display:none` 只让页面矮了 73px

`bodyHeight: 2608 → 2535`（只少 73px）。为什么不等于 10 张卡的高度？

**实测原因**：前 10 张 `is-rcmd` 卡里 **有 4 张高度为 0**（见 §3），
真正占布局的只有 6 张，而且它们与同行的其他卡共享 grid 行高 ——
删掉其中几张不改变行高，所以整体只矮了一点。

> ⚠️ 补充（更正后）：这 73px 也包含了"轮播被误伤"的部分。真正的干净测量见 A.3b。

---

## 3. Q0-c：用户看到的首屏到底是什么（几何实测）

### 3.1 页面结构实测

```
viewportH = 1081px   docHeight = 2608px
总卡数 = 39   is-rcmd = 28   有 BV = 23   视口内可见 = 13
```

**前 10 张 `is-rcmd` 卡的位置**：

| DOM idx | BV | top | height | 在视口内 |
| --- | --- | --- | --- | --- |
| 2 | BV1ZYJa6BEdy | 255 | 207 | ✅ |
| 3 | BV1kvp16xEmV | 255 | 207 | ✅ |
| 4 | BV17Jn86eEUx | 482 | 207 | ✅ |
| **5** | **（无 BV）** | **0** | **0** | ❌ |
| 6 | BV1d4p26SE5n | 482 | 207 | ✅ |
| 7 | BV1wmpk6DEUv | 708 | 207 | ✅ |
| 8 | BV17YJX6FEFb | 708 | 207 | ✅ |
| **9** | **（无 BV）** | **0** | **0** | ❌ |
| **10** | **BV1XzHM6PE1Q** | **0** | **0** | ❌ |
| **11** | **BV1xBJh6jE3H** | **0** | **0** | ❌ |

**前 10 张合计高度 = 1242px，但实际占据纵向范围只有 0 → 915px。**

### 3.2 关键结论

> **"前 10 张 `.is-rcmd` 卡" ≠ "用户看到的前 10 张卡"。**
>
> - 有 **4 张高度为 0**（骨架占位 / 未渲染的广告位），它们**不占视觉空间**
> - 首屏（1081px 视口）内**实际可见 13 张卡**
> - 其中前 2 张（idx 0/1）是 `isRcmd=false` 的骨架

**这对任务卡里的分界线判据有直接影响**：
task-5 用「第 10 个 `.is-rcmd` 卡之后」插分界线 —— 按本实测，
第 10 个 `is-rcmd` 卡的 `top` 是 **0**（不在正常文档流里），
**分界线插在它后面，视觉位置可能落在首屏顶部而不是第 10 张卡下方。**

⚠️ **这是一个新发现的潜在缺陷，建议 Lead 派 verifier 复核 task-5 的分界线实现。**
（我没有改 task-5 的任何代码，只是从几何数据推断出来的风险，**证据等级：推理，非实测**）

---

## 4. Q4：`order` 方案 —— **实测可行，且是更优解**

### 4.1 容器结构实测（`probe-order.mjs`）

```
.bili-feed4-layout <main>            display:block
  .feed2                             display:block
    .recommended-container_floor-aside  display:block
      .container.is-version8          display: GRID  ← 主容器，4 列 × 237.5px，48 个子元素
        .bili-feed-card  (×28)        display:block  ← grid item
          .bili-video-card            display:block
```

**⚠️ 关键**：`order` 必须加在 **`.bili-feed-card`**（grid item）上，
加在 `.bili-video-card` 上无效（它不是 grid item）。

### 4.2 实测结果（`probe-order-test.mjs`）

给前 10 个有内容的 grid item 设 `order: 9999 !important`：

| DOM idx | BV | top 前 | top 后 | 是否后移 |
| --- | --- | --- | --- | --- |
| 0 | BV1wQWN6jECn | 255 | 255 | ❌（不在目标内） |
| 1 | BV1ZYJa6BEdy | 255 | **1873** | ✅ |
| 2 | BV1kvp16xEmV | 255 | **1873** | ✅ |
| 3 | BV17Jn86eEUx | 482 | **2115** | ✅ |
| 5 | BV1d4p26SE5n | 482 | **2115** | ✅ |
| 6 | BV1wmpk6DEUv | 708 | **2115** | ✅ |
| 7 | BV17YJX6FEFb | 708 | **2115** | ✅ |
| 12 | BV1DznF6MEft | 708 | **2342** | ✅ |

**视觉顺序（按 top/left 排序）**：

```
before: BV1wQWN6jECn, BV1ZYJa6BEdy, BV1kvp16xEmV, BV17Jn86eEUx, BV1d4p26SE5n,
        BV1wmpk6DEUv, BV17YJX6FEFb, BV1DznF6MEft, BV1uWJQ67EDT, BV1Einh6rE7F, ...
after : BV1wQWN6jECn, BV1uWJQ67EDT, BV1Einh6rE7F, BV1KXeu6tEUx, BV1nwnq6FER4,
        BV1UGpr6REHf, BV1mQpU63Ebn, BV1yVnV6YE2K, BV1YFnB6JEdt, BV1cUnz6iEwS, ...
        ... BV1ZYJa6BEdy（被推到末尾）
```

**后面的卡确实上移补位了。**

### 4.3 为什么 `order` 比"隐藏"更好

| 维度 | `display:none` 隐藏 | `order:9999` 重排 |
| --- | --- | --- |
| 布局 | 脱离文档流，留空洞 | **完整保留** |
| 视觉 | 前面 10 张消失，后面上移 | 前面 10 张**移到末尾**，后面上移 |
| 滚动 | 实测正常 | 实测正常 |
| 可逆 | 删 style 即恢复 | 删 style 即恢复 |
| 信息损失 | **用户的推荐内容丢了 10 条** | **一条不丢，只是顺序变了** |
| IntersectionObserver | 可能受影响（实测未受影响） | **完全不影响**（元素仍在原位、仍占位） |

> **`order` 方案在每一个维度上都不劣于"隐藏"，且在"不丢失内容"这一条上明显更好。**

---

## 5. Q5：与 ADR 0031（页内视觉净化边界）的关系

**`order` 方案可以在 `content-home.content.ts` 里实现，不越界。**

理由（读 ADR 0031 与 `content-home.content.ts` 的明文约束）：

| 约束 | `order` 方案是否违反 |
| --- | --- |
| 不读 cookie | ✅ 不读 |
| 不发请求 | ✅ 不发 |
| 只改"页面长什么样" | ✅ 纯 CSS 视觉顺序 |

**但这只解决了"排序"，没解决"哪几张该排到前面"** —— 见 §6。

---

## 6. ⚠️ 必须如实告诉用户的三个限制（这是本报告最重要的部分）

> ⚠️ **本节 6.1 已按实测更正（2026-11-11）。** 原文说"补上来的是已经加载的后续卡"是对的，
> 但漏掉了一条关键事实：**A 的批次与 B 的批次在 DOM 上有明确类名分界**（`.feed-card` vs `.bili-feed-card`），
> 而「换一换」只刷新其中一小段（见文件头）。

### 6.1 只能让"后续批次的卡"上移，不能变出"取流账号的首屏 10 张"

推荐流首屏的 10 张是 **SSR 下发的**（服务端用页面身份渲染），DOM 里是 `.feed-card`（10 个）。
后续 rcmd 加载的卡是 `.bili-feed-card`（18+ 个）。

- **隐藏或 `order` 只能处理这两批的先后顺序**，**不能让服务端重新下发一批取流账号的 SSR**
- 补上来的是 **`.bili-feed-card` 那批**

**而 `.bili-feed-card` 里到底是谁的数据？取决于 `feed/rcmd` 是否被 DNR 代理换成了取流账号。**
- 若代理生效 → 那批是取流账号推荐的 → **方案成立**
- 若代理未生效 → 那批还是页面账号的 → **方案等于没做**

**这一条我没有独立验证**，**证据等级：未验证**。
原因：M1 无法执行 —— 本机**没有第二个账号**（Pluma 面板显示「未生效」，
`/nav` 的 mid 恒为单值）。详见 [`M1-REPORT.md`](./M1-REPORT.md)。

> ✅ `feed/rcmd` 确实在 DNR 白名单里（`routes.ts` `ROUTES_REVISION = 4`），规则层面支持。

### 6.2 首屏会"先闪一下 A 的，再跳到 B 的"

CSS 是**页面加载后**才应用的（注入有时序）。
用户会看到：**首屏先渲染 A 的 10 张 → 约几百毫秒后突然重排/隐藏**。

现在已有分界线的方案是**不跳**的（只加一条线）。改成隐藏或 `order` 是**用"视觉跳动"换"整页统一"**。
**这是产品体验的取舍，不是技术问题，必须由用户决定。**

### 6.3 隐藏/重排后，界面其余部分仍是页面身份

Lead 提到的"半页是 A 的推荐、整页 B 的界面"—— 我的判断：

> **比现在更容易困惑，不是更少。**

因为：
- 现在有**分界线**明说"以下是另一批推荐" → 用户有解释
- 改成隐藏/`order` 后**首屏直接是 B 的推荐，但顶栏头像/未读数/私信全是 A 的**
  → 用户会**以为整页都是 B**，然后发现收藏、历史、头像都是 A → **认知冲突更大了**
- 隐藏方案里 A 的卡还**留在 DOM 里**（只是 `display:none`），用户滑到底或换一换时它们可能回来
- `order` 方案里 A 的卡**被挪到末尾**，用户往下滑还会看到它们，但此时已"以为整页是 B 的"

**我的判断：两种方案在技术上可行，但在"观感一致性"上会让问题更明显而不是更少。**
除非同时做**顶栏身份提示**（例如"当前推荐来自：XX"），
否则"哪一半是谁的"会比现在更难解释。

> ⚠️ **这条是我基于读到的真实页面的主观判断，不是实测指标。** 是否采纳由用户决定。

---

## 7. 未验证项（不编推理顶替）

| 项 | 为什么没做 | 需要什么 |
| --- | --- | --- |
| 首屏 10 张 vs rcmd 首次响应的**数据来源** | 四种方法全部失败（见 §1）。页面加载后已无法从接口层取证 | 需要 CDP 在 `document_start` 注入（bsk 0.3.3 不支持），或扩展方式的 `world:'MAIN'` + `runAt:'document_start'` 探针 |
| **M1：两个账号**下推荐内容是否真的不同 | **本机只有 1 个登录账号**（Lead 已确认；Pluma 面板显示「未生效」） | 浏览器登录 A + 扩展配置 B |
| 隐藏**尾部**触发点是否也安全 | 本实验只测了"隐藏前面的卡" | 单独实验 |
| 移动端 / 窄视口下的布局 | 只测了桌面 Edge 157（1080p 视口） | 需响应式测试 |
| `order` 在列表持续加载（新增 9 张/次）后是否仍正确 | 只测了静态一次 | 需滚动 N 次后重测 |
| `order` 是否影响 B 站自己的埋点/推荐反馈 | 未测 | 需要看 B 站上报逻辑（超出只读范围） |
| 「换一换」刷新后分界线是否仍准确 | 需双账号 + 分界线已实现 | 同上 |

---

## 8. 复现方式

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;" + $env:PATH
bsk daemon start --foreground      # 若未运行
bsk session start --no-focus --json
bsk navigate --session <sid> "https://www.bilibili.com/"

# 几何：首屏到底有几张、前 10 张 is-rcmd 在哪
node poc/probe/feed-cover/probe-position.mjs --session <sid> --tab <tab>

# Q2/Q3：四种隐藏方式对无限滚动的影响（每组自动 reload）
node poc/probe/feed-cover/probe-hide-scroll-v2.mjs --session <sid> --tab <tab>

# Q4：容器结构 + order 实测
node poc/probe/feed-cover/probe-order.mjs      --session <sid> --tab <tab>
node poc/probe/feed-cover/probe-order-test.mjs --session <sid> --tab <tab>
```

⚠️ **作废的脚本保留供追溯**（`probe-q0-bv-overlap.mjs` / `probe-q0-v3.mjs` / `probe-q0-final.mjs`），
它们各自记录了一种失败的取证思路，**不要再用**。

---

## 9. 给 Lead 的一句话结论

> **用户的想法能成立，但最优实现不是"隐藏"而是 CSS `order`（容器是 grid，实测有效）。**
> 真正的风险不在这条路能不能走通，而在**走通之后用户看到的是"整页 B 的样子 + A 的头像/收藏/历史"** ——
> 这比现在的分界线**更容易误导**，除非同时加顶栏身份提示。

---

## 附录 A.【engineer-api 独立取证】2026-11-11 13:36–13:45

> ⚠️ **写域冲突说明**：本目录被两个成员并行写入。上面 §0–§9 是另一位成员的版本；
> 本节是 engineer-api 的独立实测，**只追加、不覆盖**。
> 两者结论**方向一致**（`order` 优于隐藏），但本节补充了对方未覆盖的三组数据。

### A.1 Q1（生死线）：`feed/rcmd` 首次响应**实际返回 12 条**，不是 8

用 `PerformanceObserver({type:'resource', buffered:true})` 抓本次文档的 rcmd 请求，
读其**完整参数表**（`probe-q1c-params.mjs`）：

```
第0次: {"web_location":"1430650","y_num":"3","fresh_type":"4","feed_version":"V8",
        "fresh_idx_1h":"1","fetch_row":"4","fresh_idx":"1","brush":"1",
        "ps":"12", ...}
第1次: {... "fresh_idx_1h":"2","fetch_row":"7","fresh_idx":"2","brush":"2","ps":"12" ...}
```

**关键参数 `ps=12`** → 每次请求 12 条。重放验证（`probe-q1b-itemcount.mjs`）：

| 参数 | itemCount | 构成 |
| --- | --- | --- |
| `fetch_row=4&ps=12`（实测首次） | **12** | — |
| `fetch_row=4&ps=30` | 30 | `av:28, ad:2` |
| `fetch_row=4&ps=10` | **10** | `av:8, ad:2` |
| 只给 `fresh_idx=1`（无 ps） | 30 | `av:28, ad:2`（默认 30） |

**所以 Q1 的答案是 12 条 —— 数量上足够覆盖首屏 10 张。**
但注意：**item 数与渲染出的卡片数不是 1:1**（有广告卡/骨架卡）。

> 这也解释了前序 `feed-boundary/RESULT.md` 的"每次 +8"：
> 那是按**有 BV 的卡**算的；按 `.bili-video-card` 总数算，滚动一次是 **+9**（`cardDelta: 9` 实测）。

### A.2 ❌ ~~Q4 补充：`feed-card` vs `bili-feed-card` 是 A/B 分界~~ → **已被推翻**（`probe-v-nesting.mjs`）

> ## 🔴 **本节结论错误，保留供追溯。**
> 我曾断言"`feed-card` = 首屏 A、`bili-feed-card` = rcmd B，这就是 A/B 的确切 DOM 分界"。
> **实测证明这是错的：它们是父子嵌套关系，不是两批并列数据。**

**grid 直接子元素的真实分布**（`probe-v-nesting.mjs`，按**完整 className** 归组，6 组）：

| 类名 | 数量 |
| --- | --- |
| `recommended-swipe` | 1 |
| **`feed-card`** | **10** |
| `floor-single-card` | 9 |
| **`bili-feed-card`** | **18** |
| `bili-video-card` | 9 |
| `load-more-anchor` | 1 |

**但层次关系是**：

```
container.is-version8  (grid)
 └─ feed-card  ×10   ← grid 直接子元素
     └─ bili-feed-card   ← 嵌在 feed-card 里面（10 个 feed-card 全部包含它）
 └─ bili-feed-card ×18  ← 另有 18 个是 grid 直接子元素
```

| 判据 | 实测 |
| --- | --- |
| `feedCardContainingBiliFeedCard` | **10**（全部 10 个都含） |
| `biliFeedCardContainingFeedCard` | **0** |
| `elementsWithBothClasses` | 0 |
| 父链 | `bili-feed-card → feed-card → container.is-version8` |

**所以 `.feed-card` 是 `.bili-feed-card` 的父级包装，两者不是"批次 A vs 批次 B"。**

**另一条独立证据**（`probe-u-what-fills.mjs`）：`feed-card` 的 8 个唯一 BV **全部**出现在
`bili-feed-card` 里，前 5 条顺序完全相同：

```
feedFirst5: ["BV186pc65E68","BV1EB4w6uETd","BV1uFnw6CEZH","BV1AJxv6qEFP","BV1QLWM6qEZd"]
biliFirst5: ["BV186pc65E68","BV1EB4w6uETd","BV1uFnw6CEZH","BV1AJxv6qEFP","BV1QLWM6qEZd"]
overlap: 8 / 8
```

> **这是本轮第四次"我以为这个选择器选的是什么"** —— 前三次是 `nth-of-type` 误伤、
> `.is-rcmd` 跨区块、`.bili-video-card` 误伤轮播；这一次是**把父子当成兄弟**。

### A.2b ⚠️ 因此 A.3b 的结论**前提不成立**

A.3b 说"隐藏 `.feed-card` 后补上来的是 B 的卡"—— **这句话没有任何证据支撑**，因为：
1. **本机没有配置取流账号 B**，Pluma 扩展**未注入**（见 A.2c）
2. `rcmd` 的 `data.mid` = 浏览器登录账号 A
3. `feed-card` 与 `bili-feed-card` 是**同一批数据**（上表的 8/8 重叠）

**能证明的**：隐藏 `.feed-card` 后，`bili-feed-card` 顶到 top=255（**布局补位机制成立**）。
**不能证明的**：补上来的是**另一个账号**的数据 —— 这需要 **M1**（DNR 实际换 Cookie 生效）。

### A.2c 🔴 身份前提的实测（回答 Lead 的 M1 问询）

| 判据 | 实测 | 含义 |
| --- | --- | --- |
| `window.__PLUMA_HANDSHAKE__` | **不存在** | Pluma 扩展**未注入本页** |
| `window.__PLUMA_PGC__` | **不存在** | 同上 |
| `page/snapshot` 桥 | **超时**（`gotSnapshot: false`） | 扩展的页面桥**不可用** |
| `nav` mid | {{主账号mid}} | 浏览器登录的是 **A** |
| `rcmd` 响应 `data.mid` | **{{主账号mid}}** | rcmd 用的也是 **A** |

> **结论：本次全部补测（含 A.3b）都是在"扩展未生效、只有一个账号"的环境下做的。**
> 隐藏 `.feed-card` 后补上来的 `bili-feed-card` **是同一账号 A 的 rcmd 数据**，
> **不是取流账号 B 的**。
>
> **所以"隐藏 A 的 SSR、露出 B 的 rcmd"这个效果，本轮无法证明，也未证伪。**
> 它成立与否**完全取决于 M1**：`feed/rcmd` 那条请求是否真的被 DNR 换成了 B 的 Cookie。

### A.3 ~~"隐藏补位"不成立~~ → **已推翻：成立**（2026-11-11 15:00 更正）

> ## ⚠️ 本节原结论**已被推翻**，保留原文供追溯。**以 A.3b 为准。**

**原（错误）结论**：隐藏前 10 张后顶部留 154px 空洞，新卡只追加到末尾，补位不成立。

**为什么错**：原实验用 `.bili-video-card` 选择器隐藏"前 10 张"，
而 **`recommended-swipe`（顶部轮播）内部也嵌了 `.bili-video-card`** ——
那几张被一起隐藏了，导致轮播高度 **433 → 134**（塌 299px），
第一张卡才被从 255 推到 409。**空洞是轮播误伤造成的，不是"10 张卡补不满"。**

> 这正是本轮反复出现的同一个病根：**选择器实际命中范围 ≠ 我以为的范围**。
> 上一次是 `nth-of-type` 误伤 28 张，这次是 `.bili-video-card` 跨越了轮播边界。

---

### A.3b ✅ **布局结论成立**：只隐藏 `.feed-card`，补位机制无空洞（`probe-s-feedcard-only.mjs`）

> **⚠️ 本节的"布局"部分成立；"身份"部分见 A.2b/A.2c —— 本轮环境无法证明补上来的是另一个账号。**

**修正实验设计**：只对 `.feed-card`（共 10 个）设 `display:none`，
**显式断言"没有一个命中元素在 `recommended-swipe` 内部"**。

| 断言 | 结果 |
| --- | --- |
| `.feed-card` 总数 | 10 |
| 实际命中 | **10**（`assertHitEqualsTotal: true`） |
| 轮播内部被误伤数 | **0**（`assertSwipeUntouched: true`） |

**结果**：

| 状态 | 第一张可见卡 `top` | 轮播高 | 文档高 |
| --- | --- | --- | --- |
| 基线（不隐藏） | **255** | 433 | 2608 |
| **只隐藏 `.feed-card`** | **255** ✅ | 449（基本不变） | 2155 |

**第一张可见卡 `top` 回到 255（= 顶栏高度），零空洞。**

#### 连滚 3 轮依然稳定（`probe-s2-fill-scroll.mjs`）

| 轮次 | 第一张可见卡 top | 可见卡数 | 隐藏的 feed-card | 轮播高 | rcmd 累计 |
| --- | --- | --- | --- | --- | --- |
| 初始 | **255** | 27 | 10 | 449 | 2 |
| 第 1 轮 | **255** | 36 | 10 | 449 | 4 |
| 第 2 轮 | **255** | 44 | 10 | 449 | 5 |
| 第 3 轮 | **255** | 51 | 10 | 449 | 5 |

**四轮 top 全是 255，滚动正常（rcmd 累计 +3），内容持续补位。**

#### 补上来的是什么（`probe-s3-whose-cards.mjs`）

隐藏 `.feed-card` 后，首屏可见容器分类：

```
recommended-swipe    top 255  h 449  cards 2   ← 轮播（内部仅 2 张骨架，无 BV、无标题）
floor-single-card    top 255  h 222  cards 0
bili-feed-card       top 255  h 222  cards 1   ← 第一个内容容器，紧贴顶部
bili-feed-card       top 497 ...              ← 其余 bili-feed-card
```

- 轮播内那 2 张是**骨架占位**（`bvs: []`、`hasTitles: 0`），不是真实推荐内容
- **轮播之后的第一个内容容器是 `bili-feed-card`，top=255**

> ## ✅ **能证明的（布局层）**
> 只隐藏 10 个 `.feed-card`、不碰轮播，**没有空洞、滚动正常、持续补位**。
> 之前的"154px 空洞"确系 `.bili-video-card` 误伤轮播造成。
>
> ## ❌ **不能证明的（身份层）**
> 补上来的 `bili-feed-card` **是不是"另一个账号"的推荐**。
> 本轮环境：**Pluma 未注入、只有一个账号 A、rcmd 的 `data.mid = A`**（见 A.2c）。
> 且 `.feed-card` 与 `.bili-feed-card` 是**父子关系而非两批数据**（见 A.2）。
> **→ 结论依赖 M1。**

### A.4 `order` 方案的**代价量化**（对方未给数字）

施加 `.container.is-version8 > .bili-feed-card{order:-1}` 后（`probe-q4f-cost.mjs`）：

| 项 | 值 |
| --- | --- |
| B 卡（`bili-feed-card`）首个 top | **255**（紧跟轮播，占据首屏） |
| A 卡（`feed-card`）首个 top | **1161** |
| A 卡末个 top | 1388 |
| 可见 A 卡数 | **6 张** |
| 可见 B 卡数 | 14 张 |
| **重复 BV 数** | **0** |

**A 卡没有消失，只是被推到 1161–1388px** —— 用户往下滚**仍会看到**那 6 张页面身份的卡。
这与对方 §6.3 的判断一致，但这里给出了**具体像素位置**，可直接用于设计分界线。

### A.5 与并行数据的对账（`probe-r-reconcile.mjs`）

`hide-scroll-result.json` 的 `A-display-none` 记 `newRcmdRequests: 0`，与"隐藏不破坏滚动"相反。
对账结果：

| 项 | 对方 | 本附录 |
| --- | --- | --- |
| 选择器 | `.bili-video-card.is-rcmd:nth-of-type(-n+10)` | JS 精确取前 10 个加 class |
| **实际命中** | **28 张**（实测 `displayNoneCount: 28`） | **10 张** |
| 隐藏后可见卡 | 11 张 | 24 张 |

用**对方的选择器**在干净页面重测 → 仍 `displayNoneCount: 28`，但 **`rcmdDelta: 1`（滚动照常触发）**。

> ⚠️ **口径教训**：`nth-of-type(-n+10)` 在首页会**误伤 28 张**（`.bili-video-card` 在同类型元素里分布很散）。
> **任何"隐藏前 N 张"的实验必须先断言 `命中数 == N`**，否则测的是另一个场景。

### A.6 engineer-api 的独立结论（**已按 A.3b 更正**）

1. **Q1 = 12 条**（不是 8），数量足够
2. ~~"隐藏补位"不成立~~ → **✅ 成立**：**只隐藏 `.feed-card`、不碰轮播**时，
   第一张可见卡 `top` 回到 **255**，连滚 3 轮稳定，补上来的全是 `bili-feed-card`（B 身份）
3. **`order` 也可行** —— 零高度变化、零重复、新卡自动继承；代价是 A 卡被推到 ~1161px 仍可见
4. **两条路线对比**：

| | 隐藏 `.feed-card` | `order` 重排 |
| --- | --- | --- |
| 首屏最上方是 | **B 的卡**（top 255） | 轮播骨架 + B 的卡 |
| A 的卡 | **不可见**（display:none） | 仍在 **1161px** 处可见 |
| 文档高度变化 | **−453px** | **0** |
| 滚动 | 正常 | 正常 |
| 风险 | 选择器必须精确到 `.feed-card`，**碰轮播就塌** | 依赖 grid，改版即失效 |

5. **建议**：若目标是"视觉上整页都是取流账号"，**隐藏 `.feed-card` 更彻底**（A 完全不可见）；
   若要保留 A 的卡可回看，用 `order`。
   **两种方案的分界线坐标不同，不可混用**：

| 方案 | 分界线应插在 |
| --- | --- |
| 隐藏 `.feed-card` | **无需分界线**（A 已不可见） |
| `order` 重排 | `bili-feed-card` 批次结束处（A 卡起始 ~1161px） |
| 都不做（现状） | 第 10 个 `feed-card` 之后 |

### A.7 本附录脚本清单

| 脚本 | 验证什么 |
| --- | --- |
| `probe-q1-first-response.mjs` | 首次 rcmd 请求 ± item 数 |
| `probe-q1b-itemcount.mjs` | `ps` / `fetch_row` 对 itemCount 的影响 |
| `probe-q1c-params.mjs` | rcmd 完整参数表 |
| `probe-q2b-exact-hide.mjs` | 精确隐藏 10 张后滚动是否触发 |
| `probe-q2c-fill.mjs` | ❌ **已被 A.3b 推翻**：用 `.bili-video-card` 会误伤轮播 |
| `probe-q2d-baseline-top.mjs` | 基线 vs 隐藏后的第一张卡位置 |
| `probe-q4d-structure.mjs` | grid 六类子元素分布 |
| `probe-q4e-promote.mjs` | `order:-1` 提升 B 卡 |
| `probe-q4f-cost.mjs` | A 卡被推到哪、有无重复 |
| `probe-q5-mixed-identity.mjs` | 顶栏与推荐卡是否同屏 |
| `probe-r-reconcile.mjs` | 与并行数据的对账 |
| **`probe-s-feedcard-only.mjs`** | ✅ **关键实验**：只隐藏 `.feed-card`，断言不误伤轮播 |
| **`probe-s2-fill-scroll.mjs`** | ✅ **关键实验**：连滚 3 轮补位稳定性 |
| **`probe-s3-whose-cards.mjs`** | ✅ **关键实验**：补上来的是谁的卡 |

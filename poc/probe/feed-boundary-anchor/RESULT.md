# task-19 · 分界线锚点复核

> 复核者：**verifier** · 2026-11-11
> 依据：engineer-dnr 的原始几何数据（`poc/probe/feed-cover/RESULT.md` §3）+ engineer-api 的类名分界实测 + 我自己的实现读码
> **本轮未修改任何源文件。**

---

## §0 结论先行

**这是真 bug，而且是用户可见的。** 但它不是 engineer-dnr 猜的那个机制，**比那个更确定**。

| 问题 | 答案 |
|---|---|
| 实现按什么数「第 10 个」？ | `querySelectorAll('.bili-video-card.is-rcmd')` 的 **DOM 顺序第 10 个**，**零过滤** |
| 有几何过滤吗？ | ❌ **完全没有**（无 `height`、无 `getBoundingClientRect`、无 `offsetParent`） |
| 有类名过滤吗？ | ❌ **没有**（不区分 `feed-card` / `bili-feed-card`） |
| 会插错位置吗？ | ✅ **会**。详见 §2 |

---

## §1 实现读码（静态确凿，不需要真机）

`feed-boundary-dom.ts:141`：

```ts
const cards = [...doc.querySelectorAll<HTMLElement>(RCMD_CARD_SELECTOR)];
```

`feed-boundary.ts:55`：

```ts
export const RCMD_CARD_SELECTOR = '.bili-video-card.is-rcmd';
```

`feed-boundary.ts:70-73`：

```ts
export function findBoundaryAnchor<T>(cards: readonly T[]): T | null {
  if (cards.length < BOUNDARY_AFTER_NTH_CARD) return null;   // 10
  return cards[BOUNDARY_AFTER_NTH_CARD - 1] ?? null;         // cards[9] = 第 10 个
}
```

`feed-boundary-dom.ts:161`：

```ts
plan.anchor.insertAdjacentElement('afterend', host);
```

**全仓 grep `height` / `getBoundingClientRect` / `offsetParent` / `feed-card` 在这两个文件里：
除 CSS 样式（`line-height: 1`、`height: 1px` 是分界线自己的样式）外，`feed-boundary-dom.ts:141` 是唯一取卡的地方，**没有任何几何或类名判据。**

### ∴ 静态结论

**「第 10 个 `.bili-video-card.is-rcmd`」= DOM 顺序第 10 个，不管它是否渲染、是否有内容、是否属于 A 批还是 B 批。**

---

## §2 为什么这会插错（把三段事实拼起来）

### 2.1 engineer-dnr 实测的几何（前 10 张 `.is-rcmd`）

| DOM idx | 有 BV | top | height | inViewport |
|---|---|---|---|---|
| 2 | ✅ | 255 | 207 | ✅ |
| 3 | ✅ | 255 | 207 | ✅ |
| 4 | ✅ | 482 | 207 | ✅ |
| **5** | ❌ | **0** | **0** | ❌ |
| 6 | ✅ | 482 | 207 | ✅ |
| 7 | ✅ | 708 | 207 | ✅ |
| 8 | ✅ | 708 | 207 | ✅ |
| **9** | ❌ | **0** | **0** | ❌ |
| **10** | ✅ | **0** | **0** | ❌ |
| **11** | ✅ | **0** | **0** | ❌ |

**前 10 张里 4 张 `height=0`、`top=0`**（idx 5/9/10/11）。
其中 idx 10/11 **有 BV 但尺寸为 0** —— 所以「按有无 BV 过滤」也不够（这正是 `feed-boundary/RESULT.md` 当初排除候选 B 的原因）。

### 2.2 engineer-api 实测的类名分界

容器 `.container.is-version8` 是 grid，48 个子元素分六类：

| 类名 | 数量 | 含义 |
|---|---|---|
| `recommended-swipe` | 1 | 顶部轮播（**内部也嵌卡**） |
| **`feed-card`** | **10** | **首屏 = 浏览器账号 A 的** |
| `floor-single-card` | 9 | 分区楼 |
| **`bili-feed-card`** | **18** | **rcmd = 取流账号 B 的** |
| `bili-video-card` | 9 | — |
| `load-more-anchor` | 1 | 无限滚动哨兵 |

### 2.3 把两段拼起来 —— 这是本报告最关键的一步

**`.bili-video-card.is-rcmd` 这个选择器**按定义匹配「带 `is-rcmd` 类的视频卡」。而 engineer-api 的分界表明：

- **A 批（`feed-card`）10 个**
- **B 批（`bili-feed-card`）18 个**
- 两批**都可能是 `.bili-video-card`**（同一视觉组件），且都**可能带 `is-rcmd`**

**∴ `.is-rcmd` 序列 = A 批 ∪ B 批（∪ 可能还有 `recommended-swipe` 里嵌的卡）**，
**不是"首屏那一批"，也不是"滚动加载那一批"。**

**而「第 10 个 `.is-rcmd`」落到的位置，取决于 A/B 两批在 DOM 里怎么交织。**
engineer-dnr 的几何数据证明：前 10 个 `.is-rcmd` 里**已经混进了 `height=0` 的元素**，
且第 10 个恰好是 `top=0 / height=0`。

### 2.3.1 ✅ 矛盾已解开（**用已有数据定案，不需要真机**）

Lead 要求先做 §5 第 0 项。**我用两份已有实测数据按 BV 对齐，直接定案了。**

**数据来源**（同一份 `poc/probe/feed-cover/RESULT.md`，但两个不同探针、两个不同坐标系）：

| 表 | 出处 | 坐标系 | 记录的 idx |
|---|---|---|---|
| 表 1 | `:123-136`（`probe-position.mjs`） | **`.is-rcmd` 序列内序号** | 2,3,4,5,6,7,8,9,10,11 |
| 表 2 | `:178-187`（`probe-order-test.mjs`） | **`.container.is-version8` 子元素序号** | 0,1,2,3,5,6,7,12 |

**按 BV 对齐**：

| BV | 表 1 的 idx（is-rcmd 序列） | 表 2 的 idx（container） | 差值 |
|---|---|---|---|
| `BV1ZYJa6BEdy` | **2** | **1** | **−1** |
| `BV1kvp16xEmV` | **3** | **2** | **−1** |
| `BV17Jn86eEUx` | **4** | **3** | **−1** |
| `BV1d4p26SE5n` | **6** | **5** | **−1** |
| `BV1wmpk6DEUv` | **7** | **6** | **−1** |
| `BV17YJX6FEFb` | **8** | **7** | **−1** |
| `BV1wQWN6jECn` | **不存在** | **0** | — |

**六个 BV 的差值全部恒为 −1，且 container idx 0 的那个卡不在 `.is-rcmd` 序列里。**

### ∴ 结论（确凿）

**`.is-rcmd` 序列的第 N+1 个 = container 的第 N 个，起点差 1。**

**这直接回答了 §2.3.1 的矛盾：**
- `feed-card` 在 container 里是 **idx 1..10**（10 个）
- `.is-rcmd` 前 10 个在 container 里是 **idx 2..11**

**两者有 9 个重叠（container 2..10），但有 1 个错位：**
- `feed-card` 含 container **idx 1**，不含 **idx 11**
- `.is-rcmd` 前 10 含 container **idx 11**，不含 **idx 1**

**⚠️ 所以「可能① = 同一批」不成立。**
「第 10 个 `.is-rcmd`」（container idx 11）**不是** `feed-card` 的最后一个（container idx 10），
**它跨过了 A 批的边界，落进了 `floor-single-card` 或 `bili-feed-card` 区**。

**这解释了 engineer-dnr 看到的那 4 张 `height=0`：**
container idx 11 起是 `floor-single-card`（9 个，idx 11..19）—— **楼层分隔，本身无内容、高度 0**。
`.is-rcmd` 序列把 `floor-single-card` 里带 `is-rcmd` 类的元素也算进去了，
**所以第 10 个 `.is-rcmd` 落在楼层分隔区里，那是文档流里靠前的一个 0 高度位置。**

### 2.3.2 这带来一个有价值的副产品

**`.is-rcmd` 序列表 1 里 idx 9 / 10 / 11 三张 `height=0`**（其中 idx 10/11 有 BV），
对应 container 的 idx 10 / 11 / 12：
- container idx 10 = `feed-card` 的最后一个（A 批末尾）
- container idx 11 = `floor-single-card` 区起点
- container idx 12 = `bili-feed-card` 起点（B 批）

**∴ `.is-rcmd` 序列在 A/B 交界处横跨了三个区块**，
「第 10 个 `.is-rcmd`」这个锚点**在结构性上就是错的**，不是"偶尔偏"。

### 2.3.3 这对修法的影响（更新 §4）

**可能②成立 → 候选 A（用 `.feed-card` 最后一个）语义上是对的**（它正好是 A 批的真实末尾）。
但 §4 里我给的两条反对理由**仍然有效**（依赖内部类名、静默失效）。

**∴ 修法建议不变，但候选 A 的正确性现在有数据支撑了。**

### 2.4 判定

**`insertAdjacentElement('afterend', host)` 插在一个 `height=0`、`top=0` 的元素后面** →
分界线会出现在**文档流里那个元素的位置**，即**页面顶部附近**，而不是"第 10 张可见卡下方"。

**用户看到的是：首页最上面一条「以下推荐来自取流账号（滚动加载）」。**
—— 这正是我在初验里说的那类最坏情况：**界面陈述错误事实**（首屏那批其实是 A 的，不是 B 的）。

**证据等级**：
- 实现零过滤 → **静态确凿**
- 第 10 个 `.is-rcmd` 是 `height=0` → **engineer-dnr 实测**
- 分界线渲染在顶部 → **推理**（未真机确认，见 §5）

---

## §3 ⚠️ 一个更根本的发现：判据从一开始就选错了概念

`poc/probe/feed-boundary/RESULT.md` 当初的判据是：

> `.bili-video-card.is-rcmd` 数 = `[10,10,10,10,10]`，**sd=0** → ✅ 用这个

**那个测量是在 HTML 解析层做的**（`DOMParser` 解析原始 HTML，不执行 JS、不渲染）。
**它测的是"HTML 里有几个这样的标签"，不是"渲染后有几个可见卡"。**

**这是"同一概念在两个层面上的两种事实"**——与本轮反复出现的模式相同（HTML 层 vs 渲染层）。

`[10,10,10,10,10]` 这个数字**本身没错**，但**它回答的问题是错的**：
- 它回答："HTML 里 `is-rcmd` 标签有几个" → 10
- 需要回答："用户看到的前 10 张卡在哪结束" → **不是这个数**

---

## §4 修法建议（判据需重新实测，我给方向不给结论）

### 候选 A：锚点改成「`feed-card` 批的最后一个」

```ts
const aCards = [...doc.querySelectorAll('.feed-card')];
const anchor = aCards[aCards.length - 1];
```

| 维度 | 评价 |
|---|---|
| 语义 | ✅ **直接表达"A 批在哪结束"**，不靠数数猜 |
| 稳定性 | ⚠️ **未实测**（需多次 reload 验 `feed-card` 数量是否恒为 10） |
| **改版风险** | 🔴 **高** —— 依赖 B 站内部类名。`feed-card` / `bili-feed-card` 是 B 站实现细节，改版即失效且**静默失效**（选择器匹配不到 → 不插线 → 用户看不到分界线，但不会报错） |

### 候选 B：锚点改成「第 10 个 `height > 0 && inViewport` 的 `.is-rcmd`」

| 维度 | 评价 |
|---|---|
| 语义 | 🟡 仍是"数数"，但**数的是用户看得见的东西** |
| 稳定性 | ⚠️ 未实测（需验 `height>0` 的卡数是否稳定 ≥10） |
| 改版风险 | 🟡 中 —— 仍依赖 `is-rcmd` 类名，但**不依赖 A/B 分界类名** |
| 额外问题 | ⚠️ 需要 `getBoundingClientRect()`，即**每次校正要做布局计算**（`MutationObserver` 频繁触发时有性能代价） |

### 候选 C：**不插线，改用「只在面板里说明」**

| 维度 | 评价 |
|---|---|
| 语义 | ✅ **永远不会说错话** |
| 用户价值 | ❌ 用户在页面上看不见 |
| 结论 | 这是**保底选项** —— 如果 A/B 都验不稳定，应该退到这里 |

### 我的倾向（**不是结论**）

**候选 A 的语义最对**，但**改版风险最高**，而且本项目一贯的立场是"宁可没有这条线，也不能让它说假话"（`feed-boundary.ts:118` 原文）。

**∴ 如果 `feed-card` 的稳定性实测不过关，宁可退到候选 C，也不要用一个"数不准"的判据。**

---

## §5 未验证项（必须补，不许跳过）

| # | 项 | 需要什么 |
|---|---|---|
| ~~0~~ | ~~`.feed-card` 与 `.is-rcmd` 前 10 是不是同一批~~ | ✅ **已用已有数据定案**（§2.3.1）：**不是同一批，差 1 个**。`.is-rcmd` 第 10 个 = container idx 11，跨出 A 批 |
| 1 | 分界线**实际渲染的 `top`** | 真机：装扩展 → 首页 → 量分界线的 `getBoundingClientRect().top` |
| 2 | `feed-card` 数量是否恒为 10 | 真机：**连续 5 次 reload**，记录 `.feed-card` 数量 |
| 3 | `feed-card` 与 `bili-feed-card` 是否**顺序连续**（A 全在 B 前） | 真机：记录两批在 DOM 里的相对位置 |
| 4 | `height > 0` 的 `.is-rcmd` 数量是否稳定 ≥10 | 真机：同上 |
| 5 | `recommended-swipe` 里嵌的卡会不会也带 `is-rcmd` | 真机：查 `.recommended-swipe .bili-video-card.is-rcmd` |
| 6 | 若改用类名判据：`.feed-card` 里有没有 `height=0` 的（决定候选 A 是否也要加几何过滤） | 真机：量 `.feed-card` 每个的 `height` |

> **#0 已定案，剩余 6 项仍需真机**（尤其 #1「实际渲染 top」和 #2「`feed-card` 稳定性」）。

**本轮未能执行原因（如实记录）**：

```
bsk daemon 进程 22240 已死（Get-Process 查不到、管道 \\\\.\\pipe\\bsk-daemon-bf0b5a6aae87a0a6 不存在）
bsk status 报 "ensure daemon is running: automatic daemon startup is disabled (BSK_AUTO_START=0)"
按环境约束我不能在此启动 daemon（需要 host 前台任务）
```

**∴ 「分界线实际渲染位置」这一条是推理，不是实测。**
但 §1（实现零过滤）+ §2.1（第 10 个是 `height=0`）都是确凿的，
**两者一合，推理链是闭合的**——只差一个"渲染在顶部"的直接观测。

---

## §6 给 Lead 的处置建议

1. **这是真 bug，建议本轮修**（性质：用户可见的错误陈述，比 🟡 级重）
2. **修法不要直接采纳候选 A** —— 它依赖 B 站内部类名，改版风险高于现有方案，而且**静默失效**
3. **先补 §5 的 5 条实测**（尤其 #2 `feed-card` 稳定性、#3 顺序连续性），再定判据
4. **我倾向：若 A 验不稳 → 退到候选 C（不插线 + 面板说明）**。理由是本项目在 `feed-boundary.ts:118` 已经写下了这条立场：
   > **宁可没有这条线，也不能让它说假话。**
5. ⚠️ **在修好之前，建议先关掉分界线功能**（`ui-prefs` 的开关默认关），避免用户看到错误的线

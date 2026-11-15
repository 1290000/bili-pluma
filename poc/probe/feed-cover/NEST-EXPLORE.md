# 隐藏方案还有没有别的路 —— 嵌套前提下的四条探查

> **日期**：2026-11-11 18:xx
> **环境**：bsk 0.3.3 / Edge 157（用户日常 Edge）/ 首页 `https://www.bilibili.com/`
> **纪律**：只读 + **可逆**样式实验（每轮结束恢复 + reload）。未改任何代码。

---

## 0. 结论先行

# ✅ **有路。`order` 能真正把 B 批换到首屏。**

**关键实测**：给 `.feed-card` 设 `order:9999` 后，首屏的批次序列

```
变换前 : other other A A A A A A B B B B B    ← A=6, B=5
变换后 : other other B B B B B B B B B B B    ← A=0, B=11
```

**A 的卡从首屏完全消失，B 的卡补满首屏。**

⚠️ 但"B 批"到底是什么身份的数据，**仍未验证**（需要 M1 双向成立）。

---

## ① 结构细节（实测）

### `.feed-card` 的完整属性

```
classes : "feed-card"
attrs   : class, data-v-ca6d02a9   ← 只有一个 Vue scoped 属性，**没有语义标记**
rect    : {top: 255, h: 207, w: 237}
children: 1 个 —— DIV.bili-feed-card
outerHTML 前 500 字:
  <div class="feed-card" data-v-ca6d02a9="">
    <div class="bili-feed-card" data-v-ca6d02a9="">
      <div class="bili-video-card is-rcmd enable-no-interest" ...>
```

### 内层 `.bili-feed-card`

```
classes  : "bili-feed-card"
isRcmd   : false                    ← 注意：这层**没有** is-rcmd
bv       : BV1qfWx6wEd6
rect     : {top: 255, h: 207, w: 237}   ← 与外层**完全相同**
depth1   : ["DIV.bili-video-card is-rcmd enable-no-intere"]  ← 真正的卡在这一层
videoCard: isRcmd=true, bv=BV1qfWx6wEd6
```

---

## ② 内外内容是否同一张卡 —— **实测：是同一张**

### 三层结构

```
.feed-card            ← Vue scoped wrapper（透明）
  └ .bili-feed-card   ← 又一层 wrapper（is-rcmd=false）
      └ .bili-video-card.is-rcmd   ← 真正的卡
```

| 判据 | 结果 |
| --- | --- |
| 外层 BV 与内层 BV 相同 | ✅ 是（三张样本全部一致） |
| 外层 rect 与内层 rect 相同 | ✅ 完全相同（top/height 一致） |
| `feed-card` 的 BV 集合 vs `bili-feed-card` 集合 | **8 个 feed-card BV 全部也在 bili-feed-card 里** |
| `feed-card` 内是否有第二张卡 | ❌ 没有（`children: 1`） |

**所以 `.feed-card` / `.bili-feed-card` 都是纯 wrapper，不是"两批不同的数据"。**

### ⚠️ 这推翻了之前"类名分界"的理解

`RESULT.md` / `附录 A` 里曾把 `.feed-card` 当作"A 批的专属类名"、`.bili-feed-card` 当作"B 批"。
**实测证明这个理解是错的** —— 它们是**同一个盒子的两层包装**。

**真正的分界是「谁在 `.feed-card` 里面 vs 谁不在」**，即：
- 在 `.feed-card` 里 → 首屏 SSR 那批（10 个）
- 直接挂在 grid 上、不在任何 `.feed-card` 里 → rcmd 加载的那批（18 个）

---

## ③ 四条路径的可行性（实测）

### 3.1 `display:contents` —— 有效但效果弱

| 方案 | 首屏 BV 变化 | 评价 |
| --- | --- | --- |
| **`display:contents`** | 变了 **2 个**（第 7/8 位） | ✅ 有效但很弱 |
| `contents` + `grid-auto-flow:dense` | 同样只变 2 个 | 无明显增益 |
| **`order:9999`** | **变了 11 个（A 全清空）** | ✅✅ **效果最强** |

`display:contents` 让 `.feed-card` 去掉盒子、孩子直接参与 grid 布局，但**不改变顺序**，
所以只影响了少数卡的行高/列位，效果很弱。

### 3.2 `order:9999` —— **效果最强，这就是解法**

#### 批次归属判定方法
```js
const batchOf = (el) => el.closest('.feed-card') ? 'A' : (el.closest('.bili-feed-card') ? 'B' : 'other');
```

#### 实测结果（`probe-batch-shift.mjs`）

```
【变换前】
  全页批次分布: A=10  B=18  other=11
  首屏可见: 13 张 → A=6  B=5  other=2
  首屏批次序列: other other A A A A A A B B B B B
  首屏 BV: BV1rhWL66Ej7, BV1D8x46oEtj, BV16QJY6LESZ, BV1mKWu6YEbz,
           BV16rWJ6JE7x, BV1xRnB6kEDE, BV1iypF6QECS, BV1ebWt68E7o,
           BV1v5n56QEbt, BV1NUHK6nEJN, BV1mfxN6tEcn

【变换后 order:9999】
  全页批次分布: A=10  B=18  other=11   ← 数量不变，只是挪位置
  首屏可见: 13 张 → A=0  B=11  other=2
  首屏批次序列: other other B B B B B B B B B B B
  首屏 BV: BV1iypF6QECS, BV1ebWt68E7o, BV1v5n56QEbt, BV1NUHK6nEJN,
           BV1mfxN6tEcn, BV1GhxQ6PEWC, BV1eX4K6LEL4, BV1e8nC6PER2,
           BV1DE4B6ZEjG, BV1jKWM6yEY4, BV13Nxq6REre
```

**判读**：
- 首屏 A 批：**6 → 0**
- 首屏 B 批：**5 → 11**
- `other`（轮播等）不变：2 → 2

> ### ✅ **`order:9999` 把 A 完全挤出首屏，B 补满。这正是用户想要的效果。**

### 3.3 滚动是否正常 —— **实测：正常**

| 方案 | after.total | afterScroll.total | 判定 |
| --- | --- | --- | --- |
| 对照组 | 39 | 48 | ✅ |
| `display:contents` | 39 | 48 | ✅ |
| `contents + dense` | 39 | 48 | ✅ |
| `order:9999` | 38 | 47 | ✅ |

**所有方案都不破坏无限滚动。**

### 3.4 `.feed-card` 是不是透明 wrapper —— **实测：是**

```
display  : block
padding  : 0px
margin   : 0px
background: rgba(0, 0, 0, 0)    ← 完全透明
border   : 0px none
position : static
overflow : visible
gridRow  : auto
gridColumn: auto
```

**它不提供任何视觉，只是个盒子。**

---

## ④ 关键限制（必须说清）

### 4.1 "B 批"的身份仍未验证

`order:9999` 把 `.bili-feed-card` 直接子元素（18 个）换到了前面。但**这 18 个是不是取流账号的数据**，
取决于 **DNR 是否在首页真的换了 `feed/rcmd` 的 Cookie** —— 而 **M1 双向仍未完成**。

- 若 M1 成立 → 这个方案**完全可行**
- 若 M1 不成立 → 只是把页面账号的另一批推荐换到前面，**等于什么都没做**

### 4.2 首屏仍留 2 张 `other`（轮播）

```
首屏序列: other other B B B B B B B B B B B
```
前 2 个 `other` 是**轮播区**（`recommended-swipe`），不是推荐卡，保留是对的。

### 4.3 视觉跳动

`order` 是 CSS，页面加载后才生效 → 用户会看到 A 闪一下再变成 B。

### 4.4 `order` 会不会影响 B 站自己的上报

**未测**。B 站可能按 DOM 顺序上报曝光，`order` 只改视觉顺序，上报的可能仍是 A。

---

## ⑤ 与"隐藏"的对比（更新版）

| 方案 | 首屏 A 数量 | 布局 | 内容丢失 | 滚动 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 隐藏 `.feed-card` | 0 | 塌陷 | **丢失 A 的 10 条** | 正常 | **不可行**（连内层 B 一起藏） |
| `display:contents` | 约 4 | 保留 | 不丢 | 正常 | 效果弱 |
| **`order:9999`** | **0** | **保留** | **不丢** | **正常** | ✅ **推荐** |

---

## ⑥ 逐项「实测 / 推理」

| # | 项 | 状态 |
| --- | --- | --- |
| ① 结构细节（属性/class/几何） | ✅ **实测** |
| ② 内外是否同一张卡 | ✅ **实测：是**（BV 相同、rect 相同、feed-card 的 8 个 BV 全在 bili-feed-card 里） |
| ③ `display:contents` 有效但弱 | ✅ **实测**（首屏只变 2 个） |
| ③ `order:9999` 把 A 挤出首屏 | ✅ **实测**（A: 6→0，B: 5→11） |
| ③ 滚动不被破坏 | ✅ **实测**（四种方案全部正常） |
| ④ `.feed-card` 是透明 wrapper | ✅ **实测** |
| "B 批"是不是取流账号的数据 | ❌ **未验证**（依赖 M1 双向） |
| `order` 是否影响 B 站上报 | ❌ **未测** |
| 视觉跳动的影响 | 推理 |

---

## 附：脚本

| 文件 | 用途 |
| --- | --- |
| `probe-nest-detail.mjs` | ①②④ 结构 / 内容关系 / 盒子样式 |
| `probe-contents-v2.mjs` | ③ 四条路径 + 滚动影响（每组 reload 隔离） |
| `probe-batch-shift.mjs` | ③ **关键**：`order:9999` 后首屏 A/B 批次占比 |

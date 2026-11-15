# 「A 消失 + 零留白」可行性对照表

> **日期**：2026-11-11 18:xx
> **目标（用户新指示）**：开关开启后首页推荐流**全部**是取流账号的，**A 一张都不出现**，**不允许留白**
> **环境**：bsk 0.3.3 / Edge 157（用户日常 Edge）/ 首页
> **纪律**：只读 + 可逆样式实验；**每组 reload 隔离**；**断言命中数**；实验后恢复 inline style

---

## 0. 结论

# ✅ **路径 1（`display:none` 10 个 `.feed-card`）完全合格，零留白。**

关键数据：

```
before : firstTop=255  A=6  B=5   feedCard=10(隐藏4/inline0)
after  : firstTop=255  A=0  B=11  feedCard=10(隐藏10/inline10)
序列   : other other B B B B B B B B B B B
```

**首屏第一张卡 `top` 保持 255（与基线一致）→ 零留白。A 数量归零。B 填满首屏。**

---

## 1. 对照表（Lead 要求的格式）

| 方案 | 首屏第一张卡 top | 首屏 A 数 | 首屏 B 数 | 留白 | 滚动 | Vue 是否回填 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **基线（不动）** | **255** | 6 | 5 | — | — | — | 参照 |
| **路径1 `display:none`** | **255** ✅ | **0** ✅ | **11** ✅ | ❌ **无** ✅ | 正常 ✅ | 未回填 ✅ | ✅ **合格** |
| 路径2a `visibility:hidden` | 255 | **6** ❌ | 5 ❌ | — | — | — | ❌ 不合格 |
| 路径2a `height:0;overflow:hidden` | 255 | **6** ❌ | 5 ❌ | — | — | — | ❌ 不合格（还让轮播塌了 433→360） |
| **路径3 `el.remove()`** | **255** ✅ | **0** ✅ | **11** ✅ | ❌ **无** ✅ | 正常 ✅ | **3 秒内未回填** ✅ | ✅ **合格** |

### 只有路径 1 和路径 3 合格。

---

## 2. 为什么路径 1 不漏白（机制实测）

### 2.1 `.feed-card` 是 grid 的**直接子元素**

```
.grid 直接子元素（前 16）
[ 0] recommended-swipe   top=255 h=433      ← 轮播
[ 1] feed-card           top=255 h=207      ← A 批（10 个）
...
[10] feed-card           top=  0 h=  0
[11] floor-single-card   top=708 h=222      ← 楼层分隔
[12] bili-feed-card      top=708 h=222      ← B 批
[13] bili-feed-card      top=951 h=207
```

**`.feed-card` 的父元素就是 `.container.is-version8`（`display:grid`，48 个子元素）。**

### 2.2 藏掉之后，grid 自动补位（实测）

```
藏之后 grid kids（前 16）
[ 0] recommended-swipe   top=255 h=449      ← 轮播高度反而 433→449
[ 1] feed-card           top=  0 h=  0      ← 10 个全塌成 0 高度
...
[10] feed-card           top=  0 h=  0
[11] floor-single-card   top=255 h=222      ← ★ 从 708 提到 255
[12] bili-feed-card      top=255 h=222      ← ★ B 批顶到 255
[13] bili-feed-card      top=497 h=207
```

> ### **`display:none` 的 grid item 不占位，后面的 item 自动上移补位。**
> **不存在"空占位"、不存在 `grid-row` 写死的问题。**
> 藏之后 grid 里有高度的子元素 30 个、可见卡 27 张 —— **位置全部被 B 批和楼层卡填满。**

### 2.3 `bodyHeight` 从 2382 → 2155（少 227px）

这是**正常收缩**（去掉 10 个卡的高度），不是留白。
首屏 `firstTop` 不变 = **没有空洞**。

### 2.4 为什么 `visibility:hidden` 不合格

`visibility:hidden` **保留布局**，元素仍占 207px 高度，所以：
- A 的卡仍在首屏位置（只是看不见）→ **首屏 A 数仍是 6**
- 而且**用户看到的是空白格**（这正是留白）

### 2.5 为什么 `height:0` 不合格

`height:0` 没让元素脱离布局，grid 仍按零高度占位；
且它**把轮播也带塌了**（`swipeH: 433 → 360`）—— 说明有连带影响。
A 仍是 6。

---

## 3. 耐受性验证（滚动 3 轮）

`probe-durability.mjs`，施加 `display:none` 后连滚 3 次：

| 阶段 | firstTop | total | A | B | feedCard 数 | 隐藏 | inline 保持 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before | 255 | 39 | 6 | 5 | 10 | 4 | 0 |
| t0（施加后） | 255 | 39 | **0** | 11 | 10 | **10** | **10** |
| round 1 | 255 | 48 | **0** | 11 | 10 | 10 | 10 |
| round 2 | 255 | 57 | **0** | 11 | 10 | 10 | 10 |
| round 3 | 255 | 66 | **0** | 11 | 10 | 10 | 10 |

**结论**：
- ✅ A 始终为 0
- ✅ `feed-card` 数量始终 10（Vue 没有重建元素）
- ✅ **inline `display:none` 全部保持**（Vue 没有覆盖）
- ✅ `firstTop` 始终 255

---

## 4. 路径 3（`el.remove()`）—— 也合格，但不如路径 1

| 项 | 结果 |
| --- | --- |
| 1 秒后 | `feed-card` 剩 **0**，A=0，firstTop=255 |
| 3 秒后 | `feed-card` 剩 **0**（**Vue 没回填**），A=0，firstTop=255 |

**技术上同样合格，但风险更大**：
- `display:none` 可逆（删 style 即恢复），`remove()` **不可逆**
- Vue 以后若重新渲染该区域，`remove` 过的节点可能造成状态不一致
- **建议选路径 1**

---

## 5. 断言（我自己踩过的坑）

每次实验前都断言：

```js
const targets = [...document.querySelectorAll('.feed-card')];
const inSwipe = targets.filter(el => el.closest('.recommended-swipe'));
if (targets.length !== 10) throw new Error('命中数 ' + targets.length + ' != 10');
if (inSwipe.length !== 0) throw new Error('有 ' + inSwipe.length + ' 个在轮播内');
```

**实测结果：`feedCardCount: 10`，`inSwipe: 0`** —— 没有误伤轮播。

> 这对应我之前用 `:nth-of-type(-n+10)` 误伤 28 张的教训。

**注意**：`.feed-card` 与 `recommended-swipe` 是**兄弟关系**（都是 grid 子元素），
所以 `.feed-card` 选择器**天然不会命中轮播内的卡** —— 之前 154px 空洞确实是选择器写错导致的。

---

## 6. 仍未验证的（不掩盖）

| 项 | 状态 |
| --- | --- |
| **B 批是不是取流账号的数据** | ❌ **未验证** —— 取决于开关开启时 DNR 是否真的换了 `feed/rcmd` 的 Cookie |
| 切换开关后需要刷新吗 | ❌ 未测（样式注入时机 vs SSR 渲染时机） |
| 移动端/窄视口 | ❌ 未测 |
| Vue 长时间（>10 分钟）是否会重建 | ❌ 只测了 3 轮滚动约 15 秒 |
| 滚动很多次后新增的 `feed-card` | ❌ 未测（若 rcmd 也返回 `.feed-card` 类，后续新增的需要再次隐藏） |

> ⚠️ 最后一条值得注意：**新加载的卡会不会也带 `.feed-card` 类？**
> 本轮滚动后 `feedCardCount` 始终是 10，说明**新增的卡不带这个类** —— 这是好现象。

---

## 7. 开关文案确认

Lead 批准：「**首页推荐流使用取流账号**」—— 收到，写进实现时不改。

---

## 附：脚本

| 文件 | 用途 |
| --- | --- |
| `probe-no-blank.mjs` | 四种方案对照 + 父元素/空占位探查 |
| `probe-durability.mjs` | `display:none` 滚动 3 轮耐受性 |

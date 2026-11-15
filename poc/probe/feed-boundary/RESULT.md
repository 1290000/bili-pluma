# 推荐流分界线 · 条数稳定性探测

> **日期**：2026-11-11
> **问题**：只回答一个数值问题 —— 「首屏 SSR 批大小是否稳定为 10」，决定横线分界能否**按条数精确插入**。
> **范围**：不拓展到方案设计。

---

## 0. 结论先行

| 问题 | 结果 |
| --- | --- |
| **Q1 首屏 SSR 批大小** | **`[10,10,10,10,10]`，标准差 0**（两路独立方法交叉验证一致） |
| **Q2 rcmd 首次替换形态** | **不是"10→20 整体替换"，也不是"只替换前 N 条"** —— SSR 的 10 张卡在 rcmd 到达后**成为 24 条真实卡的一部分**（详见 §3，此处与任务预设不同） |
| **Q3 第 2/3 次滚动** | **每次净增 8 条，纯追加**，`droppedCount: 0`、`relativeOrderKept: true`、`newCardsBeforeOldHead: 0` |

### 判定标准（任务给定，写死在此）

> - 若 Q1 的 5 次全部为同一数值（标准差 0）**且** Q3 无顺序错乱 → **可按条数精确插入分界线**
> - 若 Q1 有波动 **或** Q3 有乱序 → 分界线无法精确插入

### 判定结果

> ## ✅ **可按条数精确插入分界线**
> Q1 标准差 = 0（10/10/10/10/10）；Q3 两组样本均无乱序。

---

## 1. 取证环境

| 项 | 值 |
| --- | --- |
| bsk | 0.3.3（`BSK_HOME=C:\Users\i1290\.bsk`，`BSK_AUTO_START=0`） |
| 浏览器 | Edge 157，扩展 browser-skill 0.3.3 |
| 登录态 | **已登录单账号**（`vipStatus:0`，非大会员） |
| 被测页面 | `https://www.bilibili.com/` |
| 脚本 | 本目录 `probe-q1-ssr-count.mjs` / `probe-q1b-domparser.mjs` / `probe-q2q3-scroll.mjs` / `probe-q2-breakdown.mjs` |

**⚠️ 游客态未测（硬红线）**：清 cookie 会破坏用户的登录态。按任务要求
「若会改变现有登录态，跳过并写明」，**本轮未做游客态对照**。
替代信息：上游 `RESULT.md` §10.2 已用 `credentials:'omit'` 在同一登录会话内取过一次，
游客态也是 **10 张**（那次不改变浏览器的 cookie，属于安全做法，但**不是本轮样本**）。

---

## 2. Q1：首屏 SSR 批大小

### 方法 A：原始 HTML 字符串统计（主路）

直接 `fetch` 主文档并统计 `bili-video-card is-rcmd` 出现次数。
这份 HTML 是**服务端原始字节**，尚未执行任何页面 JS —— 与「`document_start` 那一刻」同源。

每次带 `_t=时间戳` + `cache:'no-store'`，间隔 **3.2 秒**，共 5 次。

```
第 1 次: cardRcmd=10 imageLink=10 titles=10 feedDiv=10 len=181860
第 2 次: cardRcmd=10 imageLink=10 titles=10 feedDiv=10 len=182825
第 3 次: cardRcmd=10 imageLink=10 titles=10 feedDiv=10 len=188701
第 4 次: cardRcmd=10 imageLink=10 titles=10 feedDiv=10 len=184179
第 5 次: cardRcmd=10 imageLink=10 titles=10 feedDiv=10 len=189668

数组: [10,10,10,10,10]
均值: 10.000  标准差: 0.000  样本数: 5
是否全部相同: true
```

> HTML 长度在 181860–189668 之间波动（差 7.8 KB，是推荐内容不同导致的），
> 但**卡片数恒为 10** —— 这是"内容变、结构不变"的干净证据。

### 方法 B：`DOMParser` 解析后统计（交叉验证）

`DOMParser` 构建文档**不执行脚本、不加载资源**，是纯解析结果，
最接近「`document_start` 后 DOM 已解析但 JS 未跑」的状态。

```
第 1 次: .bili-video-card=12  .is-rcmd=10  有BV=9   标题=10
第 2 次: .bili-video-card=12  .is-rcmd=10  有BV=9   标题=10
第 3 次: .bili-video-card=12  .is-rcmd=10  有BV=10  标题=10
第 4 次: .bili-video-card=12  .is-rcmd=10  有BV=8   标题=10
第 5 次: .bili-video-card=12  .is-rcmd=10  有BV=9   标题=10

is-rcmd 数组: [10,10,10,10,10]   标准差: 0.000
```

**方法 A 与方法 B 结论一致：`.bili-video-card.is-rcmd` 恒为 10。**

### ⚠️ 一个必须写清的口径细节

- **`.bili-video-card` 总数 = 12**，不是 10
- **`.bili-video-card.is-rcmd` = 10**（这才是"首屏推荐批大小"）
- 另有 2 张是无 `is-rcmd` 类名的其他卡片骨架
- **"有 BV"数在 8–10 之间波动** —— 因为部分卡片是广告位（有标题、无 BV）
  → **不能用"有 BV 的卡数"做分界线判据**，必须用**卡片位置**（第 10 张之后）

### Q1 结论

> **首屏 SSR 批大小 = 10，5 次全同，标准差 0。**
> 口径：按 `.bili-video-card.is-rcmd` 计。
> 不能按"有 BV 的卡数"计（那会波动到 8–10）。

---

## 3. Q2：rcmd 首次替换后的条数

### 3.1 实测结构

页面加载完成、rcmd 首轮结束后（`readyState: complete`）逐张拆解 39 张卡：

```
total: 39
withBv: 24        withoutBv: 15
```

无 BV 的 15 张分**两类**（这是关键）：

| 类别 | idx | 有标题 | 说明 |
| --- | --- | --- | --- |
| **骨架占位** | 0, 1 | ❌ 无 | 首屏最前两张，加载前占位 |
| **广告卡** | 5, 9, 16, 25 | ✅ 有 | 标题如「Seedance每秒才一毛七」，`is-rcmd` 但无 BV |
| **尾部骨架** | 30–38 | ❌ 无 | 列表末尾预留下的占位 |

真实内容卡（有 BV）**严格连续**排在 idx 2–29 区间。

### 3.2 与任务预设的**不一致**（必须写明）

任务预设两种形态：
- (a) 整体替换：10 → 20
- (b) 只替换前 N 条

**实测都不是。** 实际是：

| 观测 | 值 |
| --- | --- |
| SSR 批 | 10 张 `is-rcmd` |
| 页面稳定后 `is-rcmd` 总数（前序 §10 实测） | **39–48**（含骨架与广告卡） |
| 页面稳定后**有 BV 的卡** | **23–24** |
| 首次 rcmd 请求数 | **2**（加载过程中打了两次） |

**所以 Q2 的准确表述是**：
> SSR 的 10 张卡**不是被单独替换掉的那一批**，而是**混在 rcmd 返回的列表里**。
> 页面稳定后的 23–24 条真实卡中，**分不出哪几条"来自 SSR"、哪几条"来自 rcmd"** ——
> 因为两者都是 `is-rcmd` 组件、都是同一个接口的数据形态。

> ⚠️ **这条对"分界线插在哪"有直接影响，但不改变本次判定**：
> 分界线要标的是「用户第一次触发新请求的位置」，那是个**滚动位置/条数位置**，
> 不依赖"哪几条来自 SSR"。见 §5。

### 3.3 后续每次滚动的净增（这是确定值）

| 观测 | 样本 1 | 样本 2（reload 后） |
| --- | --- | --- |
| 初始有 BV 卡数 | 23 | 24 |
| 第 2 次滚动后 | 31（+8） | 32（+8） |
| 第 3 次滚动后 | 39（+8） | 40（+8） |
| 每次 rcmd 请求数增量 | +1 | +1 |

**每次滚动恰好新增 8 条真实卡**（两组样本一致）。

---

## 4. Q3：顺序是否错乱

### 判定方法

每次滚动后取全部 BV 序列，检查旧卡在新序列中：
1. `relativeOrderKept`：旧卡之间的相对顺序是否单调递增（据此判"有没有插到中间"）
2. `keptCount` / `droppedCount`：旧卡保留/丢弃数
3. `newCardsAfterOldTail` / `newCardsBeforeOldHead`：新卡出现在旧卡末位之后还是插到前面

### 结果

**样本 1：**

| 区间 | prevCount | curCount | netAdd | keptCount | droppedCount | relativeOrderKept | newAfterOldTail | newBeforeOldHead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 初始 → 第 2 次 | 23 | 31 | **8** | 23 | **0** | ✅ **true** | 8 | **0** |
| 第 2 次 → 第 3 次 | 31 | 39 | **8** | 31 | **0** | ✅ **true** | 8 | **0** |

**样本 2（reload 后复现）：**

| 区间 | prevCount | curCount | netAdd | keptCount | droppedCount | relativeOrderKept | newAfterOldTail | newBeforeOldHead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 初始 → 第 2 次 | 24 | 32 | **8** | 24 | **0** | ✅ **true** | 8 | **0** |
| 第 2 次 → 第 3 次 | 32 | 40 | **8** | 32 | **0** | ✅ **true** | 8 | **0** |

### 序列首尾肉眼核对

```
初始: 前5=["BV1ycnN6zE3E","BV1SXH56UE1E","BV1eGWJ6uEfr","BV1H6nv6sEms","BV1ZAJm65EA9"]
第2次:前5=["BV1ycnN6zE3E","BV1SXH56UE1E","BV1eGWJ6uEfr","BV1H6nv6sEms","BV1ZAJm65EA9"]  ← 完全相同
第3次:前5=["BV1ycnN6zE3E","BV1SXH56UE1E","BV1eGWJ6uEfr","BV1H6nv6sEms","BV1ZAJm65EA9"]  ← 完全相同
```

**旧卡一条不少、顺序一点没动、新卡全部追加在末尾。**

### Q3 结论

> **无顺序错乱。** 两组样本 × 两个区间共 4 次比对，全部满足：
> `relativeOrderKept: true`、`droppedCount: 0`、`newCardsBeforeOldHead: 0`、`newCardsAfterOldTail: 8`。
> **新卡纯追加到末尾，旧卡零丢失、零位移。**

---

## 5. 判据结论（任务要求的最终判定）

### 给定判据逐条核对

| 判据项 | 要求 | 实测 | 通过 |
| --- | --- | --- | --- |
| Q1 五次同一数值 | 标准差 0 | `[10,10,10,10,10]`，sd=0（两路方法一致） | ✅ |
| Q3 无顺序错乱 | 无乱序 | 4 次比对全 true，零丢弃、零前插 | ✅ |

### 最终结论

> # ✅ **可按条数精确插入分界线**

**理由**：SSR 批大小恒为 10（标准差 0），且后续每次滚动都是**纯尾部追加 8 条**、
旧卡零位移 —— 所以「第 N 条之后就是新来源」这个位置**不会随时间漂移**。

### ⚠️ 但插入判据必须用「卡片位置」，不能用「有 BV 的卡数」

| 可用判据 | 稳定性 |
| --- | --- |
| 第 10 张 `.bili-video-card.is-rcmd` 之后 | ✅ **稳定**（sd=0） |
| 第 10 张 `.bili-video-card` 之后 | ❌ 不稳定（总数是 12，含 2 张非 rcmd 骨架） |
| 「有 BV 的第 N 张」之后 | ❌ **不稳定**（8–10 张浮动，广告卡无 BV） |
| 按滚动像素（约 1527px） | ❌ 不稳定（视口高度、卡片高度随设备变） |
| **按"第 10 个 is-rcmd 卡"的 DOM 位置** | ✅ **推荐** |

### 无法测到的部分（不拍）

| 项 | 原因 |
| --- | --- |
| **游客态** SSR 批大小 | **为避免影响用户登录态，未测**（清 cookie 是硬红线）。上游 §10.2 用 `credentials:'omit'` 在同会话内取到过 10 张，但那不是本轮独立样本 |
| 分界线在**换账号后**是否仍在第 10 条 | 需要跨账号实测，本机单账号做不了 |
| 移动端 / 窄视口下的是否仍为 10 | 未测（本机只测桌面 Edge 157 默认视口） |

---

## 6. 复现方式

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;C:\Users\i1290\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:PATH
bsk daemon start --foreground
bsk session start --no-focus --json                 # → session_id
bsk navigate --session <sid> "https://www.bilibili.com/"   # → tab

node poc/probe/feed-boundary/probe-q1-ssr-count.mjs  --session <sid> --tab <tab> --rounds 5
node poc/probe/feed-boundary/probe-q1b-domparser.mjs --session <sid> --tab <tab> --rounds 5
node poc/probe/feed-boundary/probe-q2-breakdown.mjs  --session <sid> --tab <tab>
node poc/probe/feed-boundary/probe-q2q3-scroll.mjs   --session <sid> --tab <tab>
```

⚠️ 四个脚本**全部只读**：只 `fetch` 主文档 + 滚动 + 读 DOM。
不点击视频、不发写请求、不登录/登出、不打印任何凭据。

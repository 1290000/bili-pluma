# proxy 吞吐量与冷热档实测（2026-11-18）

> 前两份报告的争议点是「proxy 慢不慢」，但**都只用 TTFB 说话**。TTFB 只回答"首字节多久到"，
> 而 4K 轨的 `bandwidth` 是 6–12 Mbps：若 proxy 这一跳在首字节之后限速，用户看到的是**卡顿**，
> 不是"多等 800 ms"。本报告补这个盲区：**下 2 MiB，量持续吞吐与 stall**。

---

## 0. 一句话结论

> **proxy 没有劣化 4K 播放**。36 对下载（每对 2 MiB）：proxy 吞吐中位 **7.78 MB/s**、
> 直连官方中位 **5.27 MB/s**，**stall 两边都是 0/36**，`truncated` 两边都是 0/36。
> 以"轨码率 × 1.5 余量"为可播判据，proxy **36/36 可播**、直连 **32/36**（4 条不可播全在 `mirrorcoso1`）。
> 但这不是"proxy 更快"的证据 —— **慢的是直连侧的 `mirrorcoso1`，不是 proxy 慢**（见 §4）。

> ## ⚠️ 更正（2026-11-19 01:45 +0800，16 MiB 长窗口实测后）
>
> **"慢的是 `mirrorcoso1` 这个镜像自己"这个定性错了。** 见 [`REPORT-long-window.md`](./REPORT-long-window.md)。
>
> - `mirrorcoso1` 不是"坏镜像"，是**慢启动镜像**：2 MiB 窗口量到的是它的**首桶**
>   （0.61–0.87 MB/s，首桶耗时 2.3–3.3 s），16 MiB 稳态是 **5.16–9.14 MB/s**，能撑 4K。
> - 因此"直连 32/36 可播、4 条失败全在 mirrorcoso1"是**短窗口的产物**：
>   16 MiB 下 8 条直连**稳态全部够播（8/8）**，只有 1/8 首桶不足。
> - **本报告的主结论"proxy 没有劣化 4K"仍然成立**（16 MiB 下 proxy 8/8 全程不掉速，`末/首` 1.68–6.25）。
> - **但"proxy 更好"这个引申不成立**：两者稳态都能撑 4K，proxy 的优势只在**起播（首桶）**与稳态上限。

---

## 1. 口径（先说清楚，否则数字会被误读）

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-11-18T16:38Z（`proxy-throughput.json` 的 `sourceAt`） |
| 测量时间 | 2026-11-18T17:17Z（同上 `at`），**采集后约 39 分钟**，签名 `deadline` 未过期 |
| 下载量 | `Range: bytes=0-2097151`（2 MiB，`content-length` 2097153，实测每次都拿满） |
| 请求头 | 同前两份报告：登录态 UA + `Referer: https://www.bilibili.com/` |
| T 组样本 | **12 对象 × 3 轮 = 36 对**，proxy / direct 逐对象交替顺序（`P→D` / `D→P` 各半） |
| C 组样本 | 2 个**全新**对象（采集时已排除上一轮全部 bvid），每个连续 5 次 |
| 串行间隔 | 150 ms；单次下载超时 60 s |
| stall 判据 | 相邻 chunk 间隔 > 2000 ms |
| 可播判据 | `吞吐 ≥ 轨带宽 × 1.5`（1.5 是给缓冲填充留的余量，`proxy-throughput.json` 里的 `sustainFactor`） |

### 样本规模（与任务书给的数不一致，以此为准）

任务书提到"8 视频 25 轨"，那是**上一轮**（`v1-path-candidates.json`）的规模。
本轮冷样本池 `proxy-throughput-candidates.json` 的实际口径是：

| 项 | 实测 |
| --- | --- |
| 视频数 | **7**（`BV1NDsS6UE8D`、`BV16Qsp6AEaL`、`BV1yAsF6qEot`、`BV1oZsu6DEr5`、`BV1r5sP61Epx`、`BV15osT6yEgQ`、`BV1MssN6ZEri`） |
| 2160p 轨数 | **21** |
| 轨形态 | `(height,width,id) = (2160,3840,120)` × **20** + `(2160,3840,126)` × **1** |
| 含真实 `/v1` 候选的轨 | **14** |
| 采数轮数 | 5 轮 API 直取（`rounds: 5`），7 次 sweep 全部命中 |

> **不是 8 视频 25 轨。** 12 对 T 组样本和 2 个 C 组对象都取自这 7 视频 / 21 轨。

---

## 2. T 组完整表（36 对，proxy 与 direct 成对）

`MB/s = 2 MiB / (首块到达 → 最后一字节到达)`，**不含 TTFB**；"最大间隔"是相邻 chunk 的最大间隔。

| 轮 | 对象 | cc | 轨码率 Mbps | 直连 host（peer index2） | 顺序 | proxy st | proxy TTFB | proxy MB/s | proxy 最大间隔 | direct st | direct TTFB | direct MB/s | direct 最大间隔 |
| -- | ---- | -- | ---- | ---- | ---- | -- | -- | -- | -- | -- | -- | -- | -- |
| 1 | BV1NDsS6UE8D#t0 | 7 | 11.28 | upos-sz-mirrorcoso1.bilivideo.com | D→P | 206 | 460 | 5.71 | 44ms | 206 | 1603 | 0.62 | 266ms |
| 1 | BV16Qsp6AEaL#t1 | 12 | 13.60 | upos-sz-mirrorhw.bilivideo.com | P→D | 206 | 128 | 36.68 | 4ms | 206 | 51 | 27.27 | 6ms |
| 1 | BV1oZsu6DEr5#t2 | 13 | 2.02 | upos-sz-mirrorhwo1.bilivideo.com | D→P | 206 | 125 | 47.04 | 2ms | 206 | 93 | 7.93 | 56ms |
| 1 | BV1yAsF6qEot#t1 | 12 | 7.36 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 285 | 8.03 | 33ms | 206 | 432 | 2.39 | 200ms |
| 1 | BV1r5sP61Epx#t1 | 12 | 2.55 | upos-sz-mirrorbd.bilivideo.com | D→P | 206 | 345 | 6.52 | 36ms | 206 | 167 | 0.96 | 134ms |
| 1 | BV15osT6yEgQ#t1 | 12 | 4.66 | upos-sz-estgoss.bilivideo.com | P→D | 206 | 462 | 3.70 | 61ms | 206 | 387 | 5.12 | 61ms |
| 1 | BV1MssN6ZEri#t0 | 12 | 23.21 | upos-sz-estgoss.bilivideo.com | D→P | 206 | 407 | 5.88 | 45ms | 206 | 141 | 10.66 | 9ms |
| 1 | BV1NDsS6UE8D#t1 | 12 | 3.10 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 415 | 3.58 | 62ms | 206 | 2594 | 0.53 | 209ms |
| 1 | BV16Qsp6AEaL#t2 | 13 | 13.94 | upos-sz-estgoss.bilivideo.com | D→P | 206 | 342 | 7.49 | 34ms | 206 | 370 | 5.12 | 62ms |
| 1 | BV1oZsu6DEr5#t1 | 12 | 2.94 | upos-sz-estgoss.bilivideo.com | P→D | 206 | 391 | 3.49 | 67ms | 206 | 130 | 10.55 | 13ms |
| 1 | BV1r5sP61Epx#t2 | 13 | 1.59 | upos-sz-mirrorbd.bilivideo.com | D→P | 206 | 165 | 26.59 | 7ms | 206 | 34 | 3.80 | 90ms |
| 1 | BV15osT6yEgQ#t2 | 13 | 3.29 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 84 | 47.02 | 6ms | 206 | 1070 | 0.61 | 288ms |
| 2 | BV1NDsS6UE8D#t0 | 7 | 11.28 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 433 | 5.25 | 49ms | 206 | 437 | 2.04 | 247ms |
| 2 | BV16Qsp6AEaL#t1 | 12 | 13.60 | upos-sz-mirrorhw.bilivideo.com | D→P | 206 | 161 | 36.34 | 6ms | 206 | 49 | 25.96 | 13ms |
| 2 | BV1oZsu6DEr5#t2 | 13 | 2.02 | upos-sz-mirrorhwo1.bilivideo.com | P→D | 206 | 156 | 44.07 | 4ms | 206 | 60 | 31.47 | 8ms |
| 2 | BV1yAsF6qEot#t1 | 12 | 7.36 | upos-sz-mirrorcoso1.bilivideo.com | D→P | 206 | 308 | 8.69 | 33ms | 206 | 426 | 3.67 | 205ms |
| 2 | BV1r5sP61Epx#t1 | 12 | 2.55 | upos-sz-mirrorbd.bilivideo.com | P→D | 206 | 341 | 6.80 | 33ms | 206 | 30 | 23.42 | 17ms |
| 2 | BV15osT6yEgQ#t1 | 12 | 4.66 | upos-sz-estgoss.bilivideo.com | D→P | 206 | 467 | 3.55 | 64ms | 206 | 343 | 5.36 | 57ms |
| 2 | BV1MssN6ZEri#t0 | 12 | 23.21 | upos-sz-estgoss.bilivideo.com | P→D | 206 | 401 | 5.79 | 46ms | 206 | 128 | 11.33 | 6ms |
| 2 | BV1NDsS6UE8D#t1 | 12 | 3.10 | upos-sz-mirrorcoso1.bilivideo.com | D→P | 206 | 473 | 3.57 | 63ms | 206 | 1556 | 0.51 | 313ms |
| 2 | BV16Qsp6AEaL#t2 | 13 | 13.94 | upos-sz-estgoss.bilivideo.com | P→D | 206 | 331 | 7.53 | 35ms | 206 | 395 | 4.84 | 61ms |
| 2 | BV1oZsu6DEr5#t1 | 12 | 2.94 | upos-sz-estgoss.bilivideo.com | D→P | 206 | 91 | 23.00 | 32ms | 206 | 134 | 11.12 | 9ms |
| 2 | BV1r5sP61Epx#t2 | 13 | 1.59 | upos-sz-mirrorbd.bilivideo.com | P→D | 206 | 160 | 23.87 | 8ms | 206 | 35 | 33.98 | 6ms |
| 2 | BV15osT6yEgQ#t2 | 13 | 3.29 | upos-sz-mirrorcoso1.bilivideo.com | D→P | 206 | 94 | 33.66 | 6ms | 206 | 1167 | 0.58 | 332ms |
| 3 | BV1NDsS6UE8D#t0 | 7 | 11.28 | upos-sz-mirrorcoso1.bilivideo.com | D→P | 206 | 326 | 5.40 | 49ms | 206 | 472 | 2.05 | 296ms |
| 3 | BV16Qsp6AEaL#t1 | 12 | 13.60 | upos-sz-mirrorhw.bilivideo.com | P→D | 206 | 86 | 37.43 | 5ms | 206 | 36 | 32.92 | 6ms |
| 3 | BV1oZsu6DEr5#t2 | 13 | 2.02 | upos-sz-mirrorhwo1.bilivideo.com | D→P | 206 | 14 | 57.27 | 3ms | 206 | 38 | 28.10 | 13ms |
| 3 | BV1yAsF6qEot#t1 | 12 | 7.36 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 250 | 8.15 | 33ms | 206 | 466 | 2.13 | 286ms |
| 3 | BV1r5sP61Epx#t1 | 12 | 2.55 | upos-sz-mirrorbd.bilivideo.com | D→P | 206 | 240 | 6.88 | 34ms | 206 | 125 | 31.76 | 5ms |
| 3 | BV15osT6yEgQ#t1 | 12 | 4.66 | upos-sz-estgoss.bilivideo.com | P→D | 206 | 386 | 3.60 | 64ms | 206 | 399 | 5.18 | 55ms |
| 3 | BV1MssN6ZEri#t0 | 12 | 23.21 | upos-sz-estgoss.bilivideo.com | D→P | 206 | 338 | 5.62 | 50ms | 206 | 141 | 10.53 | 8ms |
| 3 | BV1NDsS6UE8D#t1 | 12 | 3.10 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 378 | 3.57 | 64ms | 206 | 1094 | 0.58 | 300ms |
| 3 | BV16Qsp6AEaL#t2 | 13 | 13.94 | upos-sz-estgoss.bilivideo.com | D→P | 206 | 77 | 18.79 | 34ms | 206 | 377 | 5.36 | 53ms |
| 3 | BV1oZsu6DEr5#t1 | 12 | 2.94 | upos-sz-estgoss.bilivideo.com | P→D | 206 | 93 | 22.29 | 31ms | 206 | 146 | 10.58 | 10ms |
| 3 | BV1r5sP61Epx#t2 | 13 | 1.59 | upos-sz-mirrorbd.bilivideo.com | D→P | 206 | 18 | 53.84 | 3ms | 206 | 30 | 32.08 | 5ms |
| 3 | BV15osT6yEgQ#t2 | 13 | 3.29 | upos-sz-mirrorcoso1.bilivideo.com | P→D | 206 | 18 | 58.26 | 2ms | 206 | 436 | 1.79 | 272ms |

### 全体汇总（`proxy-throughput.json` → `throughput`）

| 指标 | proxy | 直连官方 |
| --- | ---: | ---: |
| 吞吐中位 | **7.78 MB/s** | **5.27 MB/s** |
| 吞吐 p10 / p90 | 3.57 / 47.03 | 0.60 / 31.62 |
| 吞吐 min / max | 3.49 / 58.26 | 0.51 / 33.98 |
| TTFB 中位 / p90 | **297 / 447 ms** | **255 / 1131 ms** |
| stall（最大间隔 >2 s） | **0/36** | **0/36** |
| 未下满 2 MiB（`truncated`） | **0/36** | **0/36** |
| 最大 chunk 间隔的全局峰值 | **67 ms** | 332 ms |
| 可播 4K（`吞吐 ≥ 码率×1.5`） | **36/36** | **32/36** |

逐对比值（proxy MB/s ÷ direct MB/s）：中位 **2.05**、p10 0.52、p90 8.11、min 0.22、max 77.08；
proxy 更快 **26/36**。

> **注意两个比值不要混用**：`2.05` 是"逐对比值的中位"，`1.48` 是"两个中位数的比"（7.78/5.27）。
> 二者都不是稳定属性，随镜像构成剧烈变化（见 §3）。

---

## 3. 按镜像分组（关键：整体数字被一个镜像主导）

| 镜像 | n | proxy 吞吐中位 | proxy p10–p90 | direct 吞吐中位 | direct p10–p90 | 逐对比值中位 | proxy TTFB 中位 | direct TTFB 中位 | 轨码率中位 | 需求（×1.5）中位 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| **upos-sz-mirrorcoso1.bilivideo.com** | 12 | 6.87 | 3.57–45.68 | **1.21** | **0.53–2.37** | **6.48** | 317 | **771** | 5.32 | 0.95 |
| upos-sz-estgoss.bilivideo.com | 12 | 5.84 | 3.56–21.94 | 7.95 | 5.12–11.07 | **0.71** | 364 | 245 | 9.30 | 1.66 |
| upos-sz-mirrorbd.bilivideo.com | 6 | 15.38 | 6.66–40.22 | 27.59 | 2.38–33.03 | 1.19 | 203 | 35 | 2.07 | 0.37 |
| upos-sz-mirrorhw.bilivideo.com | 3 | 36.68 | 36.41–37.28 | 27.27 | 26.23–31.79 | 1.35 | 128 | 49 | 13.60 | 2.43 |
| upos-sz-mirrorhwo1.bilivideo.com | 3 | 47.04 | 44.66–55.22 | 28.10 | 11.96–30.80 | 2.04 | 125 | 60 | 2.02 | 0.36 |

**读法**：proxy 对 `mirrorcoso1` 是压倒性的（6.87 vs 1.21），但对 `estgoss` 是**输的**（5.84 vs 7.95，0.71×），
对 `mirrorbd` 也略输（15.38 vs 27.59，1.19×）。**"proxy 更快"只在慢镜像上成立。**

**排除 `mirrorcoso1` 后的反事实**（这是我算的，不是任务书给的）：

| 口径 | n | proxy 吞吐中位 | direct 吞吐中位 | 逐对比值中位 | proxy 更快 |
| --- | --: | --: | --: | --: | --: |
| 全体 | 36 | 7.78 | 5.27 | 2.05 | 26/36 |
| **排除 `mirrorcoso1`** | **24** | **13.16** | **10.62** | **1.37** | **14/24** |

即：**去掉这一个镜像，proxy 的优势从 2.05 降到 1.37，从"26/36 更快"降到"14/24 更快"（勉强过半）。**
所以整体优势**不能外推**为"proxy 普遍更快"。

---

## 4. 慢的是谁：`mirrorcoso1` 的直连，不是 proxy

> ## ⚠️ 更正（2026-11-19 01:45 +0800，16 MiB 长窗口实测后）
>
> **本节把 `mirrorcoso1` 定性为"慢镜像"是错的，已由 16 MiB 数据推翻。**
> 见 [`REPORT-long-window.md`](./REPORT-long-window.md)。
>
> - 本节的 `1.21 MB/s` 是 **2 MiB 首桶读数**，不是稳态。同一对象（`BV1NDsS6UE8D#t0`）在 16 MiB 下：
>   首桶 **0.61**、全程平均 ≈3.1、**稳态（后 4 桶中位）5.16 MB/s**，首桶耗时 3.3 s，`末/首 = 9.394`。
> - 所以它是**慢启动镜像**，不是持续限速的"坏镜像"。稳态 5.16–9.14 MB/s 完全能撑 4K。
> - 本节"4 条直连不可播全在 `mirrorcoso1`"同样是 2 MiB 窗口的产物：
>   16 MiB 下 8 条直连**稳态全部达到播放需求（8/8）**，真正首桶不足的只有 1/8。
> - **新发现**：真正的"中途限速"在 **`mirrorbd`**（首段 11.8/18.2 MB/s → 第 2 桶断崖至 0.94/1.37 并持续），
>   但按轨码率算余量仍有 1.96× / 4.58×，**也不导致卡顿**。
>
> 下方原文保留，以便对照"短窗口会得出什么结论"。

`mirrorcoso1` 是本轮唯一一条**直连吞吐掉到 1 MB/s 量级**的镜像：

- 12 次直连全部落在 **0.51–3.67 MB/s**，中位 **1.21 MB/s**；
- 12 次直连 TTFB 全部 ≥ 426 ms，中位 **771 ms**，峰值 **2594 ms**；
- `BV1NDsS6UE8D#t1`（轨码率 3.10 Mbps，需求 0.55 MB/s）三次直连只有 **0.53 / 0.51 / 0.58 MB/s** ——
  贴着需求线，**三次里两次不够**；这正是"直连 32/36 可播"里 4 条失败中的 3 条；
- 第 4 条失败是 `BV15osT6yEgQ#t2`（需求 0.59 MB/s，拿到 0.58 MB/s）。

**4 条直连不可播的样本，`peerHost` 全是 `mirrorcoso1`**，无一例外（逐条见下）：

| 轮 | 对象 | 需求 MB/s（×1.5） | 直连实测 | proxy 实测 |
| -- | ---- | --: | --: | --: |
| 1 | BV1NDsS6UE8D#t0 | 2.02 | **0.62** | 5.71 |
| 1 | BV1NDsS6UE8D#t1 | 0.55 | **0.53** | 3.58 |
| 2 | BV1NDsS6UE8D#t1 | 0.55 | **0.51** | 3.57 |
| 2 | BV15osT6yEgQ#t2 | 0.59 | **0.58** | 33.66 |

### 这个慢是跨轮稳定的，不是偶发

同一台机器上三份独立测量都指向 `mirrorcoso1` 慢：

| 数据源 | `mirrorcoso1` | 其他官方镜像 |
| --- | --- | --- |
| 本报告 T 组直连（n=12） | TTFB 中位 **771 ms**、吞吐中位 **1.21 MB/s** | `mirrorhw` 49 ms / 27.3；`mirrorbd` 35 ms / 27.6；`estgoss` 245 ms / 7.9 |
| `proxy-paired-latency.json`（n=27 / 6 / 12） | TTFB 中位 **277 ms**、max 974 ms | `mirrorbd` 35 ms / max 44；`estgoss` 186 ms / max 360 |
| `v1-path-on-official.json` Q1/Q2b（403 也是真实响应） | TTFB 中位 **431 ms**、max **2743 ms**（n=10） | `mirrorhw` 10 ms / max 235；`estgoss` 49 ms / max 203 |

三次测量的绝对值不同（时段、网络状况不同），但**排序完全一致**：`mirrorhw`/`mirrorbd` 最快，
`estgoss` 中间，`mirrorcoso1` 最慢。**这说明"换 host 到官方镜像"的 128 ms 基准不是全镜像通用** ——
如果规则 A 恰好抽到 `mirrorcoso1`，直连反而可能比 proxy 更差。

> ⚠️ 一条重要限定：本轮的 `mirrorcoso1` 样本全部来自**其中 3 个视频的 peer index2**，
> 不能排除"这几个对象在 `mirrorcoso1` 上恰好是冷对象/被限速"的可能。
> 但跨三份数据的一致排序，使"镜像本身慢"比"对象偶发"更可信。

---

## 5. C 组：冷对象是否必落慢档（本轮核心判断）

2 个**全新**对象（采集时排除了上一轮全部 7 个 bvid，proxy 边缘此前**从未见过它们**），
同一 proxy URL 连续 5 次。第 1 次下 2 MiB（走真实冷路径），第 2–5 次下 1 KiB（只看首字节档位，避免又把对象焐热）。

| 对象 | 第 1 次（2 MiB） | 第 2 次 | 第 3 次 | 第 4 次 | 第 5 次 | 降幅 |
| --- | --: | --: | --: | --: | --: | --: |
| BV1MssN6ZEri#t2（cc12，14.51 Mbps） | **384 ms** | 88 | 89 | 88 | 90 | **−296 ms** |
| BV1MssN6ZEri#t3（cc13，13.33 Mbps） | **278 ms** | 56 | 57 | 59 | 59 | **−220 ms** |

**判断**：**是两档，不是"冷对象必慢"。**

1. 首次 **384 / 278 ms**，后续**稳定在 88–90 / 56–59 ms**，中间没有连续过渡 ⇒ 与第一轮观察到的"两档"一致；
2. 但首次的两个值（384、278）**都远低于第一轮的 949 ms，也低于本轮 `slowThresholdMs = 600` 的判据** ——
   **`firstSlow = 0/2`、`restSlow = 0/8`**，即本轮**没有任何一次落进慢档**；
3. 降幅 296 / 220 ms 说明"首次确实比后续慢"，但**慢的幅度只是几百毫秒级**，不是 900 ms 级。

**缓存假设的裁决：方向成立，但不足以支撑"用户首块必慢"。**

- 支持：首次明显慢于后续（2/2 降幅 >200 ms）；上一轮 9 个全新对象的冷/热对照也是首次 345 ms → 二次 265 ms（降 80 ms）。
- 不支持：n=2 太小；且这两次首次就落在**快档**（<600 ms），说明"冷"并不必然等于"949 ms 那一档"。
- 因此：**949 ms 更像是某一时段/某条边缘链路的属性，而不是"冷对象"的必然结果。**

> 口径诚实说明：C 组只有 **2 个对象**（冷样本池共 14 条含 `/v1` 的轨，T 组已用掉 12 条，只剩 2 条）。
> 这个样本量**只能证伪"冷必慢"，不能确证"冷只是略慢"**。要确证需要新一轮采集。

---

## 6. TTFB 的两档在新数据里怎么落

| 分布区间 | 本轮 proxy（n=36） | 上一轮 proxy（n=45） | 第一轮 proxy（n=18） |
| --- | --: | --: | --: |
| <100 ms | 9 | 14 | 0 |
| 100–199 ms | 6 | 8 | 2 |
| 200–299 ms | 3 | 2 | 3 |
| 300–399 ms | 10 | 11 | 2 |
| 400–499 ms | 8 | 10 | 1 |
| **500–799 ms** | **0** | **0** | **0** |
| **≥800 ms** | **0** | **0** | **10** |

本轮 proxy 的 TTFB 上界是 **473 ms**，一次都没进 500 ms 以上区间。
上一轮 45 次同样 0 次 ≥800 ms，分布上界 474 ms。
**两次独立测量都没有复现第一轮的 ≥915 ms 档**（那一档有 10/18 条）。

第一轮那 18 条 proxy 的原始值（`rewrite-4k-results.json`，`mirror = proxy(wrapped)`）：

```
109, 180, 229, 266, 267, 336, 339, 478,   ← 8 条，≤478 ms
915, 982, 1007, 1011, 1033, 1067, 1068, 1085, 1093, 1203   ← 10 条，≥915 ms
```

**478 → 915 之间完全空白**，这就是任务书说的"两档"。本报告与上一轮的 81 次测量里，
这个空白区间的两侧都不再出现 ≥800 ms 的样本 ⟹ 那一档**在 11-18 的两个时段完全消失**。

> 这与 §4 的发现互补：**慢的那一档在直连侧出现了（6 次 ≥500 ms，峰值 2594 ms，全在 `mirrorcoso1`），
> 在 proxy 侧一次都没出现。** 若第一轮记录里的 949 ms 事实上是"某条慢链路"的读数，
> 那它未必属于 proxy 本身。
>
> ⚠️ 不能反过来说"proxy 变快了"。三次测量分别在 11-17 深夜、11-18 傍晚、11-18 深夜，
> 环境变量（出口链路、B站边缘负载）都在变；**能确定的只有"949 ms 不是稳定属性"**。

---

## 7. 明确回答任务书的三个问题

### Q1：proxy 的吞吐是否低于直连官方？

**整体上不低于，但这不能当成"proxy 更好"的证据。**

- 全体 36 对：proxy 中位 **7.78** vs 直连 **5.27 MB/s**，逐对比值中位 **2.05**、p10 **0.52** / p90 **8.11**（置信区间很宽，横跨"proxy 慢一半"到"proxy 快 8 倍"）；
- **排除 `mirrorcoso1`（占 1/3 样本）后**：proxy 中位 **13.16** vs 直连 **10.62 MB/s**，逐对比值中位降到 **1.37**、p10–p90 仍很宽；
- 按镜像拆开看，**proxy 在 2 个镜像上是输的**：`estgoss` 0.71×、`mirrorbd` 1.19×（中位之比）。

**结论**：不能说"proxy 吞吐低于直连"，也不能说"proxy 吞吐高于直连"。
能说的是：**proxy 的吞吐没有低于"可播 4K"的门槛**（36/36），且**两边都没有 stall**。

### Q2：冷对象（每集第一次）是否必然落慢档？

**不必然。** C 组 2 个全新对象首次 **384 / 278 ms**，均落在快档（<600 ms），
后续 5 连发稳定在 **88–90 / 56–59 ms**。首次确实比后续慢 200–300 ms（缓存假设方向成立），
但**没有一次落进 900 ms 级**。⇒ **949 ms 不是"冷对象"的必然结果。**

### Q3：直连那条 ≥800 ms 的尾巴在哪？

上一轮 `proxy-paired-latency.json` 里 official ≥500 ms 的 5 次、≥800 ms 的 2 次，
**全部集中在 `upos-sz-mirrorcoso1.bilivideo.com`（974 / 892 ms）**，且该镜像 27 次的中位就是 277 ms，
而 `mirrorbd` 只有 35 ms。本轮 T 组进一步确认：**6 次 direct ≥500 ms 全在 `mirrorcoso1`**，
中位 771 ms、峰值 2594 ms、吞吐中位仅 1.21 MB/s。

⇒ **慢的是 `mirrorcoso1` 这个镜像，不是"官方直连"整体。** 上一条报告的 128 ms 基准仍成立，
但只对 `mirrorhw`（49 ms）/ `mirrorbd`（35 ms）这类快镜像成立，**对 `mirrorcoso1` 不成立**。

---

## 8. 一句话：4K 播放经 proxy 会不会卡

> **不会因为 proxy 而卡。** 36 对下载里 proxy **0 次 stall、0 次截断**，吞吐中位 7.78 MB/s，
> 最大 chunk 间隔 67 ms（直连侧的峰值反而是 332 ms）；按轨码率 × 1.5 余量判，**proxy 36/36 可播**。
> 真正有卡顿风险的是**直连 `mirrorcoso1`**（吞吐中位 1.21 MB/s，4 条不可播全在它身上）。
> ⇒ 若 ADR 0039 的规则 A 抽到慢镜像，**走 proxy 反而更稳**；"首块慢 949 ms"这笔代价在吞吐维度上不存在。

---

## 9. 局限（必须与结论一起读）

1. **样本小且构成偏斜**：12 个 T 组对象里 4 个（12 对）的 peer 是 `mirrorcoso1`，占 **1/3**。
   这个镜像又恰好是最慢的，**它就是整体"proxy 更快"的主要来源**。
   排除它之后，优势从 2.05 降到 1.37（§3），所以整体数字**不能当作 "proxy 更快" 的通用结论**。
2. **C 组只有 2 个对象**：只能证伪"冷必慢"，不能确证"冷只是略慢"。
3. **2 MiB 窗口很短**：轨码率 1.34 MB/s 时 2 MiB 只够 1.5 s 播放，23.21 Mbps 的轨只够 0.7 s。
   短窗口测不出"下载 30 s 后是否被限速" —— **长时段限速未测**。
   > ## ⚠️ 更正（2026-11-19 01:45 +0800）
   >
   > 这条局限**成立且已被证实**，但它低估了问题。16 MiB 实测（[`REPORT-long-window.md`](./REPORT-long-window.md)）
   > 发现短窗口的问题不只是"测不出长时段限速"，而是会**主动给出错误定性**：
   > 2 MiB 窗口量到的就是**首桶**，所以"慢启动"会被误读成"持续慢"。
   > `mirrorcoso1` 的 `1.21 MB/s` 正是首桶读数，其稳态是 5.16–9.14 MB/s。
   > 反过来，短窗口也可能**碰巧猜对**（`BV1r5sP61Epx#t1` 2 MiB 读数 0.96 ≈ 16 MiB 稳态 0.94），
   > 因为它的噪声恰好跨过了限速拐点 —— 正确率靠运气，不靠机制。
4. **单机单线路**：同一条家庭宽带、同一个出口。换网络（尤其跨省/跨运营商）结论可能完全不同。
5. **签名有效期约 2 小时**：本报告的数据采集于 16:38Z、测量于 17:17Z，属同一签名周期内，
   但**不可复现**——重跑必须重新采集。
6. **轮次效应无法与热缓存完全剥离**：T 组第 2/3 轮请求的是同一批 proxy URL（边缘已热），
   因此第 2/3 轮的数字**不能代表"用户首次观看"**。若要纯冷吞吐，需要用 3 倍数量的全新对象。

---

## 10. 边界遵守

| 项 | 状态 |
| --- | --- |
| 改 `src/` / `tests/` / `scripts/` / `entrypoints/` / `wxt.config.ts` | **无** |
| commit | **无** |
| 新增文件 | 1 个采集脚本改动（`collect-v1-path-candidates.mjs` 加 `V1_OUT` / `V1_EXCLUDE` 两个环境变量，向后兼容默认行为）+ 1 个测量脚本 + 本报告 |
| `.gitignore` | 新增 2 条（`proxy-throughput.json` / `proxy-throughput-candidates.json`，行 132–133），`git check-ignore -v` 确认命中 |
| 报告内完整 URL | **0 条**（只写 host / 对象 / 指标） |
| 测量执行 | 由 team-lead 在本地跑（`node poc/probe/pcdn-diag/measure-proxy-throughput.mjs`，83 s，exit 0）；本报告只基于已落盘 JSON |

## 复现

```bash
# 1) 采一批全新冷样本（排除上一轮 proxy 请求过的 bvid）
V1_OUT=proxy-throughput-candidates.json \
V1_EXCLUDE=BV1WMsm6zEfn,BV1Aqsz6mEX6,BV1kMsF6PEua,BV1Rqs66iEER,BV1t9sk6YE23,BV1K5sM6AELJ,BV18msM6zEqc \
V1_TARGET=14 V1_ROUNDS=5 \
node poc/probe/pcdn-diag/collect-v1-path-candidates.mjs

# 2) 测量（约 83 s）
node poc/probe/pcdn-diag/measure-proxy-throughput.mjs
```

签名有效期约 2 小时（`deadline` 参数），超时后必须重跑第 1 步。

---

## 附：与前两份报告的关系

- `REPORT-rewrite-4k.md`（ADR 0039 验证门 #1）：规则 A 15/15、规则 B 18/18 均 206，**命中率问题已结案**。
- `REPORT-v1-path-on-official.md`：规则 B **消不掉**（官方 host 不认 `/v1` 路径，6/6 `path-rejected`），
  并首次未复现 949 ms（§6）。本报告是该节 §6 的续篇 —— **从 TTFB 推进到吞吐**。
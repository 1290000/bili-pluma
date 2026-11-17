# 屏蔽 PCDN 开关 A/B 实测（2026-11-17 22:21 停）

**结论：样本不合格，不下结论。** 唯一跑完的一条视频**本来就不走 PCDN**，两组没有可比性。
本文同时记录三个汇总层缺陷的修法（已修，`--resummarize` 可验收）。

## 1. 样本量声明

| 项 | 数 |
| --- | --- |
| 计划 | 6 个长视频（`duration ≥ 600`）× A/B |
| 实际跑完 | **1 个视频 × 2 组**（`BV17osu6pEP9`，918s） |
| 因片长被剔除 | 0（6 个样本全部通过片长校验：918 / 2128 / 712 / 3830 / 2623 / 2124） |
| 作废 | 2（`gateState: no-sample`，见下） |
| 阻塞 | **bsk daemon / 浏览器连接在 22:16 之后反复断开**，`bsk open` 返回 `no_browser_connected`，剩余 5 个视频没跑 |

## 2. 唯一的表

```
bvid          组  片长  PCDN%  官方%  stall 起播s 换线  applied removed 闸门
BV17osu6pEP9  A   918      0    100     0  2.16    0  false      0  no-sample
BV17osu6pEP9  B   918      0    100     0  9.33   58  false      0  no-sample
```

**中位数**：A = PCDN 0% / stall 0 / 起播 2.16s；B 无可比样本。

## 3. 这条视频为什么不进对比

`A` 组 102 条分片请求 **全部落在 `cn-cq-gd-bcache-19/20`（官方自建 CDN）**，PCDN 请求数 **0**。
既然基线里根本没有 PCDN 流量，开关就不可能"把流量换走"——它测的是同一件事的两次。
`B` 组同样 0%，`removed: 0`，主世界连 `pcdn-filter-stats` 都没发（没东西可删）。

⇒ 这**不能算"开关无效"**，只能算"**这条片子本来就没走 PCDN**"。两种说法在报告里必须分开。

## 4. 三个汇总层缺陷（已修）

| # | 缺陷 | 事实 | 修法 |
| --- | --- | --- | --- |
| ① | `officialShare: 1` 被读成 1% | 它是 **0..1 的分数**，1 = **100%**；`per` 本身是对的（102/102） | 新增 `pcdnPct` / `officialPct`（已 ×100 带一位小数），对外只用这两个字段 |
| ② | `switches` 可疑 | 121 条请求、2 个 host、B=58 次 —— **这是对的**（音视频来自不同 host 会来回跳）；A=0 也对（同 host 连续） | 统一由 `countSwitches(media)` 从相邻 host 变化算；并加断言：`switches > media-1` 或 `> requests` **直接抛错**，不许静默写进报告 |
| ③ | `stats: []` → `applied=false` 假阴性 | "开了但没东西可删" 与 "真的没开" 被混为一谈 | 闸门改**三态**：A 组 `applied:true` → `bad`；B 组有 `applied:true` → `ok`；B 组无 stats **且该视频 A 组 PCDN=0** → `no-sample`（不进均值、保留在表里）；B 组无 stats 但 A 组 PCDN>0 → `bad` |

验收方式（不需要浏览器）：

```bash
npx tsx poc/probe/pcdn-diag/ab-filter.mjs --resummarize
```

## 5. 下次要跑对的三个前提

1. **样本必须先过"有 PCDN"这一关**：A 组（开关关）跑完后 `per.pcdn > 0` 才算有效样本，
   否则立刻换视频 —— 与片长校验同级，放在跑 B 组之前（省一半时间）。
2. **daemon 必须活过整场**：本轮 daemon 被 Job Object 收掉 3 次、浏览器连接断 1 次。
   建议把 `bsk daemon start --foreground` 放在**独立终端**里，不要挂在 agent 的后台任务上。
3. **实播秒用 Node 侧首末读数**（页面 `setInterval` 在后台标签页会被节流到 ~1 次/分钟；
   本轮两条 run 的 `实播` 都是 null，正是这个原因）。

# 屏蔽 PCDN 的 A/B 实测：**没跑出合格数据**（2026-11-17 21:05）

脚本 `poc/probe/pcdn-diag/ab-filter.mjs`　反例数据 `ab-filter.json`（gitignored）
**结论：这一轮没有可用数据。下面写清为什么、以及已经确证了什么，避免下次重新发现。**

## 1. 卡在哪（根因不是 bsk 观察不到 frame）

| 观察 | 证据 |
| --- | --- |
| 播放器**反复重开流**，`currentTime` 会倒退 | 同一页：`t=13.33, paused=true` → `v.play()` → 6 秒后 `t=5.98`（**Δ=-7.35**），期间 `paused=false` |
| 不是标签页隐藏导致 | 同一次读里 `document.visibilityState="visible"`、`hidden=false`、`readyState=4`、`height=3840` |
| 不是没网络 | 45 秒窗口里有 20 条分片请求，`cn-cq-gd-bcache-21/22` 各 10 条，全部 200 |
| 120 秒窗口里只有 ~2 秒真播 | 加了"实播秒"闸门（`ctEnd-ctStart`）后判死：`played=null/1.x`，`playOk=false` |

⇒ **在这样的窗口里 `stall=0` 是"没在播"的假象**，PCDN 占比也只是开头几秒的样本。
按主理人的口径（stall 是主指标），这种数据不能用，所以**一条也没进汇总**。

⚠️ 顺带一个**可能是产品 bug 的线索**（值得单独查）：`13.33 → 5.98` 是**往回 seek** 的特征，
而 Pluma 主世界有"还原观看进度"的响应改写（`main-world.js` 的 `PROGRESS_PATCH_PATHS`）。
是不是它每逢重开流就把进度拨回去，导致"永远播不过某几秒"，需要专门验一次。

## 2. 已经确证、可直接复用的三件事

1. **开关能拨、能读回**：面板 `显示 → 播放线路 → 屏蔽 PCDN 线路`，VOM 里是
   `@eN checkbox "屏蔽 PCDN 线路 …" [checked]`；拨完复核读到 `false/true`，与 storage 一致。
   ⚠️ 开关**不在「画质」页**（我前两轮都找错了页）。
2. **采集链路是对的**：host 用 `new URL(name).host` 当场取、`search` 一起带上，
   分类用生产函数 `classifyCdn(host, search)`；修好后 `unknown:0`。
3. **闸门真的会作废**：A 组出现 `applied:true`、或实播秒不足窗口 80% 的 run，都被判作废。

## 3. 这一轮踩掉的四个环境坑（都在脚本注释里留了原因）

| # | 坑 | 现在的做法 |
| --- | --- | --- |
| 1 | `data.bilibili.com` 埋点的 query 里嵌着 bilivideo 完整 URL ⇒ 25/47 条被当成"分片"，全是 unknown | 只认 pathname 以 `.m4s/.mp4/.flv/.ts` 结尾 |
| 2 | 关掉最后一个 agent 标签页后 `tab create` 报 `No observable document` | 常驻控制页 + 用返回的 `tab_id` 显式绑定 |
| 3 | 每次 `click` 用缓存 ctx 必失败（面板一开，控制状态就变） | 每次点击前强制 `sync` |
| 4 | VOM 里别的控件的 `[ctx: …]` 会重复整页文案 ⇒ 按 `includes` 找控件会点错（我因此误关了用户的「页内角标」，已恢复） | 按 `role + "引号内文案"` 精确匹配 |

## 4. 建议换路子（二选一）

- **A · 面板导出（最快）**：用户手动播 2 分钟，开关开/关各一次；我们读面板
  「本次线路 / 换线次数 / 开局耗时 / 采集窗口」+ 导出 JSON（含逐 host 请求数与 `filter.applied`）。
  口径就是产品自己的，缺点是样本靠人。
- **B · Playwright + 复制 profile（可自动化）**：`addInitScript` 能在 document_start 注入
  （正好解决"首屏 playurl 早于探针"），`--autoplay-policy=no-user-gesture-required`
  可避免自停，且能直接在 SW 里写 storage 翻开关、用 `page.on('request')` 抓逐条请求。
  需要一次性搭建。

我倾向 **B**：8×2 的串联需要可重跑，而 bsk 这条链在标签页/帧/会话上的抖动今天已经出现 5 次。

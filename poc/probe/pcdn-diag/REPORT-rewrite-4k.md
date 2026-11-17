# ADR 0039 验证门 #1：4K（2160p）换 authority 命中率实测（2026-11-17）

脚本：`collect-4k-candidates.mjs`（取数） / `verify-rewrite-4k.mjs`（发请求） / `recompute-4k-summary.mjs`（重算汇总）
原始数据：`rewrite-4k-candidates.json`（**含签名 URL，已 gitignored**）、`rewrite-4k-results.json`（只记 host 与 path 形态，已 gitignored）
**本报告不含任何带签名的完整 URL。**

---

## 0. 一句话结论

> **2160p 路径在官方镜像上通：按 ADR 0039 两条规则改写后 33/33 = 100% 返回 206**
> （规则 A 15/15、规则 B 18/18），**ADR 0039 验证门第 1 条满足**。

同时顺手量了验证门 #2 的 proxy 延迟（见 §5）：proxy 一跳额外中位 **939 ms**，明显慢于直连成功路径，但
规则 B 的直连换 host 是**确定性 403**，所以这笔延迟是"把该候选从 PCDN 挪走"的必要代价，不是可选优化。

---

## 1. 样本口径（先说清数据是在什么前提下拿的）

| 项 | 实测值 |
| --- | --- |
| 时间 | 2026-11-17（本机，`D:\Projects\Pluma`） |
| 登录态 | `bsk` 复用日常 Edge profile，页面 `fetch(..., {credentials:'include'})`；`nav`: `isLogin=true`、`vipType=1`（年度会员，mid 已脱敏），**不是匿名** |
| 4K 权限 | 热门榜预筛 14 条 → 取前 8 条有 `height=2160` 轨的视频；8/8 的 `accept_quality` 含 **120** |
| 取数路径 | `/x/player/playurl?avid=…&cid=…&qn=120&fnval=4048&fourk=1`（与 `remaining-candidates.mjs` 同口径） |
| 视频数 / 轨数 | **8 视频 / 25 条 `height=2160` 轨 / 75 条候选** |
| 为什么是 25 不是 24 | 前次样本每视频 3 条编码；本次 `BV1MssN6ZEri` 多一条 **id=126、3840×2160** 的轨（共 4 条）。按任务定义的"`height=2160` 的轨"如实全收，没有挑掉 |
| 轨的 PCDN 分布 | 25 轨中 **20 轨**含 PCDN 候选，5 轨全官方；20 轨的 PCDN 候选**全部改写成功** |
| 请求规模 | **81 次**串行 Range 请求，间隔 150 ms，单请求超时 12 s（proxy 20 s），UA + `Referer: /video/<BV>/` + `Range: bytes=0-1023` |

> ⚠️ 环境实况：本机 `bsk` 实际是 **0.5.0**、`bsk doctor` 8/8 全绿（`--context` / `--expect` 可用）。
> 交接说明里写的"锁 0.3.3"与 `AGENTS-TOOLS.md` 一致但与本机实况不符；本次**没有升级任何东西**，只复用了现有 CLI。

---

## 2. 规则命中与 206 率

候选分类直接 import 生产函数 `classifyCdn(host, search)`（`src/core/cdn/classify.ts` 本体），第二参数 `search` 必传：

| 分类 | 条数 | 处理 |
| --- | ---: | --- |
| `pcdn` | **33** | 按规则 A / B 改写并发请求 |
| `official` | 42 | 只统计，不动、不发请求 |
| `third-party` / `unknown` / 解析失败 | 0 / 0 / 0 | — |

| 规则 | 条数 | 206 | 命中率 | 说明 |
| --- | ---: | ---: | ---: | --- |
| **A · 普通 PCDN 换官方镜像** | 15 | 15 | **100%** | 默认镜像 `upos-sz-mirrorhw.bilivideo.com` |
| **B · mcdn + `/v1/resource/upgcxcode/` 走 proxy** | 18 | 18 | **100%** | `proxy-tf-all-ws.bilivideo.com?url=<encodeURIComponent(原URL)>` |
| **最终改写合计** | **33** | **33** | **100%** | 0 个 403、0 超时、0 DNS 失败、0 无法映射 |

规则 B 的 18 条**额外**做了"直接换 host"的对照请求（预期 403，见 §4），这 18 次对照**不算**在最终改写命中率里
—— ADR 0039 的决定对这类候选规定的就是 proxy 包装，不是直接换 host。

静态校验：对全部 75 条候选执行"只改 `protocol`/`hostname`/`port`"的改写函数，
`pathname` / `search` / `hash` 变化 **0 条**（符合 ADR 边界 1）。

---

## 3. 按 host 分组：哪个镜像对 2160p 通

TTFB 由 Node `fetch` 响应头到达时刻计时；206 时读完首块前即 cancel body，不拉整段媒体。

| 目标 host | 请求数 | 206 | 结果分布 | 206 的中位 TTFB（范围） |
| --- | ---: | ---: | --- | --- |
| `upos-sz-mirrorhw.bilivideo.com` | 33 | 15 | 15×206 + **18×403**（全是规则 B 的直连对照） | **128 ms**（18–426 ms，n=15） |
| `upos-sz-mirrorcoso1.bilivideo.com` | 15 | 15 | 15×206 | 490 ms（452–3784 ms） |
| `upos-sz-estgoss.bilivideo.com` | 15 | 15 | 15×206 | 119 ms（85–351 ms） |
| `proxy-tf-all-ws.bilivideo.com` | 18 | 18 | 18×206 | 949 ms（109–1203 ms） |

⇒ **三个官方镜像对 2160p 的普通 PCDN 路径全通**（各 15/15）；
唯一不通的组合是"`*.mcdn.bilivideo.cn` + `/v1/resource/upgcxcode/` 直接换 host"，必须走 proxy 包装。
对照镜像是每轨最多抽 1 条的小样本，结论限于"能通"，**不用于比较谁更快**（样本不同、路径不同）。

---

## 4. 失败样本分析（403 的共性）

81 次请求里共 18 次非 206，**全部是 403**，且全部来自同一类对照：

| 共性维度 | 实测 |
| --- | --- |
| 规则 | 18/18 都是 `B/proxy(direct-control)`（把 mcdn 候选直接换 host 到官方镜像） |
| path 形态 | 18/18 都是 `/v1/resource/upgcxcode/…` |
| host 形态 | 18/18 都是 `xyNxNxNxNxy.mcdn.bilivideo.cn`（数字段已用 `N` 遮蔽），`mcdn` 独立标签 |
| 换成 proxy 后 | 18/18 → **206** |

没有任何一条规则 A 的改写失败，也没有 4xx 之外的错误。
这与匿名 720p 的 27/27 结论**形态一致**：那次是 25 条直换 206 + 2 条 mcdn 403→proxy 206；
本次把比例放大到 15 + 18，**特例的触发条件没有随画质改变**，只随 host/path 组合改变。

---

## 5. proxy 一跳延迟实测（验证门 #2 的副产品）

同一条候选的配对数据（18 对）：

| 路径 | 中位 TTFB | 范围 |
| --- | ---: | --- |
| 直连换 host → **403** | **9 ms** | 8–133 ms（快速失败） |
| proxy 包装 → **206** | **949 ms** | 109–1203 ms |
| proxy 相对"直连 403"的额外耗时 | **+939 ms** | 逐对差值中位数 |

若拿"真的能成功的直连"作参照更有意义：规则 A 默认镜像 206 的中位 TTFB 是 **128 ms**，
`estgoss` 是 **119 ms** ⇒ proxy 大约多 **0.8–0.9 s**。

**结论：proxy 明显慢于直连成功路径，值得单独处理，但不建议改成"直连失败才用 proxy"**——
这些候选的直连换 host 是**稳定 403**（18/18），先打一次直连只会确定性多花一次请求，然后照样得付 proxy 那一跳。
可行选项有两条，均**超出本期 ADR 0039 授权**，留给产品决策：

1. 保持 ADR 现状：mcdn 候选原位换 proxy，接受最多约 1 s 的额外首块延迟（本探针推荐，因改动最小）；
2. 若首播延迟敏感，需要 ADR 增量授权才能把 proxy 候选挪到 backup 位（本期边界 2/5 要求条数与顺序语义不变）。

---

## 6. 验证门状态

| 门 | 状态 | 证据 |
| --- | --- | --- |
| **#1 4K 换 host 命中率** | ✅ **满足** | 8 视频 / 25 条 2160p 轨 / 33 条 PCDN 候选，最终改写 **33/33 = 206**；规则 A 15/15、规则 B 18/18 |
| #2 proxy 延迟 | ✅ 已量（本探针顺带） | 额外中位 939 ms，见 §5；是否需要改策略待产品决策 |
| #3 守卫与测试全绿 | ⏳ 不在本探针范围 | 由实现工程师在 task #17 处理 |
| #4 真机冒烟 | ⏳ 不在本探针范围 | 同上 |

**边界遵守**：未改 `src/`、未改测试、未改守卫脚本、未改 `wxt.config.ts`、未改权限、未 commit；
只在 `poc/probe/pcdn-diag/` 新增 3 个脚本 + 本报告，并在 `.gitignore` 增加两条原始数据忽略规则。

---

## 复现

```bash
# 需要 bsk 会话在 B站页面；脚本会在 idle timeout 后自行 open
node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/collect-4k-candidates.mjs
node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/verify-rewrite-4k.mjs
node poc/probe/pcdn-diag/recompute-4k-summary.mjs
```

`recompute-4k-summary.mjs` 只读已落盘的逐请求记录重算汇总，**不发任何网络请求**；
要重测命中率请重跑前两条（约 1 分钟，含 81 次串行请求）。

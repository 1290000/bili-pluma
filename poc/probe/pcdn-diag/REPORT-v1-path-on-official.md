# 探针：`/v1/resource/upgcxcode/` 路径在官方 host 上能否直连（2026-11-18）

脚本：`collect-v1-path-candidates.mjs`（取数） / `verify-v1-path.mjs`（Q1–Q4） / `verify-v1-path-w.mjs`（决定性 W 组）
原始数据：`v1-path-candidates.json`、`v1-path-on-official.json`、`proxy-paired-latency.json`、`proxy-cache-effect.json`（**均含带签名 URL，已 gitignored**）
**本报告不含任何完整 URL**，只写 host + path 形态 + 参数个数。

---

## 0. 一句话结论

> **规则 B 无法被"官方直连"替代 —— 官方 CDN 不接受 `/v1/resource/` 这个路径前缀。**
> Q1（原 `/v1` path × 4 种官方 host）**0/24 = 206**，全部 403；W1（**同一 host、同一份已验证有效的签名**、
> 只把 path 加上 `/v1/resource`）**0/6**，而同签名同 host 的 `/upgcxcode/` 原路径 **6/6 = 206**。
> ⇒ 403 由**路径**造成，与签名、与 host、与对象是否存在都无关。proxy 那一跳消不掉。

---

## 1. 先说清楚数据是怎么拿的（含两次失败）

| 项 | 实测 |
| --- | --- |
| 时间 | 2026-11-18T16:16Z（取数）→ 16:20Z（Q1–Q4）→ 16:22Z（W 组）→ 16:30Z（延迟配对） |
| 登录态 | `bsk` 复用日常 Edge profile，页面 `fetch(..., {credentials:'include'})`；`nav`: `isLogin=true`、`vipType=1` |
| 取数路径 | `/x/player/playurl?avid=…&cid=…&qn=120&fnval=4048&fourk=1` |
| 样本 | **7 视频 / 15 条含真实 `/v1` 候选的 2160p 轨**；从中选 **6 条**（跨 **6 个 bvid**、覆盖 codecid **7 / 12 / 13**） |
| 请求口径 | GET + `Range: bytes=0-1023`，同 UA + `Referer: https://www.bilibili.com/`，串行，间隔 150 ms，12 s 超时（proxy 20 s） |

### 两次取数失败（如实记录，不掩盖）

1. **旧样本已过期**：`rewrite-4k-candidates.json` 每条候选的 `deadline` 只比采集时刻晚约 40 分钟。
   本轮先拿它试 1 条 → `ENOENT`（mcdn 域解析不了，见下文）；改测**官方对等候选**（签名同样过期）→ **9/9 全 403**。
   ⇒ 旧样本作废，必须重采。**这条也顺带证明：过期签名的 403 与路径问题的 403 在状态码上无区别**，所以下面必须做 W 组配对。
2. **前 42 次 playurl 零 PCDN 分配**：第 1 版取数连打 3 轮 × 24 条稿件，`hostHistogram` 里 **0 个** mcdn/供应商域
   （全是 `upos-sz-*` 与 `cn-*` 自建）；再补测 5 组参数变体（`fnval=16/4048`、`qn=80/120`）仍 **0 个**。
   与 task #14「本机当前无 PCDN 分配」一致。**之后突然恢复**：第 4 次运行首轮就命中 15 条（候选分配每次变，计划 F3）。
   ⇒ 样本是"等到了才测"，不是"没等到就编"。

> 附：`Q2a`（原 mcdn host）6/6 `ENOENT`，与计划 F5 / `mcdn-reachable.json` 的既有结论一致 ——
> PCDN 域在公共 DNS 上返回 `0.0.0.0`，**请求根本没发出**。所以任务书原口径的 Q2 只能作为对照，没有信息量。

---

## 2. Q1（决定性问题）：原 `/v1` path × 官方 host

6 条样本 × 4 个 host（3 个指定镜像 + **同轨 index2 官方候选自己的 host**），共 24 次。

| host | path 形态 | status | TTFB | 字节数 | server |
| --- | --- | --- | ---: | ---: | --- |
| `upos-sz-mirrorhw` | `/v1/resource/upgcxcode/…`（30 参数） | **403** ×6 | 9 / 10 / 10 / 11 / 13 / 235 ms | 320 ×6 | openresty |
| `upos-sz-mirrorcoso1` | 同上 | **403** ×8 | 247 / 264 / 267 / 274 / 587 / 905 / 2074 / 2743 ms | 548 ×8 | nginx |
| `upos-sz-estgoss` | 同上 | **403** ×8 | 48 ×6 / 49 ×2 ms | 0 ×8 | — |
| 同轨 peerHost（`mirrorcoso1` / `mirrorbd` / `estgoss`） | 同上 | **403** ×6 | 36 / 48 / 49 / 247 / 264 / 331 ms | 0 / 548 | nginx / — |

**Q1 汇总：0/24 = 206。四个官方 host 无一例外。**

### 403 的响应体特征（三种形态，都不是"对象不存在"）

| 形态 | 字节数 | server | body 特征 |
| --- | ---: | --- | --- |
| A | **320** | openresty | `<title>403 Forbidden</title>` + `Date:` + `Node_info: 3162-CACHE9` + `Request_id` —— **边缘节点当场拒绝** |
| B | **548** | nginx | 纯 `<title>403 Forbidden</title>` + `<center>nginx</center>` + 一段"padding to disable MSIE"注释 —— 上游拒绝 |
| C | **0** | — | 空 body 的 403 |

三种都不是 B站的"签名过期/权限不足"页（那类在 ADR 0039 报告里是 320 字节且带 `Node_info`，但**会出现在 `/upgcxcode/` 合法路径上**；
本次 Q4/W2 用同签名的合法路径是 **206**，说明签名本身没问题）。
⇒ 不能仅凭状态码区分"路径不被接受"与"签名失效"——这正是下一节要解决的。

---

## 3. W1/W2（决定性对照）：同一 host、同一份有效签名，只差 path 前缀

做法：拿**同轨官方候选**（`/upgcxcode/…`，签名已验证 206）当底料，**只把 path 加上 `/v1/resource` 前缀**，签名一字不动。

| 组 | host | path | 签名来源 | status | TTFB | 字节 |
| --- | --- | --- | --- | --- | ---: | ---: |
| **W1** | peerHost（原值） | `/v1/resource/upgcxcode/…` | **peer 的（已验证有效）** | **403 ×6** | 10 / 73 / 118 / 276 / 298 / 884 ms | 548 ×4 / 0 ×2 |
| **W2** | peerHost（原值） | `/upgcxcode/…` | peer 的（同一串） | **206 ×6** | 13 / 139 / 152 / 161 / 261 / 273 ms | 1024 ×6 |

逐条配对（同 host、同签名、只差 `/v1/resource`）：

| bvid#轨 | codecid | peerHost | `/v1` 路径 | 原路径 | 判定 |
| --- | --- | --- | --- | --- | --- |
| BV1t9sk6YE23#t0 | 7 | mirrorcoso1 | 403 | **206** | path-rejected |
| BV1WMsm6zEfn#t1 | 12 | mirrorbd | 403 | **206** | path-rejected |
| BV1Aqsz6mEX6#t2 | 13 | estgoss | 403 | **206** | path-rejected |
| BV1kMsF6PEua#t1 | 12 | mirrorcoso1 | 403 | **206** | path-rejected |
| BV1Rqs66iEER#t1 | 12 | mirrorbd | 403 | **206** | path-rejected |
| BV1K5sM6AELJ#t1 | 12 | estgoss | 403 | **206** | path-rejected |

> **6/6 条证明：官方 CDN 不接受 `/v1/resource/` 路径，与签名无关、与 host 无关、与对象是否存在无关。**
> 这也顺带排除了"镜像缺该 segment"这一 ADR 0039 风险项 —— 缺 segment 时官方 peer 本身也不会 206。

---

## 4. Q2：去掉 `/v1/resource` 前缀（签名一字不动）

| 组 | host | path | 预设 | status | TTFB |
| --- | --- | --- | --- | --- | --- |
| **Q2a** | 原 mcdn host | `/upgcxcode/…` | 任务书原口径 | **6/6 请求失败 ENOENT** | — |
| **Q2b-mirrorhw** | `upos-sz-mirrorhw` | `/upgcxcode/…` | 有信息量的变体 | **403 ×6**（320 B，openresty） | 10 / 10 / 10 / 11 / 11 / 10 ms |
| **Q2b-peerHost** | peerHost 原值 | `/upgcxcode/…` | 同上 | **403 ×6**（548 B nginx / 0 B） | 8 / 9 / 49 / 240 / 904 / 49 ms |

**Q2 结论：去掉 `/v1/resource` 也不能让 `/v1` 那条候选复活。** 所以"签名是否绑 path 前缀"这个问题**在本次数据里得不到"
"能通"的证据 —— 去掉前缀照样 403。合理解释：签名（`upsig`/`uparams`）里带了与**该 path 配套**的字段
（`/v1` 那条的 `uparams` 与 peer 的**完全不同**：参数个数 27–30 vs 25，且含 `mcdnid` / `cdnid` / `bw` / `s` 等 PCDN 专有项）。
⇒ 不是"只差一个前缀"，而是**两条候选是两份不同的签名**。
（`Q2a` 的 ENOENT 只是再次确认 mcdn 域在本机不可解析，不构成 path 证据。）

---

## 5. Q3 / Q4：现状复核 + 基准复核

| 组 | 做法 | 样本 | 206 | TTFB | 说明 |
| --- | --- | ---: | ---: | --- | --- |
| **Q3** | `proxy-tf-all-ws?url=<encoded>` | 2 | **2/2** | 107 / 293 ms | 与 ADR 0039 的 18/18 一致：**proxy 是唯一能通的路** |
| **Q4** | 同轨官方候选**原始 URL** 直连 | 3 | **3/3** | 12 / 106 / 258 ms（中位 **106 ms**） | 128 ms 基准**仍成立**（略快） |

---

## 6. proxy 延迟：这次没有复现 949 ms（重要，且与上一轮不一致）

ADR 0039 报告里 proxy 中位 **949 ms**（n=18）。本轮同一批对象重测：

| 测量 | 样本 | proxy 中位 | 直连官方中位 | 倍数 |
| --- | ---: | ---: | ---: | ---: |
| **配对测量**（15 对象 × 3 轮，交替顺序消偏） | 45 对 | **220 ms**（24–474） | **270 ms**（31–974） | **0.81** |
| 冷/热对照（9 个本轮未被 proxy 过的对象） | 9 | 首次 345 ms / 二次 265 ms | — | — |
| Q3 抽查 | 2 | 107 / 293 ms | — | — |

分布：proxy **<300 ms 24 次、300–799 ms 21 次、≥800 ms 0 次**；直连官方 <300 ms 34 次、300–799 ms 9 次、**≥800 ms 2 次**。
逐对差值中位 **−15 ms**，45 对里 **24 对 proxy 更快**。

**这说明 949 ms 不是稳定属性**：proxy 有快/慢两档（稳定值约 90–130 ms 与约 380–450 ms），
很可能是"边缘节点是否已缓存该对象"的差异（冷/热对照也呈同样两档：345 vs 265 ms 只是轻微下降）。
本次会话整体链路更快，且 proxy 有时**比直连官方还快**。

> ⚠️ 口径诚实说明：两次测的环境/时段不同（上一轮 11-17 深夜，本轮 11-18 傍晚），**不能据此宣称"proxy 其实不慢"**。
> 能确定的是：**"proxy 固定慢 X 倍"这个说法不成立**；"首块可能略慢"方向正确但幅度不稳定。
>
> ➡️ **本节只看了 TTFB。TTFB 不是 4K 的用户体验指标，吞吐才是** —— 已另出
> [`REPORT-proxy-throughput.md`](./REPORT-proxy-throughput.md)：下 2 MiB 量持续吞吐与 stall，
> 结论是 proxy **0/36 stall、36/36 可播**，真正慢的是**直连 `mirrorcoso1`**（吞吐中位 1.21 MB/s）。

---

## 7. 明确回答任务书的问题

### Q：是否存在"官方 host + `/v1/resource/upgcxcode/` 原 path"能 206 的组合？

**没有。** 4 个官方 host（含同轨 peerHost 原值）× 6 条样本 = **0/24**，
再用同一份**有效签名**只改 path 前缀复核 = **0/6**。
⇒ 不是"哪个镜像不行"，而是**所有官方 host 都不认这个路径**。

### Q：403 是"对象不存在"还是"路径不被接受"？

**路径不被接受**，证据链三条：
1. 同 host、同签名、同对象，`/upgcxcode/…` = **206**（W2 6/6），`/v1/resource/upgcxcode/…` = **403**（W1 6/6）；
2. 403 body 是**边缘节点通用拒绝页**（320 B openresty 带 `Node_info` / 548 B nginx），
   不是 B站业务错误页，也没有 "no such key / 404" 一类语义；
3. `/v1` 候选与 peer 的 `uparams` 字段集**不同**（27–30 vs 25，含 `mcdnid`/`cdnid` 等），
   说明这两条是**各自独立的签名**，不能混用。

### Q：Q2 若"去掉 `/v1/resource` 能通"，是否说明签名不绑 path 前缀？

**本次没有观察到"能通"**（Q2b 0/12）。所以**不能**得出"签名不绑 path"的结论。
即使将来出现能通的情况，**ADR 0039 边界 1 也禁止改 path** —— 那会变成"编数据"，不是换 authority。

---

## 8. 一句话结论（给决策用）

> **规则 B 消不掉**：官方 CDN 不接受 `/v1/resource/upgcxcode/` 路径，proxy 包装是当前唯一可行解（2/2 复核通过）。
> 但"proxy 慢 949 ms / 7.4 倍"**未能复现**：本轮配对 45 次中 proxy 中位 220 ms，反而比直连官方（270 ms）略快，
> 与直连基准（106–157 ms）同量级。⇒ **文案里的"首块可能略慢"应降级为"部分线路经官方代理转发"**，
> 不要再暗示确定的慢，更不要写倍数或秒数。

---

## 9. 边界遵守

| 项 | 状态 |
| --- | --- |
| 改 `src/` / `tests/` / `scripts/` / `wxt.config.ts` / `entrypoints/` | **无**（`git status` 对这些路径无新增改动） |
| commit | **无** |
| 新增文件 | 3 个脚本 + 1 份报告（`poc/probe/pcdn-diag/`）+ `.gitignore` 4 条忽略规则 |
| 带签名原始数据 | 4 个 JSON 全部 `git check-ignore` 确认被忽略 |
| 报告内完整 URL | **0 条**（只写 host + path 形态 + 参数个数） |

## 复现

```bash
node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/collect-v1-path-candidates.mjs   # 取数（可能需重跑等 PCDN 分配）
node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/verify-v1-path.mjs               # Q1–Q4
node node_modules/tsx/dist/cli.mjs poc/probe/pcdn-diag/verify-v1-path-w.mjs            # W1/W2 决定性对照
```

签名有效期约 2 小时（`deadline` 参数），超时后需重跑取数脚本。
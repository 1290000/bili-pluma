# ADR 0039：把 PCDN 候选的 authority 换成官方镜像（升级 ADR 0038 的"删除"路线）

- 日期：2026-11-17
- 状态：**已采纳**（用户 2026-11-17 明确批准推翻 ADR 0038 的相关边界，**以本次要求优先**）
- 取代范围：[ADR 0038](./0038-filter-pcdn-candidates.md) 的**边界 2**（不许新增/换成不在当次响应里的 host）与**边界 5**（全 PCDN 轨原样保留）；边界 1 从"删除或重排"改为"替换 authority"。ADR 0038 作为"第五类响应体改写"的**授权本身继续有效**，本 ADR 是它的**升级**，不是撤销
- 继承：[ADR 0013](./0013-patch-player-info-response.md) / [ADR 0017](./0017-restore-primary-progress-in-playurl.md) 的"不伪造权益"原则**继续有效**（见本 ADR 边界 3/4）
- 设计来源：bdFun（GPL-3.0）、BiliPai（GPLv3）—— **只借鉴设计，未使用其源代码**（`pkg-verify/README.md` 立场）；两者均为 Kotlin
- 相关：`docs/plans/2026-11-17-pcdn-diag-plan.md` §2（原否决换 host 的地方，本 ADR 取代该否决）、F6（签名实测）

---

## 背景

### 一、"删除"路线的代价是我们自己量出来的

ADR 0038 选的是"把 PCDN 候选从 `backup_url` 里删掉"。代价在 `poc/probe/pcdn-diag/REPORT-remaining.md`
里有数：

| 指标 | 实测值 |
| --- | --- |
| 2160p 轨剔除 PCDN 后 `official=0` 的 | **0 / 24**（所以边界 5 没触发，开关在 4K 上"有效"） |
| 剔除后**只剩 1 条**官方候选的 | **15 / 24（62.5%）** —— 没有备份可切 |
| backup 是否真在救场 | 毒化对照：两条 PCDN 全 `ERR_TIMED_OUT`，靠 `backupUrl` 回落仍流畅播完（计划 F1） |

也就是说：删路线**用一个确定的代价（备份从 3 条掉到 1 条）换一个未证实的收益**——
严格 A/B 至今零有效样本（见 ADR 0038「价值判断」节），"起播快 X 秒"没有数据支撑。

### 二、换 host 的技术前提已经验证过（不是拍脑袋）

| 事实 | 证据 |
| --- | --- |
| B站 CDN 的 `upsig` / `uparams` **不绑 host** | 计划 F6：把 upos host 套原 base 的签名参数，换 host 仍 206 |
| 换 host 实测命中率 | 匿名 720p、1 个视频，**27/27**：25 条直接换官方镜像返回 206；2 条 `*.mcdn.bilivideo.cn`（path `/v1/resource/upgcxcode/`）换 host 403，改 `proxy-tf-all-ws.bilivideo.com?url=<编码后的原地址>` 包装后 206 |
| 两个生产项目都在用 | bdFun 给 19 个写死镜像、`rewrite()` 只换 host（path/query 不动）；BiliPai 对 `/upgcxcode/` 的 mcdn 也换 host、TF 类走 proxy 包装 |
| 规则清单同源 | BiliPai 的 `risky` 后缀（mcdn/pcdn/gotcha + szbdyd/mountaintoys/qrstuvwxyzab/zhenidc）与我们 `classify.ts` 的 `PCDN_LABELS` + `PCDN_DOMAINS` **完全一致** —— 名单不用补 |

**两个独立 Kotlin 项目 + 我们自己的 27/27 → 同一结论**：这批官方镜像同路径可互换。

### 三、换 host 同时拿到"零 PCDN"与"满额备份"

| 指标 | 现在（删） | 换 authority |
| --- | --- | --- |
| 4K 轨候选数 | 15/24 条从 3 掉到 1 | **不变（仍 3 条）** |
| 实际 PCDN 流量 | 0 | 0（URL 已不指向 PCDN） |
| 弱网退路 | 没了 | **保留** |
| 会否造新地址 | 不会 | 会 —— **本 ADR 显式授权**（仅 authority，及 mcdn 的 proxy 包装） |

关键：这两件事在"删"的方案里互斥，在"换"的方案里同时成立。
而且失败是**响亮**的：换错 host → 403 + 320 字节错误页，不会静默降级成"能播但还在走 PCDN"，
排查时能直接看见。

### 四、这是"主动放弃过的选项"，现在收回

换 host 在方案 §2 曾被否决（"技术上可以，本方案主动不做"），写进 ADR 0038 边界 2。
当时是为了守住"不造地址"的洁癖。现在用户明确推翻该约束 —— **本 ADR 就是那次推翻的授权载体**。

---

## 决定

**授权第五类响应体改写的第二种形态：把 PCDN 候选的 authority 换成官方镜像，取代"删除"。**

对每一条轨的候选 `[base, ...backups]`：

1. 逐条分类（**必须传 `search`**，理由同 ADR 0038 / `classify.ts`）；
2. **PCDN 候选** → 换 authority 到官方镜像：
   `new URL(url)` 后只改 `protocol` / `host` / `port`，**`pathname` / `search` / `hash` 一字不动**；
   若该 URL 命中 mcdn 的 `/v1/resource/upgcxcode/` 变体（换 host 实测 403 那一类），
   改为 `proxy-tf-all-ws.bilivideo.com?url=<encodeURIComponent(原 URL)>` 包装（**唯一允许改变 URL 结构的例外**）；
3. **官方 / third-party / unknown 候选** → 原样保留，不换、不排、不删；
4. **候选条数严格不变**：换失败（解析异常、清单缺项、无映射）的那条**原样保留**；
5. 其余字段（`quality` / `support_formats` / 轨数 / `height` / `codecid` / 带宽 …）**一字不动**。

### 八条硬边界（缺一条就超出本授权）

| # | 边界 | 为什么 |
| --- | --- | --- |
| 1 | **只改 authority**（`protocol`/`host`/`port`）；`pathname`/`search`/`hash` 一字不动 | 换 host 成立的全部前提就是同路径可互换；动路径等于编数据 |
| 2 | **不新增、不删候选**：输出条数 **严格等于** 输入条数 | 这是本方案相对"删"的核心收益（备份全留）；破了这个就等于退回删路线 |
| 3 | `quality` / `support_formats` / `accept_quality` / 轨数量 / `height` / `codecid` / 带宽字段**一字不动** | 继承 ADR 0038 边界 3：用户能选什么画质由服务端决定 |
| 4 | **不得伪造任何权益**（会员/画质/`is_preview`/`play_check`/`user_status`） | 继承 ADR 0038 边界 4；本 ADR 只动线路，不碰身份 |
| 5 | **换不了的候选原样保留**，`new URL()` 抛错的一律保留 | 判不了就别动 —— 静默失败可以接受，制造坏 URL 不行 |
| 6 | **镜像清单与 proxy 模板经 `cfg` 下发**，不在主世界写死 host | 与 ADR 0038 的 `pcdnRules` 同机制：镜像域名漂移时不必发版 |
| 7 | **mcdn proxy 包装仅限 `/v1/resource/upgcxcode/` 变体**，且只对 PCDN 候选 | 这是唯一改变 URL 结构的例外，扩大会变成"任意 URL 重写" |
| 8 | **不并发批量试探镜像**，控制请求规模 | 批量构造官方地址对 B站 基础设施有真实成本（见风险节） |

### 与 ADR 0038 的关系（升级，不是推翻全部）

| ADR 0038 条款 | 本 ADR 的处理 |
| --- | --- |
| 边界 1（删除或重排候选） | **替换**：改为"替换 authority"，不再删除 |
| 边界 2（不许新增/换 host） | **取代**：允许换 authority + mcdn proxy，但仍不许改 path/query |
| 边界 3（画质/权益字段不动） | **继承，原文有效** |
| 边界 4（不伪造权益） | **继承，原文有效** |
| 边界 5（全 PCDN 轨原样保留） | **退休**：全 PCDN 就全换，不存在"没得播"，兜底不再需要 |
| "只减不增"的算法与测试不变量 | **替换**：见下节 |

---

## 风险（必须写清，上线前逐条处理）

| 风险 | 现状 | 处置 |
| --- | --- | --- |
| **样本太窄** | 27/27 是 **1 个视频、匿名 720p** | ⚠️ **上线前必须补 8 个视频 × 24 条 4K 轨的命中率验证**（见"验证门"）。只验"2160p 路径在镜像上同样通"，不验收益 |
| **proxy 多一跳的延迟未知** | `proxy-tf-all-ws` 是官方代理，但没量过延迟 | 量化；若明显慢于直连，mcdn 类改为"直连失败才用 proxy"（不阻塞首播） |
| **镜像缺该 segment → 403** | 未观测到，但理论上可能 | 本方案**不删候选**，其他候选天然兜底 —— 比"删到只剩 1 条"安全得多。先用真实数据看 403 出现率，不预防性加复杂逻辑 |
| **批量构造官方地址有基础设施成本** | 换 host 会把 PCDN 候选的流量打到官方镜像 | 不无节制并发试探；不为选镜像做逐 host 探测（明确不抄 bdFun 的 1 MiB 测速） |
| **"屏蔽 PCDN"文案的真实性** | 删路线下"删了候选但播放器可能从别处拿到 PCDN"，文案有水分 | 换 authority 后流量确实不走 PCDN，文案**变成字面真实**；但收益类话术仍受 ADR 0038「价值判断」约束，不承诺秒数 |

---

## 对测试与守卫的连锁要求（不做完会直接红）

这是本 ADR 最容易漏的一半 —— 三处机械闸门都按"删除"写的，升级后必须同步：

| 位置 | 现状 | 改成 |
| --- | --- | --- |
| `tests/unit/core/cdn/filter.test.ts:116` | 不变量"`输出 URL 集合 ⊆ 输入`" | **`输出 URL 的 path+search 多重集合 == 输入`，条数相等，authority 可变** |
| `tests/unit/core/cdn/filter.test.ts` 多处 | 断言 `backup_url === []`（删到只剩 1 条） | 断言条数不变、host 已换、path 未变 |
| `scripts/check-patch-scope.mjs` 第七类 | 拦截"造 URL 的字面量 / 写死域名" | 保留拦截，但为**清单下发的镜像与 proxy 模板**开一个受控白名单（从 `classify.ts` 派生，不手抄） |
| `src/core/cdn/filter.ts` | `filterPcdnCandidates` 做"剔除" | `rewritePcdnCandidates`（或保留旧名但语义改为替换），`FilterStats` 增 `rewritten` / `fallbackKept` |
| `src/content/main-world.js` | `filterOneTrack` 只删 | 同步换 authority；镜像清单经既有 `cfg` 通道下发 |
| `AGENTS.md` §5.5 | 第五类描述"只减不增" | 改为"只换 authority、不增删候选" |

> ⚠️ 在"验证门"通过、上述闸门同步之前，**不许打开开关的默认开启**；实现可以落地，但保持默认关闭。

---

## 验证门（上线前，缺一不可）

> **更新（2026-11-17 23:55）**：#1、#2 已由探针完成并回填；#3 在实现任务（task #17）进行中；
> #4 待实现完成后做。原始报告 `poc/probe/pcdn-diag/REPORT-rewrite-4k.md`。

1. **4K 换 host 命中率** ✅ **已通过**：登录态 8 视频 / 25 条 2160p 轨 / 33 条 PCDN 候选，
   按两条规则改写后 **33/33 = 206**（规则 A 15/15、规则 B 18/18）。三个官方镜像
   （`mirrorhw` / `mirrorcoso1` / `estgoss`）对普通 PCDN 的 2160p 路径各 15/15 全通；
   静态校验 75 条候选的 `pathname`/`search`/`hash` 变化 **0 条**。
   **注意**：18 条 403 是"故意的直连对照"（mcdn + `/v1/resource/upgcxcode/` 直换 host 稳定 403），
   **不是改写失败**，改走 proxy 后 18/18 全 206。
2. **proxy 延迟** ✅ **已量化（按现状保留，无需增量授权）**：proxy 206 中位 TTFB **949 ms**，
   比"能成功的直连"（mirrorhw 128 ms / estgoss 119 ms）多约 **0.8–0.9 s**。
   **不改成"直连失败才用 proxy"** —— 这些候选直连换 host 是确定性 403（18/18），
   先打一次直连只会确定性多花一次请求，然后照样要付 proxy 那一跳。
   保持本 ADR 现状（原位换 proxy，接受延迟）；"挪到 backup 位"属增量授权，本期不做。
3. **守卫与测试全绿** ✅ **已完成**：`check-patch-scope.mjs`（含新增 ADR 0039 行）、
   `check-boundaries.ts`、`tsc`、`eslint`、全量单测（149 文件 / 2696 用例）全绿。
   实现提交 `40c152c`；面板文案随 ADR 0039 语义更新提交 `129f30c`。
4. **真机冒烟** ⚠️ **部分完成，需在新构建上重验**：用户 2026-11-18 00:5x 在浏览器里拨开开关，
   两次 4K 播放起播 2.42s / 2.15s、host 为官方自建 `cn-cq-gd-bcache-20`、画质未降、无卡顿 ——
   **但该截图里的开关文案仍是旧版（"弱网更容易卡"）**，核对构建产物发现浏览器加载的是
   **21:10 的旧构建**（早于实现提交 `40c152c`），跑的还是"删候选"逻辑，不是本 ADR 的换 authority。
   且服务端当次未分配 PCDN，换 host 逻辑本就未被触发。
   ⇒ 这次只能证明"旧实现开着不出问题"，**不能作为新实现的冒烟证据**。
   已于 01:02 重新构建（含换 authority + 新文案），**待用户重新加载扩展后复验**：
   核对四项（开关开 / host 非 PCDN / 4K 未降 / 无卡顿）与新文案出现，即可关门。

## 边界（不做什么）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 抄 bdFun 的"自动测速" | **不做** | 扩展里逐 host 拉 1 MiB 会产生真实流量、污染我们自己的时间轴、拖慢起播；它是安卓 App 可以随便发请求，我们不行 |
| 搬 Kotlin 源代码 | **不做** | 许可虽兼容（GPL），但项目立场是只借鉴设计（`pkg-verify/README.md`） |
| 健康度记忆 / pinnedHost | **本期不做** | 那是 BiliPai 的增量；先把手艺做对，再谈优化 |
| 按测速重排官方候选 | **不做** | F7：响应无 `Timing-Allow-Origin`，拿不到 TTFB/字节数，排了也是猜 |
| 改 `quality` / 权益字段 | **不做** | 边界 3/4；本 ADR 不松动 |

---

## 相关

- [ADR 0038](./0038-filter-pcdn-candidates.md)：本 ADR 取代其边界 2/5、升级边界 1；其余授权继续有效
- `docs/plans/2026-11-17-pcdn-diag-plan.md` F6：签名不绑 host 的实测
- `poc/probe/pcdn-diag/REPORT-remaining.md`：24 条 4K 轨的剩余候选分布（删路线的代价）
- `pkg-verify/README.md`：只借鉴设计、不使用竞品源代码的项目立场

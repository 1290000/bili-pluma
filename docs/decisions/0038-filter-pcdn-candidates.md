# ADR 0038：在取流数据上过滤 PCDN 候选（只减不增）

- 日期：2026-11-17
- 状态：**已采纳**（**第五类响应体改写授权**；前四类见 [ADR 0013](./0013-patch-player-info-response.md) / [ADR 0017](./0017-restore-primary-progress-in-playurl.md) / [ADR 0021](./0021-patch-pgc-preview-flags.md) / [ADR 0023](./0023-intercept-playview-durl-swap.md)）。⚠️ **授权已定，"值不值得做"尚未定** —— 见「未定」一节，第 1/3 项实测之前不许开工
- 授权来源：**用户 2026-11-17 在本会话中明确指示**——「本会话的新要求优先，既有 ADR 的限制不再构成阻碍，需要新 ADR 就写」
- 相关：[ADR 0004](./0004-request-level-identity-proxy.md)（请求级身份代理）、[ADR 0017](./0017-restore-primary-progress-in-playurl.md)（本 ADR 要越过的字面边界）、[ADR 0020](./0020-pgc-sync-injection-and-reload.md) / [ADR 0023](./0023-intercept-playview-durl-swap.md)（本次一并追认的两类流数据改写）
- 方案出处：`docs/plans/2026-11-17-pcdn-diag-plan.md` §12（v3 候选过滤）

---

## 背景

### 一、诊断已经能"看清"，但还不能"改变"

PCDN 诊断这一轮已交付：`core/cdn/classify.ts` 判线路、`core/loading/timeline.ts` 归一事件、
`content/isolated/loading-trace.ts` 采集、面板渲染时间轴与导出 JSON。
它回答的是**"这次走了哪条线路"**，对**"能不能不走 PCDN"** 没有任何能力。

用户需求里的这一半，至今没有实现。

### 二、候选只有三处来源，且**不是每处都被播放器消费**

这一节是本 ADR 的地基。三处来源，**四条消费路径**：

| 页面 | 数据来源 | 结构 | 播放器真的读它吗 | 证据 |
| --- | --- | --- | --- | --- |
| `/video` | playurl 响应（XHR + fetch 兜底） | `{code, data:{dash\|durl}}`；每轨 `base_url`/`baseUrl` + `backup_url`/`backupUrl` | **是**（扩展启用时是唯一来源） | `main-world.js:19-21`（"播放器直接读 `__playinfo__`，根本不发 playurl"→ 所以必须藏）、`:623-629`（getter 返回 `undefined`）、`:1558`（`playinfoHidden = enabled && !IS_PGC`）；结构见 `core/playinfo/parse.ts:59-92`、`:144-165` |
| `/video` | `window.__playinfo__`（SSR） | 同上（dash 在 `data` 层） | **不读** —— 被 `enabled && !IS_PGC` 藏掉 | 同上；`__playinfo__` 只在隐藏前被抓一份当主账号基线（`main-world.js:186-210`） |
| PGC 整页加载 | `__playinfo__.result.video_info`（扩展注入） | `{data:{result:{arc, play_check, video_info}}}` | **是**（PGC 页不能藏，藏了就没流） | `main-world.js:768-798`、`:1053-1060`（setter 内同步替换）、`:1375`（`r.video_info = next`）；合并白名单 `core/playinfo/pgc-merge.ts:29-41` |
| **PGC SPA 切集** | **`GET /ogv/player/playview` 的响应** | `{code, data:{arc, video_info:{durls:[4×6min]}}}`（**没有 `result` 层**） | **是**（此时 `__playinfo__` 完全不动） | [ADR 0023](./0023-intercept-playview-durl-swap.md):14-33（实测：URL 变了但 `__playinfo__.result.arc.cid` 还是上一集）；实现 `main-world.js:2716-2760`、`:3076-3110`、`:3170-3245` |

**结论**：候选过滤必须覆盖 **三处**（`/video` 的 playurl、PGC 的 `__playinfo__` 注入点、PGC 的 `playview` 换流点）。
计划 §12.7 的初版只写了前两处，**漏掉的第三条恰好是番剧切集唯一走的那条**；同一次改动已把 §12.5 / §12.7 补成三处。

> ⚠️ 对 `/video` **不需要**再过滤 `__playinfo__`：它在 `enabled` 时已被藏成 `undefined`
> （`main-world.js:1558`、`:627`），播放器读不到，候选只可能来自它自己发的 playurl。
> 计划 §12.5 原来那句"必须同时作用于 `__playinfo__` 与 playurl"对 PGC 成立、对 `/video` 不成立，
> 已按本节改写。

### 三、撞上的字面边界

[ADR 0017](./0017-restore-primary-progress-in-playurl.md):48、:59 写着：

> 禁止改写的字段：其它一切，**尤其 `dash` / `support_formats` / `quality`**……
> 不伪造权益——`dash` / `quality` / `support_formats` 全部来自播放账号的真实响应，**一个字节不改**

而"剔除 PCDN 候选"必然要动 `dash.video[].base_url` / `backup_url`。字面上越线，没有解释空间。
`AGENTS.md` §5.5（:176）还规定"**加路径或主机 = 扩大越权，先改 ADR 再改代码**"。

所以本 ADR 存在的**唯一目的**，就是把这个动作变成一次**有边界、可审计**的授权。

---

## 决定

**授权第五类响应体改写：在取流响应 / 注入数据上做"只减不增"的候选过滤。**

算法只在**同一条轨**内做减法（方案见计划 §12.2）：

1. 把该轨的 `[baseUrl, ...backupUrl]` 展开；
2. 逐条用 `classifyCdn(hostname, search)` 分类（**必须传 `search`**，否则 `os=mcdn` 那条判据失效，见 `core/cdn/classify.ts:253-254`）；
3. 若剩余 ≥ 1 条：`baseUrl = 第一条`、`backupUrl = 其余`，**官方之间不重排**（没有测速依据）；
4. 若剩余 0 条：**整条轨原样保留**，一个字段都不动。

### 五条硬边界（缺一条就超出本授权）

| # | 边界 | 为什么 |
| --- | --- | --- |
| 1 | 只允许**删除或重排**候选 URL（`base_url`/`baseUrl`、`backup_url`/`backupUrl`） | 这是"减法"的全部内容 |
| 2 | **不许新增**任何候选 URL —— 不许拼、不许换成不在当次响应里的 host | 凭空造 URL 等于编数据，且签名可能不对（ADR 0017 的"不伪造"同一条纪律） |
| 3 | `quality` / `support_formats` / `accept_quality` / 轨数量 / `height` / `codecid` / 带宽字段**一字不动** | 用户能选什么画质、实际拿到几条轨，必须由服务端决定。动了就是"假装有某个档位" |
| 4 | **不得伪造任何权益**：不假装是会员、不假装有某档画质、不改 `is_preview` / `play_check` / `user_status` | 这是决策 5 的立法目的，**本 ADR 不松动它**；这也是它与 ADR 0013/0017 的分界线 |
| 5 | **全 PCDN 的轨原样保留**（不删轨、不换 host、不降级） | 删掉那条轨 = 用户点了 4K 却没有 4K，会直接黑屏/切换失败。宁可照旧走 PCDN |

### 与 ADR 0017 的关系（不是推翻，是划界）

- ADR 0017 的禁止是**针对"观看进度还原"这同一个 patch 的字段边界**——它在保护"不借着改进度顺手改流"。
- 本 ADR 授权的是**另一个动作、另一组字段、另一套目的**：不改任何权益字段，只从服务端当次下发的候选里做减法。
- 两者**并存**：`PROGRESS_PATCH_PATHS` 仍然只许改 `last_play_time` / `last_play_cid`；
  候选过滤走**独立的常量与独立的函数**，不许合进 ADR 0017 那条路（合并后"这条路径为什么被授权"就查不出来了）。
- ⚠️ **本 ADR 不给"改 `quality`"开口子**。边界 3 是硬约束，将来谁想动它，必须另写 ADR。

---

## 一并修正的治理缺口（本次最重要的一半）

`AGENTS.md` §5.5 原写"`src/content/main-world.js` 有**四类**响应体改写"。**这句话在 ADR 0020/0023 落地后就过期了**：

| 改写 | 已在生产运行 | 改了什么 | 在 §5.5 里登记过吗 |
| --- | --- | --- | --- |
| ADR 0020・PGC 整页注入 | 是（`main-world.js:1053-1060`、`:1375`） | 把 `result.video_info` 换成缓存里的完整流 | ❌ 没有 |
| ADR 0023・`playview` 换流 | 是（`main-world.js:3231-3245`） | **`vi.dash = full.dash`**、`vi.quality`、`vi.support_formats`、`vi.accept_quality`、删 `durl`/`durls` | ❌ 没有 |

而 `scripts/check-patch-scope.mjs` 只认识 `PATCH_PATHS` / `PROGRESS_PATCH_PATHS` / `PATCH_HOSTS` / PGC 三标记 / 提示条
（脚本 :86、:99、:115、:130、:140），**完全不知道 `playview` 换流的存在**——
它那句"加路径就必须先改 ADR，否则这里会红"对 `playview` 从未成立。

**所以本 ADR 同时做三件事**：

1. **追认** ADR 0020 / 0023 这两类**已经存在**的流数据改写，把它们补进 §5.5 的清单；
2. 新增本 ADR 这一类（候选过滤），使"清单 = 生产现状"重新成立；
3. 明确：`check-patch-scope.mjs` 的校验集扩展（把 `playview` 与候选过滤纳入）**是配套任务**，
   在它落地之前，"机器能拦住越权"这句话对这两项**仍然不成立**。

> 这不是"顺手改文档"。§5.5 是决策 5 的例外边界，它写少了 = 越权范围无法审计。
> 一次只补一行、不回头对账，最后一定会变成"代码比授权宽"。

---

## 未定（**必须先实测，不许当成已定**）

| # | 问题 | 影响 | 怎么测 |
| --- | --- | --- | --- |
| 1 | **4K 轨剔除 PCDN 后还有没有官方候选？** | 若 2160p 轨经常 3/3 全 PCDN，边界 5 会让它原样保留 → **功能在 4K 上等于没做**。这一条决定本 ADR 值不值得落地 | 登录态 + 4K，抓 20 次 playurl，对 `dash.video[]` **逐轨**统计"剔除后剩余条数"的分布 |
| 2 | 播放器接受 `backup_url: []` 吗？ | 边界 1 可能把 1+2 条削成 1+0 条；若播放器索引 `backupUrl[0]`，会不播 | 构造只剩 `baseUrl` 的轨，看 `readyState` / `error` / 是否仍发起请求 |
| 3 | `/video` 的 playurl 是 `arraybuffer` 吗？ | 若不是 `''`/`text`/`json`，现有改写闸门（`main-world.js:3533`）根本进不去，方案需另议 | hook `XMLHttpRequest.prototype.open`，打印 playurl 的 `responseType` |
| 4 | 删掉候选后播放器是否真的不再请求它？ | Q9 只证明"用的是手里已有候选"，**没证明"候选里没有时不会回退到别处"** | 删掉响应里全部 mcdn URL，跑 40 秒，看 `PerformanceObserver` 是否出现 pcdn host |
| 5 | PGC 两条路过滤后是否照常播、画质不降？ | PGC 的 `playview` 换流还带 `isBetterSwap` 画质比较（`main-world.js:3212-3227`），过滤后不能触发"不更高就不换" | 番剧会员集：整页进一次 + SPA 切两集，比 `duration` / `videoHeight` / `currentSrc` 的 host |

在 1 与 3 有结论之前，**不要开始改代码**。

---

## 边界（不做什么）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 删掉整条轨 | **不做** | 等于砍画质档位，违反边界 3/5；用户会看到"点了 4K 没反应" |
| 新增 / 拼接候选 URL | **不做** | 违反边界 2；且 `upsig` 是否绑 host 虽有实测（F6），但换 host 属另一个决策（计划 §2 已否决） |
| 改 `quality` / `support_formats` | **不做** | 边界 3；这是"伪造权益"与"选线路"的分界线 |
| 按测速重排官方候选 | **不做** | 没有测速依据；`PerformanceResourceTiming` 缺 `transferSize`/TTFB（F7），排了也是猜 |
| 用 DNR `block` 实现 | **本期不做** | 见计划 §7（已废弃为备选）+ §12.6；且需新增 CDN 主机权限，`block` 是否触发 `backupUrl` 回退**未测**（计划 §11 Q7） |
| 远程下发 PCDN 域名表 | **不做** | §3 决策 6 |

---

## 对既有代码的影响（落地时）

| 位置 | 预期变化 |
| --- | --- |
| `src/core/*` | 新增候选过滤**纯函数**（输入 `video_info` / `dash`，输出同形状），可全量单测 |
| `entrypoints/content.ts` | PGC 整页：`mergeVideoInfo` 的输出在写缓存/下发前过滤 |
| `src/content/main-world.js` | ① `/video`：playurl XHR / fetch 响应过滤；② PGC 切集：`pgcSwapPlayviewBody` 换流后过滤。**新增一个独立常量**，不许并进 `PROGRESS_PATCH_PATHS` |
| `scripts/check-patch-scope.mjs` | **配套任务**：把 `playview` 换流与本类过滤纳入校验集（本 ADR 不改这个脚本） |
| `AGENTS.md` §5.5 | 五类响应体改写 + 补登 ADR 0020 / 0023（已在本 ADR 同一提交内完成） |

---

## 相关

- [ADR 0017](./0017-restore-primary-progress-in-playurl.md)：本 ADR 越过的字面边界，也是"不伪造"原则的来源
- [ADR 0020](./0020-pgc-sync-injection-and-reload.md) / [ADR 0023](./0023-intercept-playview-durl-swap.md)：本次一并追认的两类流数据改写
- `docs/plans/2026-11-17-pcdn-diag-plan.md` §12：算法与三步法的完整描述
- `poc/probe/pcdn-diag/REPORT.md`：84 个 host 的实测分布（PCDN 占候选出现次数约 63%）

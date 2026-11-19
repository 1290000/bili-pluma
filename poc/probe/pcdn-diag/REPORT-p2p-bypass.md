# P2P 分片绕过「屏蔽 PCDN」的诊断（2026-11-19 00:0x）

脚本 `poc/probe/pcdn-diag/p2p-bypass.mjs`　数据 `p2p-bypass.json`（gitignored）
扩展 `.output/chrome-mv3`（11-18 18:24 构建，开关**开**）。**结论先给，证据在后。**

## 结论三行

1. **Q1（候选有无 PCDN）：今夜拿到的 playurl 候选里没有 PCDN host** —— `BV1Rqs66iEER`
   18 条轨 54 个候选全部 official；热门榜另外 30 个 ≥600s 有 4K 的视频逐一查 playurl，
   **PCDN 候选一律 0**。⇒ 无法在今晚判"候选里有但没被改写"（接线 bug）。
2. **Q2（mountaintoys 分片与候选的关系）**：今晚没有 PCDN 分片可采样，**无法直接测**。
   但历史证据（11-17 16:19 的 `remaining-candidates.json`）显示：用户截图里那条
   `6u5b277a.edge.mountaintoys.cn` 的**同域**（`svx61w.edge.mountaintoys.cn`）
   当时就是 **playurl 的 `backup_url`、带 `os=mcdn`** —— 即这类主机是**服务端分配的候选**，
   不是 p2p loader 自己造的地址（形态证据，非行为证据，见"测不出"）。
3. **Q3（p2p 模块入口）**：`p2pGlobals` 空、`script[src]` 含 p2p/peer 的 **0 条**、
   探针装载后 ~90 秒播放里 **`RTCPeerConnection` 创建 0 次**。⇒ 在这条页面上
   **没观察到任何 WebRTC P2P 活动**；mountaintoys 更像 playurl 候选（`os=mcdn`）
   而非 p2p loader。

## 三问证据

### Q1：候选 host 集合（ON 状态，页面内 fetch，会被扩展改写 = 播放器视角）

`BV1Rqs66iEER`（128s，18 轨 = 6 档画质 × 3 编码，54 候选）：

| 分类 | 条数 |
| --- | --- |
| official | 54 |
| pcdn / third-party / unknown | **0 / 0 / 0** |

热门榜大盘扫描（`duration≥600` 且有 4K，共 30 条）：**全部 0 PCDN 候选**。

⚠️ **边界**：这只能证明"此刻候选干净"。要区分"扩展把它改掉了"还是"服务端本来就没分配"，
需要同一时刻的**服务端原始响应**（bsk debug 录不到 playurl 响应体，`festival/REPORT-handoff.md`
已验证 `initial_load_not_recorded`）。不过 11-17 16:39 的历史数据（`applied:true, removed:34`）
证明过：**当服务端真的分配了 PCDN 时，改写确实生效且把 `mountaintoys`/`mcdn` 剔掉了**。

### Q2：URL 关系（形态证据 + 缺口）

| 项 | 值 |
| --- | --- |
| 用户截图的分片 host | `6u5b277a.edge.mountaintoys.cn` |
| 11-17 16:19 的 playurl `backup_url` 样本 | `b-iba9z996j4h3alp2d9cro8fe7rc48za.edge.mountaintoys.cn`（`os=mcdn`）、`svx61w.edge.mountaintoys.cn`（`os=mcdn`） |
| 形态 | **同一形状**：`<随机串>.edge.mountaintoys.cn`，且都是 playurl 候选形态（`os=mcdn`） |
| 今晚实测 | 分片（official）的 `pathname` **就在候选 `path` 集合里**（`-1-30121.m4s` 视频 / `-1-30280.m4s` 音频），`search` 前缀同形（`?e=ig8euxZM2rNcNbdlhoNvN…`） |

⇒ 播放器使用的分片 path 与候选 path **同路径**、只换 authority —— 与 ADR 0039"换
`baseUrl` 的 authority"同构。**如果** mountaintoys 分片也是这么来的，那"阻断域名"能让
播放器干净回落到官方候选；**但今晚没有 mountaintoys 分片样本，行为证据缺失**。

### Q3：p2p 入口

| 检查 | 结果 |
| --- | --- |
| `window` 全局（`biliP2P` / `webp2p` / `P2P` / `BILIP2P`） | **无** |
| `<script src>` 含 `p2p` / `peer` | **0 条** |
| `RTCPeerConnection` 创建（探针装载后 ~90s 播放） | **0 次** |

⚠️ 探针在页面加载 ~2.5s 后才装上（bsk 无法 document_start 注入），**头 2.5 秒**创建的
RTC 连接抓不到。但 p2p loader 若活跃，播放期间的重建/重连也会创建 RTC —— 90 秒里 0 次，
结合 `os=mcdn` 候选形态，**今晚这条页面上没有 p2p 模块活动的迹象**。

### 附带项：SPA 第二次 playurl 的 wantFilter

两次 fetch（间隔 ~60s，各 18 轨）**host 集逐轨一致**（仅签名 query 不同）。
与"两次都执行了 wantFilter"和"两次都没执行"都相容 —— **今晚没有 PCDN，区分不了**，
与 Q1 是同一个限制。

## 修法选项与代价（**不定方案**）

| 选项 | 作用点 | 代价 / 风险 |
| --- | --- | --- |
| A · 修接线：保证 SPA 换片 / 非预期入口的 playurl 也过 `pcdnFilterReady()` + `patchPlayurlBody` | 候选改写层 | 若用户那次是这条路，这是最小修；但要先拿到"开关开着、候选里仍有 PCDN"的现场才能确诊 |
| B · DNR 阻断 PCDN 域名（`mountaintoys.cn` / `mcdn` 等） | 网络层，覆盖 playurl 候选**和**任何其它来源 | 需维护域名清单（`classify.ts` 已有，可生成规则）；误伤面小（这些域不会是官方线路）；但**治标**：候选还在响应里，播放器会对被阻候选重试，可能拖慢起播 |
| C · 禁用播放器 p2p 模块（如找到挂点） | 播放器层 | **今晚没有找到挂点**（无全局、无 script、无 RTC）；且 B站 播放器内核是闭源 bundle，挂点脆弱，升级即碎 |
| D · 什么都不改，等 PCDN 分配窗口再实测 | — | 用户可能随时再遇到；无法主动复现 |

**能一锤定音的实测**（等 PCDN 分配回来再做，~10 分钟）：
同一页面同时抓「playurl 完整响应体」与「分片请求 URL」，若候选里 0 PCDN 而分片里有
mountaintoys ⇒ P2P 绕过实锤；若候选里有 mountaintoys ⇒ 接线 bug 实锤。

## 测不出 / 歧义的项

1. **今晚 B站 没有为本机分配任何 PCDN**（30 条视频 0 PCDN 候选 + 10 页播放 0 PCDN 分片），
   与 11-17 白天（4K 候选 46% 是 PCDN）对比强烈 ⇒ 分配是**服务端按时段/负载动态决策**的，
   与视频无关（连热门视频都不给）。
2. "用户那次"候选到底有没有 mountaintoys：**无现场**（用户的截图只有分片时间轴，没有响应体）。
3. RTC hook 的装载时机缺口（头 2.5s）。
4. `bsk debug` 录不到 playurl 响应体（`festival/REPORT-handoff.md` 已证），Q1 只能走页面内 fetch。

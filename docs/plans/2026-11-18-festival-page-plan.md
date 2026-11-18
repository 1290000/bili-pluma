# 实施方案：支持 B站活动专区页（`/festival/*`）的播放器接管

日期：2026-11-18
状态：**用户已拍板方案 B（nano 钩子真接管流）；可行性已由探针验证，进入实施**

> 🔧 **当前有效** —— 活动页支持的实施中方案：第 1、2、5 步已落地，第 3、4 步（主世界接流、真机验收）待做。

依据：
- 真机调查 `poc/probe/festival/REPORT.md`（bsk 登录态，两个真实活动页 + 对照组）
- 只读审计 `audit-festival`（六维影响面，文件:行号）
- **可行性探针 `poc/probe/festival/REPORT-nano.md`**（2026-11-18，5 问实测：方案 B 可行但需额外条件）
- 用户决定：开关保持默认关闭；「要支持」活动页；第 3 步选 **B**（真接管流，非 A 的诊断-only）

---

## 0. 结论先行

**好消息**：身份代理（DNR 换 Cookie）**完全不用改** —— 活动页的取流走的就是白名单里的
`/x/player/wbi/playurl`，DNR 路径规则只按 `urlFilter` + `requestDomains` + `method` 匹配，
与页面 URL 无关。设备 Cookie、登录态也和标准页一致，`readDeviceCookies()` 原样可用。

**要做的**：现有"接管"逻辑靠"藏 `__playinfo__` 逼播放器发 playurl"起步，而活动页**没有
`__playinfo__`**（连属性描述符都没有），且两个注入入口与页面判据都不认 `/festival/*`。
所以必须新增一条活动页路径，让扩展进得去、认得出、且**不黑屏**。

**工作量分水岭已在第 3 步解决**：用户选 B（nano 钩子真接管流），探针已验证可行，
实现要点与当年的 ADR 0019 路径完全不同（见第 3 步）。

---

## 0.1 页面事实（调查实测，方案的地基）

| 项 | 活动页 | 标准 `/video/` 页 |
| --- | --- | --- |
| URL 形态 | `/festival/<key>?bvid=BV…`（**bvid 在 query**） | `/video/BV…`（bvid 在路径） |
| 实例 | `/festival/COLMO2026?bvid=BV1ydeX65Edn`（COLMO）、`/festival/bnj2026?bvid=BV1eoZ7BnEGy`（拜年纪） | — |
| `window.__playinfo__` | **无**，连描述符都没有 | 有 Pluma 装的 getter/setter |
| 页面数据源 | `window.__INITIAL_STATE__.videoInfo.cid` | SSR `__playinfo__` |
| 取流接口 | `/x/player/wbi/playurl`（api.bilibili.com，白名单内） | 同 |
| 响应 | `dash`，无 durl/FLV | 同 |
| 播放器内核 | `nano.createPlayer` 存在（同标准页内核） | 同 |
| Pluma 钩子 | **一个都没有**（`__PLUMA_MAIN__ === undefined`） | 有 |
| 设备 Cookie | 齐全，同域同形态 | 同 |

⚠️ 一个易错点：`qn=120` 是**请求参数**，不等于拿到 4K —— 拜年纪那页请求 qn=120 但响应 quality=112、
无 id=120 的轨；COLMO 页才有真 4K。验收要用响应里的 `quality` / `dash.video[].id`，别看请求参数。

---

## 步骤（按顺序，每步带验证）

### 第 1 步 · 打开注入面（让扩展进得去）

改：
- `entrypoints/content.ts:2413` 的 `matches` 增加 `*://www.bilibili.com/festival/*` 字面量
- `entrypoints/main-hook.content.ts:51` **同步加同一条**（WXT 静态分析 matches，不能引用跨文件常量；
  只改一边会让 `content.ts:3136` 的 `__PLUMA_MAIN__` 自检报"主世界未就绪"，功能全废）

**不改**：host permission（已够）、`routes.ts` 白名单、`dnr.ts` 规则构造、`readDeviceCookies`
（真机实测全部兼容，改了反而引入新规则段与规则 ID 漂移风险）。

验证：`npm run build` 后看 `.output/chrome-mv3/manifest.json` 里两个入口的 matches 都含 festival；
`node scripts/check-page-gate.mjs` 绿。
⚠️ **守卫绿 ≠ 做对了**：check-page-gate 规则 2 只查"两条必需模式还在"，对多出的 festival 沉默。
必须人工核对 manifest。

### 第 2 步 · 扩展页面判据（让扩展认得出）

改 `src/shared/utils/video-page.ts`（判据唯一真相源，**禁止在别处写 `/festival/` 前缀判断**——
这是项目最贵的教训，2026-10-28 番剧页就因手写正则漏判，tsc/单测/verify 全绿但 popup 谎报未生效）：
- `PLAY_PAGE_URL_PATTERNS` 增 festival 模式（供 `chrome.tabs.query`）
- `parsePlayPage()` 认 `/festival/<key>?bvid=BV…`，从 **query** 解析 bvid（现有 `parseVideoPage` 只从路径取），
  返回形态需新增一个 kind（如 `festival`）或复用 `video` + 额外字段

连带（否则界面半残）：
- `entrypoints/content.ts:2046` 的 `if (!info) return` 是面板"未生效"的直接原因，第 2 步做好即自动解开
- `src/background/handlers/tabs.handler.ts:45-61 findAffectedTabs()`、background 的 `isVideoPageUrl`
  会自动跟随 parsePlayPage（审计确认），无需单独改
- `src/platform/page/page-state-client.ts:49` 的 tab 查询自动含新模式

验证：`tests/unit/shared/video-page.test.ts` 的两处 `toEqual([...两条])`（:218-224）**必红**，
更新为新三条；:226-242 的模式-样本对必须给 festival 配真实样本 URL（`COLMO2026?bvid=BV1ydeX65Edn`）。
`background-play-page.test.ts` 补 festival case。跑 `check-page-gate.mjs` + 全量单测。

### 第 3 步 · 主世界接流（**方案 B，探针已验证可行**）

活动页没有 `__playinfo__`，"藏它逼出 playurl"的招在这里不适用。**用户已选 B**：走
`nano.createPlayer` 钩子真接管流。可行性已由 `REPORT-nano.md` 用真机 5 问验证——**可行，但实现
方式与 ADR 0019 当年的路完全不同**，下面每一条都是探针实测结论，不是推测：

**探针关键结论（改写方案的地基）**

| 问 | 实测 | 对实现的约束 |
| --- | --- | --- |
| 钩子点 | `document_start` 挂 `nano` setter，660ms 赋值即同步包装，1134ms `createPlayer` 被调用 | 必须在 `document_start` MAIN world 抢在页面脚本前挂 setter |
| config 形状 | **没有 `prefetch.playUrl`，也没有 `requestConfig.reqHttpPlayUrlInfo`**（15 个键，Proxy 读键记录里也没有） | ⚠️ **不是"删 prefetch 逼回退"**（那是 PGC 的路，这里没有 prefetch）；要**新建** `config.requestConfig.reqHttpPlayUrlInfo` |
| 回退行为 | 补上回调后 `cbHits=1`，且**只有回调里的那一次 fetch**，播放器原生 XHR 被完全替换；播放器把含签名的 params 交给回调，扩展不用自己算签 | 回调直接 `fetch(params 构造的 URL, credentials:'include')` 即可 |
| 喂流 | 能播。返回 `{data: json, headers:{}, status}`，code=0、readyState=4、零 error；裁 `dash.video` 6→3 后 videoHeight **480→360** → 证明播放器消费了我们的流 | 返回体**必须带 `data` 层**；**不要拿 `duration` 当验证判据**（SSR 分 P 时长锁定，改元数据无效） |
| SPA 换片 | 同一 nano/player 实例复用，`createPlayer` **不再调用**；但 `player.updateRequestConfig({reqHttpPlayUrlInfo: cb2})` 后 cb2 生效并拿到新 cid | 切集靠 `updateRequestConfig` 重挂；用 `params.cid` 防串场；⚠️ 原生未注入页直接调它会抛错（kernel `Object.assign(undefined,…)`），**重挂只在首次已注入的前提下成立** |

**因此 ADR 0019 的否定结论不能照搬**：当年 `cbCalled:0` 是 PGC 的 `prefetch.playUrl` 短路造成的，
活动页根本没有 prefetch；但也不能照搬它的实现（那条 `prefetch` 路在这里不存在）。

**实现要点（逐条对应探针发现）**
- `main-world.js`：放宽 `IS_PGC` / 新增 `IS_FESTIVAL` 判据（`:598`，手写判据，活动页当前被误判成普通视频页）；
  在 `createPlayer(config)` 里若 `config.requestConfig` 不存在就**新建**，再挂 `reqHttpPlayUrlInfo`
- 回调里从 `window.__INITIAL_STATE__.videoInfo.cid` 取 cid（与播放器给的 params.cid 交叉核对），
  fetch 用播放器传入的含签名 params
- 防御性清 `prefetch` / `config.playUrl`（探针建议，虽然活动页没有，防页面变体）
- ⚠️ **不要在 DOM 型 config 键（element/auxiliary）上套 Proxy** —— 探针实测会栈溢出
- SPA：监听 bvid 变化 → `player.updateRequestConfig` 重挂 + params.cid 防串场
- `playinfoHidden` (`:1915`) 保持不动（活动页无 `__playinfo__`，藏了无副作用；PGC 的黑屏先例不适用）

**探针如实标注的残留限制**：4K 登录态下的回调注入**未直接实测**（bsk 0.5.0 不能在 document_start
注入、复制 Edge Cookies 被运行中浏览器独占）。机制与身份无关，但真机验收必须用登录态再确认一次 4K。

**首波接管的边界（2026-11-18 真机后二次修订）**

> 依据：`poc/probe/festival/REPORT-gate-window.md`（门控窗口精确时序 + 同步注入实测）。

旧归因是「门控晚到，补挂抢不到首波」。实测**推翻了它**：10 次里 9 次门控比首波 playurl **还早**
200–500ms，首波依然是原生 XHR —— **首波取流在 `createPlayer` 里就排好队，之后再
`updateRequestConfig` 结构上只影响 reload 后的那一波**。

正解是**在 `createPlayer` 返回前同步写 `config.requestConfig.reqHttpPlayUrlInfo`**（门控等待代理）。
真机实测同步注入会被调用：真实 fetch 模式 `cbHits=1`、正常起播、播放器自己一条原生 playurl XHR
都没发；回调在 `createPlayer` 后 52–68ms 被调，比原生 XHR 早 0.45–1.1s。

门控到达时刻相对 `createPlayer`：p50 50ms / p90 66ms / max 68ms，所以等待上限取 **300ms**
（原生 XHR 在 create+约 496ms 才发，不会让首帧更晚）。代理仍是 fail-closed：

- 门控**未知** → 只等、**不发任何请求**，超时交还原生（页面原回调 → 原生 XHR → code=-1 壳）；
- `cfgEnabled === false` / `page/activate` 明确未激活 → **立即**交还原生，不让用户白等。

同时**撤销**了上一版"补挂后 `player.reload()` 换首波"：它确实有效，但重建 MediaSource 会把
`currentTime` 归 0，从中间续播时进度被拽回开头，用户明确否掉。`updateRequestConfig` 补挂保留，
只作为兜底（钩子晚装 / config 非对象 / SPA 换片），不再承担抢首波。

### 第 4 步 · 真机验收（机器守卫盖不到的部分）

审计明确：最可能的真机症状是"面板有却判未生效 / 显示接管但既不换 Cookie 也不注入流 / 黑屏"，
而这些**静态检查发现不了**。必须人工验：

1. 打开两个活动页，面板显示「已接管」而非「未生效」
2. 线路卡出现，host 为官方线路
3. 正常起播、画质未降（用响应的 `quality` 判断，不看 qn 参数）——**必须用登录态验 4K**
   （探针只在游客态跑通注入；COLMO 页登录态有真 4K，用它验）
4. 身份代理真的生效（诊断页 identity = extension）
5. 拨「屏蔽 PCDN 线路」开关后刷新，不出 403/黑屏
6. **SPA 换片**：同页换 `?bvid=` 后，回调重挂生效、cid 不串场（探针发现 `createPlayer` 不再调用，
   靠 `updateRequestConfig` 重挂）

### 第 5 步 · 守卫与文档收尾

- `scripts/check-page-gate.mjs` 的登记表/文案（"两个模式"→"三个模式"，`REQUIRED_MATCH_PATTERNS` 注释）
- `tests/unit/content/content-entry.test.ts:38-41`（`toContain` 不会红，但"两类"描述失真）
- `docs/decisions/` 新 ADR 记录"注入面扩大到 /festival/"的决策与边界（项目纪律：扩大注入面前先改 ADR）
- `poc/probe/realdevice/FINAL-REALDEVICE.md:38` 等写了"两条 matches"的文档同步

---

## 风险与边界（方案必须写清）

| 风险 | 处置 |
| --- | --- |
| 两个 content 入口只改了一个 → 功能全废 | 第 1 步强制同步，并在真机核对 `__PLUMA_MAIN__` |
| `IS_PGC` 手写判据误分类 → 黑屏 | 探针验证活动页无 `__playinfo__`、藏了无副作用（`REPORT-nano.md`），PGC 黑屏先例不适用；但仍需真机验收第 3 项确认 |
| 把 festival 加成全站通配 → 注入面越权 | 只加精确路径 `/festival/*`，check-page-gate 规则 2c 会拦多余域 |
| 判"非播放页"变松 → 无主规则带账号 Cookie 留在标签页 | 第 2 步确认 `/festival/*` 确实是有播放器的页面（已验证）才纳入 |
| 测试绿灯但功能半残 | 第 4 步人工验收不可省 |

## 明确不做

- 不改 DNR 规则 / 白名单 / `readDeviceCookies`（真机实测兼容）
- 不把整个 bilibili.com 通配注入
- 不照搬 ADR 0019 的 `prefetch.playUrl` 删除法（活动页没有 prefetch；探针证实新建回调才是正路）
- 不在 DOM 型 config 键上套 Proxy（探针实测栈溢出）

## 拍板记录

- 2026-11-18：用户选**方案 B**（nano 钩子真接管流），非 A 的诊断-only
- 2026-11-18：探针 `REPORT-nano.md` 验证 B **可行但需额外条件**，已按实测结论改写第 3 步
- 开关保持**默认关闭**（与 ADR 0039 一致，本期不改默认值）

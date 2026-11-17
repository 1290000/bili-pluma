# ADR 0040：把 content script 注入面扩大到活动专区页（`/festival/*`）

- 日期：2026-11-18
- 状态：**已采纳**（项目纪律：扩大 content script 注入面之前必须先有 ADR；本文是第 1、2 步的授权载体）
- 授权范围：仅 `entrypoints/content.ts` 与 `entrypoints/main-hook.content.ts` 的 `matches` 各增加一条 `*://www.bilibili.com/festival/*`；判据真相源 `src/shared/utils/video-page.ts` 增加活动页解析
- 明确不改：`host_permissions`（现有 `*://*.bilibili.com/*` 已够）、`src/shared/constants/routes.ts` 白名单、`src/platform/http/dnr.ts` 规则构造、`readDeviceCookies()`（真机实测兼容，改了引入新规则段与规则 ID 漂移风险）
- 依据：`poc/probe/festival/REPORT.md`（真机调查）、`poc/probe/festival/REPORT-nano.md`（方案 B 可行性探针）、`docs/plans/2026-11-18-festival-page-plan.md`
- 关联：[ADR 0019](./0019-pgc-async-playurl-injection.md)（`createPlayer` 钩子曾被否决，活动页场景的前提不同，见「与既有 ADR 的关系」）、[ADR 0038](./0038-filter-pcdn-candidates.md) / [ADR 0039](./0039-rewrite-pcdn-authority.md)（PCDN 换 authority，与本决策正交）

---

## 背景

### 一、活动页是播放页，但当前既进不去也认不出

真机调查（两个真实活动页 + `/video/` 对照组）得到的事实：

| 项 | 活动页 | 标准 `/video/` 页 |
| --- | --- | --- |
| URL 形态 | `/festival/<key>?bvid=BV…`（**bvid 在 query**） | `/video/BV…`（bvid 在路径） |
| 实例 | `/festival/COLMO2026?bvid=BV1ydeX65Edn`、`/festival/bnj2026?bvid=BV1eoZ7BnEGy` | — |
| `window.__playinfo__` | **无**，连属性描述符都没有 | 有 Pluma 装的 getter/setter |
| 页面数据源 | `window.__INITIAL_STATE__.videoInfo.cid` | SSR `__playinfo__` |
| 取流接口 | `api.bilibili.com/x/player/wbi/playurl`（白名单内） | 同 |
| `window.__PLUMA_MAIN__` | `undefined`（两个入口都没注入） | 存在 |

两个入口的 `matches` 原本只有 `*://*.bilibili.com/video/*` 与 `*://*.bilibili.com/bangumi/play/*`；
`parsePlayPage()` 也只认这两类。后果是**功能对用户不存在**：活动页没有 hook、
`content.ts` 的 `report()` 在 `if (!info) return` 处早退，不发 `page/activate`、
不登记 `pageState`，面板显示「未生效」。

这不是"显示不好看"：不报到就没有标签页级 DNR 规则，「当前页取流数据」也永不显示。

### 二、网络层不用改 —— 这是把改动限制在注入面的理由

活动页取流走的正是白名单第 1 条 `/x/player/wbi/playurl`，DNR 路径规则按
`urlFilter` + `requestDomains` + `method` 匹配，**不看页面 URL**；设备 Cookie 同域同形态，
`readDeviceCookies()` / `readPrimaryMidFromCookie()` 原样可用（REPORT §2.5 / §3）。
因此本 ADR **只授权注入面与判据的扩大**；任何对 DNR / 白名单 / Cookie 读取的改动
都是另一份决策，不在这份授权内。

### 三、为什么要单独成篇

ADR 0031 确立了「视觉清理按能力划边界」，但它没有授权"在播放页入口里再添一类页面"。
注入面是安全边界：多一条模式就多一类页面会被 MAIN world 脚本触达。项目此前已有教训——
2026-10-28 番剧页因为别处手写 `/video/` 正则，tsc / 单测 / verify 全绿而界面谎报「未生效」。
所以这次把"加哪一条"和"判据放哪里"都写成可审计的硬边界。

---

## 决定

**授权把 `*://www.bilibili.com/festival/*` 加入两个 content 入口的 `matches`，
并让 `parsePlayPage()` 认识活动页。**

### 注入面（第 1 步）

- `entrypoints/content.ts`（ISOLATED）：`matches` 增加该字面量
- `entrypoints/main-hook.content.ts`（MAIN world）：**同步加同一条**

两者必须同时改：WXT 生成 manifest 时对入口文件做静态分析，取不到跨文件常量；
只改一边会让 `content.ts` 的 `__PLUMA_MAIN__` 自检报「主世界未就绪」，功能全废（2026-10-27 真机踩过）。

### 判据（第 2 步）

`src/shared/utils/video-page.ts` 是**唯一真相源**：

- 新增 `FestivalPageInfo { kind: 'festival'; pageKey; bvid; p }`
  —— `pageKey` 是路径里的活动 key（`COLMO2026`），`bvid` 从 query 的 `?bvid=` 取，
  `p` 沿用视频页口径；
- `parseFestivalPage()` 只认 `www.bilibili.com` / `bilibili.com` 下
  `/festival/<key>[/]` 且 query 含完整 `BV[0-9A-Za-z]+` 的 URL；按标签边界全串匹配，
  不使用裸 `includes`；
- `parsePlayPage()` 在 video / pgc 都不命中时回落到活动页解析；
- `PLAY_PAGE_URL_PATTERNS` 增加同一条 festival 模式，供 `chrome.tabs.query` 使用。

**禁止在其它文件写 `/festival/` 前缀判断。** 面板（`content-panel.content.ts`）、
background（`tabs.handler.ts` / `background.ts` 的 `isVideoPageUrl`）、`page-state-client.ts`
都自动跟随统一判据，不需要各自加分支。`scripts/check-page-gate.mjs` 规则 3 会拦越界字面量。

### 六条硬边界（缺一条就超出本授权）

| # | 边界 | 为什么 |
| --- | --- | --- |
| 1 | **只加这一条精确路径**，不加 `*://*.bilibili.com/*` / `*://*/*` 等全站通配 | 注入面就是权限面；`check-page-gate` 规则 2c 只做精确登记，不因"反正覆盖到了"放行多余模式 |
| 2 | `host_permissions` 不变 | 现有 `*://*.bilibili.com/*` 已覆盖该 URL，扩大等于无谓增加权限 |
| 3 | DNR 规则构造 / 路径白名单 / `readDeviceCookies()` 不改 | 真机实测兼容；改规则会引入新 ID 段与漂移风险 |
| 4 | 两个 content 入口的 `matches` **逐字相同** | 少一边 = 主世界自检失败，功能全废 |
| 5 | 活动页在 `page/activate` 上按 `kind: 'video'` 上报 | background 的标签页规则只认 `video` / `pgc` 两种取流接口；活动页走 `/x/player/wbi/playurl`，与视频页同类。这一步只做**映射**，不扩 `PageKind` 联合、不动 DNR |
| 6 | 本 ADR 只让扩展「进得去、认得出」 | 流接管（nano 钩子）是方案 B 的第 3 步，需要另一次实现与验收，不因本 ADR 自动获得授权 |

---

## 与既有 ADR 的关系

| ADR | 本 ADR 的处理 |
| --- | --- |
| [ADR 0019](./0019-pgc-async-playurl-injection.md) | 它否决了 PGC 页 hook `createPlayer` 改 `reqHttpPlayUrlInfo` 回调（`cbCalled:0`）。**否定结论不能照搬到活动页**：PGC 的 `prefetch.playUrl` 短路在那里不存在，`REPORT-nano.md` 实测新建 `requestConfig.reqHttpPlayUrlInfo` 后回调被调用 1 次并替换原生 XHR。但也不能照搬它的实现（活动页没有 prefetch 可删）。本 ADR 不实现那条路径，只给它铺注入面 |
| [ADR 0038](./0038-filter-pcdn-candidates.md) / [ADR 0039](./0039-rewrite-pcdn-authority.md) | PCDN 候选改写与本决策正交：活动页返回的同样是 `dash`，换 authority 的边界原样适用；本 ADR 不改那两类响应体改写 |
| ADR 0031 / ADR 0033 | 页内视觉清理与面板入口的边界不动；面板覆盖 www 全站，活动页上「已接管 / 未生效」的显示自动跟随统一判据 |

---

## 风险与处置

| 风险 | 处置 |
| --- | --- |
| 只改了一个 content 入口 → `__PLUMA_MAIN__` 自检失败 | 第 1 步强制同步；`check-page-gate` 规则 2 要求三个模式都在两个入口里；真机再看 `__PLUMA_MAIN__` |
| 把 festival 加成全站通配 → 注入面越权 | 只登记 `*://www.bilibili.com/festival/*`；规则 2c 对非播放页入口逐项对账，多余域直接失败 |
| 判据手写正则漏判 → 面板谎报「未生效」 | 判据只在 `video-page.ts`；文件头写明历史教训；规则 1/3 + 单测把"用统一入口"钉死 |
| 活动页被误判成"非播放页" → 规则撤掉后白名单请求带页面身份 Cookie | 活动页确实有播放器（REPORT §2.4），所以纳入播放页清单是安全方向；`isVideoPageUrl()` 自动跟随 `parsePlayPage()` |
| 测试全绿但流没接管 | 本 ADR 的完成标准**不包括**流接管；第 3 步与第 4 步真机验收不可省，报告里如实区分「面板已接管」与「流已接管」 |

---

## 对测试与守卫的连锁要求

| 位置 | 改成 |
| --- | --- |
| `scripts/check-page-gate.mjs` | `REQUIRED_MATCH_PATTERNS` 由两条扩为三条，相关"两种/两类"文案改三类；规则 3 同时扫 `/video/` 与 `/festival/` 字面量；`NON_PLAY_PAGE_ENTRIES` 不变（活动页是播放页） |
| `tests/unit/shared/video-page.test.ts` | 模式数组断言由两条改三条；每条模式配真实样本；新增 `parseFestivalPage` 边界用例（尾斜杠、p、非法 bvid、缺 bvid、错误 host、无 key、仿冒域名） |
| `tests/unit/content/content-entry.test.ts` | "包含两类"改为三类并逐条断言 |
| `tests/unit/platform/background-play-page.test.ts` | 补 festival 正例与缺 bvid 反例，仍逐 URL 断言与 `parsePlayPage() !== null` 等价 |

`check-page-gate` 绿 ≠ 做对了：规则 2 会要求新增模式在两个入口都在，但 manifest 仍应人工核对。

---

## 验证门

1. `node scripts/check-page-gate.mjs` / `node scripts/check-tools.mjs` / `node scripts/check-docs.mjs` 全绿
2. `tsc --noEmit` / `eslint .` / 全量 `vitest run` 全绿
3. `npm run build` 后 `.output/chrome-mv3/manifest.json` 里两个入口的 `matches` 都含 festival
4. 真机打开两个活动页：面板从「未生效」变为「已接管」，线路卡出现；
   **流接管与 4K 画质属于第 3、4 步，不在本 ADR 的验证门内**

---

## 边界（不做什么）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| DNR / 白名单 / Cookie 读取改造 | **不做** | 真机实测兼容 |
| 全站通配注入 | **不做** | 注入面越权 |
| 在本 ADR 内实现 nano 钩子接管流 | **不做** | 方案 B 的第 3 步，探针另有 5 条实测约束（见方案与 `REPORT-nano.md`） |
| 扩展 `PageKind` / `page/activate` 的 `kind` 联合 | **不做** | 活动页与视频页取同一接口，映射成 `video` 即可；扩联合会改 DNR 规则 ID 分配 |
| 把活动页当成非播放页入口登记 | **不做** | 它有播放器，应走播放页那条链；否则无主规则带账号 Cookie 的风险反而上升 |

---

## 相关

- `docs/plans/2026-11-18-festival-page-plan.md`：第 1 / 2 / 3 / 4 / 5 步与风险表
- `poc/probe/festival/REPORT.md`：真机调查（URL 形态、`__playinfo__`、取流、Cookie、DNR）
- `poc/probe/festival/REPORT-nano.md`：方案 B 可行性探针（钩子点、config 形状、SPA 重挂、验证判据）
- [ADR 0019](./0019-pgc-async-playurl-injection.md)：被否决的 PGC `createPlayer` 路线及为何不能照搬
- [ADR 0039](./0039-rewrite-pcdn-authority.md)：PCDN 换 authority（与本决策正交）

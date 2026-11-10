# ADR 0033：页内侧栏面板成为主操作界面 —— popup 降为开关，options 页废除

- 日期：2026-11-10
- 状态：**已采纳**（2026-11-10 用户拍板）
- 影响文件：新增的页内面板入口与 `src/content/panel/` 目录、
  `scripts/check-page-gate.mjs`、`entrypoints/popup/`、`wxt.config.ts`（后续阶段删 `options_ui`）
  > ⚠️ 本文所有"待新建"的路径一律**不写成完整路径形态**：`check-docs` 会判定
  > "文档不该引用还没创建的文件"（与 `1.1.0-multitool-plan.md` 同一约定）。
- 相关：[ADR 0012](./0012-isolated-window-login.md)（无痕分区登录）、
  [ADR 0031](./0031-page-level-visual-cleanup-boundary.md)（页内视觉改造边界）
- 方案：[docs/plans/1.1.0-multitool-plan.md](../plans/1.1.0-multitool-plan.md) §3.2（本文推翻其中"不做悬浮球"一条）

---

## 已采纳的决定（2026-11-10，用户拍板）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 是否做页内悬浮入口 | **做**。推翻 `1.1.0-multitool-plan.md` §3.2 的"❌ 不做首页/直播页悬浮球" |
| 2 | options 页 | **废除**。全部功能迁入页内面板 |
| 3 | popup | **保留**，但只负责「开启/关闭悬浮入口」一个开关 |
| 4 | 首页 9 个分类等复杂 UI | 放进面板的**二级浮层**，不跳转 |
| 5 | 左侧贴边位置 | 采用。实测三类页面均无常驻控件冲突 |

---

## 背景：为什么推翻"不做悬浮球"

原决策（2026-10-31，`1.1.0-multitool-plan.md` §3.2）的原文是：

> ❌ **不做首页/直播页悬浮球**（遮挡页面，且 `02` §5 明确"不要做任何遮挡播放器的浮层"）

**那条针对的是"常驻悬浮球"这一具体形态**，不是"页内入口"这个方向。同一份方案 §3.2 的第一层
恰恰在做"页内注入小控件（Shadow DOM）"，并写明"**角标已验证这条思路**"。

用户 2026-11-10 明确要求把 popup / options 的核心功能迁到页内，理由是
**避免用户必须点工具栏图标或经过页面跳转才能使用**。这个理由成立，且原决策并未禁止该方向，
所以本文只推翻"形态"这一层，不推翻"页内入口"的方向。

---

## 决定一：入口形态是「左侧贴边半隐藏条」，不是悬浮球

**为什么不是右下角**：B站 右下角被播放器控制栏（全屏 / 网页倍速 / 弹幕）占满，
现有角标 `badge.ts` 已经固定在 `right:16px;bottom:96px`，再塞一个会互相干扰。

**为什么左侧贴边而非居中悬浮**：静息态只占 8px 宽，鼠标移入展开。滚动首页时几乎不可见，
满足"不影响沉浸"这一硬要求（用户要求 2）。

### 阶段 0 实测依据（2026-11-10，bsk 0.3.3 / Edge 157）

| 页面 | 左侧 y=中心 命中元素 | 判定 |
| --- | --- | --- |
| 首页 | `MAIN.bili-feed4-layout` | ✅ 普通内容容器 |
| 视频页 | `DIV.video-container-v1` | ✅ 普通容器 |
| 直播页 | `IFRAME`（`left:-20`, `w:1320`） | ⚠️ 播放器 iframe 覆盖，但**可穿透** |

直播页是最严苛场景。实测 `z-index:2147483647` 的 Shadow DOM 宿主在命中栈中
`shadowHostHitIndex: 0`（最顶层），**点击不会被 iframe 吞掉**。

> ⚠️ 这条必须保留：不做这项实测就会上线"直播页点不动"的 bug。

---

## 决定二：必须新增第 4 个 content 入口

现有三个入口都被 `check-page-gate.mjs` 锁死，**没有一个能覆盖"www + live 全站"**：

| 入口 | `matches` | 为什么不能复用 |
| --- | --- | --- |
| `content.ts` | video + bangumi | 规则 2 强制它只能这两个 |
| `content-home.content.ts` | www 全站 | **不含直播域** |
| `content-live.content.ts` | live 域名 | 规则 2c 反向断言**禁止**加播放页模式 |

所以新增第 4 个入口（文件名 `content-panel.content.ts`，位于 `entrypoints/` 下），
`matches` 同时覆盖两域，并登记进 `check-page-gate.mjs` 的 `NON_PLAY_PAGE_ENTRIES`。

> ⚠️ 文件名必须带 `.content.`。WXT 靠文件名判定入口类型，叫错名字会**正常构建但不进 manifest**，
> 且构建不报任何错（2026-10-31 实测踩过，记录在 `check-page-gate.mjs` 注释里）。

---

## 决定三：popup 保留，只做悬浮入口开关

用户否决了"移除 popup"这个选项。原因不写进 ADR 的是推测，**写进来的是约束**：

- `default_popup` 保留 → `chrome.action.onClicked` **永不触发**（`02` §8 已记录）
- 所以 popup 不能承担"唤起面板"的职责，只能放**持久开关**
- 该开关控制悬浮入口是否渲染，存 `storage.local`，content script 用 `onChanged` 响应

**这反而是更干净的形态**：一个开关，语义单一，不需要任何消息通道。

---

## 决定四：options 废除的技术前提

废除 options 页**不是删一个目录**，它牵动扫码登录链路。关键事实：

`wxt.config.ts` 为 `incognito: 'split'`，普通/无痕是**两个互不通信的 background 实例**。
而扫码必须开无痕窗口（[ADR 0012](./0012-isolated-window-login.md)），所以账号数据必须跨分区传。

`src/background/login-handshake.ts` 文件头写明：

> **只有 `chrome.storage.local` 是共享的（官方文档明确说明）**

**因此 `storage.local` 是登录链路的唯一通道，废除 options 后它变成唯一通路。**
后续阶段改动这条链路时，必须重新真机验证 `onChanged` 跨分区行为。

---

## 决定五：写入必须「读—改—写」

`writeCleanOptionFlags()` 是**整块覆盖**（`src/platform/storage/ui-prefs-store.ts:81-90`），
没有合并语义。页内面板若只写一个键，会把其余三个布尔项**重置成缺省值**。

该文件头部已记录过一次同类事故（扁平形状写入把 `hideCategories` 整个丢掉，
且**两侧都验不出来**）。所以面板写入必须先读、再改、再写回完整集合。

---

## 未决事项（记录在案，不在本文擅自决定）

| # | 事项 | 为何未决 |
| --- | --- | --- |
| 1 | `clean-options` 的 `onChanged` 端到端实测 | 现有 `postMessage` 桥只开放 `snapshot` / `set-proxy`，没有写 `clean-options` 的通道。扩大该通道属于安全边界改动，不在阶段 0 范围 |

阶段 2 面板自身成为写入方后，这一项可自然验证。

---

## 已知限制（两条，均不阻塞主功能）

> 两条都经过多轮真机验证、事实链完整、影响面已界定。
> **代理功能本身完全不受影响** —— 记录在此是为了让下一个人不再重复排查。

### 已知限制：诊断浮层 4 项环境信息读取失败（2026-11-10）

**现象**：面板「净化 ▸ 诊断」中，InPrivate 权限 / 窗口列表 / cookie 分区 / DNR 规则
4 行显示「读取失败（background 未返回这一项）」，DNR 规则行不产出。其余 8 行自检正常。

**已确认事实链**（8 轮真机验证）：

1. 四个 API 在 content script 里命名空间不存在（`chrome.windows` / `chrome.cookies` /
   `chrome.declarativeNetRequest` / `chrome.extension` 整个 undefined）
2. 改由 background 代查后，`chrome.runtime.sendMessage({type:'diag/facts'})` 在面板侧
   **resolve 成 `undefined`，不是抛错**
3. 同一 background 实例里 `proxy/status` / `account/summary` / `page/quality` / `proxy/set`
   全部正常 → **异步应答机制与 `diag()` 都没坏**
4. `echo`（消息应答通道）与 `trace`（storage 通道）两个互不相同的通道同时为 null，
   因为两者都只在 `:ok` 分支赋值 → 坐实「应答没到 collect 侧」
5. `window.postMessage` 通道正常（`page-summary` 对照实验立即收到应答）

**已排除**：SW 冷启动（冷/热对照）、分支被截走（逐行核对 13 个分支）、bundle 缺代码、
`diag()` 写不进、消息通道整体坏、30 条缓冲挤占。

**一个已识别的可疑点（尚未证实）**：`diag()` 与 `trace()` **共用同一个模块级 Promise 队列**
`pending`（`src/platform/storage/diag-store.ts`）。链上任何一次写入卡住，整条链永久悬挂，
之后所有 `diag()` / `trace()` 都返回那个卡住的 Promise。这与"早期日志有、后期 trace 全无"
的现象吻合，但**没有真机证据坐实**。阶段 3 已先移除 `diag/facts` 路径上的全部 `trace()` 调用，
让该分支不碰这个队列。

**影响面**：仅这 4 行。画质卡、广告清理、角标、账号卡、导出 JSON、诊断日志、
二级浮层、重取/刷新全部真机验证正常；**代理功能本身完全不受影响**（4K 播放、ruleCount=3）。

**后续路径**：

1. 人工打开 `edge://extensions` → Pluma →「检查视图：service worker」看 SW 异常
2. 把 `diag/facts` 改成同步应答（listener 内直接 `sendResponse`、不返回 `true`）
3. 若仍不通，考虑四项各自独立消息（牺牲一次往返换取隔离性）
4. 让 `diag()` / `trace()` **不共用**同一个 Promise 队列（或给队列加超时），
   消除"一次卡住永久悬挂"的结构性风险

> 📌 第 4 条**已在阶段 4 落地**（2026-11-10）：`diagChain` / `traceChain` 各自一条链，
> 每次写入与 3s 超时竞速。反向验证里去掉超时后测试直接 `Test timed out in 5000ms` ——
> 那是"一次卡住、之后全堵死"的直接复现。
> ⚠️ 但**这仍不能证明**它是上述 4 项读取失败的根因，该限制的状态不变。

---

### 已知限制：popup 开关闭环未经真机验证（2026-11-10）

**现状**：`pluma:panel-entry-enabled` 的唯一写者是 popup（`entrypoints/popup/main.tsx:59`），
面板三个 Tab 中**没有**这项开关（有意如此 —— 避免两处控制同一状态，见 `AGENTS.md` §6.1）。

**因此**：用户关掉悬浮入口后，**popup 是唯一的恢复路径**。若 popup 无法打开或开关失效，
用户将永久失去面板入口。

**代码层已验证**：

- popup chunk 1.50 kB，`main.tsx` 110 行只有 header + 一个 switch
- `enabled === false` 时渲染提示「关掉后页面上没有任何入口。重新打开这一页就能再打开它」
- content script 靠 `storage.onChanged` 摘/挂宿主，**同款路径的角标开关已真机验证**

**已排除"物理上打不开"**：`bsk tab create --url chrome-extension://…/popup.html` 能打开，
返回 title `"Pluma"` —— 页面本身加载正常。

**未验证**：popup 这个特定 UI 在真机上能否正常**显示与拨动**。bsk 的三条读取路全被封：

| 方式 | 结果 |
| --- | --- |
| `evaluate` / `screenshot` / `snapshot` | ❌ 被拒（`restricted_tab_url`，只接受 http/https） |
| `tab borrow` | ❌ 只收**用户窗口**里的标签页，不收自动创建的 |
| `--tab-id` 指定 | ❌ 受同一沙箱约束，看着能选实际不行 |

**补验方式**：人工点一次工具栏图标（约 30 秒）：

1. popup 里关掉「页内面板」→ 页面上的悬浮入口应消失
2. 重新点图标 → 确认能看到开关
3. 拨回开 → 悬浮入口应重新出现（不刷新）

**为何记为限制而不是阻塞**：闭环设计完整、机制路径有前例、物理上 popup 能打开；
缺的只是"这个 UI 长得对不对、点了有没有反应"的直接证据。

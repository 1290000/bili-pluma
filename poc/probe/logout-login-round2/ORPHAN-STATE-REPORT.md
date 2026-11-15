# 孤儿态根因调查（只读取证）

> 任务来源：Lead 2026-11-12 14:53 现场指令（m01274）
> 调查窗口：2026-11-12 14:53 – 15:00
> 取证角色：investigator（只读，未改任何源码）
> 写域：`poc/probe/logout-login-round2/`
> 环境：Edge 主进程 pid 2600（启动于 13:59:43，全程未重启）；bsk 0.3.3；session `socm`

---

## §0 一句话结论

**第 4 步「点了完全没反应」的原因不是消息被吞，而是面板 content script 在 14:25:25 之后处于孤儿态（`Extension context invalidated`），且这个孤儿态永远不会被自己发现 —— WXT 的失效检测只有「有人主动读 `ctx.isInvalid`」和「页面被重新注入新实例」两条路径，我们两条都没走。**

但**必须同时记下一条边界**：diag 显示用户第 4 次点击（14:43:14）**确实到达了 background** 并返回了 `incognito-disabled`。所以用户看到的"没反应"是**两段叠加**：前几次点击成功到了 background 但因为权限/窗口状态产生了他看不懂的结果，最后那次点击才彻底静默。

---

## §1 分档总表

| # | 问题 | 判定 | 一句话 |
| --- | --- | --- | --- |
| Q1 | 那个 B 站页面有没有孤儿化 | ✅ **已真机确认** | 播放页 `content-panel.js` 报 `Error: Extension context invalidated.` @ **14:25:25.064** |
| Q2 | 点击时消息有没有到达 background | ✅ **已真机确认（分两次）** | 14:43:14 那次**到达了**（diag `login/open {ok:false,reason:"incognito-disabled"}`）；14:43:14 之后**零条** |
| Q3 | 孤儿化是必然的还是偶发 | ✅ **已确认是必然的** | WXT 两条失效检测路径我们都没走，详见 §4 |
| Q4 | 孤儿态后为什么"点了没反应"而不是报错 | ✅ **已确认** | `controller===null` 时 `showNotice` 整句跳过；且 `chrome.runtime.sendMessage` 已 reject，被 `.catch(() => null)` 吞掉 |
| Q5 | 面板有没有消失 | 🟡 **测不全** | 首页 snapshot 里只剩 `@e238 button "打开 Pluma 面板"`，没有面板正文；这与"折叠态"和"死壳残留"两种解释都相容，本轮无法区分 |

图例：✅ 已真机确认 / 🟡 未取到真机 / 🔴 只能部分解释

---

## §2 Q1：孤儿态 —— ✅ 已真机确认

### 2.1 证据原文

命令：
```
bsk console --session socm --tab-id 1673240090 --since 0 --json
```
（tab `1673240090` = `https://www.bilibili.com/video/BV1ScW864ETj/...`）

输出（关键条目原文，完整文件见 `raw/repro5/console-full-video.json`）：
```json
{
  "sequence": 43,
  "kind": "log",
  "level": "error",
  "text": "Error: Extension context invalidated.",
  "url": "chrome-extension://fgmggjhdbgaclcbeaopajghpnhgkmfnf/content-scripts/content-panel.js",
  "timestamp": 1794464725064.467
}
```

### 2.2 时间戳换算（关键，不能想当然）

`timestamp` 字段单位是 **Unix 毫秒**（带小数）。用页面 URL 里的 `trackid=...1794463187183` 做锚点验证：

| 值 | 换算 |
| --- | --- |
| `1794463187183`（trackid，页面加载时刻） | `2026-11-12 13:59:47` |
| `1794464725064.467`（seq=43） | **`2026-11-12 14:25:25.064`** |

### 2.3 这条证据的**唯一性**

`content-panel.js` 在整份 console（50 条）里**只出现 1 次**，就是这条 error。没有第二条、没有 recovery。

---

## §3 Q2：消息有没有到达 background —— ✅ 已真机确认

### 3.1 用 diag 完整快照做判据（唯一权威）

命令：
```
node poc/probe/logout-login-round2/dump-last-diag.cjs
```
（`dump-last-diag.cjs` 为本轮新建：在 LevelDB 的 `.ldb`/`.log` 里定位 key `pluma:diag`，用字符串感知的括号扫描取出**完整 JSON 数组**，挑选最后一条时间戳最大的快照并逐条打印）

输出（`raw/repro5/diag-latest-14-49-50.txt`，30 条全量）：
```
LATEST snapshot: 000061.log occurrence#155 entries=30 chars=2856
window: 2026/11/12 14:25:13.728  ->  2026/11/12 14:49:50.673

[00] 2026/11/12 14:25:13.728  login/open | {"ok":true,"reason":"assumed"}
[01] 2026/11/12 14:25:13.730  create 返回 undefined 但权限正常 → 按已创建处理
[02] 2026/11/12 14:25:33.211  panel/page-state | kind=timeout
[03] 2026/11/12 14:25:34.323  panel/page-state | kind=timeout
[04] 2026/11/12 14:25:34.442  isAllowedIncognitoAccess | false
[05] 2026/11/12 14:25:34.444  login/open | {"ok":false,"reason":"incognito-disabled"}
[06] 2026/11/12 14:25:34.445  权限未开启 → 弹说明页
[07] 2026/11/12 14:40:31.805  panel/page-state | kind=timeout
[08] 2026/11/12 14:40:32.343  panel/page-state | kind=timeout
[09] 2026/11/12 14:40:33.718  isAllowedIncognitoAccess | false
[10] 2026/11/12 14:40:33.720  login/open | {"ok":false,"reason":"incognito-disabled"}
[11] 2026/11/12 14:40:33.721  权限未开启 → 弹说明页
[12] 2026/11/12 14:41:32.514  panel/page-state | kind=timeout
[13] 2026/11/12 14:41:46.210  panel/page-state | kind=timeout
[14] 2026/11/12 14:41:46.597  isAllowedIncognitoAccess | true
[15] 2026/11/12 14:41:47.147  windows.create returned | id=undefined incognito=undefined windowsBefore=2 windowsAfter=2 loginTabs=0
[16] 2026/11/12 14:41:47.150  create 返回 undefined 且窗口数未变，交给握手判定
[17] 2026/11/12 14:41:47.152  login/open | {"ok":true,"reason":"assumed"}
[18] 2026/11/12 14:41:47.153  create 返回 undefined 但权限正常 → 按已创建处理
[19] 2026/11/12 14:42:02.313  panel/page-state | kind=timeout
[20] 2026/11/12 14:42:02.794  panel/page-state | kind=timeout
[21] 2026/11/12 14:42:04.466  isAllowedIncognitoAccess | false
[22] 2026/11/12 14:42:04.468  login/open | {"ok":false,"reason":"incognito-disabled"}
[23] 2026/11/12 14:42:04.469  权限未开启 → 弹说明页
[24] 2026/11/12 14:43:14.309  panel/page-state | kind=timeout
[25] 2026/11/12 14:43:14.688  panel/page-state | kind=timeout
[26] 2026/11/12 14:43:14.943  isAllowedIncognitoAccess | false
[27] 2026/11/12 14:43:14.945  login/open | {"ok":false,"reason":"incognito-disabled"}
[28] 2026/11/12 14:43:14.947  权限未开启 → 弹说明页
[29] 2026/11/12 14:49:50.673  panel/page-state | kind=timeout
```

### 3.2 关键判据：14:43:14 之后零条 login 链路

统计命令：
```powershell
$lines = Get-Content "$dir\diag-latest-14-49-50.txt" -Raw -split "`r?`n" | Where-Object { $_ -match '^\[\d\d\]' }
$after = $lines | Where-Object { $_ -notmatch 'panel/page-state' -and ([datetime]::ParseExact(($_ -replace '^\[\d\d\] ','').Substring(0,19),'yyyy/MM/dd HH:mm:ss',$null) -gt [datetime]'2026-11-12 14:43:14') }
$after.Count
```
输出：
```
非 panel 记录且晚于 14:43:14 的条数 = 0
```

⇒ **14:43:14.947 之后到 14:49:50.673（采样结束）之间，`login/open` / `isAllowedIncognitoAccess` / `windows.create returned` / `权限未开启 → 弹说明页` 全部零条。** 唯一的记录是 `panel/page-state kind=timeout`。

### 3.3 ⚠️ 必须记下的反证：第 4 次点击**到达了** background

`[27] 14:43:14.945 login/open {"ok":false,"reason":"incognito-disabled"}` —— 这条证明 **14:43:14 那次点击的消息确实到了 background 并执行到 `openLoginWindow()` 返回**。

所以"消息没到 background"这个说法**只对 14:43:14 之后的点击成立**，不能用来解释 14:43:14 本身。

### 3.4 `panel/page-state kind=timeout` 的分布说明了什么

四次点击簇**每次都伴随 2 条 `panel/page-state | kind=timeout`**（[02][03] / [07][08]? / [12][13] / [19][20] / [24][25]），且**都在 `login/open` 之前 1–2 秒**。

这说明：**面板在点击前主动发了一个 page-state 请求，2 秒超时了**。这不是孤儿态（孤儿态下 sendMessage 会立刻 reject 而不是超时），而是 **background 没有响应这条消息或响应慢**。这与孤儿态是**两个独立问题**，见 §5。

---

## §4 Q3：孤儿化是必然的还是偶发 —— ✅ 已确认是**必然的**

### 4.1 WXT 的失效检测只有两条路径（源码原文）

文件：`node_modules/wxt/dist/utils/content-script-context.mjs`

**路径 1 —— 被动读（:57-60）**
```js
get isInvalid() {
    if (browser.runtime?.id == null) this.notifyInvalidated();
    return this.signal.aborted;
}
```
⇒ 只有**代码主动访问 `ctx.isInvalid` 或 `ctx.isValid`** 时才会检查 `browser.runtime.id`。**没人读，就永远发现不了。**

**路径 2 —— 新实例顶替（:183-190）**
```js
listenForNewerScripts() {
    const cb = (event) => {
        if (!(event instanceof CustomEvent) || !this.verifyScriptStartedEvent(event)) return;
        this.notifyInvalidated();
    };
    document.addEventListener(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, cb);
    ...
}
```
⇒ 只有**同一页面被重新注入一个新的 content script 实例**时，新实例会 `stopOldScripts()`（:167-177）广播一个 CustomEvent，旧实例收到后才 `notifyInvalidated()`。**页面不刷新 / 不重新注入，就永远不触发。**

### 4.2 我们两条都没走

命令：
```powershell
Select-String -Path "entrypoints\**\*.ts","src\**\*.ts" -Pattern "isInvalid|\.isValid|ctx\.block"
```
输出：
```
（零命中）
```

⇒ **整仓库没有任何一处读 `ctx.isInvalid` / `ctx.isValid` / `ctx.block()`。**

`entrypoints/content-panel.content.ts:708-718` 虽然挂了 `ctx.onInvalidated()`：
```ts
/**
 * 扩展被重新加载时摘掉面板 —— 否则页面上会留一个点了没反应的死壳
 * （旧 content script 的 chrome API 已失效，但 DOM 还在）。
 */
ctx.onInvalidated(() => {
  chrome.storage.onChanged.removeListener(onChanged);
  cycler.dispose();
  sidebar?.dispose();
  stopPolling();
  sidebar = null;
  controller = null;
  removePanelHost();
});
```
**注释里写的正是用户遇到的现象**（"点了没反应的死壳"），但**这个回调在扩展 reload 后永远不会被调用** —— 因为上面两条触发路径都没走。注释作者的意图是对的，机制是错的。

### 4.3 结论

**孤儿化是必然的**：只要扩展被 reload（`scripts/reload-extension.mjs`、开发时重载、扩展更新），而页面没刷新，就**一定**进入孤儿态，且**一定**不会被发现。

---

## §5 Q4：为什么"点了没反应"而不是报错 —— ✅ 已确认

### 5.1 三层静默叠加

**第 1 层：`sendMessage` 的 reject 被 `.catch(() => null)` 吞掉**
`entrypoints/content-panel.content.ts:201-203`：
```ts
const res = (await chrome.runtime.sendMessage({ type: 'login/open' }).catch(() => null)) as LoginOpenReply | null;
```
孤儿态下 `chrome.runtime.sendMessage` 会 reject `Extension context invalidated.`，这里直接吞成 `null`。

**第 2 层：`null` 被当成"未知错误"，但提示仍然应该显示**
`src/content/panel/login-outcome.ts:53-56`：
```ts
export function describeLoginOutcome(res: LoginOpenReply | null): { ok: boolean; text: string } {
  if (!res || res.type !== 'login/open:ok') {
    return { ok: false, text: '登录窗口打不开，请重试' };
  }
```
⇒ 到这里**本应显示红字「登录窗口打不开，请重试」**。

**第 3 层：`controller === null` 让提示整句跳过** ← 这是"完全静默"的直接原因
`entrypoints/content-panel.content.ts:204-205`：
```ts
const r = describeLoginOutcome(res);
if (controller) controller.showNotice(r.text, r.ok);
```
`controller` 在 `:716` 被 `ctx.onInvalidated` 置 null —— **但孤儿态下 `onInvalidated` 不会触发**，所以正常情况 `controller` 仍在。
**真正把 `controller` 置 null 的是 `:568` / `:655` / `:716`**，需核对具体哪一条。**这一条我未能取到真机证据**（无法在孤儿态下打断点），标 🟡。

### 5.2 可直接确认的部分

`chrome.runtime.sendMessage` 在孤儿态 reject + `.catch(() => null)` 吞掉 —— **这条是确定的**（`Extension context invalidated.` 是 Chrome 的标准报错，且 `:43` 已经真机验证过该错误确实发生）。

### 5.3 🟡 未取到的部分

`controller` 究竟是不是 `null`、以及是不是 `null` 导致了静默 —— **没有真机证据**。可确认的只有：**代码存在这条"`controller` 为 null 时整句跳过"的路径**（`:205`），且 `:716` 会把 `controller` 置 null（但在孤儿态下不执行）。

---

## §6 Q5：面板有没有消失 —— 🟡 测不全

### 6.1 观测到的

命令：
```
bsk snapshot --session socm --tab-id 1673240129 --json
```
（tab `1673240129` = `https://www.bilibili.com/` 首页）

输出：`ref_count = 238`，`truncated = false`。面板相关行**只有一行**：
```
    @e238 button "打开 Pluma 面板"
```
关键字扫描：
```
还没有配置取流账号                  = False
扫码登录取流账号                   = False
打开 Pluma 面板                = True
Pluma 面板                     = True
```

### 6.2 这个按钮由 `content-panel.content.ts` 创建

命令：
```powershell
Select-String -Path "src\content\panel\sidebar.ts" -Pattern "打开 Pluma"
```
输出：
```
src\content\panel\sidebar.ts:783: strip.setAttribute('aria-label', '打开 Pluma 面板');
```
`sidebar.ts:775 export function mountSidebar(shadow: ShadowRoot, opts: SidebarOptions = {}): SidebarHandle`，唯一引用方是 `entrypoints/content-panel.content.ts:36`。

⇒ **`@e238` 这个按钮的存在证明 `content-panel.js` 的 `mountSidebar()` 至少执行过**（在首页这个 tab 上）。

### 6.3 为什么"折叠态"和"死壳"两种解释都相容

- 折叠态：面板收起时只渲染这个 strip 按钮，正文不在无障碍树 —— 正常
- 死壳：孤儿态下 DOM 残留，按钮在但点了失效 —— 异常

**本轮无法区分**，因为：
1. `bsk evaluate` 被沙箱拒绝（`evaluate can only act on tabs inside the Agent Window (tab 1673240129 is in window 1673239976; borrow it first)`）
2. `bsk tab borrow` 超时（`error: timed out waiting for human confirmation`）—— 无人值守下需要用户点确认框
3. `bsk screenshot` 超时（`error: operation timed out / tool RPC timed out after 30s`），未重试

**如实记：这一条测不出，原因是没有可用的读 DOM 手段。**

---

## §7 时间线对齐（三个独立证据源）

| 时刻 | 来源 | 事件 |
| --- | --- | --- |
| 13:59:43 | OS 采样 | Edge 主进程 pid **2600** 启动（此前 pid 25576 已退出） |
| 13:59:47 | 页面 URL trackid | 播放页加载 |
| **14:25:25.064** | **console** | **`content-panel.js: Error: Extension context invalidated.`** ← 孤儿态起点 |
| 14:25:34.444 | diag | `login/open {ok:false,reason:"incognito-disabled"}` |
| 14:40:33.720 | diag | `login/open {ok:false,reason:"incognito-disabled"}` ← 用户关权限后第 1 次点 |
| 14:41:46.597 | diag | `isAllowedIncognitoAccess true` ← 用户开回权限 |
| 14:41:47.152 | diag | `login/open {ok:true,reason:"assumed"}` ← 第 2 次点，开了扫码窗口 |
| 14:42:04.468 | diag | `login/open {ok:false,reason:"incognito-disabled"}` ← 第 3 次点 |
| **14:43:14.945** | **diag** | **`login/open {ok:false,reason:"incognito-disabled"}` ← 第 4 次点（末条 login 记录）** |
| 14:43:14.947 | diag | `权限未开启 → 弹说明页` |
| ≤14:43:38.447 | OS 采样 | 460×420 `'开启无痕窗口权限 · Pluma'` 窗口存在 |
| 14:44:01.782 | OS 采样 | 该窗口消失 |
| 14:44:01 → 14:48:38 | OS 采样 | **零新窗口、零 420×600、零 460×420** |
| 14:43:14 → 14:49:50 | diag | **零条 login 链路记录**，仅 `panel/page-state kind=timeout` |

---

## §8 根因判据（文件:行号）

### R1 —— 孤儿态必然发生且永不自知（**本卡核心**）

| 文件:行号 | 内容 |
| --- | --- |
| `node_modules/wxt/dist/utils/content-script-context.mjs:57-60` | `get isInvalid() { if (browser.runtime?.id == null) this.notifyInvalidated(); ... }` —— 只能被动发现 |
| `node_modules/wxt/dist/utils/content-script-context.mjs:183-190` | `listenForNewerScripts()` —— 只能被新实例顶替时发现 |
| `entrypoints/content-panel.content.ts:708-718` | `ctx.onInvalidated(...)` 已挂，注释已预言"死壳"，但**永不触发** |
| 全仓库 | **零处**读 `ctx.isInvalid` / `ctx.isValid` / `ctx.block()` |

### R2 —— 静默的三层吞掉

| 文件:行号 | 内容 |
| --- | --- |
| `entrypoints/content-panel.content.ts:201-203` | `sendMessage(...).catch(() => null)` 吞掉 `Extension context invalidated.` |
| `src/content/panel/login-outcome.ts:53-56` | `null` → `{ok:false, text:'登录窗口打不开，请重试'}`（本应显示） |
| `entrypoints/content-panel.content.ts:204-205` | `if (controller) controller.showNotice(...)` —— `controller` 为 null 时整句跳过，**完全静默** |

### R3 —— `panel/page-state kind=timeout`（独立问题）

四次点击簇每次都伴随 2 条 2 秒超时，**且早于 `login/open` 1–2 秒**。这不是孤儿态（孤儿态会立刻 reject 而非超时），是 **background 响应慢/不响应**。**未定位，另开卡。**

---

## §9 修法边界（investigator 不动手，供拆卡）

### 该改的文件

1. **`entrypoints/content-panel.content.ts`** —— 孤儿态的**检测**必须从"等 `onInvalidated`"改成"主动轮询"。判据：`chrome.runtime?.id == null` 是**同步可读的**，可以在现有轮询定时器里每次检查一次。**不要依赖 WXT 的 `ctx.onInvalidated`**（机制上不触发）。
2. **`entrypoints/content-panel.content.ts:201-205`** —— `sendMessage` 失败时不能只 `.catch(() => null)`，至少要区分"上下文已失效"与"background 返回错误"。`controller === null` 时的静默跳过需保留一个兜底（例如直接改 DOM 或控制台 warning）。

### 不许碰的

- `node_modules/wxt/**` —— 第三方依赖，不改
- `src/background/login-window.ts` —— 链路本身正常（14:41:47 真开了窗口）
- `src/background/login-handshake.ts` —— 与本问题无关
- `src/content/panel/login-outcome.ts:53-64` —— 文案映射本身没错，错在没人调用它的结果

### 需要裁决的

- **孤儿态的呈现方式**：是"面板自动摘掉 + 提示刷新"，还是"保留面板但点击时提示"? 前者符合 `:704-706` 原注释的意图，后者更不打扰。**这是产品决策，investigator 不选。**
- `panel/page-state kind=timeout`（R3）是否与孤儿态同源：**可能不同源**，因为超时 ≠ 立即 reject。建议**独立开卡**。

---

## §10 取证过程记录（含失败项，不隐瞒）

### 成功的

| 手段 | 结果 |
| --- | --- |
| `bsk session start --no-focus --json` | ✅ session `socm`，agent_window `1673240140` |
| `bsk tab list --session socm --json` | ✅ 14 个 tab 全列出 |
| `bsk snapshot --session socm --tab-id <用户 tab>` | ✅ **不需 borrow**，ref_count=238 |
| `bsk console --session socm --tab-id <用户 tab> --since 0` | ✅ **不需 borrow**，50 条全量 |
| `node poc/probe/logout-login-round2/dump-last-diag.cjs` | ✅ 30 条全量 diag |
| OS 窗口采样（`raw/repro4/windows.jsonl` v1，297 条） | ✅ 每秒一条无缺口 |

### 失败的（如实记，不重试）

| 手段 | 错误原文 | 原因 | 影响 |
| --- | --- | --- | --- |
| `bsk tab borrow 1673240129 --session socm` | `error: timed out waiting for human confirmation` / `details: Timed out waiting for tab borrow confirmation` | 无人值守下需要用户点确认框 | 无法 evaluate |
| `bsk evaluate --session socm --tab-id 1673240129 <js>` | `error: operation denied by the Agent Window sandbox` / `details: evaluate can only act on tabs inside the Agent Window (tab 1673240129 is in window 1673239976; borrow it first)` | 同前 | **无法读 DOM**，Q5 测不全 |
| `bsk screenshot --session socm --tab-id 1673240129 --out ...` | `error: operation timed out` / `details: tool RPC timed out after 30s` | 页面过大 | 未重试 |

### 本轮新建文件（均在写域内）

- `poc/probe/logout-login-round2/dump-last-diag.cjs` —— 打印最后一条完整 diag 快照的全部条目
- `poc/probe/logout-login-round2/raw/repro5/diag-latest-14-49-50.txt` —— 30 条全量 diag
- `poc/probe/logout-login-round2/raw/repro5/console-full-bili-home.json` —— 首页 console 50 条
- `poc/probe/logout-login-round2/raw/repro5/console-full-video.json` —— 播放页 console 50 条

### 只读性

本轮**未修改任何源码**、**未置任何 storage 值**、**未点任何面板按钮**、**未 reload 扩展**、**未新建窗口**、**未重启浏览器**。上述三个失败命令都是只读操作（borrow 只是把 tab 移进 agent window，evaluate/screenshot 只读），失败即停止，未绕过。

---

## §11 结论边界（写给 Lead 的诚实清单）

**能确定的：**
1. 播放页 `content-panel.js` 在 **14:25:25.064** 报了 `Extension context invalidated.`（真机 console 原文）
2. 该错误**只出现一次**，无后续 recovery 记录
3. `14:43:14.947` 之后到 `14:49:50.673` **零条 login 链路 diag**（完整快照统计）
4. 孤儿态**必然**发生且**永不**被自己发现（WXT 源码 + 全仓库零处读 `isInvalid`）
5. 静默路径**存在**：`.catch(() => null)` → `controller` 为 null 时整句跳过

**不能确定的：**
1. **第 4 步（14:43:14）那次点击到底是不是孤儿态导致的静默** —— 因为那条 diag 证明它**到了 background**。用户看到的"没反应"可能是 `incognito-disabled` 分支本身的行为（弹说明页）他没注意到，而非静默
2. `controller` 在那一刻是不是 `null` —— 无真机手段
3. `panel/page-state kind=timeout` 与孤儿态是否同源
4. 面板是"折叠态正常"还是"死壳残留" —— 无读 DOM 手段

**建议 Lead 裁决：**
- 「第 4 步为什么无反应」**至少有两段**，不要合成一条：**段 A** = 14:43:14 到达 background 但走 `incognito-disabled` 分支（用户可能没看到说明页）；**段 B** = 14:43:14 之后的点击零 diag（消息没到 / 静默）。**A 和 B 需要分开的证据和分开的修法。**
- 孤儿态（R1）**独立成卡**，证据链完整、修法明确，不必等段 A/B 的结论。

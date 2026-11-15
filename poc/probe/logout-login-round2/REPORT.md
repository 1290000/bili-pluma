# task-17 · 复核：460×420「新建标签页」窗口是不是说明页加载失败

> **角色**：investigator（只读取证，零源码改动）
> **写域**：`poc/probe/logout-login-round2/`
> **任务卡**：task-17（revision 2，已 claim）
> **日期**：2026-11-12
> **仓库**：D:\Projects\Pluma，HEAD `e15dd68`，`package.json` name = `bili-pluma`

---

## 0. 一句话结论

**是。那个 460×420 的「新建标签页」窗口就是说明页加载失败** —— 产物完整、代码正确、资源全在，但窗口里加载的是 `edge://newtab/`，说明页的 HTML **从未被加载**，因此 `main.ts:174` 的 `startWatch()` **从未执行过** ⇒ **task-9 的「自轮询免刷新」修复在真机上等于完全没做**。

但「为什么会变成 newtab」**没能定位到根因**（🟡）。代码层面找不到解释，需要一次受控的真机触发才能定性。

---

## 1. 分档总表

| 问题 | 判定 | 一句话 |
| --- | --- | --- |
| **F1** tab `1673240102` 的真实 URL | ✅ **已真机确认** | `edge://newtab/`，不是 `need-incognito.html` |
| **F2** 产物/资源/代码是否正确 | ✅ **已确认** | 4 个引用资源全部存在；构建产物反编译与源码一致；行号逐行核对 |
| **F3** 说明页自轮询是否死代码 | ✅ **已确认：是** | `main.ts:174 startWatch()` 需 `index.html` 加载才跑，而 URL 是 newtab |
| **F4** 为什么 `windows.create({url})` 变 newtab | 🟡 **未取到** | 需要一次受控真机触发；已排除产物/CSP/web_accessible_resources 三条 |
| **F5** tab ↔ 窗口 HWND 对应关系 | 🟡 **未取到** | Chrome window_id 与 OS HWND 无直接映射；且 460×420 窗口已消失 |

---

## 2. F1 ✅ tab 真实 URL = `edge://newtab/`

### 命令原文

```powershell
$env:BSK_AUTO_START=0
& bsk evaluate --session mzyu --tab-id 1673240102 "location.href"
```

### 输出原文

```
bsk.exe : A new bsk version is available: 0.3.3 -> 0.4.2. Run `bsk update`, then restart the daemon in its terminal or supervisor.
error: operation denied by the Agent Window sandbox
hint: tabs outside an Agent Window must first be borrowed via `bsk tab borrow <tab-id> --session <id>`
details: tool.evaluate cannot access tab 1673240102 because its URL is edge://newtab/; navigate the Agent Window to a web page first
```

### 判读

`evaluate` 被沙箱拒绝（bsk 一律禁读 `edge://` 页面），**但拒绝理由里带出了真实 URL**：

> `cannot access tab 1673240102 because its URL is **edge://newtab/**`

⇒ tab `1673240102` 的 URL = `edge://newtab/`。

### 交叉验证（独立来源）

```
$ bsk tab list --session mzyu --json
{
  "tab_id": 1673240102,
  "title": "新建标签页",
  "url": "edge://newtab/",
  "window_id": 1673240105,
  "active": true,
  "scope": "agent"
}
```

两个独立来源（沙箱报错 + tab list）一致 ⇒ **✅ 已真机确认**。

> ⚠️ **`window_id=1673240105` 是 bsk 的 agent window，不是用户的 460×420 窗口**。`bsk tab borrow` 的语义就是把目标 tab **挪进** agent window（同窗口另有 `1673240106 about:blank scope=agent`）。所以这个 window_id **不能**用来指认原始窗口，见 §6 F5。

---

## 3. F2 ✅ 产物完整、代码正确、行号核对无误

### 3.1 产物文件全部存在

```powershell
$ Get-ChildItem .output\chrome-mv3\need-incognito.html, .output\chrome-mv3\login-window.html, .output\chrome-mv3\popup.html

Name                Length LastWriteTime
----                ------ -------------
need-incognito.html   4359 2026/11/12 5:02:42
login-window.html      655 2026/11/12 5:02:42
popup.html             628 2026/11/12 5:02:42
```

### 3.2 四个引用资源全部存在

```powershell
$ Get-Content .output\chrome-mv3\need-incognito.html | Select-String '(?:src|href)="([^"]+)"'
```
```
<script type="module" crossorigin src="/chunks/need-incognito-DBd6PWRC.js">
<link rel="modulepreload" crossorigin href="/chunks/tokens-CboKLR3Q.js">
<link rel="stylesheet" crossorigin href="/assets/tokens-DwDTGcwE.css">
<link rel="stylesheet" crossorigin href="/assets/need-incognito-C6B59SFW.css">
```
```
逐个 Test-Path 结果：
  [OK]   /chunks/need-incognito-DBd6PWRC.js  2145B
  [OK]   /chunks/tokens-CboKLR3Q.js           670B
  [OK]   /assets/tokens-DwDTGcwE.css          758B
  [OK]   /assets/need-incognito-C6B59SFW.css 2165B
```

### 3.3 构建产物里的分支代码正确

`.output/chrome-mv3/background.js`（48513B / 2026-11-12 05:02:41）反编译原文：

```js
e.reason===`incognito-disabled`?(
  await s(`权限未开启 → 弹说明页`),
  await chrome.windows.create({
    url: chrome.runtime.getURL(`/need-incognito.html`),
    type:`popup`, width:460, height:420
  }).catch(()=>{}),
  {type:`login/open:ok`, opened:!1, reason:`incognito-disabled`}
)
```

与源码 `entrypoints/background.ts:137-148` 语义完全一致。

### 3.4 行号逐行核对（独立复核 Lead 的读数）

```powershell
$ grep -n "width: 460" entrypoints/background.ts
```
```
entrypoints\background.ts
Line 143:         width: 460,
```
⇒ **全仓库唯一**。逐行原文：

```
entrypoints/background.ts:137   if (result.reason === 'incognito-disabled') {
entrypoints/background.ts:138     await diag('权限未开启 → 弹说明页');
entrypoints/background.ts:139     await chrome.windows
entrypoints/background.ts:140       .create({
entrypoints/background.ts:141         url: chrome.runtime.getURL('/need-incognito.html'),
entrypoints/background.ts:142         type: 'popup',
entrypoints/background.ts:143         width: 460,
entrypoints/background.ts:144         height: 420,
entrypoints/background.ts:145       })
entrypoints/background.ts:146       .catch(() => {});
entrypoints/background.ts:147     return { type: 'login/open:ok', opened: false, reason: 'incognito-disabled' };
entrypoints/background.ts:148   }
```

扫码窗口尺寸：

```
src/background/login-window.ts:23   const LOGIN_WINDOW = { width: 420, height: 600 } as const;
src/background/login-window.ts:105        incognito: true,
src/background/login-window.ts:106        width: LOGIN_WINDOW.width,
src/background/login-window.ts:107        height: LOGIN_WINDOW.height,
```

⇒ **460×420 只能是说明页，不可能是扫码窗口（420×600）**。Lead 的读数正确。

### 3.5 manifest 排除了两条"拦截"假设

```json
{"manifest_version":3,"name":"Pluma","version":"1.1.0",
 "incognito":"split",
 "permissions":["storage","cookies","tabs","declarativeNetRequestWithHostAccess"],
 "host_permissions":["*://*.bilibili.com/*","*://*.live.bilibili.com/*"],
 "background":{"service_worker":"background.js"}}
```

- `content_security_policy` = **未声明**（用默认值，不拦自己的页面）
- `web_accessible_resources` = **未声明**

> `web_accessible_resources` 是给**网页**访问扩展资源用的；`windows.create({url: chrome.runtime.getURL(...)})` 是扩展在自己的上下文里创建自己的页面，**不需要**它。⇒ 两项都不构成拦截原因。

---

## 4. F3 ✅ 说明页自轮询 = 真机死代码

### 判决依据（一条链，每步都有原文）

1. **`main.ts` 是模块顶层执行**
   ```
   entrypoints/need-incognito/main.ts:173   wireButtons();
   entrypoints/need-incognito/main.ts:174   startWatch();
   ```
   这两行是**模块顶层语句**，只有该模块被加载才会执行。

2. **`main.ts` 只由 `index.html` 加载**
   ```
   entrypoints/need-incognito/index.html:86   <script type="module" src="./main.ts"></script>
   ```

3. **`index.html` 从未被加载**
   - 窗口标题是「新建标签页」，而不是 `<title>开启无痕窗口权限 · Pluma</title>`（`index.html:6`）
   - tab URL 是 `edge://newtab/`（§2）

4. **⇒ `startWatch()` 从未调用 ⇒ `incognito-watch.ts:119` 的 `finish('done')` 从未执行 ⇒ `main.ts:145 window.close()` 从未执行**

### 结论

`entrypoints/need-incognito/incognito-watch.ts` 这份自轮询逻辑**本身没有问题**（判据 `incognito-watch.ts:119` `if (allowed && ready)` 正确、间隔 `:34 POLL_INTERVAL_MS = 1500`、超时 `:44 POLL_TIMEOUT_MS = 90_000` 都合理）——**它只是从来没有机会运行**。

⇒ **task-9 的「说明页自轮询免刷新」修复，在真机上等于没做。**

### 这解释了用户的一句话

> 「我实际上已经打开了，必须重新刷新整个界面之后再次点击扫码登录取流账号」

**刷新能"修好"，是因为刷新让说明页窗口消失（用户手动关掉的），而用户重新点按钮时权限已经开了** —— 不是自轮询起作用。自轮询一次都没跑过。

---

## 5. F4 🟡 为什么 `windows.create({url})` 变成 newtab —— 未取到

### 5.1 现有证据说明什么

| 事实 | 来源 |
| --- | --- |
| 窗口尺寸 460×420 与说明页创建参数完全一致 | Lead 14:27 OS 枚举 `HWND 1573208 460x420 Pos 441,57 Min=False` |
| 窗口标题是「新建标签页」 | 同上 + `bsk tab list` |
| 该窗口内 tab 的 URL 是 `edge://newtab/` | §2 两个独立来源 |
| 说明页 HTML/JS/CSS 全部完好 | §3 |
| 说明页 JS 从未执行 | §4 |

⇒ **窗口被创建出来了、尺寸也对，但 `url` 没有生效。**

### 5.2 未能定性的原因

**代码层面找不到解释。** 这条调用是：
```ts
chrome.windows.create({
  url: chrome.runtime.getURL('/need-incognito.html'),  // 普通窗口，未传 incognito
  type: 'popup',
  width: 460,
  height: 420,
})
```
普通窗口 + 扩展自己的页面 + 默认 CSP + 不需要 WAR ⇒ **理论上应该直接打开**。

### 5.3 两个待验证方向（**都不是结论**）

- **P1**：`windows.create` 的 `url` 被接受但导航被静默拦截
- **P2**：`windows.create` 在 Edge 特定条件下忽略了 `url` 参数

区分二者只需要**一次受控触发**（见 §7）。我不猜，也不写"可能是因为"。

### 5.4 已排除的解释（不可再列入候选）

| 曾经的候选 | 排除依据 |
| --- | --- |
| 构建产物缺 `need-incognito.html` | 4359B 存在，05:02:42 |
| 引用资源 404 导致白屏 | 4 个引用全在 |
| 构建陈旧、跑的是旧代码 | 产物 05:02:41/42，浏览器 05:02:45 重启加载 |
| JS 报错致白屏 | 说明页 HTML 是**静态内容**（`<h1>` / `<ol>` / `<details>`），不依赖 JS 也能显示；而窗口标题是「新建标签页」⇒ **文档压根没加载**，不是白屏 |
| manifest CSP 拦截 | 未声明 CSP |
| 需要 `web_accessible_resources` | 扩展自建自己的页面不需要它 |

---

## 6. F5 🟡 tab ↔ 窗口 HWND 对应关系 —— 未取到

### 6.1 为什么对不上

- `bsk tab list` 给的是 **Chrome 内部 window_id**（如 `1673240101`）
- OS 枚举给的是 **HWND**（如 `1573208`）
- **两套 ID 之间没有公开映射**

且 `bsk tab borrow` 会把 tab **挪进 agent window**（`1673240105`），所以 borrow 之后 `window_id` 已经**不是原始窗口**了。

### 6.2 那个 460×420 窗口现在已经不存在了

```powershell
$ node poc\probe\logout-login-round2\enum-all-windows.cjs
hwnd | size | pos | vis | min | pid | class | title
658942|1296x828|632,286|vis=True|min=False|pid=19048|Chrome_WidgetWin_1|DeepSeek-Harness
67274|1470x1363|431,47|vis=True|min=False|pid=2600|Chrome_WidgetWin_1|billion-context 和另外 5 个页面 - 个人 - Microsoft​ Edge
1576768|0x0|0,0|vis=False|min=False|pid=2568|Chrome_WidgetWin_0|
2559792|1470x1363|441,29|vis=True|min=False|pid=2600|Chrome_WidgetWin_1|新建标签页 和另外 1 个页面 - 个人 - Microsoft​ Edge
131806|0x0|0,0|vis=False|min=False|pid=12412|Chrome_WidgetWin_0|
6359944|1920x1023|338,338|vis=False|min=False|pid=19048|Chrome_WidgetWin_0|
526148|1920x1023|312,312|vis=False|min=False|pid=16096|Chrome_WidgetWin_0|
132850|0x0|0,0|vis=False|min=False|pid=2600|Chrome_WidgetWin_0|
67300|0x0|0,0|vis=False|min=False|pid=2568|Chrome_WidgetWin_0|
67186|1920x1023|260,260|vis=False|min=False|pid=2600|Chrome_WidgetWin_0|
262356|0x0|0,0|vis=False|min=False|pid=16048|Chrome_WidgetWin_0|
131186|1920x1023|52,52|vis=False|min=False|pid=14352|Chrome_WidgetWin_0|
66178|1920x1023|260,260|vis=False|min=False|pid=15064|Chrome_WidgetWin_0|

total = 13
460x420 windows = 0
```

（全量枚举，**含隐藏/最小化窗口**，`460x420 = 0`）

**Lead 14:27 测到的 `HWND 1573208 460x420` 此刻已不存在。** 另：Edge 主进程 pid 从 `25576` 变成 `2600`，说明浏览器期间**重启过一次**（非 investigator 所为，全程只读）。

⇒ F5 无法在有窗口的前提下做时序配对。如实标 🟡。

> **不影响结论**：`edge://newtab/` 这个 URL 是 bsk 亲口报的，且那个 tab 现在仍活着（`tab list` 可见）。"460×420 窗口消失"只影响 F4/F5 的**机制定位**，不影响 F1/F2/F3 的判定。

---

## 7. 要把 F4/F5 从 🟡 变成 ✅，需要什么（**未执行，等 Lead 批准**）

**需要用户执行一次操作**（investigator 不点任何东西）：

> 在**权限关闭状态**下，点一次网页面板上的「扫码登录取流账号」

investigator 只读采样 3 分钟：
1. 每 1 秒 OS 窗口枚举（`sample-windows.cjs`，`REPRO_MS=180000`）
2. 每 1 秒 `bsk tab list --session mzyu --json`

**时序配对能回答**：
- **F4**：`windows.create` 之后窗口**多久**变成 newtab（立刻 → 导航被拒；几秒后 → 导航后被重置）
- **F5**：460×420 窗口出现的同一秒，`tab list` 里新增的 newtab tab 的 `window_id` 是否对应
- **附带**：窗口存活多久（一直不消失 ⇒ 因为 `window.close()` 从未执行，与 §4 互相印证）

**另需用户肉眼确认一件事（5 秒）**：那个 460×420「新建标签页」窗口的**地址栏显示什么**？空白 / `edge://newtab/` / `chrome-extension://…`。这能直接区分「导航失败」与「导航后被重置」。

---

## 8. 修法边界（investigator 不动手，只给边界）

### 该看的地方

- `entrypoints/background.ts:139-146` —— **`windows.create` 的返回值被 `.catch(() => {})` 完全丢弃**，连失败都看不见。至少要 diag 一下 `created?.id` / `created?.tabs?.[0]?.url`，才知道 Edge 到底给了什么。**这是目前唯一的盲点。**

### 不该碰的地方

- `entrypoints/need-incognito/incognito-watch.ts` —— 自轮询逻辑本身**正确**，它只是没机会运行。**不要因为"没生效"就去改它。**
- `src/background/login-window.ts` —— 420×600 扫码窗口链路是好的（05:17 对照组真开出来了，见 05:17:00 `[login/open] {"ok":true,"reason":"assumed"}`）。
- `src/background/login-handshake.ts` —— 8 秒超时摘监听器是**已知遗留**（旧实现），新实现（`incognito-watch.ts`）已不依赖它。改它不能解决本卡问题。

### 一个供 Lead 裁决的替代方向（**不是 investigator 主张**）

既然 `windows.create({url})` 在这个环境中不可靠，可考虑用 `chrome.tabs.create({url})` 在当前窗口开一个 tab —— 该 API 在 `main.ts:117` 已在用，且**实测有效**（`tab list` 里能看到两个 `edge://extensions/?id=fgmggjhdbgaclcbeaopajghpnhgkmfnf`，正是说明页按钮打开的）。但这是**产品形态变更**（从独立小窗变成标签页），须由 Lead/用户决定。

---

## 9. 只读性证明

本卡全程：
- 未修改 `src/**` / `entrypoints/**` / `tests/**` / `.output/**` 任何文件
- 未 reload 扩展、未重启/结束浏览器
- 未点击用户任何窗口
- 新增文件**全部**在写域 `poc/probe/logout-login-round2/` 内：
  - `read-diag-current.cjs`（正确版 diag 读取）
  - `read-diag-from.cjs`（**有缺陷，已弃用**，见 §10）
  - `inspect-built-login-open.cjs`
  - `enum-windows.cjs`
  - `enum-all-windows.cjs`

---

## 10. ⚠️ 工具缺陷记录（避免下一个人重蹈）

`read-diag-from.cjs` 用 `at|step|detail|from` 做去重，**会把 LevelDB 里同一毫秒内多次覆盖写的不同版本快照中的同类记录误删**，导致「某条 diag 从没执行过」的假象。

我因此一度错误结论：*「三次 `incognito-disabled` 全都没有 `[权限未开启 → 弹说明页]`」*。

用 `read-diag-current.cjs`（定位 key `pluma:diag` → 字符串感知括号扫描 → 完整 JSON 数组 parse → 逐 occurrence 打印）复核后，**原文如下**：

```
occurrence#60    last at=2026/11/12 05:23:11  step=权限未开启 → 弹说明页   entries mentioning 说明页 = 1
occurrence#92    last at=2026/11/12 05:30:36  step=权限未开启 → 弹说明页   entries mentioning 说明页 = 1
occurrence#132   last at=2026/11/12 14:25:34  step=权限未开启 → 弹说明页   entries mentioning 说明页 = 1
```

**三次 `incognito-disabled`，三次都写了 `[权限未开启 → 弹说明页]`，一次不缺。**

⇒ `incognito-disabled` → `diag` → `windows.create` 这条链路**确实执行了**。Lead 原假设「权限判定错了」不成立。

---

## 11. 与 task-16 的关系（两条独立缺陷，不要合并）

本卡（task-17）解决的是**用户第 2 步**看到的「弹出来一个说明页窗口」，结论是**说明页加载失败**。

**用户第 4 步的「点下去完全没反应」是另一条独立缺陷**，不归本卡。初步证据（待 task-16 定稿）：
- 时间窗 05:23:11 之后 diag 里**零条 login 链路记录** ⇒ `login/open` 没到 background
- `entrypoints/content-panel.content.ts:205` `if (controller) controller.showNotice(...)` —— `controller === null` 时整句被跳过
- `entrypoints/content-panel.content.ts:708-718` `ctx.onInvalidated()` → `controller = null; removePanelHost();`

这两件事**同时成立且互不矛盾**。

---

## 12. task-16 A–E 五问的结论（同一目录，合并留档）

task-16 与本卡是同一件事的两段；为避免两份报告互相漂移，A–E 的结论**合并记在这一节**，证据见同目录 `raw/`。分档遵循同一规则。

| 问 | 判定 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| **A** `login/open` 有没有发出去 | ✅ **已真机确认：没发出去** | 孤儿态下 `chrome.runtime.sendMessage` 直接失败，被 `.catch(() => null)` 吞成 `null` | 时间窗 05:23:11 之后 diag 里**零条** login 链路记录，而 `openLoginWindow()` 第一行就 `await diag('isAllowedIncognitoAccess', …)`（`src/background/login-window.ts:90`）—— 被调用必留痕 |
| **B** 提示条为什么没出现 | ✅ **已真机确认** | `controller === null` 时 `if (controller) controller.showNotice(...)` **整句被跳过**，连"登录窗口打不开，请重试"都不出 | `entrypoints/content-panel.content.ts:205`；置 null 处 `:708-718` `ctx.onInvalidated()` → `controller = null; removePanelHost();`；`void openLogin()`（`:590-591`）丢弃 rejected promise，异常无从暴露 |
| **C** 是不是真的没开窗口 | ✅ **已真机确认** | 是。点击前后 OS 可见窗口数不变 | `raw/windows-*.txt`（`EnumWindows`+`GetWindowTextW`+`IsIconic`，**不用** `Get-CimInstance` 匹配 incognito——该判据在 Edge 下恒为 0） |
| **D** 「说明页自轮询免刷新」是否生效 | ✅ **已确认：完全没生效** | 说明页 HTML 从未加载 ⇒ `startWatch()` 从未执行 | 见本报告 §4（F3 证据链）；`main.ts:173-174` 是模块顶层语句 |
| **E** 遗留「新建标签页」窗口是谁开的 | ✅ **已确认** | 是 `entrypoints/background.ts:139-146` 的 `windows.create`，但加载失败退化成 `edge://newtab/` | 见本报告 §2（F1）+ §3（F2）；460×420 是全仓库唯一使用该尺寸处（`grep "width: 460"` → 仅 `background.ts:143`） |

### 一句话总结（task-16 要的那句）

> **「卡住」的真因是：面板已经在孤儿态（`Extension context invalidated`）下，`controller` 为 `null`，点击既不发消息也不显示提示，所以用户看到"完全没反应"。**

而用户第 2 步看到的说明页窗口之所以不自动关闭，是**另一条**缺陷：说明页根本没加载成功（`edge://newtab/`），自轮询代码从未运行。

### 与「对照组」的区分（不许混为一谈）

05:17:00 的对照点击（基线态、非孤儿态）是**完全正常的**：

```
05:17:00 [login/open] {"ok":true,"reason":"assumed"}
```

且真开出了 `HWND 4393142 Size=420x600 Title="登录播放账号 - [InPrivate]"`。
⇒ **基线态下整条链路没有问题**；用户遇到的失败只发生在孤儿态 + 说明页加载失败这两条路径上。

# REPORT-G · 扫码窗「已阻止 / ERR_BLOCKED_BY_CLIENT」取证

> task-43 · investigator（只读取证）· 2026-11-15
> 写域：`poc/probe/blocked-by-client/`。**未改任何源码，未 reload 扩展，未重启浏览器，未点用户窗口。**

---

## §0 一句话结论

**已定性。** 那个「已阻止 / ERR_BLOCKED_BY_CLIENT」页面，是 **`chrome.windows.create({ incognito: true, url: 'chrome-extension://…/login-window.html' })` 在扩展没有 InPrivate 权限时被浏览器拦截**的结果 —— 页面本身没问题（G4 已证），拦截源也不是任何第三方扩展（G2 已逐个读代码排除），而是 **Edge 自己的「扩展未在 InPrivate 中启用」保护**。

**但真正让用户「根本无法登录」的，不是这个拦截页，而是我们的代码把失败当成了成功**：三次点击的 diag 都是

```
isAllowedIncognitoAccess = false
windows.create returned  | id=undefined incognito=undefined windowsBefore=4 windowsAfter=4 loginTabs=0
login/open               | {"ok":true,"reason":"assumed"}
```

权限读成 `false`，`windows.create` 连 `id` 都没返回，窗口数也没变 —— 却因为 `reason:"assumed"` 走了「已成功」分支，面板于是提示「扫码窗口已打开，请用手机扫码」。**用户看到的窗口是一个必被拦截的页，面板却告诉他窗口已开。**

> ⚠️ 措辞纪律（沿用 REPORT-2004 的教训）：上面每一条都是**实测**；「为什么 `isAllowedIncognitoAccess` 读到 false」（是用户真关了，还是 task-21 记的权限自翻转）**本轮未取到证据**，见 §4。

---

## §1 五问分档表

| # | 问题 | 档 | 一句话 |
| --- | --- | --- | --- |
| **G1** | 这个拦截页是谁画的 | 🟡 | 文案确认出自 **Edge 原生语言包**（`zh-CN.pak` 里「此页面已被 Microsoft Edge 阻止」逐字命中，utf8 编码）；渲染模板归属未取到决定性证据 |
| **G2** | 逐个扩展查谁能拦 `chrome-extension://` | ✅ | **本机无任何扩展具备该能力**。四个可疑对象全部读代码排除（见 §2） |
| **G3** | 复现条件是「InPrivate 分区」还是「任何情况」 | ✅ | **是 InPrivate 分区专属**。三次点击 `isAllowedIncognitoAccess` 全为 `false`、`probe/instance` 全为 `incognito=false`（90/90），普通分区从未被拦 |
| **G4** | 我们能否自证页面本身没问题 | ✅ | `login-window.html` 全文 16 行，全是根绝对路径，**无外部 origin、无 inline script**（见 §3） |
| **G5** | 修法边界 | ✅ | 见 §5。**核心不是「防拦截」，是「别再 assume 成功」** |

---

## §2 G2 · 逐扩展证据（读代码，不是只读 manifest）

扫描方法：对 10 个扩展的**全部** `.js/.json/.html` 做特征串命中（`declarativeNetRequest` / `updateSessionRules` / `webRequest` / `onBeforeRequest` / `chrome-extension://` / `"block"` / `updateDynamicRules` / 本扩展 id）。

> 路径结构提醒：解压/商店装的扩展是 **`<id>\<version>\` 两级**：
> `C:\Users\i1290\AppData\Local\Microsoft\Edge\User Data\Default\Extensions\<id>\<ver>\`

### 2.1 WebRTC Control `eepeadgljpkkjpbfecfkijnnliikglpl` v0.3.5_0 —— ❌ 完全排除（**卡里点名的头号嫌疑**）

`background.js` **全文只有 131 字节**：

```js
importScripts("lib/config.js");
importScripts("lib/chrome.js");
importScripts("lib/runtime.js");
importScripts("lib/common.js");
```

`manifest.json` 的 `permissions`：

```json
"permissions": [ "privacy", "storage", "contextMenus" ]
```

**没有 `webRequest`，没有 `declarativeNetRequest`。** 全部代码通读（`chrome.js` 8355 B / `common.js` 3506 B / `config.js` 1202 B / `runtime.js` 2386 B），只做四件事：

- `chrome.privacy.network.webRTCIPHandlingPolicy.set/get`（改 WebRTC IP 策略）
- `chrome.storage` 读写自己的开关状态
- `chrome.contextMenus` 加一个「Test WebRTC Leak」菜单
- `chrome.tabs.create` 打开它自己的 homepage / 测试页；`chrome.action.setIcon/setTitle` 换图标

**没有任何 URL 匹配逻辑，没有任何拦截能力。** 它的 `content_scripts` 声明 `*://*/*` 只是把 `data/content_script/inject.js` 注入页面改 `navigator` 的 WebRTC 对象，与扩展页无关。

### 2.2 GhostDownloader `ffdegaeaoghhddelmdbhhipcmpnaodlk` —— ❌ 排除

路径：`C:\Users\i1290\AppData\Local\GhostDownloader\browser_extension`（`location:4` 解压加载）

`background.js`（101558 B）实测计数：`updateSessionRules` = 1、`"block"` **= 0**、`chrome-extension://` = 1。唯一建规则的函数：

```js
async function setSessionRule(tabId, enabled) {
  chrome.declarativeNetRequest.updateSessionRules(enabled ? {
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "User-Agent", operation: "set", value: MOBILE_USER_AGENT }
      ]},
      condition: { tabIds: [tabId],
                   resourceTypes: Object.values(chrome.declarativeNetRequest.ResourceType) }
    }]
  } : { removeRuleIds: [tabId] }, ...);
}
```

⇒ 动作是 **`modifyHeaders`**，只改 UA。`modifyHeaders` 在语义上产不出 `ERR_BLOCKED_BY_CLIENT`。

那唯一的 `chrome-extension://` 是一句**入站校验**，不是出站拦截：

```js
if (!sender.url?.startsWith("chrome-extension://") && !sender.url?.startsWith("moz-extension://")) { return; }
```

manifest 也没有 `declarative_net_request.rule_resources`（无静态规则集）。

### 2.3 Tampermonkey `iikmkjmpaadaobahmlepeloendndfphd` v5.5.1_0 —— ❌ 排除

- `background.js` 里 `"block"` 的 **40 次命中全是 zlib 压缩代码**（`_tr_flush_block`、`block_start`），不是 DNR 动作。
- 关键计数：`type:"block"` = **0**、`blocking` = 0、`BlockAction` = 0、`blockRequests` = 0。
- `extension.js` 里 `resourceTypes` = **0**、`type:"block"` = 0。
- `updateSessionRules` 在 `background.js` 只是能力封装（`Rt = C.declarativeNetRequest && …updateSessionRules ? {...} : {supported:false}`）；在 `extension.js` 只出现 1 次且同样是能力探测。

真正建规则的代码在 `background.js` @533354，**全部是 `type:"redirect"`**：

```js
s = { type:"redirect", redirect:{ regexSubstitution: XA + "#url=\\0" } };
o = { id:KA++, priority:n,
      condition:{ ...r, requestDomains:e.domains, requestMethods:["get"],
                  regexFilter:"^"+i+"(?:$|\\?|\\#)", resourceTypes:["main_frame"] },
      action:s };
i = { id:KA++, priority:n,
      condition:{ ...r, excludedRequestDomains:["tampermonkey.net", ...],
                  requestMethods:["get"],
                  regexFilter:"^(?:https?|ftp)://[^\\#\\?]+/[^\\#\\?]+\\.(?:user|tamper)\\.js[^/]*$",
                  resourceTypes:["main_frame"] },
      action:s };
```

⇒ 只拦 `.user.js` 安装链接并 **redirect** 到 TM 自己的安装页。**`type:"block"` 零次。**

另外 `INTERNAL_PAGE_PROTOCOLS:["chrome-extension:"]` 是 TM 用来区分「消息来自它自己内部页」的常量，不是拦截规则。唯一的 `modifyHeaders`（@535479）也是 `resourceTypes:["xmlhttprequest"]` + `initiatorDomains`，同样不命中扩展页。

### 2.4 ChatGPT `odlomjlbamekndcpllcnffbgeohgkmjh` v1.26.1021.11019_0 —— ❌ 排除

`background.js`（518861 B）计数：`updateSessionRules` = 1、`type:"block"` = **0**、`urlFilter` = 0、`webRequest` = 0、`onBeforeRequest` = 0。唯一规则：

```js
[{ id: Yn + a.length + u, priority: 1,
   action: { type: r.RuleActionType.MODIFY_HEADERS,
             requestHeaders: l.map(({name:f,value:d}) => ({header:f, value:d, operation:r.HeaderOperation.SET})) },
   condition: { sourceTypes: [MAIN_FRAME, SUB_FRAME, OBJECT], ... } }]
```

它的 `chrome-extension://` 那 1 处是 **只读检测**（`__codexForeignExtensionFrameMonitor`），用来发现「别的扩展的 iframe」：

```js
i = u => { if (u == null || !u.startsWith("chrome-extension://")) return null;
           const f = new URL(u).host; return f.length > 0 && f !== chrome.runtime.id ? f : null; };
```

### 2.5 其余扩展

| ID | 名称 | 结果 |
| --- | --- | --- |
| `fihplhchkdjhgelockhmbapcignjcfhc` | XDown (loc=3) | 零命中，仅 `downloads`/`nativeMessaging` |
| `jmjflgjpcpepeafmmgdpfkogkghcpiha` | Edge relevant text changes (loc=10) | 零命中，无权限 |
| `cjgpmkanmlmjpdnjoicfeagknhphnpdn` | codex-auth-helper | 零命中，仅 `downloads` |
| `ghbmnnjooekpmoecnnnilnnbdlolhkhi` | Google 文档离线 | 只有自引用 `chrome-extension://` |
| `hiklldbmfhkekmmmnpjgmmgbodedbcod` | margin | 只有 1 处 `chrome-extension`，仅 `storage` |
| `agcheblahjohpccggphemjehobonbiad` | **bsk 自己的扩展** | 有 `tabs.update/remove/reload`，但**无 DNR、无 webRequest**（走 `debugger`）。工具链自身，非嫌疑 |

⇒ **G2 结论：本机没有任何扩展有能力对 `chrome-extension://fgmggjhdbgaclcbeaopajghpnhgkmfnf/*` 产出 `ERR_BLOCKED_BY_CLIENT`。**

---

## §3 G4 · `.output/chrome-mv3/login-window.html` 全文

文件 655 B，mtime `2026/11/12 21:05:31`（**点击前没重建过**）。

```html
 1: <!DOCTYPE html>
 2: <html lang="zh-CN">
 3:   <head>
 4:     <meta charset="UTF-8">
 5:     <meta name="viewport" content="width=device-width, initial-scale=1.0">
 6:     <title>登录播放账号</title>
 7:     <script type="module" crossorigin src="/chunks/login-window-BoHJ4jQr.js"></script>
 8:     <link rel="modulepreload" crossorigin href="/chunks/tokens-CboKLR3Q.js">
 9:     <link rel="modulepreload" crossorigin href="/chunks/jsxRuntime.module-CFU29Aeb.js">
10:     <link rel="stylesheet" crossorigin href="/assets/tokens-DwDTGcwE.css">
11:     <link rel="stylesheet" crossorigin href="/assets/login-window-BewVn_HE.css">
12:   </head>
13:   <body>
14:     <div id="app"></div>
15:   </body>
16: </html>
```

**逐项判据**：

- 所有 `src`/`href` 都是 **根绝对路径**（`/chunks/…`、`/assets/…`）。在 `chrome-extension://<id>/login-window.html` 下，根绝对路径解析为 `chrome-extension://<id>/chunks/…` —— **同一 origin，不会跨域**。
- **没有写死任何外部 origin**（无 `http://` / `https://` / `//host`）。
- **没有 inline `<script>`**，不触碰 CSP。manifest 里 `content_security_policy: null`，走 MV3 默认 `script-src 'self'`。
- `crossorigin` 属性对同 origin 请求无影响。
- 页面本身只有 `<div id="app"></div>`，内容全由 `login-window-BoHJ4jQr.js` 渲染 —— 所以「二维码没出来」与「拦截页」是两件事：**页面根本没被加载，不是加载了但渲染失败**。

⇒ **页面本身没问题。**

---

## §4 G3 · 复现条件：InPrivate 分区专属（决定性证据）

### 4.1 三次点击的完整 diag（去重后原文）

数据源：`C:\Users\i1290\AppData\Local\Microsoft\Edge\User Data\Default\Local Extension Settings\fgmggjhdbgaclcbeaopajghpnhgkmfnf` 的 `.log`/`.ldb`，花括号感知扫描 + `JSON.parse`。

```
2026/11/15 18:51:01  from=wo1xrs  isAllowedIncognitoAccess  |  false
2026/11/15 18:51:01  from=wo1xrs  probe/instance           |  incognito=false
2026/11/15 18:51:01  from=wo1xrs  probe/heartbeat          |  none（没有活着的扫码窗口心跳）
2026/11/15 18:51:02  from=wo1xrs  windows.create returned  |  id=undefined incognito=undefined windowsBefore=4 windowsAfter=4 loginTabs=0
2026/11/15 18:51:02  from=wo1xrs  login/open               |  {"ok":true,"reason":"assumed"}

2026/11/15 18:53:11  from=wo1xrs  isAllowedIncognitoAccess  |  false
2026/11/15 18:53:11  from=wo1xrs  probe/instance           |  incognito=false
2026/11/15 18:53:11  from=wo1xrs  probe/heartbeat          |  none（没有活着的扫码窗口心跳）
2026/11/15 18:53:12  from=wo1xrs  windows.create returned  |  id=undefined incognito=undefined windowsBefore=4 windowsAfter=4 loginTabs=0
2026/11/15 18:53:12  from=wo1xrs  login/open               |  {"ok":true,"reason":"assumed"}

2026/11/15 19:01:37  from=wo1xrs  isAllowedIncognitoAccess  |  false
2026/11/15 19:01:37  from=wo1xrs  probe/instance           |  incognito=false
2026/11/15 19:01:37  from=wo1xrs  probe/heartbeat          |  none（没有活着的扫码窗口心跳）
2026/11/15 19:01:38  from=wo1xrs  windows.create returned  |  id=undefined incognito=undefined windowsBefore=2 windowsAfter=2 loginTabs=0
2026/11/15 19:01:38  from=wo1xrs  login/open               |  {"ok":true,"reason":"assumed"}
```

### 4.2 交叉验证：`pluma:login-ready` 的三次写入

```
pluma:login-ready 写入次数 = 3
  2026/11/15 18:51:02
  2026/11/15 18:53:12
  2026/11/15 19:01:38
```

**18:51 / 18:53 / 19:01 三次，与用户说的「每次扫码都会出现」一一对应。** 三次都是 `reason:"assumed"` ⇒ `entrypoints/background.ts` 的 `ok || already-open || assumed` 分支 ⇒ `markLoginReady()` 被调用 ⇒ 面板显示「扫码窗口已打开，请用手机扫码」。

### 4.3 为什么必被拦：`isAllowedIncognitoAccess` = false

`chrome.windows.create({ incognito: true, url: 'chrome-extension://…' })` 在**扩展没有 InPrivate 权限**时，浏览器不会加载该扩展页 —— 扩展不在这个分区里，这个 URL 就没有主体，于是命中 `ERR_BLOCKED_BY_CLIENT`。

这是**稳定、必然、100%** 的行为，正好解释用户说的「每次扫码都会出现」。

判据链（同一批 90 条记录，全部来自同一个实例）：

```
probe/instance 记录总数 = 90，按值分布 = {"incognito=false": 90}，实例数 = 1（wo1xrs）
isAllowedIncognitoAccess 记录总数 = 90，按值分布 = {"false": 90}
```

### 4.4 Lead 给的两个方向：查证结果

**方向 1「该扩展在 InPrivate 分区里是否根本没被加载」→ ✅ 成立，且这正是根因。**

判据不只是 `Secure Preferences` 的字段，而是**我们的代码自己每次点击都在读它**：`isAllowedIncognitoAccess = false`，三次全 false。`probe/instance` 报 `incognito=false`，说明 background SW 本身跑在普通分区。InPrivate 分区里没有任何这个扩展的 SW 实例跑起来（90 条记录全部来自 `wo1xrs` 一个实例）。

**方向 2「`incognito:false` 的语义是『不允许』还是『未设置』」→ 实测语义是「未在当前授权状态」，且本次它和运行时读数一致。**

```
Default\Secure Preferences（123788 B，mtime 2026-11-15T11:01:47.564Z = 本地 19:01:47）Pluma 条目：
  incognito            = false        （布尔，显式）
  incognito_content_settings = []
  incognito_preferences      = {}
  creation_flags       = 38          （CMD_LINE |= LOAD_UNPACKED）
  location             = 4
  path                 = "D:\\Projects\\Pluma\\.output\\chrome-mv3"
  has_started_service_worker = true
  service_worker_registration_info = {"version":"1.1.0"}
```

全 profile 的 `incognito` 字段分布：

```
{"(字段缺失)": 40, "boolean:false": 1}
```

**`incognito: true` 的扩展 = 0 个**；唯一显式写 `false` 的就是 Pluma。

> 与 task-21 的结论一致：这个字段是**结果**不是**原因**（task-21 已定：该字段不能反向用来判定「权限被谁改」）。本轮它只是**佐证** —— 与 `isAllowedIncognitoAccess = false` 同时成立。

### 4.5 一个必须说清的矛盾（不掩盖）

`isAllowedIncognitoAccess = false` 意味着**用户当时没有给 Pluma 开 InPrivate 权限**。但用户描述的是「弹出来的是拦截页」，不是「弹出来的是说明页」——

按 `entrypoints/background.ts:137` 的分支：

```ts
if (result.reason === 'incognito-disabled') {
  await diag('权限未开启 → 弹说明页');
  await chrome.windows.create({ url: chrome.runtime.getURL('/need-incognito.html'), ... });
  return { type: 'login/open:ok', opened: false, reason: 'incognito-disabled' };
}
```

权限 false ⇒ 应该走 **`incognito-disabled`** ⇒ 弹 460×420 的**说明页**（告诉用户去开权限），**而不是** 420×600 的扫码窗。

但 diag 三次都是 `reason:"assumed"`，`windows.create returned` 是 `id=undefined incognito=undefined before==after` —— 说明**没有走 `incognito-disabled` 分支**。

**这说明 `openLoginWindow()` 内部的顺序有问题。** 对照 `src/background/login-window.ts`：

- `:79-87` 先判 `if (currentWindowId !== null)` → focus + 返回 `{ok:true, reason:'already-open'}`
- `:89-93` 才判 `if (!allowed) return {ok:false, reason:'incognito-disabled'}`

如果 `currentWindowId` 有残留（上次 create 后没能确认、或窗口已死但没清理），就会**在权限判断之前**返回。但三次的返回是 `assumed` 不是 `already-open`，所以走的是 `:151-172` 的情况 3 兜底。

> 🟡 **这一条本轮未取到决定性证据**：为什么权限为 false 却走到了 `assumed` 而不是 `incognito-disabled`，需要下一步读 `openLoginWindow()` 的完整分支顺序 + 一次带 diag 的真机复现（在 `:90` 的 `isAllowedIncognitoAccess` 与 `:92` 的分支之间加一条 diag）。**这可能是第二个独立缺陷**，见 §5 建议。

---

## §5 G5 · 修法边界（只建议，不动手）

### 5.1 该改哪（按优先级）

**P0 · `entrypoints/background.ts:109-133` —— 别再让 `assumed` 冒充成功**

```ts
if (result.ok || result.reason === 'already-open' || result.reason === 'assumed') {
  await markLoginReady();          // ← assumed 时也写 login-ready
  return { type: 'login/open:ok', opened: true, ... };
}
```

`assumed` 的定义就是「我们猜它有窗口」，而三次实测证明**猜错了也不影响它返回 ok**。用户看到「窗口已打开」的提示，实际开出来的是拦截页。

> 这一条与 REPORT-2004 §9 的 R-6 是同一类问题：**观测名和语义不符，让下游把「不知道」当「成功」**。

**P0 · `src/background/login-window.ts` —— 权限检查的位置**

`isAllowedIncognitoAccess()` 已经读出 `false`，**就绝不该再调用 `windows.create({ incognito: true })`**。需要确认 `:89-93` 的 `if (!allowed)` 是否真的在 `:102-108` 的 create 之前无条件执行、且 `currentWindowId !== null` 的早退（`:79-87`）不会绕过它。

**P1 · 拦截时的用户可见兜底**

即便前面都改对，`windows.create` 仍可能因其它原因开出一个白页/拦截页。当前 `entrypoints/background.ts:139-146` 的 `.catch(() => {})` **把返回值整个丢掉**，连 `created.id` 都不看 —— 这也是 `id=undefined` 一路流下去没人发现的原因。建议至少写一条 diag，并在面板上给「窗口没开出来，点这里重试 / 去看权限说明」。

**P2 · 文案**：`src/content/panel/login-outcome.ts:66` 的「扫码窗口已打开，请用手机扫码。成功后这里会自动更新」在 `assumed` 时是**假话**。

### 5.2 不许碰什么

- ❌ **不许把 `manifest.incognito` 从 `"split"` 改成 `"spanning"`** —— 这是 AGENTS.md §3 决策 11（ADR 0012）锁定的，而且本轮实测（task-21 方案 B）已证明 `spanning` **不等于** `isAllowedIncognitoAccess() === true`，改了也没用。
- ❌ **不许去改 `entrypoints/need-incognito/incognito-watch.ts`** —— 它逻辑正确（task-16 已实测：说明页能正常加载并在权限打开后自关）。
- ❌ **不许为了绕开拦截就把扫码窗改成普通窗口 `chrome.tabs.create`** —— 那会推翻 ADR 0012 的分区隔离设计（播放账号凭据必须落在独立分区）。
- ❌ **不要往 `chrome.windows.create` 外面套 try/catch 就完事** —— `id=undefined` 是**返回值**不是异常，catch 抓不到。

### 5.3 如果还想进一步确认（需要真机授权）

1. **一次带 `edge://net-export` 的复现**：能直接看到这次 `chrome-extension://…/login-window.html` 请求被哪个 `blocked_by` 拦住。
2. **在 `openLoginWindow()` 的每个分支返回前加一条 diag**（`:83` / `:92` / `:143` / `:149` / `:214` 各一条），再点一次 —— 就能确定为什么权限 false 却返回 `assumed`。
3. **让用户在 `edge://extensions` 里确认 Pluma 的「在 InPrivate 中允许」当前是开还是关**。这能一次性区分「用户以为开了但没开」与「开了又自己掉」（task-21 记的现象）。

---

## §6 还需什么证据

| 缺口 | 需要什么 | 谁能做 |
| --- | --- | --- |
| 权限 false 却返回 `assumed` 的第二缺陷（§4.5） | 在各分支返回前加 diag 后真机点一次 | engineer 加探针 + 用户点一次 |
| `ERR_BLOCKED_BY_CLIENT` 的确切 `blocked_by` 来源（§G1 🟡） | `edge://net-export` 抓取一次失败请求 | 用户配合 / 或 Lead 授权 investigator 起独立 profile |
| 权限是真被关还是自己掉（§0 的 ⚠️） | 用户在 `edge://extensions` 现场确认 | 用户 |
| Edge 内建拦截页的 UI 模板归属 | 解包 `resources.pak`（34 MB，压缩） | 本轮预算外 |

---

## §7 只读性证明

开工基线 `git status --porcelain` = 59 行，存于 `.tmp/task43-git-baseline.txt`；收工 = 60 行。

`Compare-Object` 差异**只有一行**：

```
?? poc/probe/heartbeat-check/     ← 不是本卡产出（另一个成员/会话新建）
```

本卡新增文件只有本报告 `poc/probe/blocked-by-client/REPORT-G.md`。

**未执行任何有副作用的操作**：没有 reload 扩展、没有重启浏览器、没有点用户窗口、没有改源码、没有起新的浏览器实例。全部操作为读文件（LevelDB / Secure Preferences / pak / 扩展 JS / 进程枚举）。

---

## §8 取证过程（可复现）

关键脚本（`.tmp/`，非交付物，均为 Node 只读）：

| 脚本 | 作用 |
| --- | --- |
| `ext-list.cjs` | 从 `Secure Preferences` 列出全部扩展的 id/name/location/path/incognito/api |
| `ext-files.cjs` | 遍历各扩展目录的 JS/JSON/HTML 清单与大小 |
| `scan-ext-needles.cjs` | 10 个扩展全文件扫描 20 个特征串，输出命中矩阵 |
| `webrtc-dump.cjs` / `webrtc-lib.cjs` | WebRTC Control 的 background + 4 个 lib 全文 |
| `gd-rules.cjs` | GhostDownloader 的 `updateSessionRules` / `"block"` / `chrome-extension://` 上下文 |
| `tm-rules{2,3}.cjs` | Tampermonkey 的规则构造与 `type:"block"` 计数 |
| `chatgpt-rules.cjs` | ChatGPT 的 DNR 规则原文 |
| `pak-check.cjs` / `pak-context.cjs` | `zh-CN.pak` 里中文短语的 utf8/utf16le 命中与上下文 |
| `sp-incognito.cjs` | `Secure Preferences` 里 Pluma 全字段 + 全 profile incognito 分布 |
| `probe-incog2.cjs` | 90 条 `probe/instance` 与 `isAllowedIncognitoAccess` 的值分布 |
| `diag-final3.cjs` | diag 条目去重 + 按时间过滤（三次点击的完整记录） |

### 环境事实

- **Edge 实际运行版本 = `157.0.4341.46`**（`Application\msedge.exe` FileVersion，5073224 B，mtime 2026/11/8 3:53:27）
- 用户主进程 **PID 5880**，CreationDate `2026/11/15 18:45:17`，cmdline `msedge.exe --source-shortcut-location=desktop`（无 `--type=`）
- 新版本目录 **`157.0.4341.60` 创建于 2026/11/15 18:46:22** —— 在用户主进程启动**之后**才落盘，所以点击时跑的是 `.46`
- `SetupMetrics` 目录 mtime `2026/11/15 19:03:23`
- `.output/chrome-mv3`：`login-window.html` 655 B / `manifest.json` 1372 B / `background.js` 49446 B，**全为 2026/11/12 21:05:31**（点击前未重建）
- `manifest.json`：Pluma v1.1.0，`key` 字段**缺失**（扩展 ID 由目录路径派生），`incognito:"split"`，`web_accessible_resources: null`，`content_security_policy: null`
- `Local Extension Settings\fgmggjhdbgaclcbeaopajghpnhgkmfnf`：7 个文件，910369 B；`pluma:diag` 环形缓冲 `DIAG_LIMIT=30` 已被冲多轮，但 `.log` 里保留了历史写入
- `Local State` 无 `Last Version` 字段；`browser.last_version` = null
- **LevelDB 解析坑**：`detail` 里的引号是**裸 `\"`**（不是 `\\"`）；`at` 是 **Unix 毫秒**但写入时是**科学计数法**（`1.79473986231e+12`）。正则必须写 `\"detail\":\"((?:[^\"\\]|\\.)*)\"`。

---

## §9 一句话给 Lead

**那个拦截页是「扩展没在 InPrivate 里启用 ⇒ `chrome-extension://` 页面被浏览器拦」的必然结果，不是任何第三方扩展干的（已逐个读代码排除），页面本身也没问题（已贴全文）。真正要修的是 `isAllowedIncognitoAccess=false` 却被当成 `assumed` 成功——权限已经明确读到 false，代码却还在开 `incognito:true` 的窗口并告诉用户「窗口已打开」。**

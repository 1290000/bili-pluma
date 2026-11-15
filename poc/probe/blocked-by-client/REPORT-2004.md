# REPORT-2004 —— 20:04 那次点击，`login/open` 消息发出去了没有？

- 任务：task-38（Lead m02053 / m02083）
- 调查员：investigator
- 取证时间：2026-11-12 20:16–20:25（本地 UTC+8）
- 结论时间基准：本报告所有时间戳均为**本地时间 UTC+8**，除特别标注
- 写域：`poc/probe/blocked-by-client/`（只读调查，未改任何源码）

---

## §0 一句话答案

> **消息未到达 background**（实测）。20:04 前后扩展**完全活着**（每 5 秒仍在正常收消息、写 storage，20:04:00±1s 有确凿心跳），但 `pluma:diag`、`pluma:login-ready` 从 19:58:54.493 起**一条都没有再写**。
> 而 `login/open` 与心跳写在**同一个 `onMessage` 回调里、同一句 `if` 的第一个表达式**——只要消息到达 background，心跳键就必然更新，diag 就必然留痕。
> 两条判据同时为零 ⇒ **那条 `chrome.runtime.sendMessage({type:'login/open'})` 未到达 background**。

**⚠️ 措辞纪律（2026-11-12 20:42 按 Lead 要求修正）**：不写「没发出去」。理由是后者带因果断言，会诱导下一个人做出「已经知道它怎么失败」的错误推论。**「未到达」是实测，「为什么未到达」是推断，两者必须分开写。**

**唯一被证据支持的成因（2026-11-12 20:41 追查，见 §13）**：`:264` 那句 `chrome.runtime.sendMessage({type:'login/open'})` 是**普通函数调用**，孤儿态下**同步抛**，抛在 `.catch()` 被挂上之前 ⇒ `.catch` 的 error 回调永不执行 ⇒ `showOrphanHint()` 永不触发 ⇒ async 函数 reject ⇒ 被 `:590` 的 `void openLogin()` 丢弃 ⇒ **零提示 + 零 diag + 零心跳增量**。

**已排除的成因**：「`readAccountMid()` 抛异常导致 `openLogin()` 在 `sendMessage` 之前中断」——**代码上不成立**（双层 `.catch` + `()` 内联在 `let` 初始化式里，详见 §13.2）。

**一句话定性（按 Lead 要求的口径）**：拦截/失效源不在 Pluma，但「点了毫无反应」是 **Pluma 可修复的缺陷 —— 缺少失败兜底**：`sendMessage` 的**同步抛**没能被 `.catch()` 接住，`void openLogin()` 又把 reject 丢掉，于是面板既不提示也不报错。

**版本边界（见 §13.3）**：20:04 用户在浏览器里跑的产物**早于 task-33**（`showOrphanHint` 兜底）。因此 20:04 的「零提示」是那个版本的必然结果，**不能用来判定 20:19 之后版本的优劣**。

---

## §1 判据与证据总表

| # | 判据 | 结果 | 分档 |
|---|---|---|---|
| 1 | 20:04 前后 `chrome.storage.local` 各键有无写入 | `build-proof3` **320 次**（活）；`diag`/`login-ready`/`diag-trace`/`streaming-identity` **0 次**（死） | ✅ 已确认 |
| 2 | `login/open` 是否与心跳共用同一个 `onMessage` 回调 | **是**，同一句 `if` 的第一个表达式 | ✅ 已确认 |
| 3 | 20:04 那一刻的心跳是否精确存在 | **是**：`20:03:55(-4078ms)` / **`20:04:00(+928ms)`** / `20:04:05(+5928ms)` | ✅ 已确认 |
| 4 | 心跳是否由调查员操作引起 | **否**：从 04:49:34 起 2296 条，间隔 1–6s 占 1501 条，长期稳定 | ✅ 已确认 |
| 5 | `Tabs_*` 会话文件 20:00–20:10 有无新写入 | **无**：`Tabs_*.mtime` 停在 19:44:07，替代文件 0 字节 | 🟡 会话快照未落盘 |
| 6 | 19:58:53 那批 diag 是否同一次 SW 重启 | **不是**：两个不同 instance id（`g6d74i` 面板 / `j5c94o` background） | ✅ 已确认 |
| 7 | 面板侧 content script 是否处于死壳态 | **无法直接读取**（closed shadow + 无法 evaluate 用户页），只能由 1/2/3 反推 | 🟡 未取到直证 |
| 8 | 用户看到的「新建标签页」是 `edge://newtab/` 还是别的 | 会话文件里 `edge://newtab` 命中 38（UTF8），但**没有 20:04 那条**，无法与点击绑定 | 🟡 未取到 |

---

## §2 判据 1 —— 各键写入统计（本次核心）

**方法**：只读扫 `C:\Users\i1290\AppData\Local\Microsoft\Edge\User Data\Default\Local Extension Settings\fgmggjhdbgaclcbeaopajghpnhgkmfnf\000061.log`（LevelDB log，1708201 B）。**用花括号匹配 + `JSON.parse`**，不要用正则（detail 里有 `\"` 转义，正则必失败）。

**关键坑（先记在这里）**：LevelDB 里的实际键名是 **`pluma:build-proof3`**，且时间戳被 JS 序列化成**科学计数法** `1.794430174644e+12`。用 `/(1[0-9]{12})/` 匹配会全部落空。

**结果**（窗口 = 19:58:00–20:16:40 本地）：

```
=== 判据1：19:58:00–20:16:40 窗口内各键写入次数 ===
  pluma:login-ready          总事件=  18  窗口内=   2  末次=2026-11-12 19:58:54.493
  pluma:diag-trace           总事件=   0  窗口内=   0
  pluma:enabled              总事件=   0  窗口内=   0
  pluma:streaming-identity   总事件=   0  窗口内=   0
  pluma:panel-entry-enabled  总事件=   2  窗口内=   0  末次=2026-11-12 14:49:48.670
  pluma:build-proof3         总事件=2290  窗口内= 320  末次=2026-11-12 20:23:00.277
  pluma:login-window-alive   总事件=   2  窗口内=   0  末次=2026-11-12 19:43:51.716
  pluma:diag                 总事件= 356  窗口内=   0  末次=2026-11-12 19:28:32.362
  pluma:proxy-enabled        总事件=   0  窗口内=   0
  pluma:account-summary      总事件=   0  窗口内=   0
```

**读法**：

- `pluma:build-proof3` 窗口内 **320 次**，末次 20:23:00（= 取证当时，仍在写）⇒ **扩展活着，`onMessage` 正常触发，storage 正常写**。这直接**削弱** Lead 的 (a) 假设的粗粒度版本「扩展整个死了」。
- `pluma:diag` 窗口内 **0 次**，全局末次 19:28:32.362（这是快照里的 `pluma:diag` 键本身，条目层面末次是 19:58:54.493，见 §4）。
- `pluma:login-ready` 窗口内 2 次，**都是 19:58:54.493**（窗口的起点那一刻），之后到 20:23 再无第 19 条。见 §4 的完整 18 条。
- `pluma:diag-trace` / `streaming-identity` / `enabled` 全局 0 次 ⇒ 这些键名在本 profile 里从未被写（**别把它们当成「掉了」的证据**）。

---

## §3 判据 2 —— `login/open` 与心跳共用同一个回调（结论的承重墙）

产物 `.output/chrome-mv3/background.js`，`onMessage` 监听器原文：

```js
chrome.runtime.onMessage.addListener((e,t,n)=>{let r=e?.type;
  if(chrome.storage.local.set({"pluma:build-proof3":{probeVersion:2,swStartedAt:Date.now()}}).catch(()=>{}),
  r===`qr/generate`)return Ht().then(n)...
```

同一个回调里的条件分支顺序（实测抽出 16 个）：

```
qr/generate | qr/poll | page/quality | account/summary | account/remove | stats/recent |
diag/facts | page/activate | proxy/status | proxy/set | proxy/affected-tabs |
streaming/status | streaming/set | tabs/reload | feed-account/set | login/open
```

`login/open` 分支原文（段内偏移 2800）：

```js
return r===`login/open`&&(Pn().then(n).catch(()=>n({type:`login/open:ok`,opened:!1,reason:`unknown`})),!0)
```

**因此，形式化的判定是**：

> 若 `login/open` 消息到达 background ⇒
> (**必然** `build-proof3` 多一条时间戳) **且** (**必然** 走 `Pn()` → `openLoginWindow()` → `diag('login/open', ...)`)。
>
> 实测：`build-proof3` 在 20:04:00±1s 有记录（消息机制正常），但 `diag` 零新增。
> ⇒ 两者无法同时成立于「login/open 到达」。**唯一自洽的解释：这条消息未到达。**

**同时这也排除了 Lead 的 (c) 假设**：`openLogin()` 即使早退在某个 `if`，**只要它执行了 `sendMessage`**，background 就必有 diag。零 diag ⇒ 要么没执行到 `sendMessage`，要么执行了但抛了。**§13 定案为后者：执行到了 `:264`，但 `sendMessage` 同步抛。**

---

## §4 判据 3 —— 19:58:53 那 9 条 diag 的完整原文 + `login-ready` 全序列

### 4.1 最后一批 diag（19:58:53–54）

```
[19:58:53.205] from=g6d74i  panel/page-state  |  kind=timeout
[19:58:53.541] from=g6d74i  panel/page-state  |  kind=timeout
[19:58:53.940] from=j5c94o  isAllowedIncognitoAccess  |  false
[19:58:53.942] from=j5c94o  probe/instance  |  incognito=false
[19:58:53.944] from=j5c94o  probe/heartbeat  |  none（没有活着的扫码窗口心跳）
[19:58:54.486] from=j5c94o  windows.create returned  |  id=undefined incognito=undefined windowsBefore=1 windowsAfter=1 loginTabs=0
[19:58:54.488] from=j5c94o  create 返回 undefined 且窗口数未变，交给握手判定
[19:58:54.490] from=j5c94o  login/open  |  {"ok":true,"reason":"assumed"}
[19:58:54.492] from=j5c94o  create 返回 undefined 但权限正常 → 按已创建处理
```

### 4.2 这**不是**同一次 SW 重启（判据 6）

`from` 字段是 `diag-store.ts:42` 的 `INSTANCE_ID`（每个 SW 实例启动时随机生成 6 位）：
- `g6d74i` → **面板侧**实例（`panel/page-state` 写在面板入口的上下文里）
- `j5c94o` → **background SW** 实例

**两个不同实例 id 出现在同一秒**，说明 19:58:53 那一刻有**两个 JS 上下文先后写 diag**，不是一次重启。若是一次 SW 重启，`isAllowedIncognitoAccess`/`login/open`/`panel/page-state` 会全部是一个 `from`。

**⚠️ 但这也说明一件事**：`panel/page-state kind=timeout` × 2 出自 `g6d74i`，说明**面板在 19:58:53 还能写 diag**。而 20:04 那次点击**连 `panel/page-state` 都没写**。⇒ 面板这一侧的 diag 通道在 19:58:54 → 20:04 之间**失联了**。

### 4.3 `pluma:login-ready` 全部 18 条（原始片段，`at` 换算为本地时间）

```
#1  04:49:34.641   #2  05:03:17.705   #3  05:17:00.500   #4  05:03:02.091 ← (键名粘连 pluma:login-readym，实为别的键)
#5  14:25:13.732   #6  14:40:29.501   #7  14:41:47.154   #8  14:43:21.030
#9  16:40:49.209   #10 16:57:52.535   #11 17:14:22.786   #12 19:19:14.101
#13 19:22:18.037   #14 19:22:49.896   #15 19:28:32.368   #16 19:43:52.065
#17 19:58:50.915   #18 19:58:54.493
```

**第 18 条之后到 20:23 取证时，零新增。**

`pluma:login-ready` 是 `markLoginReady()` 写的（`entrypoints/background.ts:128` 附近，`login/open` 成功分支）。它一旦停了，说明 **`handleLoginOpen()` 成功率断崖**——与 `diag` 同步停摆完全一致。

---

## §5 我**没能**证实的部分（不许用推测填平）

Lead 的 (a) 假设「孤儿态」要求 `chrome.runtime` 失效。我能证明的是「消息没到」，但**不能直接证明「content script 的 chrome.runtime 是 undefined」**，因为：

1. **面板是 `mode:'closed'` shadow DOM**，D-1 之外没有任何手段从外部 evaluate 它内部的 `chrome.runtime`。
2. **`bsk evaluate` 对用户页面被沙箱拒绝**（`operation denied by the Agent Window sandbox`），`bsk tab borrow` 在无人值守下要弹确认框。
3. **`chrome.runtime.onMessage` 的调用方身份不可分辨**：`diag()` 只记 `{at, step, from, detail}`，**没有 tabId、没有 sender url**（`src/platform/storage/diag-store.ts:133`）。所以即使面板发了，也无法从 diag 侧区分是哪个 tab 发的。

**因此本节的诚实表述是**：

> 「消息未到达 background」是**实测结论**（判据 1+2+3）。
> 「为什么没到达」在 20:42 已由 §13 追查定案：**`:264` 的同步抛 + `.catch()` 挂不上**（`.catch` 的 error 回调永不执行 ⇒ 无提示、无 diag、无心跳增量）。这是**唯一被代码与产物证据支持的成因**。
> 其中「`readAccountMid()` 抛异常导致没走到 `sendMessage`」这条**已排除**（见 §13.2，双层 `.catch` + `()` 内联调用）。

**仍然没有直证的部分**：面板 `content script` 内部 `chrome.runtime` 到底是什么形态（`undefined` / 存在但上下文失效），因 closed shadow + 沙箱拒绝 evaluate 而读不到。§13 只证明了「无论哪种形态，`.catch` 都接不住这个同步抛」。

**Lead 的 (b) 假设（面板没渲染出来）未被证据支持也未被排除**：用户明确说「弹的窗都是新建标签页，根本没有内容」——如果面板没渲染，用户点的是页面别的地方，那本就不该有 diag。这条**无法只读取证**，需要问用户「你点之前面板上有没有那个按钮」。

---

## §6 判据 4 —— 20:04 那一刻的心跳确实存在

```
=== build-proof3 不同时间戳总数: 2296 ===
  最早: 2026-11-12 04:49:34
  最晚: 2026-11-12 20:23:25
  间隔分布: {"1-6s":1501,"<6-60s":176,"<1s":574,">60s":44}
  20:04:00±8s: 20:03:55(-4078ms) | 20:04:00(+928ms) | 20:04:05(+5928ms)
```

**为什么这 320 次不可能是调查员自己触发的**：
- 心跳从 **04:49:34** 就开始了，那时调查员的取证会话尚未开始（本次任务 20:16 才开始）；
- 间隔 1–6 秒 1501 次、<1s 574 次 —— 是**扩展自身的定时探针**（`probe/heartbeat`），不是人工操作节奏；
- 调查员的全部脚本都以 `fs.readFileSync` **直接读磁盘文件**，从不向扩展发消息（可复核：`.tmp/*.cjs` 全部只读）。

⇒ **20:04:00 +928ms 有一发心跳，20:04:05 +5928ms 又有一发。用户在这个区间点击，`login/open` 却零 diag。**

---

## §7 判据 5 —— 会话文件（🟡 未取到）

`C:\Users\i1290\AppData\Local\Microsoft\Edge\User Data\Default\Sessions`：

```
Session_13438956128135044   38410 B   mtime=2026-11-12 19:22:46
Session_13438956168780271       0 B   mtime=2026-11-12 19:22:48   (EBUSY，读不到)
Tabs_13438904569078987     262761 B   mtime=2026-11-12 05:32:12
Tabs_13438936787447320     496575 B   mtime=2026-11-12 19:44:07
Tabs_13438957449599696          0 B   mtime=2026-11-12 19:44:09   (EBUSY，读不到)
```

**`Tabs_13438936787447320` 从 19:44:07 到 20:23 一直没再写**，替代它的 `Tabs_13438957449599696` 是 **0 字节**。

⇒ **20:00–20:10 之间没有任何 tab 变更落盘**。Edge 的 `Tabs_*` 是**周期性快照**（非每次变更立即落盘），19:44:07 之后没有新快照扫描，所以**用户 20:04 看到的「新建标签页」窗口没有被记录**，无法与点击绑定。

各文件 URL 命中（UTF16LE / UTF8）：
```
Session_13438956128135044 : about:blank 0/0  · edge://newtab 0/5  · need-incognito 0/0 · login-window 0/0 · ERR_BLOCKED 0/0
Tabs_13438904569078987    : about:blank 6/26 · edge://newtab 0/10 · need-incognito 0/0 · login-window 0/0
Tabs_13438936787447320    : about:blank 13/32· edge://newtab 0/38 · need-incognito 6/16· login-window 0/0 · ERR_BLOCKED 0/0
```

**判据 8 的答案（🟡）**：会话文件里 `edge://newtab` 有 38 处（UTF8 段），但**没有一条带 20:04 的时间锚**。用户看到的「新建标签页」**无法确认是 `edge://newtab/` 还是 `about:blank`**，也无法确认是不是我们扩展开的（`chrome-extension://fgm…/` 在会话文件里只有 `need-incognito.html` 的 6 条，全部有 460×420 边界，属于更早的 19:29 那次）。

---

## §8 F1 / F2 / F3 复核（沿用前轮结论，行号已重测）

### F2 ✅ 已排除 Pluma 的 DNR

`src/platform/http/dnr.ts` 全文**只有 `modifyHeaders` 一种 action**，`block` 命中 **0**：

- `:558` `action: { type: 'modifyHeaders', ... }`（全局路径规则，`:556` `priority: 1`）
- `:561-568` `condition: { urlFilter: path, requestDomains: [...BILI_API_HOSTS], resourceTypes: ['xmlhttprequest'], requestMethods: ['get'] }`
- `:914` `priority: 2, // 高于全局路径规则（priority 1）`
- `:916` `action: { type: 'modifyHeaders', ... }`
- `:919-925` `condition: { urlFilter, requestDomains: [...BILI_API_HOSTS], resourceTypes: ['xmlhttprequest'], requestMethods: ['get'], tabIds: [...tabIds].sort((a, b) => a - b) }`
- `src/shared/constants/routes.ts:42` `BILI_API_HOSTS = [BILI_API_HOST, 'api.biliapi.net']`

⇒ `chrome-extension://…/need-incognito.html` 三重条件（域 / xhr 类型 / 路径白名单）**一条都不满足**；且 `modifyHeaders` 语义上产不出 `ERR_BLOCKED_BY_CLIENT`。

**本机 4 个有 DNR 权限的扩展，实测都不 block**：
```
ffdegaeaoghhddelmdbhhipcmpnaodlk  loc=4  DNR=[declarativeNetRequest]              WR=[webRequest]  ← GhostDownloader 2.2.0
fgmggjhdbgaclcbeaopajghpnhgkmfnf  loc=4  DNR=[declarativeNetRequestWithHostAccess]  WR=[]            ← Pluma
iikmkjmpaadaobahmlepeloendndfphd  loc=1  DNR=[declarativeNetRequestWithHostAccess]  WR=[webRequest]  ← Tampermonkey
odlomjlbamekndcpllcnffbgeohgkmjh  loc=1  DNR=[declarativeNetRequestWithHostAccess]  WR=[]            ← ChatGPT
```
GhostDownloader 实证：`manifest.json` 无 `declarative_net_request.rule_resources`；`background.js`（101558 B）`updateDynamicRules` **0 处**、`"block"` **0 处**；唯一建规则函数只设 `User-Agent` 头。

### F3 ✅ 判 B（只有 need-incognito，login-window 零记录）

`Default\Sessions\Tabs_13438936787447320`（496575 B，mtime 19:44:07）：
```
need-incognito.html : 6  (UTF16LE 6 / UTF8 16)
login-window.html   : 0  ← 零
420x600             : 0  （LOGIN_WINDOW 尺寸，src/background/login-window.ts:23）
3 条窗口边界： window id=1673240256/259/262  bounds=(x=441, y=57, 460x420)
```
- **460×420 全仓库唯一出处**：`entrypoints/background.ts:161`
- `LOGIN_WINDOW = { width: 420, height: 600 }`（`src/background/login-window.ts:23`）会话文件里 **0 次**
- 窗口 id 号段 `…243 → …256/259/262` 连续，与 diag `need-incognito 窗口创建结果 | id=1673240243`（本地 **19:29:11**，from=`89g4mb`）相差 13/16/19

### F1 🟡 错误页归属未取到决定性证据

扫 `C:\Program Files (x86)\Microsoft\Edge\Application\157.0.4341.46\locales\zh-CN.pak`（956158 B，UTF8 段可读，UTF16 段无匹配）：
- 「此页面已被」3 处：@638940 组织策略对话框 / @652893 **代理错误页**（`ERR_PROXY_CONNECTION_FAILED` 文案）/ @773528 edge://policy
- `ERR_BLOCKED_BY_CLIENT` 在 zh-CN / zh-TW / en-US / `resources.pak`(34062176 B) **全部零命中**（pak 内资源压缩）
⇒ 用户截图错误页**不是** Edge 语言包里的现成模板，最接近的 @652893 文案不同。**错误页 HTML 在压缩的 resources.pak 里，未解包取证。**

---

## §9 待修项（交 Lead 拆卡，investigator 不动手）

**置顶待修：R-6**（Lead m02162 第 5 段裁定：它是「会误导人的观测名」，不是用户可感知缺陷，主线收敛后再单开卡，但必须置顶登记，否则下一个人会被它再骗一次）。

| # | 问题 | 根因判据（文件:行号） | 修法边界 |
|---|---|---|---|
| **R-6** | `pluma:build-proof3` 的 `swStartedAt` **不是** SW 启动时刻，是「每收到一条消息就写一次」。注释与实现不符 | 产物 `background.js`：`chrome.runtime.onMessage.addListener((e,t,n)=>{...chrome.storage.local.set({"pluma:build-proof3":{swStartedAt:Date.now()...}})`；源码 `entrypoints/background.ts:233-242` 注释写「每次 SW 启动都写」 | **该改**：要么把写入移到 SW 顶层（真正启动时），要么改注释。**这个键名/语义混淆已经害我误判过一次** |
| R-1 | 面板 `sendMessage` 失败被 `.catch(() => null)` 吞掉，用户看不到任何提示 | `entrypoints/content-panel.content.ts:201-203` `const res = (await chrome.runtime.sendMessage({type:'login/open'}).catch(() => null)) as LoginOpenReply \| null` | **该改**：区分「sendMessage 抛异常」与「reply 不正常」。抛异常时给「扩展已更新，请刷新页面」类提示。**不许碰** `login/window.ts` 的权限判定逻辑 |
| R-2 | `login: () => void openLogin()` 丢弃 rejected promise，异常无从暴露 | `entrypoints/content-panel.content.ts:590-591` | 同上。可加 `.catch()` 上报 |
| R-3 | diag 无 tabId / 无 sender url，无法判断消息来自哪个上下文 | `src/platform/storage/diag-store.ts:133` `from: INSTANCE_ID,`（字段只有 `at/step/from/detail`） | **该改**：`diag()` 增加可选 `tabId`/`senderUrl`。**不许**扩大 `DIAG_LIMIT`（30 条是既定设计，改了会掩盖真问题） |
| R-4 | `need-incognito 窗口创建结果` 的 `url=` **恒空**，无法区分「create 没返回」与「返回了但 tabs 为空」 | `entrypoints/background.ts:161` 附近（`created?.tabs?.[0]?.url`） | **该改**：空值显式写 `url=<no-tabs>` 或 `created=undefined` |
| R-5 | 文案自相矛盾：提示说「再点一次「**扫码登录**」」，按钮上写的是「**扫码登录取流账号**」 | 产物 `content-panel.js`：`e.reason===\`incognito-disabled\`?\`需要先在扩展详情页打开「在 InPrivate 中允许」…然后再点一次「扫码登录」\`` vs `u=W(\`button\`,\`acct-btn ghost\`,s?\`重新登录\`:\`扫码登录取流账号\`)` | **该改**：两处文案统一取同一常量 |
| R-7 | 修 A 的落点（§13）：`:264` 的**同步抛**接不住 | `entrypoints/content-panel.content.ts:264` | 见 §13.4：改 `try/catch`，**catch 里任何路径都必须 `showOrphanHint()` 或写 diag**，不许静默 `res = null` |

**R-6 的实证危害**：我一度据 `swStartedAt` 2260 个不同值推出「SW 每 5 秒重启 2210 次」，那是**错的解读**——事实是「每 5 秒收到一条消息」。这个键的名字在骗人。

---

## §10 自我更正清单（教训，不许删）

1. **`19:31:54` → 实际 `19:29:11`**：最初用 Chrome 1601 epoch 换算 diag 的 `at`，算错。`at` 是 **Unix 毫秒**。
2. **把 `swStartedAt` 当 SW 启动时刻**：错。它在 `onMessage` 回调里写，含义是「每收到一条消息写一次」。我据此推出「SW 每 5 秒重启 2210 次」，是**错的解读**（心跳事实本身成立）。
3. **正则解析 diag 条目**：用 `/\{"at":([0-9]{13}),"detail":"((?:[^"\\]|\\.)*)".../g` 得到 **0 条**，因为 detail 里有双重转义 `\"`。改用**花括号匹配 + `JSON.parse`** 才拿到 399 条。
4. **`read-diag-from.cjs` 有缺陷勿用**：按 `at|step|detail|from` 去重会把 LevelDB 里同毫秒多版本快照的同类记录误删，造成「记录缺失」假象。正确做法是 `read-diag-current.cjs`（字符串感知括号扫描取完整 JSON 数组）。
5. **`pluma:*` 键名不能靠猜**：LevelDB 里真实键是 `pluma:build-proof3`（带版本号后缀），我第一次用 `/["'](pluma:[a-z0-9:-]+)["']/` 匹配得到 **0 个键**，因为原始形态里键名后面紧跟二进制字节，没有引号收尾。必须按 `indexOf("pluma")` 逐点取前缀。

---

## §11 只读性证明

本次调查**只执行了文件读取**，无任何写操作：

- 全部脚本以 `fs.readFileSync` 读 LevelDB log 与 `Secure Preferences`，**且不写回**。
- 临时脚本放在 `.tmp/`（非交付物、非源码）：`diag-from1944.cjs`、`diag-from2.cjs`、`diag-keys.cjs`、`diag-keys2.cjs`、`key-window.cjs`、`bp-branch.cjs`、`bp-gaps.cjs`、`sw-last.cjs`、`sw-heartbeat.cjs`、`session-20xx.cjs`、`out-bp.cjs`、`find-5000.cjs`、`cp-login.cjs`、`cp-login2.cjs`、`lr-raw.cjs`
- **未 reload 扩展、未重启浏览器、未点用户窗口、未 borrow tab、未改任何源码**。

**⚠️ 但必须如实声明**：`git status --porcelain` 当时**不为空** —— 实测 **58 行**（早期观测时是 18 个 `M`，此后其他成员继续改动，行数已增长到 58）。这些改动来自 **engineer 等其他成员**（`src/content/panel/login-outcome.ts`、`entrypoints/background.ts` 等），**不是 investigator 的改动**。

**investigator 本次新增的文件只有两个**（均在写域内，且都是只读脚本/报告）：
```
poc/probe/blocked-by-client/REPORT-2004.md          22721 B   ← 本报告
poc/probe/blocked-by-client/*.cjs（.tmp/ 下临时脚本不计入交付）
```
目录内另两个文件 `inspect-raw-shape.cjs`(1803 B, 20:16:12)、`lead-check-last-diag.cjs`(6058 B, 20:16:33) 是 **Lead 先建的**，不是我建的。

上上轮我曾因「没跑就断言 git 干净」被自己记过一条教训，这次先跑再写。

---

## §12 一句话交回 Lead

**消息未到达 background**（实测：20:04:00±1s 有心跳、零 diag、零 login-ready）。**不是整条通路死**（心跳 320 次证明扩展活着），**死的是面板侧调用 `sendMessage` 的能力**。

**成因已在 §13 定案**：`:264` 那句 `chrome.runtime.sendMessage({type:'login/open'})` 是普通函数调用，孤儿态下**同步抛**，抛在 `.catch()` 挂上之前 ⇒ error 回调不执行 ⇒ 无提示、无 diag、无心跳增量。`readAccountMid()` 抛异常这条**已排除**。

无论形态如何，**产品责任在 Pluma 这一侧**：`.catch(() => null)` 接不住同步抛，`void openLogin()` 又把 reject 丢掉，用户点了按钮之后既没有窗口也没有提示 ⇒ **必须补失败兜底**（R-1/R-2/R-7）。

---

## §13 修 A 依据追查（2026-11-12 20:41，Lead 追加提问）

**问题**：`openLogin()` 里「`readAccountMid()` 抛异常导致没走到 `sendMessage`」这条解释，代码上是否成立？

**判据**：`.output/chrome-mv3/content-scripts/content-panel.js`（78797 B，mtime 20:19:54）—— 浏览器 20:04 实际运行的那一份产物的原文。

### 13.1 产物原文

```js
u=async()=>{let e=await chrome.runtime.sendMessage({type:`account/summary`}).catch(()=>null),
             t=e?.type===`account/summary:ok`?e.account?.profile?.mid??null:null;
             return{mid:typeof t==`number`?t:null}},

d=async()=>{ l(), o?.clearNotice();
  let e=(await u().catch(()=>({mid:null}))).mid,
      t=Vt(await chrome.runtime.sendMessage({type:`login/open`}).catch(e=>(Jt(e)&&Z(),null)));
  Yt()||o?.showNotice(t.text,t.ok),
  !Yt()&&o===null&&Z(),
  t.shouldPoll&&(s=Wt({read:u,onDone:e=>{s=null,o&&(e.kind===`configured`?...:e.kind===`timeout`&&...)}},e)) },
```

符号对照：`u` = `readAccountMid`；`d` = `openLogin`；`Vt` = `describeLoginOutcome`；`Jt` = `isOrphanError`；`Z` = `showOrphanHint`；`Yt` = `isOrphanHintShown`。

### 13.2 ❌ 结论：「`readAccountMid()` 抛异常」这条路**不成立**

三层依据：

1. `readAccountMid`（`u`）内部对 `sendMessage` **自带** `.catch(()=>null)` —— 第一个 error 回调在这里就用掉了；
2. 调用侧还有 **第二层** `u().catch(()=>({mid:null}))`；
3. 更关键：`()` 是**直接在 `let e = ...` 初始化式里内联调用**的，**没有委托、没有传递、没有延迟执行** —— ES 语义下 error 回调处理的就是被调函数返回 promise 的 rejection。

⇒ `let e = ...` 拿到的一定是 `{mid: ...}`。**`:262` 这一行抛不出任何东西，为它加保护是白做。**

### 13.3 ✅ 真正的洞：`:264` 的**同步抛**，`.catch()` 挂不上

`chrome.runtime.sendMessage({type:'login/open'})` 是**普通函数调用**，不是「promise 已经满足后的续体」。孤儿态下它**同步抛**（`TypeError: Cannot read properties of undefined` 或 `Error: Extension context invalidated.`）。

链条：

> 同步抛发生在 `.catch` 被挂上**之前**
> ⇒ error 回调 `(Jt(e)&&Z(),null)` **永不执行**
> ⇒ `Z()`（`showOrphanHint`）**永不触发**
> ⇒ `d()` 作为 async 函数 reject
> ⇒ 被 `login: () => void openLogin()`（`:590-591`）的 `void` **丢弃**
> ⇒ **零提示 + 零 diag + 零心跳增量**

这正是 §2–§6 观测到的指纹：消息一个字节都没进 IPC，background 的 `onMessage` 从不触发，`build-proof3` 自然不会为它 +1。**所以 `build-proof3` 那 320 次证明的是其它探针在跑，不是 `login/open` 在跑。**

**版本边界（重要）**：产物 20:19:54 **已含 task-33**（`pluma-orphan-hint` 命中 1、`旧面板已经失效` 命中 1、`Extension context invalidated` 命中 3、`Receiving end` 命中 1），但**不含 task-39**（`data-pluma-panel-gen` 命中 **0**；当前源码 `entrypoints/content-panel.content.ts` mtime 20:34:00 已加）。
⇒ **20:04 运行时比这两版都早**，其「零提示」是那个版本的必然结果，**不能用来判定 20:19 之后版本的优劣**。

### 13.4 修法边界（Lead m02162 裁定后的定稿，investigator 不动手）

**落点**：`entrypoints/content-panel.content.ts:264`。

```ts
let res: LoginOpenReply | null = null;
try {
  res = await chrome.runtime.sendMessage({ type: 'login/open' });
} catch (e) {
  // 同步抛与异步 reject 都在这里；两种都必须留痕，不许静默
  showOrphanHint();          // 先说结论：走到这里就是"发不出去"
  // 且把 e 的分类写进 diag（非孤儿错也要留痕，否则又是一次静默）
  return;
}
```

**判据**：`catch` 块里**任何路径都必须调用 `showOrphanHint()` 或写 diag**。不允许「判断不是孤儿错 → 什么都不做 → 继续往下走」——走到 catch 就意味着消息没发出去，对用户等价于「点了没反应」，必须告诉他。

**为什么不许写成 `if (isOrphanError(e)) { showOrphanHint(); return; } res = null;`**（我最初给的版本，已被 Lead 否掉）：`e` 非孤儿错时会**静默地 `res = null`**，又回到「看起来处理过了」的老路。

### 13.5 现有守卫的**未证伪**风险（必须如实标注）

task-39 在 `:230` 已加同步守卫，但：

- **守卫的正确写法**（verifier 运行期探针实测：`chrome` 整体不存在时 `chrome.runtime?.id` 那一行自己就抛 TypeError）：
  ```ts
  const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;
  ```
- **gen 代际机制（`isStaleGeneration()`）已被 Lead 裁决撤掉**（收益零真机证据、误报代价不对称）。本文档此前「这就要靠 `isStaleGeneration()` 那条」的说法**作废**。

> **如实风险陈述**：「`chrome.runtime` 仍存在但上下文已失效」这一形态，现有守卫**可能兜不住**；该形态**无真机证据，未证伪也不证实**。

# 「切 InPrivate 权限是否导致扩展 reload / 孤儿态」取证报告

> 任务来源：Lead m01355（用户质问「开关了在 InPrivate 中允许后再点击扫码登录取流账号，就不能直接正常的去使用扩展吗？真的没有更好的解决办法了吗？」）
> 取证者：investigator　写域：`poc/probe/logout-login-round2/`
> 约束：只读。未 reload 扩展、未重启浏览器、未借用用户标签页、未点击任何东西。
> 数据截止：2026-11-12 15:16（Edge 157.0.4341.46，扩展 `fgmggjhdbgaclcbeaopajghpnhgkmfnf`，版本 1.1.0，解压加载 `location=4`）

---

## §0 一句话结论

**切「在 InPrivate 中允许」不会导致扩展 reload，也不会产生孤儿态。**
真正的触发源是 **MV3 Service Worker 每次被事件唤醒都会重启**（`INSTANCE_ID` 每次新生成），这与权限开关无关，是正常行为。
**用户第 4 步「没有反应」的原因是：那一刻 `isAllowedIncognitoAccess()` 真的返回了 `false`，走了 `incognito-disabled` 分支、弹出了说明页 —— 而不是弹出了用户期待的扫码窗口。** 说明页窗口**确实弹出来了**（OS 采样抓到 23 秒），所以用户说的「没反应」指的是「没出现扫码窗口」，不是「屏幕上什么都没发生」。

**⚠️ 上一轮 `ORPHAN-STATE-REPORT.md` 的主断言（「第 4 步失败是孤儿态造成的」）在本轮被推翻，见 §5。**

---

## §1 分档总表

| # | 问题 | 结论 | 分档 |
| --- | --- | --- | --- |
| Q1 | 切 InPrivate 权限是否导致扩展 reload / 孤儿态 | **不会**（无证据支持，且有反证） | 🟢 已排除 |
| Q2 | 14:25:25 那条 `Extension context invalidated` 与切权限有关吗 | **无关**，且它发生在那次 `login/open` 之后 11.3 秒 | ✅ 已真机确认 |
| Q3 | 14:40–14:43 用户四步期间有没有新的 invalidated | **没有**（console 全量 50 条只有 14:25:25 那一条） | ✅ 已真机确认 |
| Q4 | 第 4 步 `login/open` 到底返回了什么 | `{"ok":false,"reason":"incognito-disabled"}` | ✅ 已真机确认 |
| Q5 | 第 4 步的 `windows.create(460×420)` 成功了吗 | **成功了**，说明页真实存在 23 秒 | ✅ 已真机确认 |
| Q6 | 为什么说明页存在用户却说「没反应」 | **无法从现有证据判定**（窗口在 z 序上层，理论上可见） | 🟡 未取到 |
| Q7 | 权限为什么在没有用户操作的情况下 `true → false` 翻转 | **无法确认**，但实测到 4 次翻转 | 🟡 未取到 |
| Q8 | MV3 SW 频繁重启是否与权限切换有关 | 无直接关系（每次事件唤醒都会重启） | ✅ 已确认 |

---

## §2 Q1：切 InPrivate 权限是否导致扩展 reload —— 🟢 已排除

### 2.1 判据逻辑（为什么可以下结论）

「扩展 reload」在 content script 侧的**唯一可观测症状**是 `chrome.runtime` 失效，表现为
`Error: Extension context invalidated.` 这条 console error。

- 实测：**全量 50 条 console 里，这条只出现 1 次**（14:25:25.064），且发生在用户四步操作之前约 15 分钟。
- 如果切权限会导致 reload，那么用户 14:41:46 打开权限那一瞬间，**必须**再产生一条 invalidated。**没有。**
- 更强的反证：14:40:33 / 14:41:46 / 14:42:04 / 14:43:14 四次点击的 `login/open` **全部到达了 background**（diag 有 4 条记录）。若 content script 已孤儿化，`chrome.runtime.sendMessage` 会立即 reject 并被 `.catch(() => null)` 吞掉 —— **不会留下任何 diag 记录**。

### 2.2 命令与输出原文

```powershell
$env:BSK_AUTO_START="0"
bsk console --session zldk --tab-id 1673240090 --since 0 --json
```

全量 50 条里 url 命中我们扩展 id 的**只有 3 条**：

```
seq=12  13:59:55.860 [error] TypeError: Cannot use 'in' operator to search for 'durl' in suee
         url=chrome-extension://fgmggjhdbgaclcbeaopajghpnhgkmfnf/content-scripts/content.js
seq=23  14:00:00.118 [error] TypeError: Cannot use 'in' operator to search for 'durl' in suee
         url=chrome-extension://fgmggjhdbgaclcbeaopajghpnhgkmfnf/content-scripts/content.js
seq=43  14:25:25.064 [error] Error: Extension context invalidated.
         url=chrome-extension://fgmggjhdbgaclcbeaopajghpnhgkmfnf/content-scripts/content-panel.js
```

落盘：`raw/repro5/console-video-recheck.json`（34943 字符，entries=50）

**`content-panel.js` 在 14:25:25 之后再无任何输出** —— 但这不等于它死了，因为：
1. 它只在出错时才写 console，正常工作是静默的；
2. 14:40–14:43 的点击消息都到达了 background，证明有活的 content script 在发消息。

### 2.3 查不到的边界（诚实记录）

**「Chromium 内部切换 Allowed-in-Incognito 是否触发扩展 reload」这一点我没查到权威文档。**
- `@types/chrome` 的注释只说：`isAllowedIncognitoAccess()` "corresponds to the user-controlled per-extension 'Allowed in Incognito' setting accessible via the `chrome://extensions` page"（`node_modules/@types/chrome/index.d.ts:4832` 附近），**没有**说切换会 reload。
- 我们的 manifest **没有 `management` 权限**，无法用 `chrome.management.onEnabled` 直接观测。
- Edge 未开 `--enable-logging`，`chrome_debug.log` 不存在。

⇒ **所以 Q1 的结论不是「查文档确认的」，是「用真机症状反证排除的」**：如果切权限会 reload，必然留下 invalidated，而实测没有。

---

## §3 Q2：14:25:25 那条 invalidated 是什么

### 3.1 三源时间线（`raw/repro5/diag-latest-14-49-50.txt` + console）

| 时刻 | 源 | 事件 |
| --- | --- | --- |
| 14:25:13.728 | diag | `login/open {"ok":true,"reason":"assumed"}` from=qkcods |
| 14:25:13.730 | diag | `create 返回 undefined 但权限正常 → 按已创建处理` |
| **14:25:25.064** | **console** | **`Error: Extension context invalidated.` (content-panel.js)** ← **11.3 秒后** |
| 14:25:33.211 | diag | `panel/page-state | kind=timeout` |
| 14:25:34.323 | diag | `panel/page-state | kind=timeout` |
| 14:25:34.442 | diag | `isAllowedIncognitoAccess | false` |
| 14:25:34.444 | diag | `login/open {"ok":false,"reason":"incognito-disabled"}` |
| 14:25:34.445 | diag | `权限未开启 → 弹说明页` |

### 3.2 两个关键推论

1. **invalidated 在 `login/open` 之后 11.3 秒**，不是之前。若「点扫码 → 开 InPrivate 窗口」导致 reload，顺序应当是 invalidated 在前、消息发不出去。实际相反：**先成功开了窗口，11 秒后才 invalidated**。
2. **invalidated 之后 8 秒（14:25:34），又有 `login/open` 到达 background** ⇒ 已有可用的 content script 在发消息。孤儿态没有持续。

### 3.3 `panel/page-state kind=timeout` 不是孤儿态症状

孤儿态下 `sendMessage` 会**立即 reject**，不会「2 秒后超时」。这两条 timeout 来自**活着的** content script，是 background 没在 2 秒内响应。属独立缺陷（R3，见 §7）。

---

## §4 Q3–Q5：第 4 步的真实返回值

### 4.1 第 4 步 diag 原文

```
[24] 2026/11/12 14:43:14.309  panel/page-state | kind=timeout
[25] 2026/11/12 14:43:14.688  panel/page-state | kind=timeout
[26] 2026/11/12 14:43:14.943  isAllowedIncognitoAccess | false
[27] 2026/11/12 14:43:14.945  login/open | {"ok":false,"reason":"incognito-disabled"}
[28] 2026/11/12 14:43:14.947  权限未开启 → 弹说明页
```

⇒ **Q4 答案：`{"ok":false,"reason":"incognito-disabled"}`。** 消息到达了 background（有 diag 记录），权限判定是 `false`。

### 4.2 说明页窗口确实弹出来了（Q5）

OS 采样 `raw/repro4/windows.jsonl`（每秒一条，297 条）：

```
hwnd=12980162  w=460 h=420 x=456 y=58  visible=True minimized=False
               pid=2600  cls=Chrome_WidgetWin_1
               title='开启无痕窗口权限 · Pluma'
首次=2026-11-12T14:43:38.447   末次=2026-11-12T14:44:00.763   出现 23 次
```

**说明页 HTML 加载成功了**（标题是「开启无痕窗口权限 · Pluma」，不是「新建标签页」），存在 23 秒后消失（`incognito-watch.ts` 自轮询或在用户关闭）。

⇒ **`entrypoints/background.ts:139-146` 的 `chrome.windows.create({url: need-incognito.html, type:'popup', width:460, height:420})` 在这一次是成功的。`.catch(() => {})` 没有吞掉实际失败 —— 没有失败。**

---

## §5 为什么用户说「没反应」—— 🟡 未取到确切答案，且**推翻上一轮结论**

### 5.1 必须撤回的上一轮结论

`ORPHAN-STATE-REPORT.md` §0 写的是：

> **第 4 步「点了完全没反应」的原因不是消息被吞，而是面板 content script 在 14:25:25 之后处于孤儿态…**

**这条断言在本轮被推翻。** 判据：

| 假设 | 预言 | 实测 | 裁定 |
| --- | --- | --- | --- |
| H1 孤儿态致静默 | 消息发不出去 ⇒ **diag 无** `login/open` 记录 | 14:43:14.945 **有** `login/open` 记录 | ❌ 不成立 |
| H2 权限真为 false | 走 `incognito-disabled` ⇒ **弹出** 460×420 说明页 | 14:43:38 **抓到** 460×420 说明页 23 秒 | ✅ 成立 |

**孤儿态是真的存在的（14:25:25 有硬证据），但它不是第 4 步失败的原因。**

### 5.2 「被遮挡」解释也不成立（自我更正）

我一度推测说明页被另一个同为 460×420 的「新建标签页」窗口遮挡（两者位置仅差 15×1 像素）。**撤回**：

`EnumWindows` 按 z 序（上→下）返回，第 1 帧原文：

```
 0. hwnd=658942     1296x828  '读取交接文档 — DeepSeek-Harness'
 1. hwnd=12980162    460x420  '开启无痕窗口权限 · Pluma'   <== 说明页在上层
 3. hwnd=67274     1470x1363  '哔哩哔哩… Microsoft Edge'
 4. hwnd=8785842     460x420  '新建标签页'                 <== 在说明页下层
```

⇒ **说明页在最前面，理论上用户看得见。**

### 5.3 剩下的可能性（未验证，不选）

我**不能**替用户断定「没反应」的含义。用户原话（task-16 逐字）：

> 「…成功的点击开启了在 InPrivate 中允许权限，之后我返回原界面，点击扫码登录取流账号，就没有任何反应了」

两种解读都与证据相容：
- **(a) 语义误解**：用户期待「弹出扫码窗口」，实际弹出的是「说明页」（叫你再开一次权限）⇒ 用户感觉「没反应」。
- **(b) 用户当时真没看到窗口**：说明页 14:43:14 弹出、14:43:38 我第 1 次采样时它已在、14:44:00 消失，共 46 秒。用户可能视线在别处。

**区分二者需要问用户**，不是我能测的。

---

## §6 Q7：权限自己翻转 —— 🟡 实测到现象，原因未确认

### 6.1 现象（硬数据）

全量 diag（185 条去重记录，04:09→14:49，`raw/repro5/diag-union-full-history.txt`）里，`isAllowedIncognitoAccess` 的**全部**取值：

```
04:13:04  true
04:49:34  true
04:50:10  false   <- 36.1 秒后
05:16:59  true
05:23:11  false   <- 370.6 秒后
05:30:36  false
14:25:13  true
14:25:34  false   <- 20.7 秒后
14:40:33  false
14:41:46  true
14:42:04  false   <- 17.3 秒后
14:43:14  false
```

**四次 `true → false` 翻转，间隔分别是 36.1s / 370.6s / 20.7s / 17.3s。**
用户自述只说了「关一次、开一次」，**没有**说自己在 14:42:04 之前又把权限关了。

### 6.2 我不能下结论的原因

- `isIncognitoAllowed()` **无缓存**（`src/background/login-window.ts:57-63` 每次直查 `chrome.extension.isAllowedIncognitoAccess()`），所以读到的就是浏览器当时的值。
- 但**「值为什么变」**我看不到：Edge 的偏好变更没有日志。
- **可能是用户真的又点了**（用户自述不完整），**也可能是别的**。**我没有证据区分。**

### 6.3 一个高价值观察（供 Lead 判断，不是结论）

`14:41:46 true → 14:41:47 开窗口成功 → 14:42:04 false`。
**权限在「成功开出一个 InPrivate 窗口」之后变成 false。**
四次翻转里，`04:50:10`（36s）和 `14:25:34`（20.7s）也都紧跟在一次成功开窗之后。
**这可能只是巧合（用户手动关的），也可能是 InPrivate 窗口生命周期与权限状态的某种关联。我没有证据，只能提出这个相关性供 Lead 决定是否值得另开卡验证。**

---

## §7 真正的触发源是什么（回答 Lead 的「如果无关，那是谁」）

### 7.1 MV3 SW 重启 —— 正常行为，不是 bug

`src/platform/storage/diag-store.ts:42`：

```ts
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
```

每次 Service Worker 启动都会重新执行模块顶层 ⇒ 新 `INSTANCE_ID`。

实测 12 次 `login/open`，`from` **12 个全不同**：

```
04:13:05 8zz3vd / 04:49:34 jfufc2 / 04:50:10 6iqmri / 05:16:59 frushh
05:23:11 i6q2dk / 05:30:36 9gbtw8 / 14:25:13 qkcods / 14:25:34 iefs57
14:40:33 0jyphl / 14:41:46 np5nnr / 14:42:04 jybwup / 14:43:14 orn2ji
```

**这是 MV3 的常态**：SW 空闲 30 秒被杀，任何事件唤醒它就是新实例。**与权限切换无关**（17 秒和 20 秒的间隔太短，不可能因空闲被杀，但也可能被浏览器主动回收——无法区分，不影响结论）。

### 7.2 我们自己的 `reload-extension.mjs` —— 需查证

`scripts/reload-extension.mjs` 会明确 reload 扩展，**在页面不刷新的情况下必然产生孤儿态**。
**但本轮没有运行它**（`git status` 证明我零改动，也没有执行）。用户四步期间也没有。
**14:25:25 那条 invalidated 的来源我无法确定**（可能是某人跑了 reload 脚本、可能是扩展被浏览器更新、可能是 dev 模式的热重载）。

---

## §8 回到用户的根本问题：「开了权限能不能直接用？」

### 8.1 直接回答

**能，而且现在的代码路径本来就是通的 —— 前提是权限状态真的为 `true`。**

有对照组硬证据：**14:41:46 那次** `isAllowedIncognitoAccess=true`，用户点了按钮：

```
[14] 14:41:46.597  isAllowedIncognitoAccess | true
[15] 14:41:47.147  windows.create returned | id=undefined incognito=undefined windowsBefore=2 windowsAfter=2 loginTabs=0
[17] 14:41:47.152  login/open | {"ok":true,"reason":"assumed"}
```

这条路径**没有孤儿态、没有提示、没有幺蛾子**，就是用户想要的「直接正常用」。
（窗口实际开出来了 —— 05:17 同类调用的 OS 采样抓到过 `HWND 4393142 420x600 '登录播放账号 - [InPrivate]'`。）

### 8.2 所以「更好的解决办法」需要解决的不是孤儿态，而是这句

**用户切完权限回来后，`isAllowedIncognitoAccess()` 读到的是 `false`。**

14:42:04（18 秒前刚设为 true）又读到 false —— **这是用户遭遇的全部。**
如果这个值稳定为 true，「开了权限 → 点按钮 → 弹扫码窗口」这条路径现在就成立。

### 8.3 修法边界（investigator 不动手）

**该查的（按优先级）**：
1. **权限翻转的真因** —— 是用户又手动关了？还是浏览器行为？这是真正的关键，**但需要用户配合确认操作步骤，或另开卡做受控实验**。
2. `entrypoints/background.ts:139-146` 的 `windows.create(...).catch(() => {})` —— 返回值完全丢弃，**连 `created.id` 都不看**。本次虽然成功了，但这个盲点应当补 diag。
3. `entrypoints/content-panel.content.ts:204-205` 的 `if (controller) controller.showNotice(...)` —— 本次虽不是它导致的，但 `controller===null` 时整句跳过仍是真实缺陷。

**不该碰**：
- `entrypoints/need-incognito/incognito-watch.ts` —— 本轮实测说明页正常加载并自关（23 秒后消失），**逻辑是对的**。
- `src/background/login-window.ts:57-63` `isIncognitoAllowed()` —— 无缓存、直查，**读到的就是真值**，不是它的问题。
- WXT 的 `ctx.onInvalidated` 机制本体。

**孤儿态要不要修？（需 Lead 裁决）**
孤儿态**真实存在**且**修法明确**（主动轮询 `chrome.runtime?.id == null`），但它**不是本次用户报的问题的原因**。
⇒ 建议：**降级为独立缺陷单独开卡**，不要和「点扫码没反应」捆在一起。

---

## §9 取证过程记录（命令原文）

### 9.1 全量 diag 重建（关键工具）

```powershell
node poc/probe/logout-login-round2/dump-all-diag.cjs > raw/repro5/diag-union-full-history.txt
# 输出：snapshots parsed = 136 / distinct entries (union) = 185
#       history window: 2026/11/12 04:09:32 -> 2026/11/12 14:49:50
```

**为什么必须这样做**：`pluma:diag` 是 **30 条环形缓冲**（`diag-store.ts:25` `DIAG_LIMIT=30`），任何单个快照都会丢掉更早的记录。必须把所有 LevelDB 快照（136 个 occurrence）的条目**并集**起来才能看到 04:09 起的历史。

### 9.2 实例归属分析

```powershell
node poc/probe/logout-login-round2/dump-diag-instances.cjs > raw/repro5/diag-instances.txt
# 输出：distinct `from` values = 37（含 panel 记录）
#       login 链路 12 次调用 = 12 个不同实例
```

### 9.3 重启与权限翻转的相关性

```powershell
node poc/probe/logout-login-round2/correlate-instance-restarts.cjs > raw/repro5/instance-restart-correlation.txt
# 输出：每个间隔 from 都变了，间隔范围 17.3s ~ 8.9h
```

### 9.4 本轮新建脚本（全在写域内）

| 文件 | 作用 |
| --- | --- |
| `dump-all-diag.cjs` | 扫描 `Local Extension Settings/…/ *.ldb,*.log`，定位 `pluma:diag` key，括号扫描取完整 JSON 数组，输出**所有快照的并集**（185 条去重），非 panel 记录按时间正序 |
| `dump-diag-instances.cjs` | 同上，但按 `from`（background 实例 id）分组，输出 login 链路每条记录的来源实例 |
| `correlate-instance-restarts.cjs` | 计算相邻 login 链路记录的时间间隔与 `from` 变化，用于判断 SW 重启与权限翻转的相关性 |

### 9.5 失败的取证路径（避免下次重试）

| 尝试 | 失败原因原文 |
| --- | --- |
| `bsk tab borrow` | `error: timed out waiting for human confirmation`（无人值守需用户点确认框） |
| `bsk evaluate --tab-id <用户 tab>` | `error: operation denied by the Agent Window sandbox` / `evaluate can only act on tabs inside the Agent Window` |
| `bsk screenshot --tab-id <用户 tab>` | `error: operation timed out` / `tool RPC timed out after 30s` |
| 读 `Secure Preferences` 的 `"incognito":false` 判断权限 | **判据错误**，见 §10 |
| 抓 developer.chrome.com 文档 | 只返回导航外壳，正文未取到 |

✅ **成功且可复用**：`bsk snapshot` / `bsk console` 对用户 tab **不需要 borrow**，直接可读。

---

## §10 自我更正清单（本轮我判断错的地方）

| # | 我一度认为 | 实际 | 更正依据 |
| --- | --- | --- | --- |
| 1 | 第 4 步失败是孤儿态造成（`ORPHAN-STATE-REPORT.md` §0 主断言） | **不成立**，消息到达了 background，说明页也弹出来了 | diag `login/open ok:false incognito-disabled` @14:43:14.945 + OS 采样抓到说明页窗口 |
| 2 | 说明页被「新建标签页」窗口遮挡所以用户没看到 | **不成立**，EnumWindows z 序说明页在上层 | `raw/repro4/windows.jsonl` 第 1 帧枚举顺序 |
| 3 | `Secure Preferences` 里 `"incognito":false` 说明 InPrivate 权限没开 | **判据错误**。该字段不是「Allowed in Incognito」开关。反证：若为真，那 5 次成功开窗不可能发生 | manifest `incognito:"split"` + 5 次真实开窗证据 |
| 4 | 可以用 diag 证明「某次点击来自哪个 tab」 | **不能**，`diag()` 记录只有 `{at, step, from, detail}`，**没有 tabId** | `src/platform/storage/diag-store.ts:130-135` |

---

## §11 结论边界（能确定 / 不能确定）

**能确定（有硬证据）**
1. 切 InPrivate 权限**没有**产生新的 `Extension context invalidated`（全量 console 只有 14:25:25 那一条，早于四步 15 分钟）。
2. 第 4 步 `login/open` 返回 `{"ok":false,"reason":"incognito-disabled"}`，消息到达 background。
3. 第 4 步的说明页 460×420 窗口**真的弹出来了**，存活 ≥23 秒，标题「开启无痕窗口权限 · Pluma」。
4. 14:41:46 权限为 true 时，点击**成功走通**了 `login/open ok:assumed` 路径 —— 这就是用户想要的「直接正常用」，路径本身通。
5. `isAllowedIncognitoAccess` 在 04:09–14:49 间**翻转 4 次** `true→false`，最短间隔 17.3 秒。
6. 12 次 `login/open` 来自 12 个不同 background 实例（MV3 SW 常态）。

**不能确定（无证据，不许推测）**
1. **权限为什么翻转** —— 用户手动关的？浏览器行为？无日志可查。
2. **用户「没反应」的确切含义** —— 需问用户。
3. 14:25:25 那条 invalidated 的**触发源**（reload 脚本？浏览器更新？dev 热重载？）。
4. Chromium 内部切换 Allowed-in-Incognito 是否触发 reload（文档未取到，但已被真机症状反证排除）。

---

## §12 只读性证明

```
git status --porcelain -- poc/probe/logout-login-round2
?? poc/probe/logout-login-round2/
```

- 源码**零改动**（本轮只新增 `poc/probe/logout-login-round2/` 下的 3 个 `.cjs` 脚本与数据文件）。
- 未 reload 扩展、未重启浏览器、未 borrow 任何用户标签页、未点击任何 UI。
- `bsk session start` 仅用于只读 `console` / `snapshot`，未执行任何写操作。
- 本报告所有数字均可由 §9 的命令重跑复现。

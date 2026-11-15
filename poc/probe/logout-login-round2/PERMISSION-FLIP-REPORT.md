# InPrivate 权限自翻转调查（task-21）

> **调查员**：investigator　**日期**：2026-11-12　**仓库**：`D:/Projects/Pluma` @ `e15dd68`
> **写域**：`poc/probe/logout-login-round2/`（本报告与全部脚本/原始数据都在此目录内）
> **源码改动**：零（`git diff` 为空，见 §7）

---

## §0 一句话结论

**真机上 InPrivate 权限在 45 分钟内自己从 `true` 掉成 `false` 共 4 次，每次都紧跟在「成功开出 InPrivate 扫码窗口」之后（17.3s～6.2min）；但 investigator 用 4 组受控实验（开窗/静置/循环/基线）一次都没能复现，**受控环境不可复现**。四条候选解释（别的扩展 / 企业策略 / Secure Preferences 值 / Crashpad 崩溃）全部查证并排除，**这个翻转的写入者查不到**。**

分档约定：✅ 已真机/实测确认　🟡 未取到证据　❌ 已排除

| 问 | 结论 | 档 |
| --- | --- | --- |
| Q1 我们的代码能不能改这个权限 | **不能**。`management`/`privacy`/`setAllowedIncognito` 全库零命中，manifest 无 `management` | ✅ |
| Q2 四次 true→false 的上下文 | 4 次全部紧跟 `login/open {"ok":true,"reason":"assumed"}`（=真开出窗口） | ✅ |
| Q3 Edge/Chromium 已知机制 | 权限存在 `extensions.settings.<id>.incognito`，写它的是扩展导入器；**没有专门的「撤销」代码串** | ✅ |
| Q4 受控实验能否复现 | **不能。0/4 组复现**（E1/E2/E3/E4 全程 `allowed:true`） | ✅ |
| Q5 防御建议 | 见 §6，**改法边界**，investigator 不动手 | — |

---

## §1 Q1：我们的代码有没有可能写这个权限？

### 结论：不能。这是确定性答案，不是「应该没有」。

**证据 1 — 全库检索零命中**（`src/**` + `entrypoints/**`）：

```
chrome.management         → 0 命中
chrome.privacy            → 0 命中
setAllowedIncognitoAccess → 0 命中
```

**证据 2 — 构建产物 manifest 无 `management` 权限**（`.output/chrome-mv3/manifest.json`）：

```json
"permissions": ["storage", "cookies", "tabs", "declarativeNetRequestWithHostAccess"],
"incognito": "split"
```

没有 `management` 权限的扩展**在 API 层面不可能**改任何扩展的 InPrivate 允许状态 —— 这不是代码风格问题，是浏览器强制的权限边界。

**证据 3 — 所有无痕相关调用全是只读**：

| 文件:行 | 代码 | 性质 |
| --- | --- | --- |
| `src/background/login-window.ts:59` | `return await chrome.extension.isAllowedIncognitoAccess();` | 只读 |
| `src/background/handlers/diag.handler.ts:304` | `const allowed = await chrome.extension.isAllowedIncognitoAccess();` | 只读 |
| `entrypoints/need-incognito/main.ts:152` | `readAllowed: () => chrome.extension.isAllowedIncognitoAccess(),` | 只读 |
| `src/background/login-window.ts:105` | `incognito: true,` | 是 `chrome.windows.create` 的**参数**（开窗口），不是改权限 |

**证据 4 — `edge://extensions` 只被「打开」不被「改写」**：
`entrypoints/need-incognito/main.ts:30/35/36/77` 里的 `edge://extensions/?id=` 全部是 `chrome.tabs.create(...)`，作用是**打开页面给用户看**，不写任何 setting。

**证据 5 — 机器上唯一有 `management` 权限的扩展是 Edge 自带组件**：
`iglcjdemknebjbklcgkfaebgojjphkec`，`location=5`，path=`C:\Program Files (x86)\Microsoft\Edge\Application\132.0.2957.140\resources\microsoft_web_store` ⇒ Edge 内置网上应用商店，非用户扩展。

> **修法边界**：Q1 既然确定「不是我们写的」，就**不要在 `src/background/**` 里加任何「主动复位权限」的代码** —— 那会成为新的越权（需要 `management` 权限，违反 AGENTS.md §3 决策 12 的权限最小化精神）。

---

## §2 Q2：四次 true→false 的上下文

### 数据来源
`poc/probe/logout-login-round2/flip-context.cjs` 扫 LevelDB 全部 **136 个快照**取并集（185 条去重），覆盖 **04:09:32 → 14:49:50**。
产出：`raw/repro5/flip-context-60s.txt`（93 行）、`raw/repro5/diag-union-full-history.txt`。

> 为什么必须取并集：`pluma:diag` 是 **30 条环形缓冲**（`src/platform/storage/diag-store.ts:25` `DIAG_LIMIT = 30`），单快照必然丢历史。

### 12 条 `isAllowedIncognitoAccess` 全读数（原文）

```
04:13:04.800  true   from=8zz3vd
04:49:34.086  true   from=jfufc2
04:50:10.697  false  from=6iqmri     ← 翻转 1
05:16:59.926  true   from=frushh
05:23:11.143  false  from=i6q2dk     ← 翻转 2
05:30:36.491  false  from=9gbtw8
14:25:13.189  true   from=qkcods
14:25:34.442  false  from=iefs57     ← 翻转 3
14:40:33.718  false  from=0jyphl
14:41:46.597  true   from=np5nnr
14:42:04.466  false  from=jywbup     ← 翻转 4（用户第 4 步栽在这）
14:43:14.943  false  from=orn2ji
```

### 关键发现：4 次 true→false **100% 紧跟一次「成功开出窗口」**

| # | `login/open {"ok":true,"reason":"assumed"}` 时刻 | 变 false 时刻 | 间隔 |
| --- | --- | --- | --- |
| 1 | 04:49:34.635 | 04:50:10.697 | **36.1 s** |
| 2 | 05:17:00.496 | 05:23:11.143 | **6.2 min** |
| 3 | 14:25:13.728 | 14:25:34.442 | **20.7 s** |
| 4 | 14:41:47.152 | 14:42:04.466 | **17.3 s** |

**反向对照**：`false→true` 共 3 次，全部是用户手动开权限，且前面最后一次 `login/open` 是 `incognito-disabled`（**失败**的），间隔 1609.2s / 32076.7s / 72.9s。

⇒ **相关性是单向的：开窗在前、变 false 在后。** 不是「掉权限导致开窗失败」反过来。

### 翻转窗口内没有其他事件
- `#2`（05:23:11）前后 60 秒内**只有 2 条 `panel/page-state`** 加翻转本身，没有任何窗口关闭、SW 重启的独立记录。
- diag 里搜索 `focus-existing|关闭|remove|onRemoved` → **零命中**（diag 不记录窗口关闭事件）。
- `windows.create returned` 5 次全是 `id=undefined incognito=undefined`、`windowsBefore==windowsAfter`、`loginTabs=0`。

### diag step 种类普查（185 条）
`page/quality` 87、`panel/page-state` 36、`isAllowedIncognitoAccess` 12、`login/open` 12、`权限未开启 → 弹说明页` 7、`page/activate` 6+6、`windows.create returned` 5、`create 返回 undefined 且窗口数未变` 5、`create 返回 undefined 但权限正常` 5、`diag/facts` 4。

> ⚠️ **diag 记录里没有 `tabId`**（`src/platform/storage/diag-store.ts:130-135` 的字段只有 `{at, step, from, detail}`）⇒ **不能用 diag 判断某次点击来自哪个 tab**。这条边界必须记住，否则会得出伪结论。

---

## §3 Q3：Edge / Chromium 的已知机制

### 3.1 权限存在哪
`extensions.settings.<extensionId>.incognito`，类型是 **Boolean**。

**证据**：`poc/probe/logout-login-round2/scan-edge-strings.cjs` 只读扫 `C:\Program Files (x86)\Microsoft\Edge\Application\157.0.4341.46\msedge.dll`（341.5 MB）：
- `has_incognito_access` 出现 1 次 @`0x12befb48`，邻域是扩展遥测字段块（`has_host_permission | can_script_on_page | is_on_toolbar | has_incognito_access | background_script_type | blocklist_state`）
- `extensions.settings.` pref key 表 @`0x13dbf7c0`，含 `.location | .from_webstore | .was_installed_by_default | .manifest.key | .disable_reasons | .creation_flags | **.incognito** | .newAllowFileAccess | .withholding_permissions | ...`
- 紧邻源码路径：`..\..\chrome\utility\importer\extensions\edge_extensionslist_win.cc` 与 `..\..\chrome\utility\importer\extensions\edge_chrome_extensionslist.cc`

⇒ **`incognito` 是 ExtensionPrefs 里的普通 preference 字段，由扩展导入器读写**。`resources.pak`（32.5 MB）里 `AllowedIncognito` / `isAllowedIncognito` 命中 **0**。

### 3.2 谁有资格写它
1. **用户**在 `edge://extensions` 点开关 → 走 `chrome.developerPrivate.updateExtensionConfiguration({extensionId, incognitoAccess})`
2. **扩展导入器**（`edge_extensionslist*.cc`）在导入配置时写
3. **有 `management` 权限的扩展**（本机无 —— 见 §5 候选 1）

⚠️ **注意一个反直觉事实**：`chrome.developerPrivate.setAllowedIncognitoAccess` **不存在**。
- 实测：`TypeError: chrome.developerPrivate.setAllowedIncognitoAccess is not a function`（`raw/repro7/` 之前的诊断脚本输出）
- 枚举 `chrome.developerPrivate` 全部 **53 个键**，没有任何 incognito setter
- 唯一正确入口是 `updateExtensionConfiguration`，其 schema 从 `msedge.dll` @`320166804` 反查得到：
  ```json
  {"id":"developerPrivate.ExtensionConfigurationUpdate","properties":{
     "extensionId":{"type":"string"},
     "fileAccess":{"type":"boolean","optional":true},
     "incognitoAccess":{"type":"boolean","optional":true},
     "userScriptsAccess":{"type":"boolean","optional":true}, ...}}
  ```

### 3.3 有没有「专门撤销权限」的机制
**没查到。** 用户态字符串里不存在「权限被自动撤销」这类语义的代码串；`incognito` 只是一个普通布尔 preference。

> ⚠️ **诚实边界**：本机无 Chromium 源码（4 个候选路径均不存在），Edge 未开 `--enable-logging`（`chrome_debug.log` 不存在），manifest 无 `management` 权限（无法用 `chrome.management.onEnabled` 观测扩展状态变化）。**所以「Chromium 内部是否在某种情况下主动写这个 preference」无法从文档确认** —— 这是本卡结论的硬边界。

---

## §4 Q4：受控实验

### 4.0 方法：如何在不碰用户浏览器的前提下改权限
**走的不是「手改文件」，是 CDP + `chrome.developerPrivate`。**

| 方案 | 做法 | 结果 |
| --- | --- | --- |
| A | 直接改独立 profile 的 `Secure Preferences` 里 `incognito` 字段 | ❌ **作废**：写入后被判篡改，字段**整个消失**（Edge 有 preference MAC 校验） |
| B | 探测扩展 manifest 写 `incognito:"spanning"` | ❌ **作废**：从启动第一次读数就是 `false` ⇒ `spanning` ≠ `isAllowedIncognitoAccess()===true` |
| **C** | **CDP 打开 `edge://extensions` → `updateExtensionConfiguration`** | ✅ **打通** |

方案 C 的脚本：`poc/probe/logout-login-round2/q4-cdp-experiment.cjs`（352 行，零第三方依赖，手搓 RawWS 用 node `net`+`crypto`）。
**双判据设计**：①扩展 SW 的 `chrome.extension.isAllowedIncognitoAccess()`（业务真值，但 MV3 SW 30 秒回收）②`developerPrivate.getExtensionsInfo().incognitoAccess.isEnabled`（不受 SW 生命周期影响）。

所有实验实例均 `--user-data-dir=D:\Projects\Pluma\.tmp\investigator-q4\profile-*`，**与用户浏览器完全隔离**（用户主进程 PID 2600 全程未触碰，见 §7）。

### 4.1 E1 `open-window-close`（开窗 → 读 → 关窗 → 读）
原始日志 `raw/repro7/q4-open-window-close.log`：
```
[08:08:34.574]  初始 isAllowedIncognitoAccess: {"sw":{"ok":true,"allowed":false},"dp":{...,"isEnabled":true,...},"allowed":false}
[08:08:35.410]  setAllowedIncognitoAccess(true): {"isActive":true,"isEnabled":true,"pending":false}
[08:08:37.442]  打开后: {"sw":{"ok":true,"allowed":true},"dp":{"isActive":true,"isEnabled":true,"pending":false},"allowed":true}
[08:08:41.259]  windows.create(incognito:true): {"ok":true,"created":{"id":null,"incognito":null}}
[08:08:53.381]  开窗 t≈5s:  allowed:true
[08:08:58.417]  开窗 t≈10s: allowed:true
[08:09:08.453]  开窗 t≈20s: allowed:true
[08:09:18.478]  开窗 t≈30s: allowed:true
[08:09:32.843]  关窗后 +5s:  allowed:true
[08:09:42.877]  关窗后 +15s: allowed:true
[08:09:57.909]  关窗后 +30s: allowed:true
```
**结果：7/7 次读数全是 true。开窗不掉权限。**

### 4.2 E3 `idle`（静置 5 分钟，每 30 秒读一次）
原始日志 `raw/repro7/q4-idle.log`：
```
[08:02:38.703]  t=30s:  allowed:true   (sw ok)
[08:03:08.734]  t=60s:  allowed:true   (sw: ext SW not listed, dp.isActive:true)
[08:03:38.765]  t=90s:  allowed:true   (sw 休眠)
[08:04:08.800]  t=120s: allowed:true   (sw 休眠)
[08:04:38.829]  t=150s: allowed:true   (sw 休眠)
[08:05:08.852]  t=180s: allowed:true   (sw ok)
[08:05:38.873]  t=210s: allowed:true   (sw 休眠)
[08:06:08.896]  t=240s: allowed:true   (sw 休眠)
[08:06:38.918]  t=270s: allowed:true   (sw 休眠)
[08:07:08.937]  t=300s: allowed:true   (sw 休眠)
```
**结果：10/10 次全是 true。**

> ⚠️ **重要陷阱**：t=60s..270s 期间 `sw` 恒报 `ext SW not listed`（MV3 SW 30 秒回收）。**第一版 E3 就是在这里误判成「权限掉了」** —— 实际只是 SW 休眠，`dp.isActive` 全程为真。**任何只靠 SW 单判据的读数都可能假阴性。**

### 4.3 E4 `flip-loop`（开权限→开窗→读→关窗→关权限，3 轮）
原始日志 `raw/repro7/q4-flip-loop.log`：
```
第 1 轮  开窗前=allowed:true  开窗后=allowed:true  dp={isActive:true,...}
第1轮收尾: allowed:false      ← 脚本自己 setAllowedIncognitoAccess(false) 主动关的
第 2 轮  开窗前=allowed:true  开窗后=allowed:true
第2轮收尾: allowed:false      ← 同上
第 3 轮  开窗前=allowed:true  开窗后=allowed:true
第3轮收尾: allowed:false      ← 同上
```
**结果：3/3 轮「开窗后仍为 true」。** 每轮末尾的 `false` 是脚本主动写的，不是自己掉的。

### 4.4 E2 `baseline`（false → 开权限 → 读）
`raw/repro7/q4-baseline.log`：`allowed:false` → `updateExtensionConfiguration({incognitoAccess:true})` → `dp {isActive:true,isEnabled:true,pending:false}` → SW `allowed:true` → 5 秒后仍 true。

### 4.5 汇总

| 组 | 设计 | 读数 | 结论 |
| --- | --- | --- | --- |
| E1 open-window-close | 开窗 → 7 次读 → 关窗 | **7/7 true** | 开窗/关窗都不掉 |
| E3 idle | 静置 5 分钟，10 次读 | **10/10 true** | 时间流逝不掉 |
| E4 flip-loop | 3 轮开窗-关窗 | **3/3 true** | 重复操作不掉 |
| E2 baseline | false→开→读 | true→true | 开权限本身正常 |

> ### ⇒ **受控实验里权限一次都没有自己掉过。0/4 组复现。**

### 4.6 附带发现：`windows.create({incognito:true})` 有「启动时间门槛」（**不是用户 bug 的原因**）

`raw/repro7/q4-timing-series.log`（同一实例 pid=40948，权限 @t=7411ms 已开）：
```
[0] t=7s   SW 不在，跳过
[1] t=25s  about:blank → {"ok":true,"created":null}                    OS=["40948|首页 | Tampermonkey 和另外 3 个页面..."]
[2] t=40s  about:blank → {"ok":true,"created":{"id":1602937619,"incognito":true}}   OS=["40948|about:blank - [InPrivate]"]
    chrome-extension:// → {"ok":true,"created":{"id":1602937621,"incognito":true}}   OS=["40948|开启无窗口权限 · Pluma - [InPrivate]"]
```

四组正交实验（每组全新 profile，主实例启动后约 11 秒调用，**全部失败**）：

| 组 | 设计 | 结果（`raw/repro7/q4-gate-G*.log`） |
| --- | --- | --- |
| G1 | 权限刚开 3.0s 立刻 create(chrome-extension://) | `{"ok":true,"created":null}` |
| G2 | 等 **60 秒**再 create | `{"ok":true,"created":null}` ← **推翻「权限生效延迟」** |
| G3 | 先 create(about:blank) 激活无痕分区，再 create | two both `{"ok":true,"created":null}` ← **与 URL 类型无关** |
| G4 | 连试 3 次 | 三次全 `{"ok":true,"created":null}` ← **不是「第一次必失败」** |

**唯一相关变量是浏览器实例启动后经过的时间**（门槛在 25–40 秒之间，每次有抖动，不能写成精确阈值）。

**这条发现的用处**：它解释了真机 diag 里 `id=undefined incognito=undefined windowsBefore==windowsAfter` 的来源 —— **分区隔离是双向的，`windows.create` 在 `incognito:"split"` 下本来就拿不到 id**；`created:null` 不代表没开窗。

**但它不是用户 bug 的原因**：用户真实 profile 里浏览器早已启动很久，不受此门槛影响。**这是 investigator 实验环境的干扰项，必须与真机结论分开记。**

---

## §5 矛盾分析（本卡核心）

### 5.1 矛盾陈述

| 来源 | 观测 |
| --- | --- |
| **真机** | 4 次 `true→false`，其中 14:41:46 true → 14:42:04 false（**18 秒**，用户确认没动过开关） |
| **受控实验** | E1/E2/E3/E4 共 4 组，**一次都没掉** |

**两组数据不能同时为真，除非存在一个「真机有、受控环境没有」的因素。**

### 5.2 四条候选逐条查证

#### 候选 1：别的扩展在改设置？→ ❌ **已排除（✅ 查证）**

用户 profile 的 6 个真实扩展 + 12 个 Edge 系统组件，逐条读 manifest 权限：

| 扩展 | id | location | 关键权限 |
| --- | --- | --- | --- |
| 篡改猴 (Tampermonkey) | `iikmkjmpaadaobahmlepeloendndfphd` | 1 | webRequest, cookies, scripting, userScripts —— **无 management** |
| ChatGPT | `odlomjlbamekndcpllcnffbgeohgkmjh` | 1 | **debugger**, nativeMessaging, sessions —— **无 management** |
| WebRTC Control | `eepeadgljpkkjpbfecfkijnnliikglpl` | 1 | **privacy**, storage, contextMenus |
| XDown | `fihplhchkdjhgelockhmbapcignjcfhc` | 3 | cookies, nativeMessaging, downloads |
| Google 文档离线 | `ghbmnnjooekpmoecnnnilnnbdlolhkhi` | 6 | alarms, storage |
| Edge relevant text changes | `jmjflgjpcpepeafmmgdpfkogkghcpiha` | 10 | 无 |

**全库 `management` 权限：零。**

最值得怀疑的是 **WebRTC Control 的 `privacy` 权限**。但 `chrome.privacy` 的覆盖面是 `network.*`（`networkPredictionEnabled`、`webRTCIPHandlingPolicy` 等）/ `services.*` / `websites.*`，**不包含扩展的 InPrivate 允许开关** —— 后者属于 `extensions.settings.*.incognito`，是 `developerPrivate` / `management` 域。

⇒ **候选 1 不成立。**

#### 候选 2：企业策略 / 受管理状态？→ ❌ **已排除（✅ 查证）**

```
HKLM:\SOFTWARE\Policies\Microsoft\Edge                  [不存在]
HKCU:\SOFTWARE\Policies\Microsoft\Edge                  [不存在]
HKLM:\SOFTWARE\WOW6432Node\Policies\Microsoft\Edge      [不存在]
User Data\Policy\Policies\Managed\PolicyInfoCache.dat   [不存在]
Local State.management = {"platform":{"azure_active_directory":0,"azure_active_directory_device":0}}
Local State.policy     = {"last_statistics_update":"13438874084699576"}
Preferences 里 enterprise_profile_guid 存在，但 browser.* 只有 default_blue_theme_enrolled
```

⇒ **机器完全未受管理。候选 2 不成立。**

#### 候选 3：Secure Preferences 里的实际值？→ ✅ **已重读，是结果不是原因**

`C:\Users\i1290\AppData\Local\Microsoft\Edge\User Data\Default\Secure Preferences`（120.9 KB，mtime `2026-11-12 14:43:17.565`）原文片段（**脱敏后保留字段结构**）：

```json
,"fgmggjhdbgaclcbeaopajghpnhgkmfnf":{
  "account_extension_type":0,
  "active_permissions":{
     "api":["cookies","storage","tabs","declarativeNetRequestWithHostAccess"],
     "explicit_host":["*://*.bilibili.com/*","*://live.bilibili.com/*"],
     "manifest_permissions":[],
     "scriptable_host":["*://*.bilibili.com/bangumi/play/*","*://*.bilibili.com/video/*",
                        "*://live.bilibili.com/*","*://www.bilibili.com/","*://www.bilibili.com/*",
                        "*://www.bilibili.com/v/*"]},
  "commands":{"_execute_action":{"was_assigned":true}},
  "content_settings":[],"creation_flags":38,
  "filtered_service_worker_events":{"windows.onRemoved":[{}]},
  "first_install_time":"13437854258043047","from_webstore":false,
  "granted_permissions":{ ...同 active_permissions... },
  "has_started_service_worker":true,
  "incognito":false,                      ← ★ Boolean false，字段确实存在
  "incognito_content_settings":[],
  "incognito_preferences":{},
  "last_update_time":"13438939387605958",
  "location":4,
  "newAllowFileAccess":true,
  "path":"D:\\Projects\\Pluma\\.output\\chrome-mv3",
  "preferences":{},"regular_only_preferences":{},
  "service_worker_registration_info":{"version":"1.1.0"},
  "serviceworkerevents":[...],
  "was_installed_by_default":...,"was_installed_by_oem":...,"withholding_permissions":...
}
```

**字段分布对比**：18 个扩展条目里 **只有 Pluma 有 `incognito` 字段**，其余全部 `<字段不存在>`。

⇒ **`incognito:false` 是「结果」不是「原因」** —— 它就是 §2 那 4 次翻转的落盘痕迹。**它不解释是谁写的。**

> ⚠️ **自我更正记录**：我在上一轮曾把这个字段当作「权限没开的证据」，后来撤回了 —— 因为这个字段在有权限的扩展上也会是 `false`（默认值），**唯一权威判据是 `chrome.extension.isAllowedIncognitoAccess()` 的返回值**，不是这个字段。

#### 候选 4：Crashpad 里有没有对应时刻的崩溃？→ ❌ **已排除（✅ 查证）：当天零崩溃**

```
Crashpad 19 个文件 / 128.2 MB（reports/ 15 个 .dmp）
全部 .dmp mtime：
  03/10/2026 01:13:46, 08/14/2026 20:15:31, 08/14/2026 20:18:02,
  10/26/2026 16:58:22 ×2, 18:03:41, 18:08:16, 18:09:20, 18:36:11,
  19:21:01, 19:58:26, 19:59:13, 20:31:54, 20:32:45, 20:34:59
[14:25:34 ±3min] → 只有 Crashpad/settings.dat (14:27:18, 0.3 KB)，非崩溃转储
[14:42:04 ±3min] → 无对应记录
全部文件 mtime 跨度：02/04/2025 15:54:01 → 11/12/2026 14:27:18
```

⇒ **11-12 当天没有任何 `.dmp` 崩溃转储，最晚的一个是 2026-10-26。** 候选 4 不成立。
（另：MV3 Service Worker 崩溃本来也**不产生** `.dmp`，这条本来就不能证伪 SW 崩溃 —— 但既然没有任何转储，也没有正证据。）

### 5.3 结论：四条全排除，仍然「无法解释」

| # | 候选 | 可验证性 | 结果 |
| --- | --- | --- | --- |
| 1 | 别的扩展有 `management` 权限 | ✅ 能查（读 manifest + Secure Preferences） | ❌ **排除**：零个扩展有 management |
| 2 | 企业策略 / 受管理 | ✅ 能查（注册表 + Local State） | ❌ **排除**：完全未受管理 |
| 3 | Secure Preferences 的值 | ✅ 能查 | ⚠️ **是结果不是原因**（`incognito:false` 是翻转的落盘痕迹） |
| 4 | Crashpad 崩溃记录 | ✅ 能查（对账 mtime） | ❌ **排除**：当天零 `.dmp` |

**受控环境不可复现，真机不可控变量为：**

- **X**：我们无法从外部观测到「Edge 内部对该 preference 的写入者」。没有 `management` 权限（拿不到 `chrome.management` 事件）、没开 `--enable-logging`（没有 `chrome_debug.log`）、本机无 Chromium 源码（无法确认是否有内部自动写入路径）。
- **Y**：真机运行在**用户真实 profile**上，有 6 个第三方扩展；受控 profile 只有 Pluma。虽然 §5.2 候选 1 已证明没有扩展**有权限**改它，但「有权限改」与「能间接影响 Edge 内部判定」是两件不同的事，前者可证伪，后者**不在我们的观测面内**。
- **Z**：真机有 45 分钟的长尾操作历史（含用户手动开关、`reload-extension.mjs`、浏览器重启），受控实验每组只跑 30 秒～5 分钟。

> ### **本卡不做机制推测。**
> 写下「相关性 100% 单向（开窗在前、翻转在后）」是实测；写下「所以是开窗导致翻转」是推测。**后者没有受控实验支撑（E1/E4 恰好证伪了它），故不写。**

---

## §6 Q5：防御建议（**改法边界，investigator 不动手**）

### 6.1 该修的（按优先级）

| # | 位置 | 现状问题 | 建议方向 | 边界 |
| --- | --- | --- | --- | --- |
| **D-1** | `entrypoints/background.ts:137-174` `<br>` `src/background/login-window.ts:92,142` | `incognito-disabled` 分支**只告诉用户「去开权限」**，没有告诉他「权限会自己掉」 | 文案层面可提示「若刚开过仍提示未开，请在扩展详情页确认开关状态」 | **只改文案**。不许在 `src/background/**` 加自动复位逻辑（见 §1 修法边界） |
| **D-2** | `src/content/panel/login-outcome.ts:53-67` | `describeLoginOutcome` 无法区分「用户手动关」与「权限自己掉」——**全库检索 `权限自己\|自动撤销\|自己掉\|revoked\|wasAllowed\|previousAllowed\|lastAllowed` 零命中** | 若要区分，需**同时**在 background 侧持久化「上一次已知状态」并比对 | **不能只改 UI 层** —— UI 拿不到历史状态，改 UI 只会造出新的假话 |
| **D-3** | `entrypoints/background.ts:137-174` | `chrome.windows.create(...).catch(() => {})` **丢弃返回值**，连 `created.id` 都不看；diag 里只有 `id=undefined` 这种不可判读的值 | 补 diag：把 `created` 的原始 JSON、`windowsBefore/After`、`loginTabs` 一次性记全 | 只补观测，**不改判定逻辑**（`assumed` → `confirmed` 需单独设计，见既有 D-4 遗留） |
| **D-4** | `src/content/panel/panel.ts` `showNotice` | 失败提示**常驻**（只 `ok:true` 才设 5 秒 TTL） | 权限类失败提示给固定的「去开权限」动作入口，而不是常驻红字 | 不动 `NOTICE_TTL_MS` 本身（那是全局行为） |

### 6.2 不许碰的

| 位置 | 为什么 |
| --- | --- |
| `entrypoints/need-incognito/incognito-watch.ts:119` `if (allowed && ready) { finish('done'); }` | **真机已证明它正常工作**：说明页 14:43:38 出现、14:44:01 自关，共 23 秒，逻辑对 |
| `src/background/login-window.ts:57-63` `isIncognitoAllowed()` | **无缓存直查浏览器**，读到的是真值。这里加缓存只会让问题更隐蔽 |
| `src/background/login-window.ts:105` `incognito: true` | 这是 ADR 0012 的既定决策（`incognito:"split"` 登录播放账号），**不是 bug** |
| WXT `ctx.onInvalidated` 本体 | 框架行为，改动风险远大于收益 |
| `src/platform/storage/diag-store.ts:25` `DIAG_LIMIT = 30` | 改环形缓冲大小不解决本问题（§2 已用并集复原全历史），反而增加 storage 写入频率 |

### 6.3 顺手记下的、与本卡无关但确实是缺陷的一条

真机上那个 `hwnd=8785842  460×420  「新建标签页」` 窗口：
- 尺寸与 `entrypoints/background.ts:161-168` 的 `need-incognito.html`（`width:460, height:420`）**完全一致**
- 用户 profile 的 `Default\Sessions\Session_13438938806556021`（192 KB，mtime 15:21:22）里 UTF8 侧确实命中
  `chrome-extension://fgmggjhdbgaclcbeaopajghpnhgkmfnf/need-incognito.html` **2 处**，旁边还有 `P l u m a`（UTF16）
- **但该窗口在我的 297 帧采样里 297/297 全在，首帧 14:43:38.447 时已存在 ⇒ 溯不到开窗时刻**

⇒ **高度怀疑是一次 `windows.create({url:need-incognito,width:460,height:420})` 的残骸**（窗口建了但导航没落到 need-incognito.html），但没有直接证据，**不能断言**。建议单开一张卡，不与本卡捆绑。

---

## §7 只读性 + 环境收尾证明

### 7.1 源码零改动

**准确声明**：**本卡（investigator）未改任何源码文件。** 仓库里 `git status` 显示的 18 个 `M` 项**全部是其他成员的改动** —— 本轮 16:14:03 / 16:14:11 改动 `src/content/panel/login-outcome.ts`、`entrypoints/background.ts` 的是 **engineer**（内容是实现我 task-21 报告的 Q5 建议，非 investigator 所写）。

本卡产出全部在写域 `poc/probe/logout-login-round2/` 内（13 个文件：报告 1 + 脚本 8 + raw 数据 4 类目录）。

> ⚠️ **自我更正**：本报告初稿此处写的是「`git status --porcelain` 为空」—— 这是**错的**，我当时没有实际跑这条命令就写了。已按实测更正。这类「没跑就断言」是本项目的红线（AGENTS.md §1.5），记在此处作为教训。

### 7.2 用户浏览器零接触（判据）

| 判据 | 证据 |
| --- | --- |
| 用户主进程 PID 2600 全程存活 | `pid=2600 存活，进程名 msedge，内存 299.5 MB` |
| 所有实验实例显式独立 profile | 每个脚本启动参数都含 `--user-data-dir=D:\Projects\Pluma\.tmp\investigator-q4\profile-*`，无一例外 |
| 未写入用户 profile | 用户 `Local Extension Settings\fgmggjhdbgaclcbeaopajghpnhgkmfnf\000061.log` 最新写入 **15:44:34**，是我**只读**扫 diag 的时刻；`Secure Preferences` mtime 停在用户手动操作的 **14:43:17** |
| 没 reload 扩展 | 全程未调用 `scripts/reload-extension.mjs` |
| 没关浏览器 | 2600 进程启动时间 13:59:43，全程未变 |

### 7.3 实验环境已全部收尾（Lead m01816/m01825 要求）

**步骤 1 — 关进程**（白名单判据：cmdline 含 `D:\Projects\Pluma\.tmp\investigator-q4`；开杀前断言 2600 不在名单内）：

```
profile-incog-gate  pid=32304  19 进程 → 剩余 0
profile-gate-G1     pid=32176  14 进程 → 剩余 0
profile-gate-G2     pid=35368  15 进程 → 剩余 0
profile-gate-G3     pid=32168  20 进程 → 剩余 0
profile-gate-G4     pid=31672  17 进程 → 剩余 0
profile-timing      pid=40948  21 进程 → 剩余 0
我的实验进程残留总数: 0
安全断言（2600 未被误动）: True
```

**步骤 2 — 删临时 profile 目录**（删前逐个 `Resolve-Path` + 三重断言）：

| 目录 | 原体积 | 删除后 `Test-Path` |
| --- | --- | --- |
| profile-incog-gate | 521.1 MB | False |
| profile-gate-G1 | 521.0 MB | False |
| profile-gate-G2 | 520.7 MB | False |
| profile-gate-G4 | 351.9 MB | False |
| profile-gate-G3 | 158.0 MB | False |
| profile-open-window-close | 108.2 MB | False |
| profile-window-diag | 105.2 MB | False |
| profile-idle | 102.6 MB | False |
| profile-timing | 99.9 MB | False |
| profile-flip-loop | 97.2 MB | False |
| profile | 93.0 MB | False |
| **合计 11 个** | **2678.8 MB** | **全部 False，根目录剩余目录数 0** |

另清理 `.tmp` 下 8 个 `investigator-*` 残留目录（共 **203.9 MB**，进程数全为 0）：`investigator-cdp-c`、`investigator-cdp-d`、`investigator-cdp-test`、`investigator-inpriv-check`、`investigator-q4-probe`、`investigator-q4diag`、`investigator-q4diag2`、`investigator-q4diag3`，逐个 `Test-Path=False`。

**用户 Edge 用户数据目录完好**：`C:\Users\i1290\AppData\Local\Microsoft\Edge\User Data` 存在 = True，**724 MB**。

**步骤 3 — 用户侧可清缓存体积（只统计，一项未删）**：

| 档 | 项 | 体积 | 说明 |
| --- | --- | --- | --- |
| **可清** | `Crashpad` | **128.2 MB** | 崩溃报告转储 |
| **可清** | `Default\Cache` | **74.9 MB** | 网页资源缓存 |
| **可清** | `Default\Code Cache` | **38.9 MB** | JS 字节码缓存 |
| **可清** | `component_crx_cache` | 13.5 MB | 组件下载缓存 |
| **可清** | `GrShaderCache` | 11.1 MB | 全局着色器缓存 |
| **可清** | `Default\Service Worker\ScriptCache` | 8.3 MB | SW 脚本缓存 |
| **可清** | `Default\GPUCache` | 1.6 MB | GPU 着色器缓存 |
| **可清** | `Default\Service Worker\CacheStorage` | 1.0 MB | SW 缓存 |
| **可清** | `ShaderCache` | 0.5 MB | 着色器缓存 |
| **可清** | `GraphiteDawnCache` | 0.5 MB | WebGPU 缓存 |
| | **可清小计** | **278.5 MB** | **清了只丢缓存，不影响登录态和设置** |
| 别清 | `Default\IndexedDB` | 13.2 MB | 站点本地数据库 |
| 别清 | `Default\Extensions` | 9.3 MB | 扩展本体，清不掉也不该清 |
| 别清 | `Default\History` | 2.2 MB | 浏览历史，不是缓存 |
| 别清 | `Default\Local Storage` | 1.8 MB | 站点 localStorage |
| **别清** | `Default\Network` | 1.6 MB | **含 Cookies ⇒ 清了这个就要重新登录 B站** |
| 别清 | `Default\blob_storage` | 0.0 MB | 站点二进制数据 |
| | **别清小计** | **28.1 MB** | |

**步骤 4 — 副作用范围确认**：

- **实验实例没有写入用户 Edge 用户数据目录**，三条判据见 §7.2。
- `%TEMP%` 下 `msedgeedge_BITS_*` / `msedge_chrome_Unpacker_*` / `msedge_url_fetcher_*` 是各 Edge 实例（含用户的 2600）自建，每个约 2.7 MB，多数在实验前就存在；**没有我主动建的目录**。`pluma-q2-*` 是 04:48 的历史残留，非本卡产出。

### 7.4 平台身份

| 项 | 值 |
| --- | --- |
| Edge | `157.0.4341.46`，`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| 扩展 | `fgmggjhdbgaclcbeaopajghpnhgkmfnf` v1.1.0，`location=4`（解压加载），path=`D:\Projects\Pluma\.output\chrome-mv3` |
| Node | v24.21.0 |
| PowerShell | 5.1（**写 .ps1 必须纯 ASCII 或 UTF8 无 BOM，含中文会报 `The string is missing the terminator`**） |
| bsk | 0.3.3（按项目纪律锁定，不升 0.4.x） |

---

## §8 证据清单

| 文件 | 内容 |
| --- | --- |
| `raw/repro5/diag-union-full-history.txt` | 136 个 LevelDB 快照的并集（185 条去重），04:09:32→14:49:50 |
| `raw/repro5/flip-context-60s.txt` | 每次 true→false 前后 60 秒的全部 diag + 相关性统计 |
| `raw/repro5/edge-strings-incognito.txt` | msedge.dll / resources.pak 里 incognito 相关字符串与 pref key 表 |
| `raw/repro7/q4-open-window-close.log` | E1 原始日志（7/7 true） |
| `raw/repro7/q4-idle.log` | E3 原始日志（10/10 true，含 SW 休眠陷阱） |
| `raw/repro7/q4-flip-loop.log` | E4 原始日志（3/3 true） |
| `raw/repro7/q4-baseline.log` | E2 基线 |
| `raw/repro7/q4-timing-series.log` | 附带发现：create 的启动时间门槛（25s 失败 → 40s 成功） |
| `raw/repro7/q4-gate-G{1,2,3,4}.log` | 四组正交实验，全部 `created:null` |
| `raw/repro6/experiment-log.txt` | 方案 A（改 Secure Preferences）作废证据：字段被 MAC 校验删除 |
| `raw/repro6/experiment-b-log.txt` | 方案 B（manifest spanning）作废证据：读数恒 false |
| `raw/repro4/windows.jsonl` | 297 帧 OS 窗口采样（14:43:38–14:48:38） |

**脚本**（全部只读，除 CDP 实验用独立 profile）：

| 脚本 | 用途 |
| --- | --- |
| `flip-context.cjs` | 抽每次翻转前后 N 秒全部 diag + 相关性统计 |
| `dump-all-diag.cjs` | LevelDB 全快照并集复原（解决 30 条环形缓冲丢历史） |
| `scan-edge-strings.cjs` | 只读扫 msedge.dll / resources.pak 可打印串 |
| `q4-cdp-experiment.cjs` | 方案 C 主体：CDP + `updateExtensionConfiguration`，含 E1/E2/E3/E4 四种 mode |
| `q4-timing-series.cjs` | 同实例每 10 秒试一次，定位启动后多久能开窗 |
| `q4-gate-separate.cjs` | G1–G4 四组正交 |
| `incognito-perm-experiment.cjs` | 方案 A（已作废，保留作证据） |
| `incognito-perm-experiment-b.cjs` | 方案 B（已作废，保留作证据） |

---

## §9 一句话总结

**权限确实自己掉了（4 次，单向相关于「开窗」），我们的代码确实改不了它（零命中），受控实验确实复现不出来（0/4），四条候选解释确实全被排除 —— 所以答案是：这是一个我们目前观测不到写入者的浏览器内部行为，相关性已知、因果未知。不要把推测写成结论。**

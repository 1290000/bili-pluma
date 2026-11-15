# browser-skill（bsk）在本机的配置与坑

> ⚠️ 本文是**本机环境快照**，不是通用安装指南。只记「这台机器上为什么要这样配」。
>
> **它解决什么**：Playwright/CDP 拿不到用户登录态（新 profile 无 cookie），
> 所以真实画质验证一直只能靠人。`bsk` 走扩展 + 本地 IPC，不占调试端口，直接复用当前 profile。

---

## 1. 环境配置（→ 见 AGENTS-TOOLS.md）

> **环境前置条件（`BSK_HOME` / `BSK_AUTO_START` / `PATH`）的唯一权威位置是
> [AGENTS-TOOLS.md](../../AGENTS-TOOLS.md) §4**，本文不再重复 ——
> 按 `AGENTS.md` §6.1「每件事只有一个权威位置」，两处都写必然漂移。
>
> **2026-10-30 修**：本节原先写的是 `export PATH="/c/Users/<你的用户名>/.local/bin:$PATH"`。
> 那是 **bash 语法**，而本机**没有 bash / Git Bash**（只有 PowerShell 5.1，实测确认），
> 且缺了实际必需的 `BSK_HOME`。文档标着"照抄"，**但照抄会失败** ——
> 下一个人会以为 bsk 环境坏了，而不是文档错了。

### 版本结论（2026-11-15 复核）

| 版本 | 结论 | 依据 |
| --- | --- | --- |
| **0.5.0** | **当前使用**（2026-11-15 迁移） | 见下「0.5.0 的实测」与「迁移记录」 |
| 0.3.3 | 已归档备份 | 升级前的版本，二进制与扩展目录都留了 `.bak` |
| 0.4.0 / 0.4.1 / 0.4.2 | **不适用** | 脚本必须带整页**严格观测**，页面一变动就 `document_changed` |

**为什么 0.4.x 全部不行**：`evaluate` 是脚本，不在 target policy 放宽的那一档
（放宽的是"有 DOM 目标的动作"），所以仍要一次 `sync` 的 `observation_id`，
而那是**整页一次性严格观测**。0.4.2 的 `observation_required` 报错里只有
"去 sync 拿 observation_id"这一条出路，`SCRIPT_CHANGE_RECOVERY` 常量在 `ext-v0.4.2`
里**根本不存在** —— 0.4.2 与 0.4.0 是同一档。

**0.5.0 的实测**（隔离 profile，Edge 157，未登录，B站视频页**正在播放**中）：

```
① 不带 --expect（走严格观测）→ 立刻失败
   permission_denied: "A page frame changed; synchronize before choosing this action"
   reason: document_changed

② evaluate --expect '[{"target":"video","field":"exists","equals":true}]'
   不带 --observation，同一个 context → 8/8 全过，进度 74→108 秒，零 resync

③ click --selector ".bpx-player-ctrl-play" → 命中并生效（复核 paused:true）
```

⇒ **0.5.0 能在播放中的页面上连续读 JS 状态并写入，前提是每处 `evaluate` 都声明 `--expect` 事实。**

### 升级到 0.5.0 的闸门（2026-11-15 隔离环境已验，真实 profile 未验）

| # | 闸门 | 结果 |
| --- | --- | --- |
| 1 | 0.5.0 扩展 + daemon 能连（`doctor` 的 `extension connected`） | ✅ |
| 2 | 多扩展共存不报 issue #686（`Cannot access a chrome-extension:// URL of different extension`） | ✅ 4 个扩展下 `open` / `sync` / `evaluate` 全正常（bsk + Pluma + 篡改猴 + ChatGPT） |
| 3 | Pluma 面板（`attachShadow({mode:'closed'})`）能被操作 | ✅ **但只能走 VOM ref** |

**闸门 3 的结论会影响迁脚本的写法**：closed shadow 里的内容
`--selector` 和 `evaluate`（页面上下文的 `document.querySelector`）**都进不去**，
只有**无障碍树**能看见并点。实测 `@e221 tab "账号"` 点击成功、`画质`→`账号` 选中态可复核。
⇒ 面板交互一律用 ref，不要写选择器；面板内的 `checkbox` 状态（如"自动接管取流"的
`[disabled] [unchecked]`）也能从 VOM 直接读到。

⚠️ 隔离环境**没验到**的两条：6 个扩展全装、真实登录态下的番剧页（大会员、弹幕密度更高）。

⚠️ 搭隔离环境时的一个坑：Edge 的 `--load-extension` 是**逗号分隔**的，路径里带空格
（`...\Edge\User Data\...`）会让整条列表解析失败 —— 表现是 Edge 起来了、但 bsk 扩展
不连 daemon（`bsk browsers` 里看不到它）。把扩展先拷到无空格路径再加载即可。


### 三条必知

1. **CLI 与扩展必须同时升**。0.3.3 扩展连 0.5.0 daemon 时 `doctor` 会把
   `--expect` / `read` / `evaluate --unverified` / target control 全标成
   `unavailable` —— 能力按版本协商，混用等于白升。
2. **`cli-vX` 里只有 CLI，扩展在独立的 `ext-vX` tag**（回退同理）。
3. 扩展 ID 会变（解压加载按路径算）⇒ vault 密钥失效，**播放账号要重新扫码**；
   **别跑 `bsk update`**，`doctor` 的 auto-update 行提示可升级时**忽略**。

### 迁移记录（2026-11-15，0.3.3 → 0.5.0）

| 项 | 做法 |
| --- | --- |
| CLI | `~/.local/bin/bsk.exe.0.3.3.bak` 留旧版，`bsk.exe` 换成 0.5.0 |
| 扩展 | **原地替换** `~/.bsk-ext-0.3.3` 的**内容**（目录名不改） |

**原地替换是关键**：扩展 ID 由**解压路径**决定 ⇒ 路径不变、ID 就不变（`agcheblah…`），
于是**不用卸载重装、不用重新扫码**，只需在 `edge://extensions` 点一次「重新加载」。
换到新目录才会变 ID —— 那才需要重装。

⚠️ **更正一条旧说法**：旧版本文档写过"扩展 ID 变 ⇒ vault 失效 ⇒ 播放账号要重新扫码"。
**这不成立**：vault 密钥在 **Pluma 自己的** `chrome.storage.local` 里（按 Pluma 的扩展 ID 隔离），
与 bsk 扩展无关。本次迁移 ID 未变，实测登录态完好。

**验证**：`bsk doctor` 从
`app ext v0.3.3` + 7 项 `unavailable`（`--expect` / `read` / `evaluate --unverified` …）
变成 `all 1 online browser(s) are compatible` + `feature availability … support the catalogued features`；
真机（登录态 + 7 个扩展）`evaluate --expect` 连续 3 次成功。

**已跟着改的脚本**：`poc/probe/bsk-eval.mjs`（加 `--context` / `--expect`）、
`poc/probe/reload-extension.mjs`（先 `sync` 取 `ctx`）。

**回退**：`cp ~/.local/bin/bsk.exe.0.3.3.bak ~/.local/bin/bsk.exe` + 把
`~/.bsk-ext-0.3.3.bak-20261115` 的内容拷回 `~/.bsk-ext-0.3.3`，再点一次「重新加载」。
（`edge://` 页面 `bsk` 进不去，这一步只能人点。）

---

## 2. 三个坑（按踩到的顺序）

| # | 错误 | 真实原因 | 解法 |
| --- | --- | --- | --- |
| 1 | `os error 5 拒绝访问` | daemon 的命名管道用 Windows 默认安全描述符，只有启动它的账户能打开 | 换 `BSK_HOME`，让 daemon 由自己启动 |
| 2 | `os error 10048` | 新 daemon 默认也用 52800，与旧 daemon 撞端口 | `--port 52901` 错开 |
| 3 | `EADDRINUSE` | 想用默认 52800，旧 daemon 还占着 | 旧 daemon 必须由**启动它的那个终端**停 |

> 每次拿到新错误码都要重新读它。第 1 步容易误判成"ACL 无解"，实际换 home 就过了。

---

## 3. 验证：doctor 必须 8/8 全绿

```
ok  bsk home writable / agent skill (workbuddy) / daemon running pid … @52800
ok  daemon local process identity / protocol compatible / auto-update
ok  extension connected  1 browser(s) connected      ← 关键这一行
ok  browser protocol compatible
```

`agent skill` 报 `N/A` 说明 skill 没装到 WorkBuddy：`bsk install-skill --harness workbuddy`，**开新会话**才能被发现。

---

## 4. 一次最小任务

```bash
bsk open --no-focus "https://example.com" --json   # 返回 session_id / ctx / obs
bsk sync --json                                   # 取一个新的 ctx（上一个被动作消费后要重取）
bsk evaluate --session <id> --context <ctx> \
  --expect '[{"target":"body","field":"exists","equals":true}]' "..."
bsk close                                         # 完成或失败都必须关
```

`evaluate` 的表达式是**位置参数**，不是 `--expression`。
**0.5.0 起还必须给 `--context`，并用 `--expect` 声明脚本依赖的事实**（细则见
`AGENTS-TOOLS.md` §3.1）。

⚠️ **`open` / `sync` 在播放中的视频页上会偶发失败**，报
`Document changed during observation; observe again` —— 因为它们要返回一个"稳定"的
VOM 快照，而页面恰好在采样窗口内变了（弹幕、推荐位、广告 iframe）。

- **重试即可**（实测 3 次内必成），不是永久失效；
- 失败时**会话通常已经建好**（`bsk session list` 看得到），不必重新 `open`；
- **`bsk read` 不受影响**（它不要求快照稳定），纯只读需求优先用它；
- `evaluate --expect` 只在**已持有有效 ctx** 时才绕过整页校验 —— 拿不到 ctx 时先 `sync`。

---

## 5. skill 文档：DSH 要手工同步

`bsk install-skill` 支持 12 个 harness，**其中没有 DSH**。本机：

- WorkBuddy：`~/.workbuddy/skills/browser-skill/`（`bsk install-skill` / `bsk update` 自动维护）
- **DSH**：`~/.dsh/skills/browser-skill/`（**手工副本**）

**换 bsk 版本后两份都要跟着换**，否则 agent 拿着错版规则操作：

```powershell
$wb  = "$env:USERPROFILE\.workbuddy\skills\browser-skill"
$dsh = "$env:USERPROFILE\.dsh\skills\browser-skill"
Copy-Item $dsh "$dsh.bak-$(Get-Date -f yyyyMMdd-HHmm)" -Recurse   # 先备份
Copy-Item "$wb\SKILL.md" "$dsh\SKILL.md" -Force
Copy-Item "$wb\references\*" "$dsh\references\" -Force
```

**判断副本是否对版**（0.4.x 及以后独有的三个文件，0.3.3 没有）：

| 文件 | 0.3.3 | 0.4.0 |
| --- | --- | --- |
| `references/cooperation.md` | ❌ 无 | ✅ 有 |
| `references/step-and-cache.md` | ❌ 无 | ✅ 有 |
| `references/native-dialogs.md` | ❌ 无 | ✅ 有 |

校验和在各 harness 目录的 `.bsk-source` 里（每个文件一条 sha256）。

> ⚠️ `doctor` 的 `agent skill matches bundled CLI` **只检查它自己管的那一个 harness**。
> DSH 是手工副本不在其列 —— 8/8 全绿也可能意味着 DSH 的文档是错版本。

---

## 6. 和 `poc/verify/` 的分工（不要互相替代）

| 场景 | 工具 | 为什么 |
| --- | --- | --- |
| DNR 规则、扩展加载、SW 生命周期（不需登录态） | `poc/verify/*.cjs`（Playwright） | 全自动，换平台零成本 |
| 真实画质、Hi-Res、`__playinfo__`、Cookie 头（要登录态） | `bsk` | 只能这样 |

`poc/verify/` 里依赖登录窗口的脚本（`e2e-login`、`e2e-scan`、`e2e-vault`、`e2e-dnr-playurl`…）
在无头环境跑不了——`chrome.windows.create` 建窗口会崩，且本来就要人扫码。**这类归 `bsk` 那条线。**

---

## 7. 三个能力边界（都是实测）

### 7a. `network` / `debug` 抓不到早期请求

| 命令 | 上限 | 实测 |
| --- | --- | --- |
| `bsk network` | `--limit` 最大 200 | 视频页加载后，200 条里 `playurl` 已被挤出 |
| `bsk debug requests` | `--limit` 最大 100 | 41 条就 `truncated: true`，全是字体/日志 |

视频页一加载就产生几百个 `.m4s` 分片请求，早期那次 `playurl` 会被挤出去。`--since` 也救不了。

**所以：要验证"某个入口有没有被代理覆盖"，不要抓路径，抓结果。**
主账号非会员（1080P 上限），任何入口下**能播到 1080P 以上**就说明覆盖了（判据见 `docs/03` Q8）。

### 7b. `chrome-extension://` 页面能打开、但读不到

| 动作 | 结果 |
| --- | --- |
| **打开**（`bsk tab create --url chrome-extension://…/login-window.html`） | ✅ 可以 |
| **读取**（evaluate / screenshot / snapshot / observe） | ❌ 一律拒绝 |

> ⚠️ 2026-11-10：**`options.html` 已废除**（ADR 0033 阶段 4），现在只剩
> `popup.html` / `login-window.html` / `need-incognito.html` 三个扩展页面。
> popup 也不能用 `tab create` 打开（它靠 `action` 弹出），所以这条实验只能用
> `login-window.html` 复现 —— 结论不变（`chrome-extension://` 一律读不到）。

判定发生在 **URL 层面**（`permission_denied` + `reason: restricted_tab_url`），只接受 http/https。
`--tab-id` 看着像"可以指定任意标签页"，**但受沙箱约束**；`tab borrow` 也没用。

**替代路径**：

| 目标 | 做法 |
| --- | --- |
| 判据取值（`canPlayType` / `isTypeSupported`） | 在**任意 https 页面**跑同一段表达式 |
| 渲染文本 | 抽成纯函数单测，或写桩页面复现同一份 JSX |
| 扩展页能否打开（有没有白屏） | **只能人眼看** |

⚠️ 「设置页三个分区都能进」这类验收（`01-architecture.md` §9 的 3a）**必须由人点一遍**。

### 7c. 让新构建生效：`reload-extension.mjs`

`edge://extensions/` 的「重新加载」点不到，`chrome.runtime.reload()` 只能由扩展自己调。
所以走第四条路：**让浏览器自己重读那批文件**。

```bash
node poc/probe/reload-extension.mjs              # 构建 → 重载 → 校验（最常用）
node poc/probe/reload-extension.mjs --no-build   # 用现有 .output 重载
node poc/probe/reload-extension.mjs --dry-run    # 只打印判断，不动任何文件
```

**它会强制结束浏览器再重新拉起**（`--dry-run` 除外）。登录态不受影响——cookie 早已落盘。

**五个坑**：

| # | 现象 | 真因 |
| --- | --- | --- |
| 1 | `Preferences` 里 `extensions.settings` 是空的 | 扩展配置在 **`Secure Preferences`** |
| 2 | "浏览器还在跑"恒为真，永远走强杀分支 | `tasklist /FI IMAGENAME eq msedge.exe` **会匹配 `msedgewebview2.exe`**（永不退出）。正确判据是 CSV 第一列**精确等于**进程名 |
| 3 | `taskkill` 不带 `/F` 杀不掉 | Edge 渲染进程拒绝"请求关闭" |
| 4 | `evaluate` 的表达式被截断 | spawn 带了 `shell: true`，`!` 触发历史展开、`"` 被剥掉。**必须 `shell: false`** |
| 5 | 校验报 `no-bsk`（退出码 3）但 daemon 明明在跑 | `BSK_HOME` 被写死成 `~/.bsk-agent`，活动 home 是 `~/.bsk`。已改为优先读环境变量 |

**校验用哪个标签页**：浏览器重启后那个 B站标签页在**用户窗口**里，沙箱只允许操作 Agent Window 内的标签页。

| 办法 | 结果 |
| --- | --- |
| 直接 `evaluate --tab-id` | ❌ `can only act on tabs inside the Agent Window` |
| `tab borrow` | ❌ 要弹确认框，无人值守下报错 |
| **自己 `tab create` 一个** | ✅ 不需要确认，判据一样成立 |

**重载不碰 storage，别为此加备份**：脚本只做「关浏览器 → 重启 → 校验」，不写任何文件。
密钥丢失只有**手动卸载扩展**这一种场景，而开发回归里没人会去卸载（那等于把登录态一起扔掉）。

> 两条硬规矩（换任何脚本都适用）：
> 1. **不要打印密钥内容来"确认备份成功"**，连前缀都不要 —— 数文件和字节数就够。
> 2. 真要做备份，**整目录搬到仓库之外**；`.gitignore` 不能当防线。

---

## 8. 已验证的事实（2026-10-26）

`BV1jt421t7XH`，真实双账号：

| 观测 | 结果 |
| --- | --- |
| `window.__playinfo__` | **不存在**——这是 Pluma 生效的标志（故意移除，逼播放器走 API） |
| `video.videoWidth/Height` | **3840 × 2160**，主账号只有 1080P 权限 |

**判据**：`__playinfo__` 为空 + `videoHeight = 2160` = 成功。
若 `__playinfo__` 还在，说明脚本注入没生效。

> 另有一个更**用户可见**的判据（2026-10-30 加，见 `poc/probe/verify-pgc-by-snapshot.mjs`）：
> 播放进度显示的总时长 > 180 秒 = 播的是完整集，不是试看流。

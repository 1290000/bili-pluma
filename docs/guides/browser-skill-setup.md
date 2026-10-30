# browser-skill（bsk）在本机的配置与坑

> ⚠️ 本文是**本机环境快照**，不是通用安装指南。只记「这台机器上为什么要这样配」。
>
> **它解决什么**：Playwright/CDP 拿不到用户登录态（新 profile 无 cookie），
> 所以真实画质验证一直只能靠人。`bsk` 走扩展 + 本地 IPC，不占调试端口，直接复用当前 profile。

---

## 1. 唯一可用配置（照抄）

```bash
export PATH="/c/Users/<你的用户名>/.local/bin:$PATH"
export BSK_AUTO_START=0

# 必须 run_in_background: true，用默认端口 52800
bsk daemon start --foreground
```

**每个客户端调用都要重复这两行 export**——上一次 shell 的 export 不会带到下一次 tool call。
daemon 空闲 10 分钟退出；需要更长窗口加 `--daemon-idle 2h`。

### ⚠️ 锁定 bsk 0.3.3，**不要升级到 0.4.x**

同一台机器、同一个 B站番剧页的实测对比：

| | 0.3.3 | 0.4.0 |
| --- | --- | --- |
| B站动态页 `evaluate`（读） | ✅ **通** | ❌ 被挡住 |
| B站动态页 `click`/`fill`（写） | ✅ **通** | ❌ 被挡住 |
| 静态页（`example.com`） | ✅ | ✅（要先 `cooperate sync`） |
| 额外要求 | 无 | 每次操作前必须拿单次 `context_id` |

**根因**：0.4.0 的协作上下文模型把 `evaluate` 和所有 `browser mutations` 都划进「单次观测上下文」，
而 B站番剧页持续变化（进度、弹幕、评论），`sync` 与 action 之间必然被判内容已变。
实测连续 10 轮重试全失败，同法在静态页一次通过 —— 是模型与"持续更新页面"的根本冲突。

**这对本项目是致命的**：验收第 5 条（关总开关 → 刷新 → 画质回落）需要真的去拨开关，
0.4.0 下这个操作在 B站页上无法完成。

> 若将来要升级，先验证：B站番剧页播放中能否不带 `--context` 连续 `sync → evaluate → sync → click`。

### 回退到 0.3.3 的步骤

```powershell
$base = "https://github.com/Tencent/BrowserSkill/releases/download"

# 1) CLI（先停 daemon，它占着二进制）
Invoke-WebRequest "$base/cli-v0.3.3/bsk-v0.3.3-x86_64-pc-windows-msvc.zip" -OutFile "$env:TEMP\bsk033.zip"
Expand-Archive "$env:TEMP\bsk033.zip" -DestinationPath "$env:TEMP\bsk033" -Force
Copy-Item "$env:USERPROFILE\.local\bin\bsk.exe" "$env:USERPROFILE\.local\bin\bsk.exe.bak" -Force
Copy-Item "$env:TEMP\bsk033\bsk.exe" "$env:USERPROFILE\.local\bin\bsk.exe" -Force
bsk --version     # 必须 0.3.3

# 2) 扩展（**在 `ext-v0.3.3` 这个 tag，不在 `cli-v0.3.3`**）
Invoke-WebRequest "$base/ext-v0.3.3/browser-skill-extension-v0.3.3-chrome.zip" -OutFile "$env:TEMP\ext033.zip"
Expand-Archive "$env:TEMP\ext033.zip" -DestinationPath "$env:USERPROFILE\.bsk-ext-0.3.3" -Force

# 3) 在 Edge 里手动（bsk 进不去 edge://）
#    edge://extensions → 删掉商店版 → 开发者模式 → 加载解压缩的扩展 → 选 %USERPROFILE%\.bsk-ext-0.3.3

# 4) 起 daemon 并确认 8/8
bsk daemon start --foreground     # 必须 run_in_background
bsk doctor
```

**三条必知**：
1. `cli-v0.3.3` 里**只有 CLI**，扩展在独立的 `ext-v0.3.3` tag。
2. **扩展 ID 会变**（解压加载按路径算）→ vault 密钥失效，**播放账号要重新扫码**。
3. **别跑 `bsk update`**，它会升回 0.4.0。`doctor` 的 `auto-update` 行提示可升级，**忽略**。

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
bsk session start --no-focus --json          # 记下 session_id
bsk navigate --session <id> https://example.com   # 输出 tab=<数字>
bsk evaluate --session <id> --tab-id <数字> "..."
bsk session stop <id>                        # 完成或失败都必须停
```

`evaluate` 的表达式是**位置参数**，不是 `--expression`。
**0.3.3 不需要 `cooperate sync`，也不需要 `--context`**，在持续更新的页面上照样能用。

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

**判断副本是否对版**（0.4.0 独有的三个文件，0.3.3 没有）：

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
| **打开**（`bsk tab create --url chrome-extension://…/options.html`） | ✅ 可以 |
| **读取**（evaluate / screenshot / snapshot / observe） | ❌ 一律拒绝 |

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

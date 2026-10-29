# browser-skill（bsk）在本机的配置与坑

> ⚠️ 本文是**本机环境快照**，不是通用安装指南。通用安装见官方
> `AGENT_INSTALL.md`。这里只记「这台机器上为什么要这样配」——
> 因为踩过三个坑，官方文档没有覆盖这个组合。

**它解决什么**：Playwright/CDP 拿不到用户登录态（新 profile 无 cookie），
所以真实画质验证一直只能靠人。`bsk` 走扩展 + 本地 IPC，不占调试端口，直接复用当前 profile 登录态。

---

## 1. 唯一可用配置（照抄）

```bash
export PATH="/c/Users/<你的用户名>/.local/bin:$PATH"
export BSK_AUTO_START=0
# 2026-10-29 复核：活动 home 是默认 C:\\Users\\<你的用户名>\\.bsk（daemon pid 2044 / 52800）。
# 旧文写的 .bsk-agent 已过时，那个 home 下的 daemon 已不在监听；除非需要隔离，不要再换 home。

# 必须 run_in_background: true，用默认端口 52800
bsk daemon start --foreground
```

**每个客户端调用都要重复这两行 export**——上一次 shell 的 export 不会带到下一次 tool call。

daemon 空闲 10 分钟退出；需要更长窗口加 `--daemon-idle 2h`。

> **2026-10-29 复核**：`bsk doctor` 8/8；活动 home `~/.bsk`；扩展 Edge 156 已连接。下文坑 1/2/3 保留为历史排错记录。

---

## 2. 三个坑（按踩到的顺序）

| # | 错误 | 真实原因 | 解法 |
| --- | --- | --- | --- |
| 1 | `os error 5 拒绝访问` | daemon 的命名管道用 Windows 默认安全描述符，**只有启动它的账户能打开** | 换 `BSK_HOME`，让 daemon 由自己启动 |
| 2 | `os error 10048` | 新 daemon 默认也用 52800，与旧 daemon 撞端口 | `--port 52901` 错开 |
| 3 | `EADDRINUSE` | 想用默认 52800，旧 daemon 还占着 | 旧 daemon 必须由**启动它的那个终端**停 |

**教训**：每次拿到新错误码都要重新读它。第 1 步很容易误判成"ACL 无解"，
实际换 home 就过了；真正的拦路虎是第 2 步的端口冲突，而且是完全不同的错误码。

---

## 3. 验证：doctor 必须 8/8 全绿

```bash
bsk doctor
```

```
ok  bsk home writable / agent skill (workbuddy) / daemon running pid … @52800
ok  daemon local process identity / protocol compatible / auto-update
ok  extension connected  1 browser(s) connected      ← 关键这一行
ok  browser protocol compatible
```

只有第一条 `agent skill` 报 `N/A` 时说明 skill 没装到 WorkBuddy：
`bsk install-skill --harness workbuddy`，然后**开新会话**才能被发现。

---

## 4. 一次最小任务

```bash
bsk session start --no-focus --json          # 记下 session_id
bsk navigate https://example.com --session <id>
bsk observe --session <id>                   # 语义树，不是截图
bsk session stop <id>                        # 完成或失败都必须停
```

`evaluate` 的表达式是**位置参数**，不是 `--expression`：

```bash
bsk evaluate --session <id> "JSON.stringify({w: document.querySelector('video')?.videoWidth})"
```

---

## 5. 平台限制：`browser-skill` 只装在这几处

`bsk install-skill --list` 支持 12 个 harness（Codex / Claude Code / Cursor / CodeBuddy / WorkBuddy / Pi / Hermes / Kimi…），**其中没有 DSH**。
本机目前：
- WorkBuddy：`C:\Users\<你的用户名>\.workbuddy\skills\browser-skill\`（`bsk install-skill` 管理）
- **DSH**：`C:\Users\<你的用户名>\.dsh\skills\browser-skill\`（手工副本；`skill-filesystem` 会自动扫描 `$DSH_HOME/skills`）

换 Agent 平台（Cursor / Claude Code / Codex…）要重跑：

```bash
bsk install-skill --harness cursor
```

**但 CLI 与 daemon 是共用的**——换平台只需重装 skill 文件，daemon 配置不用动。
DSH 副本的更新方式：bsk 升级后重新复制 `SKILL.md` + `references/` 到 `~/.dsh/skills/browser-skill/`。

---

## 6. 和 `poc/verify/` 的分工（不要互相替代）

| 场景 | 工具 | 为什么 |
| --- | --- | --- |
| DNR 规则、扩展加载、SW 生命周期（不需要登录态） | `poc/verify/*.cjs`（Playwright） | 全自动，**换平台零成本** |
| 真实画质、Hi-Res、`__playinfo__`、Cookie 头（要登录态） | `bsk` | 只能这样 |

`poc/verify/` 里依赖登录窗口的脚本（`e2e-login`、`e2e-scan`、`e2e-vault`、
`e2e-dnr-playurl`…）在无头环境跑不了——`chrome.windows.create` 建窗口会崩，
且它们本来就要人扫码。**这类归 `bsk` 那条线。**

已实测可跑（2026-10-26，`POC_HEADLESS=1`）：`check-urlfilter.cjs`。
其余 16 个已从 `playwright` 改为 `playwright-core`，但多数仍卡在登录窗口。

---

## 7. 抓不到早期请求：`network` / `debug` 都是小容量环形缓冲

| 命令 | 上限 | 实测 |
| --- | --- | --- |
| `bsk network` | `--limit` 最大 **200**（扩展侧硬上限） | 视频页加载后读，200 条里 `api.bilibili.com` 只剩 6 条，`playurl` 已被挤掉 |
| `bsk debug requests` | `--limit` 最大 **100** | 录制一个视频页，41 条就 `truncated: true`，全是字体/日志/文档，**没有 `playurl`** |

原因很直接：视频页一加载就产生几百个 `.m4s` 分片请求，**早期那次 `playurl` 会被挤出去**。
`--since` 游标也救不了——缓冲本身就只有那么大。

**所以：要验证"某个入口有没有被代理覆盖"，不要抓路径，抓结果。**

主账号是**非会员**（1080P 上限），所以任何入口下**能播到 1080P 以上**就说明覆盖了。
判据写在 `docs/03-open-questions.md` Q8。

> 如果将来确实需要看路径（比如要加白名单），办法是在**页面里**用 `bsk evaluate`
> 装一个 hook 再触发请求 —— 但那只对"不重新加载页面"的操作有效（切 P、悬停），
> 对整页跳转无效。

---

## 7a. `chrome-extension://` 页面 **能打开、但 bsk 读不到**（2026-10-26 逐个命令实测）

想验证扩展自己的页面（options / popup）渲染得对不对时，会自然想到
`bsk evaluate --tab-id <扩展页>`。**这条路走不通，而且不是"换个命令就好"。**

### 先分清两件事（我一开始混了）

| 动作 | 结果 |
| --- | --- |
| **打开**扩展页（`bsk tab create --url chrome-extension://…/options.html`） | ✅ **可以**。会正常跑起来，`tab list` 里标题是「Pluma 设置」 |
| **读取**扩展页（evaluate / screenshot / …） | ❌ **一律拒绝** |

所以看到"扩展页明明加载出来了"是对的 —— 限制在**读取**这一侧，
不在能否打开。把这两件事混起来会得出"扩展页打不开"的错误结论。

另外：页面虽能打开，**展开挂载的时机可能比你读的时候晚**。`tab create` 之后
立刻 `tab list` 会看到 `url=<pending>`，等 1–2 秒才是真实标题。
**别把 `url=<pending>` 当成"没加载"。**

### 错误长什么样

`evaluate` / `get-html` / `snapshot` / `observe` 报的是：

```
error: operation denied by the Agent Window sandbox
details: tool.evaluate cannot access tab … because its URL is
         chrome-extension://<id>/options.html; navigate the Agent Window to a web page first
```

`screenshot` 报的是另一个码，**这个 `reason` 是决定性证据**：

```json
{ "code": "permission_denied", "data": { "reason": "restricted_tab_url" } }
```

`restricted_tab_url` 说明判定发生在 **URL 层面**，之后所有工具被同一个闸门挡住。

### 已经排除的几种"以为是原因"的解释

**前两条是我先猜错的方向，实际都不是原因**：

| 猜测 | 实测结果 |
| --- | --- |
| "扩展模块不能从普通页面 import，是 CSP/跨源限制" | ❌ **不是**。报错时页面是 `https://www.bilibili.com`，普通网页里没有 `chrome.runtime`，`import()` 当然失败。那是**方法用错** |
| "要先 `bsk tab borrow` 借过来" | ❌ **不是**。借了照样报同一个错 |
| **真原因：沙箱 URL 白名单** | ✅ 只接受 http/https，`chrome-extension://` 一律拒绝 |

`bsk evaluate --help` 里有个 `--tab-id`，看着像"可以指定任意标签页"，
**但它受沙箱约束**，对扩展页无效。

### 那怎么验扩展页

逐个命令实测：

| 命令 | 结果 |
| --- | --- |
| `evaluate` / `get-html` / `snapshot` / `observe` | ❌ `operation denied by the Agent Window sandbox` |
| `screenshot --tab-id` | ❌ `permission_denied`，`reason = restricted_tab_url` |
| `debug pages` | ❌ 只列**录制目标**，不是全上下文清单 |

### 实际可用的替代路径

| 目标 | 可行做法 |
| --- | --- |
| 确认**判据取值**正确（如 `canPlayType` / `isTypeSupported`） | 在**任意 https 页面**跑同一段表达式——这些 Web API 与扩展上下文无关 |
| 确认**渲染文本**正确 | 抽成纯函数单测；或写桩页面复现同一份 JSX |
| 确认扩展页**真能打开**（有没有白屏） | **只能人眼看**：`edge://extensions` 点「扩展选项」，或点工具栏图标看 popup |
| 让扩展页**把数据送出来** | 要改产品代码（`postMessage`），成本高于收益，**不建议为测试这么做** |

⚠️ 「设置页三个分区都能进」这类验收（`01-architecture.md` §9 的 3a）**必须由人点一遍**。

### 记一笔

1. **报错信息要先读完再猜原因。** 第一版报错里已经写着 `because its URL is
   chrome-extension://…`，我却先按"CSP/跨源"解释，方向全错。
2. **`hint` 可能是误导项。** 那句"先 borrow"只对**普通** user 标签页成立；
   对扩展页，borrow 完照样被拒。**信 `details` 和 `reason`，不要盲信 hint。**

---

## 7b. 让新构建生效：`reload-extension.mjs`（2026-10-29）

改完代码要验证，必须让浏览器用上新构建。`edge://extensions/` 上的「重新加载」点不到
（`edge://` 被沙箱按 URL 挡掉，**连截图都拿不到**，所以也没有"点一下"这种取巧），
`chrome.runtime.reload()` 又只能由扩展自己调。所以写了个脚本走第四条路：
**让浏览器自己重读那批文件**。

```bash
node poc/probe/reload-extension.mjs              # 构建 → 重载 → 校验（最常用）
node poc/probe/reload-extension.mjs --no-build   # 用现有 .output 重载
node poc/probe/reload-extension.mjs --dry-run    # 只打印判断，不动任何文件
```

**它会强制结束浏览器再重新拉起**（`--dry-run` 除外）。登录态不受影响 —— cookie 早就落盘了。

### 四个坑（都是实测，改之前先看）

| # | 现象 | 真因 |
| --- | --- | --- |
| 1 | `Preferences` 里 `extensions.settings` 是空的 | 扩展配置在 **`Secure Preferences`**。只读前者会得出"一个扩展都没装" |
| 2 | "浏览器还在跑"恒为真，永远走强杀分支 | `tasklist /FI IMAGENAME eq msedge.exe` **会匹配 `msedgewebview2.exe`**（WebView2 宿主，永不退出）。正确判据是 CSV 第一列**精确等于**进程名 |
| 3 | `taskkill` 不带 `/F` 杀不掉 | Edge 渲染进程拒绝"请求关闭"，回的是"只能强制终止该进程 /F" |
| 4 | `evaluate` 的表达式被截断，报 `unexpected argument` | spawn 带了 `shell: true`，`!` 触发历史展开、`"` 被剥掉。**必须 `shell: false`** |

### 校验用哪个标签页

浏览器重启后那个 B站标签页在**用户窗口**里，而沙箱只允许操作 Agent Window 内的标签页：

| 办法 | 结果 |
| --- | --- |
| 直接 `evaluate --tab-id` | ❌ `can only act on tabs inside the Agent Window` |
| `tab borrow` 借过来 | ❌ **要弹确认框**（`borrow_confirmation: always`），无人值守下报 `could not display a confirmation request` |
| **自己 `tab create` 一个** | ✅ 不需要确认，判据一样成立 |

### 重载**不碰** storage —— 别为此加备份

`reload-extension.mjs` 只做「关浏览器 → 重启 → 校验」，**不写任何文件**。
**扩展的 storage 目录一个字节都不动**（扩展 ID 由 `.output/chrome-mv3` 的绝对路径决定，路径不变 ID 就不变）。

密钥丢失只有一种场景：**手动卸载扩展**（Chromium 会清空 `Local Extension Settings/<id>/`，
里面有 `pluma:vault:key`）。这件事在开发回归里不会发生 —— 没人会为了测 bug 去卸载扩展，
那等于把登录态也一起扔掉。

所以**这里不提供备份脚本**。曾经写过一个，后来整段删除，理由值得记：

> 它是为一个不存在的场景写的。为了让它「能用」，先后修了 5 处问题
> （判据写成 `pluma:vault:` 太宽、`EBUSY` 假判据、`LOCK` 可打开假判据、
> 备份排在关浏览器之前导致必然失败、`alloc(4MB)` × N 的内存浪费）。
> **一个不存在的需求，修多久都是负收益。**

两条要留下的教训（换成别的脚本也一样适用）：

1. **不要打印密钥内容来"确认备份成功"**，连前缀都不要 —— 数文件和字节数就够。
   （2026-10-29 我用 `head -c 20` 看了一眼，等于把密钥搬进了聊天记录。）
2. 真要做备份，**整目录搬到仓库之外**，不要把一个秘密从它的沙箱里提取成单独文件。
   `.gitignore` 不能当防线。

---

## 8. 已验证的事实（2026-10-26）

`BV1jt421t7XH`，真实双账号：

| 观测 | 结果 |
| --- | --- |
| `window.__playinfo__` | **不存在**——这是 Pluma 生效的标志（故意移除，逼播放器走 API） |
| `video.videoWidth/Height` | **3840 × 2160**，主账号只有 1080P 权限 |
| 4K 结论 | 请求级代理确实生效 |

**判据**：`__playinfo__` 为空 + `videoHeight = 2160` = 成功。
若 `__playinfo__` 还在，说明脚本注入没生效。

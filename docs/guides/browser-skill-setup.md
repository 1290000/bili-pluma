# browser-skill（bsk）在本机的配置与坑

> ⚠️ 本文是**本机环境快照**，不是通用安装指南。通用安装见官方
> `AGENT_INSTALL.md`。这里只记「这台机器上为什么要这样配」——
> 因为踩过三个坑，官方文档没有覆盖这个组合。

**它解决什么**：Playwright/CDP 拿不到用户登录态（新 profile 无 cookie），
所以真实画质验证一直只能靠人。`bsk` 走扩展 + 本地 IPC，不占调试端口，直接复用当前 profile 登录态。

---

## 1. 唯一可用配置（照抄）

```bash
export PATH="/c/Users/<USER>/.local/bin:$PATH"
export BSK_HOME="C:\\Users\\<USER>\\.bsk-agent"   # 必须换 home，见坑 1
export BSK_AUTO_START=0

# 必须 run_in_background: true，用默认端口 52800
bsk daemon start --foreground
```

**每个客户端调用都要重复这两行 export**——上一次 shell 的 export 不会带到下一次 tool call。

daemon 空闲 10 分钟退出；需要更长窗口加 `--daemon-idle 2h`。

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

`bsk install-skill --list` 支持 12 个 harness。**本机目前只装了 `workbuddy`**：

```
C:\Users\<user>\.workbuddy\skills\browser-skill\
```

换 Agent 平台（Cursor / Claude Code / Codex…）要重跑：

```bash
bsk install-skill --harness cursor
```

**但 CLI 与 daemon 是共用的**——换平台只需重装 skill 文件，daemon 配置不用动。

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

## 7. 已验证的事实（2026-10-26）

`BV1jt421t7XH`，真实双账号：

| 观测 | 结果 |
| --- | --- |
| `window.__playinfo__` | **不存在**——这是 Pluma 生效的标志（故意移除，逼播放器走 API） |
| `video.videoWidth/Height` | **3840 × 2160**，主账号只有 1080P 权限 |
| 4K 结论 | 请求级代理确实生效 |

**判据**：`__playinfo__` 为空 + `videoHeight = 2160` = 成功。
若 `__playinfo__` 还在，说明脚本注入没生效。

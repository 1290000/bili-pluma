# ADR 0036：自动更新 —— 远程**版本查询** + 自我写入

- 日期：2026-11-16
- 状态：**已采纳**（2026-11-15 用户提出需求并逐条拍板；本 ADR 记录边界）
- 影响文件：`src/shared/constants/update.ts`、`src/core/update/**`、`src/platform/update/**`、
  `entrypoints/update/**`、`wxt.config.ts`（host 权限）、`src/content/panel/**`（第 5 个 Tab）
- 相关：[ADR 0018](./0018-ship-built-artifacts.md)（分发方式**不变**）、
  [ADR 0001](./0001-use-mv3-pure-extension.md)（纯 MV3，**不引入 native host**）
- 方案：[docs/plans/2026-11-15-auto-update-plan.md](../plans/2026-11-15-auto-update-plan.md)
- 证据：Step 0 探针（落盘产物 `.output/chrome-mv3/probe-*.json`，已随 rebuild 清理；
  结论留档在方案 Step 0 表里）

---

## 背景

`AGENTS.md` 决策 6 原文是「**不做远程配置**，只本地版本号 + 升级提示」。
这条决策的完整理由在 [03-open-questions](../03-open-questions.md) Q15：为了省一次发版
去引入"从网络拉配置"这个新的安全与隐私面，不划算。

但现实是：**用户根本不知道有新版本**。不上架商店 ⇒ 浏览器从不比较版本号；
zip 靠手动下载手动替换 ⇒ 没有任何自动升级机制。2026-11-15 用户明确要求做一套简化的
自动更新，并说明「以这些需求优先」。

## 决策

**只加"版本查询"，不加"配置下发"。** 两件事必须分开看：

| | 远程配置（仍然不做） | 远程版本查询（本 ADR 允许） |
| --- | --- | --- |
| 拉什么 | **行为**（白名单、开关、文案） | **一个版本号 + 一个下载地址** |
| 谁能改行为 | 仓库的提交者 | 没有人 —— 改不了任何本地行为 |
| 泄露面 | 拉取行为本身泄露"我在用什么版本/哪些功能" | 一次 GET，无凭据，`credentials: 'omit'` |

具体边界：

```
允许：GET https://api.github.com/repos/<owner>/<repo>/releases/latest
      只读 tag_name / assets[] / published_at
      带 If-None-Match 条件请求（省 60/h 配额）
禁止：任何形式的配置拉取、任何远程开关、任何"从网络决定行为"的逻辑
必须：失败一律静默（限流 / 断网 / 解析失败都不打扰用户）
```

**更新动作**：用户点「立即更新」→ 独立扩展窗口 → `showDirectoryPicker` 授权一次目录 →
下载**精简包**（约 283 KB）→ 零依赖解压 → 白名单校验 → 逐文件写入并回读 size →
**收尾**：

1. 显示「已写入 N 个文件，正在重新加载扩展…」，停留 800ms（否则这句一帧都画不出来）
2. 更新页发 `update/reload` 给 SW，**不再自己 reload**
3. SW 关掉更新窗口（`tabs.query` 按 `update.html` 现查窗口 → `windows.remove`）
4. SW 延后 150ms `runtime.reload()`（让窗口移除先生效）
5. 重载后 SW 启动时 `checkPendingUpdate()` 核对版本；B站 页面上面板自动提示刷新

⚠️ 第 3、4 步**只能由 SW 做**（2026-11-17 真机缺陷）：页面先 `window.close()` 则随后的
`reload()` 不会执行；页面先 `reload()` 则页面先死、**没人关窗**，Chrome 会把那个
440×600 的 popup 填成**空白新标签页**。SW 在 reload 生效前还活着，所以由它依次做这两件事。

## 为什么不用别的路

| 方案 | 否决理由 |
| --- | --- |
| Native messaging / 本地 helper | 要写注册表 + 一个进程外组件，违反 [ADR 0001](./0001-use-mv3-pure-extension.md)（纯 MV3） |
| 自托管 `crx` + `update_url` | Windows 上非商店来源的扩展会被禁用；且本项目是 **unpacked** 加载，根本不进浏览器的更新管理器 |
| 只做"下载 zip + 三步引导手动替换" | 用户明确要求「无需手动解压和替换」。可作为 FS 路径不可用时的降级，但不是主路径 |
| 照抄 Ghost Downloader 的做法 | 它是桌面进程，`copy` 就能写盘；扩展没有"写自己安装目录"的 API。**做法搬不过来，只能搬思路** |

## 代价（必须写在明处）

1. **一次目录授权**。用户在更新窗口里选一次 Pluma 所在目录。
2. **权限不保证跨文档持久**。Step 0 实测：同一份句柄上 `queryPermission` 会在
   `granted` / `prompt` 之间摆动。所以每次更新**最多多点一次「允许编辑文件？」**
   —— 「一次授权」指的是选目录那一次，不是"以后永不再问"。
3. **没有签名校验**。我们下载并执行的是**自己 Release 的产物**，中间人可以同时改
   zip 与站点。CRC32 + 路径白名单 + 顶层白名单能挡"包结构不对"，**挡不住蓄意替换**。
   **这不是安全机制**，是本项目对自己分发物的便利通道。
4. **新增 3 条 host 权限**：`api.github.com`、`github.com`、`*.githubusercontent.com`
   （最后一条是资产下载与头像）。unpacked 扩展 reload 时不弹权限对话框，
   但用户应当能在 README 里读到为什么需要连 GitHub。

## 后果

- `AGENTS.md` 决策 6 的措辞需要订正为「不做远程**配置**；允许远程**版本查询**」
- 新增第 5 个面板 Tab「关于」，版式与文案判据见 [02-ui-spec](../02-ui-spec.md) §5.3
- 自动检查默认**开**、间隔 **1 天**、可在面板关闭（关掉只停自动发起，手动照常）
- 贡献者清单**构建期生成**（`scripts/gen-contributors.mjs`），运行时零请求
- CHANGELOG 需要一条 `### 新增`：面板多一个「关于」Tab，可在里面检查并安装更新

## 没有改变的事

| 项 | 状态 |
| --- | --- |
| 不上架商店 | **不变**（[ADR 0018](./0018-ship-built-artifacts.md)） |
| 只发 zip（含带源码版） | **不变** |
| 纯 MV3、不做桌面端 | **不变**（[ADR 0001](./0001-use-mv3-pure-extension.md)） |
| 不做远程配置 | **不变**（本 ADR 只放开了版本查询） |
| 不提供绕过付费墙的能力 | **不变** |

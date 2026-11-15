# 自动更新方案（2026-11-15）

> 📝 **草案** —— 待用户拍板。本方案**未动任何业务代码**，只做了 §1.1 的实测。
>
> 批准后按 §3 顺序实施，**Step 0 是硬门**——探针不过，后面全部作废。
>
> 需求来源：用户 2026-11-15 口述（版本检测 / 轻量提示 / 面板更新专区 / 一键更新 / 关于 tab /
> 输出方案），并追加一条：**自动检查更新要有开关，默认开启**。用户同时说明：
> **以这些需求优先，不必再迁就「不做远程配置」那条**；但「不做桌面端」仍然有效 ⇒
> 本方案不引入 native host、不引入任何进程外组件。
>
> 2026-11-15 23:58 用户已拍板三件事，见 §7（已从"待确认"改为"已定"）。

---

## 0. 结论先行

1. **能做，但"一键更新"必须付一次授权代价**：用户要手动指定**一次**扩展所在目录
   （`showDirectoryPicker`），句柄存进 IndexedDB 长期复用。
   ⚠️ 但权限**不保证**跨页面加载保留（Step 0 实测）：最坏情况下每次更新多点一次
   「允许编辑文件？」，**不用重选目录**。
2. **Ghost Downloader 的做法搬不过来**，别照着抄。它是桌面进程，天然有文件系统权限；
   扩展没有"写自己安装目录"的 API。可比的只有三种路径，见 §1.2。
3. **建议只加 1 个 tab（「关于」）**，更新区放在它顶部，不为"更新"单开 tab。理由与反方案见 §4。
4. **自动检查有开关，默认开**。开关只切"自动发起检查"这一件事 —— 关掉之后手动「检查更新」照常可用，
   已知有新版本的角标也照常显示（§6.3）。别把开关做成"整个更新功能停用"。

---

## 1. 约束与技术底牌

### 1.1 实测数据（2026-11-15，本机）

| 事实 | 读数 | 对方案的影响 |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/releases/latest` | `200`，0.8s，`tag_name=v1.1.0` | 版本检测走这个接口，只读 `tag_name` + `assets` |
| 未认证限流 | `60/h`（实测时已用 7，剩 53） | **每天一次 × 共享出口 IP 会撞限流** ⇒ 必须容错 + 静默失败，见 §5 |
| `pluma-1.1.0.zip` | **289,831 B（283 KB）** | 全量下载重写完全可行，不需要增量/补丁 |
| `pluma-<v>-with-source.zip` | 3,255,191 B | **不使用**，只取精简包（结构平铺，`manifest.json` 在根） |
| `DecompressionStream('deflate-raw')` | Node 22.22 可用 | **零依赖解 zip**，且能在 vitest 里跑 ⇒ 核心解压逻辑可被单测覆盖 |

### 1.2 三条"写入自身安装目录"的路径

| 方案 | 可行性 | 结论 |
| --- | --- | --- |
| **File System Access API**（`showDirectoryPicker` + `FileSystemDirectoryHandle`） | 扩展页面里可用；用户授权一次后句柄可持久化 | ✅ **采用** |
| Native messaging / 本地 helper | 要写注册表 + 一个桌面进程 | ❌ 违反"不做桌面端"；且杀软观感极差 |
| 自托管 `crx` + `update_url` + `chrome.runtime.requestUpdateCheck()` | Windows 上非商店来源的扩展会被禁用；且本项目是 **unpacked** 加载，根本不进更新管理器 | ❌ 走不通（不是没试，是机制上不成立） |

> 为什么不能像 Ghost Downloader 那样"下完直接替换"：桌面进程用 `shutil`/`NSFileManager` 就能写盘，
> 扩展没有等价能力。**FS Access 是这个约束下唯一的一等公民方案**，代价是一次目录授权。

### 1.3 一键更新必须发生在**扩展页面**，不能在面板里

面板是注入 `bilibili.com` 的 content script（`entrypoints/content-panel.content.ts`）。在那里调
`showDirectoryPicker` 会落在**页面 origin**：句柄无法可靠持久化，IndexedDB 也是 B 站的 —— 语义上错，
而且等于把"能改写扩展目录"的句柄交给网页域。

所以走独立扩展窗口 **`update.html`**，与现有 `entrypoints/login-window/` 完全同一套做法
（`chrome.windows.create` 开小窗，关窗即止）。它天然是 `chrome-extension://` 源，有完整扩展权限。

---

## 2. 整体架构

```
触发层（SW 启动 / 面板打开）
  └→ gate.shouldCheck(now, state, intervalDays, autoEnabled)      在飞 ≤ 1
       └→ 检查层 platform/update/github.ts
            GET releases/latest（ETag 条件请求）→ LatestRelease
              └→ 状态层 core/update/{version,gate,state}.ts
                   全是纯函数；autoCheckEnabled 也在同一个 updateState 里
                     ├→ 提示层（面板「关于」tab）
                     │    红点 / 顶部提示条（可关）/ action badge（可选）
                     │    ⚠️ 提示只由"已知有新版本"驱动，与自动开关无关
                     └→ 执行层（扩展页面 update.html）
                          ① ensureHandle 选目录（一次，句柄存 IndexedDB）
                          ② 下载 zip（fetch → ArrayBuffer，283 KB）
                          ③ 解压 core/update/zip.ts（零依赖 deflate-raw）
                          ④ 白名单 + 路径校验 core/update/plan.ts
                          ⑤ 逐文件写入 + 复核 size platform/update/writer.ts
                          ⑥ chrome.runtime.reload()
                               └→ 自检层（SW 启动时）
                                     getManifest().version === pendingUpdate.to ?
                                     是 → 成功；否 → 报"目录选错了"
```

新增/改动文件一览（**实施时的唯一清单**）：

```
新增
  src/shared/constants/update.ts        仓库坐标、API 地址、默认间隔、文件白名单
  src/core/update/version.ts            compareSemver / isNewer（纯函数）
  src/core/update/gate.ts               shouldCheck / nextCheckAt（纯函数）
  src/core/update/state.ts              UpdateState 类型 + 纯 reducer
  src/core/update/zip.ts                ZIP 中央目录解析 + deflate-raw 解压（纯函数）
  src/core/update/plan.ts               zip 条目 → 写入计划（白名单/路径校验）
  src/platform/update/github.ts         fetch releases/latest（ETag）
  src/platform/update/writer.ts         FS Access 写入（唯一碰句柄的地方）
  src/platform/update/state-store.ts    chrome.storage 实现
  src/background/handlers/update.handler.ts   消息入口
  entrypoints/update/{index.html,main.ts,style.css}
  scripts/gen-contributors.mjs          构建期生成贡献者清单
  src/generated/contributors.json       生成物（提交入库，避免运行时请求）

改动
  wxt.config.ts                         host_permissions 增 3 条
  src/shared/types/messages.ts          UPDATE_* 消息类型（漏处理不报错，靠 check-messages 兜）
  src/content/panel/tabs.ts             第 5 个 tab「关于」
  src/content/panel/sidebar.ts          tab 栏容纳 5 格（已有注释算过 48px 够）
  src/background/index.ts               注册 handler + 启动时自检
  docs/02-ui-spec.md                    「关于」tab 的版式与文案规则
  docs/decisions/0036-auto-update.md    新 ADR（远程版本查询 + 自我写入，改了旧决策 6）
```

---

## 3. 分步实施

每步都是**可独立验收**的；判据写在"完成判据"里，没有判据的步骤不许标完成。

### Step 0 · 探针（硬门，先做，不做完不许写业务代码）

**✅ 已完成（2026-11-16 00:26）。** 探针页是 `entrypoints/probe-fs/`（临时，验完即删），
判据全部落盘，不靠页面显示。原始产物在 `.output/chrome-mv3/probe-*.json`（rebuild 会清掉）。

| # | 要证的事 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 扩展页里 `showDirectoryPicker({mode:'readwrite'})` 能弹并返回句柄 | ✅ | `probe-1-*.json` 的 `dirName: chrome-mv3` |
| 2 | `requestPermission` 能拿到 `granted` | ✅ | 同文件 `permission: granted` |
| 3 | 写入后回读 size 成功 | ✅ | 回读 **190 字节**，文件真实存在于扩展目录 |
| 4 | 句柄序列化进 IndexedDB | ✅ | 真实 profile 的 `Local Extension Settings/<id>/` LevelDB 里能 grep 到 `pluma-probe` / `chrome-mv3` |
| 5 | **重开文档后句柄仍可用** | ✅ | `probe-autoload-*.json` 的 `handleFromIndexedDb: true` |
| 6 | **重开文档后权限仍是 granted** | ⚠️ **不稳定** | 观察到 `granted` / `prompt` 交替，见下面的「唯一实质修正」 |
| 7 | reload 后扩展仍可用 | ✅ | reload 之后页面仍能加载、`chrome.storage.local` 仍能写、`disable_reasons` 为空 |

#### ⚠️ Step 0 挖出来的唯一实质修正：权限不保证持久

`queryPermission` 在**同一份句柄**上，不同次加载会返回不同结果：

```
PROBE_PERM_granted      ← 刚用 picker 授权完（带用户手势）
PROBE_PERM_granted      ← 下一次加载，写文件成功
PROBE_PERM_prompt       ← 再一次加载，权限退回 prompt
PROBE_PERM_NOT_GRANTED  ← 最近一次加载，写不出文件
```

**结论：句柄可以"一次选中、长期复用"，但权限是"每次访问都可能要再确认一次"** ——
这和 Chromium 对普通页面的 File System Access 语义一致：跨文档持久的是 *handle*，
不是 *permission*（PWA / Installed 才有跨启动持久化）。

**对实现的三个硬约束**（Step 5 已按此改写）：

1. `ensureHandle()` **不许**假定 `queryPermission === 'granted'`。每次都先查，不是 `granted`
   就在**用户点击的事件处理器里**调 `requestPermission()`（必须有 transient activation，
   放在 `autoProbe` 那种无手势的路径里会直接抛 `SecurityError`）。
2. 最坏情况的用户体验是：点「立即更新」后多一次「允许编辑文件？」确认 —— **不是重选目录**。
   所以"一次目录授权"仍然成立，只是"一次"指的是**选目录**，不是"以后永不再问"。
3. 别把 `requestPermission` 放在页面加载时自动跑。那不是优化，是必然失败。

### Step 1 · 纯逻辑层（可单测，无 IO）

- `version.ts`：`compareSemver('1.10.0', '1.9.9') > 0`。**别用字符串比较**（会得出 1.9.9 > 1.10.0）。
  只接受 `\d+\.\d+\.\d+`，非法输入抛错而不是返回 0。
- `gate.ts`：`shouldCheck(now, state, intervalDays, autoEnabled)`。语义见 §6.1 与 §6.3。
  `autoEnabled === false` 必须**先于**间隔判断返回 `false`（顺序错了会把开关写成摆设）。
- `state.ts`：`idle | available | dismissed | downloading | writing | pending-reload | failed`。
- `zip.ts`：解析 EOCD → 中央目录 → 本地文件头 → `deflate-raw` 解压。**零依赖**（§1.1 已验证）。
- `plan.ts`：条目 → 写入计划。**拒绝** `..`、绝对路径、不在白名单里的顶层项。

完成判据：`tests/` 下新增单测，含一个真实 release zip 的 fixture（283 KB，入库前先确认
`secrets` 检查通过）；**每条判据配一条反向用例**（把白名单删掉一条，测试必须变红）。

### Step 2 · 检查器（平台层）

- `github.ts`：`fetch` `releases/latest`，带 `Accept: application/vnd.github+json`、`If-None-Match`（ETag）。
  只读 `tag_name` / `assets[name=pluma-<v>.zip]`。**不解析 body**，不做 markdown 渲染。
- 结果缓存：`state.lastCheckAt`、`state.etag`、`state.latest`。
- 失败分三类：网络错（静默，`lastCheckAt` 不更新，下次再来）、`304`（更新 `lastCheckAt` 但无新版本）、
  `403/429`（限流 —— **不写"无新版本"**，只延后，见 §5）。

完成判据：把 `shouldCheck` 的闸门改成恒 `false`，单测必须变红（否则等于没测）。

### Step 3 · 面板提示（轻量，不打断）

- 「关于」tab 标签上加**红点**（不是数字角标 —— 数字会让人以为是消息数）。
- 面板顶部一条 12px 高的提示条：「v1.2.0 可用 · 查看」，点进「关于」tab；带「×」，
  关掉即写 `state.dismissed = <version>`，**同一版本不再提示**，下个版本重新提示。
- 可选：`chrome.action.setBadgeText({ text: '•' })`，用户点过即清。
- **提示只由"已知有新版本"驱动，与自动检查开关无关**：关掉开关后不会自己发起检查，但用户手动点了
  「检查更新」发现新版本，角标/提示条照常出现（否则用户会觉得"手动查了也白查"）。

完成判据：真机截图（有更新 / 已关闭 / 无更新 三态）+ 关掉后重开面板不再出现；
再加一条：**关掉自动开关 + 手动检查发现新版本 ⇒ 角标必须出现**。

### Step 4 · 更新专区 UI（「关于」tab 内）

版式固定成三行（窄面板里纵向堆，不做两列）：

```
① 当前 v1.1.0 · 最新 v1.2.0 · 上次检查 3 分钟前
② [检查更新]                       自动检查 ●━
③ [立即更新]   [GitHub Releases ↗]
```

| 控件 | 行为 | 注意 |
| --- | --- | --- |
| 版本行 | 只读 | 时间用相对说法（"3 分钟前"），不显示绝对时间戳 |
| **检查更新** | 忽略闸门，冷却 60s | 冷却中置灰并说明理由，不要静默无反应；**冷却与自动开关无关** |
| **自动检查** 开关 | 写 `state.autoCheckEnabled`，默认 `true` | 关掉的只是"自动发起"；文案不要写成"启用更新检查"（会让人以为手动也失效） |
| **立即更新** | 打开 `update.html` 窗口 | **与下面那个入口完全独立**，不许合并成一个"去更新" |
| **跳转 Releases** | `chrome.tabs.create` 打开 `…/releases` | 纯外链，不下载、不设状态 |

完成判据：五个控件在"无新版本 / 有新版本 / 正在更新"三态下的可用性与文案表（含开关关闭态），
写进 `docs/02-ui-spec.md`。

### Step 5 · 一键更新执行（核心）

`update.html` 内的顺序，**任一步失败都不许进下一步**：

1. `ensureHandle()`：有句柄 → `queryPermission`；不是 `granted`（**包括 `prompt`**）→
   在**这个点击的手势里**调 `requestPermission`。只有 `denied` 或没有句柄时才 `showDirectoryPicker`。
   ⚠️ 依据见 Step 0 的「唯一实质修正」：句柄持久、权限不持久，**绝不能假定 `granted`**。
2. **校验选的是哪个目录**：读该目录的 `manifest.json`，要求 `name` 含 `Pluma`、`version` 合法。
   这一步只能"排掉明显选错的"，**不能证明就是当前加载的那个** —— 真正的判据在 Step 6。
3. 下载：`fetch(zipUrl)` → `arrayBuffer`。进度按 `content-length` 算；**实测包只有 283 KB**，
   进度条可以做，但不要为它引入复杂度（直接显示"下载中 283 KB"也够）。
4. 解压 + 生成写入计划（Step 1 的 `plan.ts`）。
5. 写入：递归 `getDirectoryHandle(..., { create: true })`，逐个 `createWritable()` 写入；
   每个文件写完 `getFile()` 复核 `size`。**全部成功才继续**。
6. 写 `state.pendingUpdate = { from, to, at }`，然后 `chrome.runtime.reload()`。

完成判据：真机从 1.1.0 更新到一个**真实新版本**（先手工发一版 1.1.1 练手，别拿未发布的本地构建验）。

### Step 6 · 更新后自检（这条是"防选错目录"的唯一硬判据）

SW 启动时：若 `state.pendingUpdate` 存在且 `getManifest().version === pendingUpdate.to`
→ 成功：清 `pendingUpdate`，写 `state.lastApplied = to`，下次开面板显示「已更新到 vX」。
否则 → 失败：保留 `pendingUpdate`，面板提示「更新没有生效，可能目录选错了 —— 请重新选择扩展目录，
或在 `edge://extensions` 手动点重新加载」。

完成判据：故意选一个**错的目录**（比如 Downloads 里的旧解压目录）跑一遍，必须走到失败分支并给出这句话。

### Step 7 · 贡献者与仓库信息（构建期生成，运行时零请求）

- 构建期脚本：调 `GET /repos/{owner}/{repo}/contributors?per_page=30`，产出生成物 JSON
  （`login` / `avatar_url` / `html_url` / `contributions`）。两个路径见 §2 的清单
  （`scripts/` 下的 `gen-contributors`，产物落在 `src/generated/` 下）。
- **过滤规则（已定）**：`type === 'Bot'` 一律丢掉（dependabot 之类不是贡献者，摆上去很难看）；
  按 `contributions` 降序取**前 12 个**（280px 面板横向放得下 6 个/行、两行）。
- 名字优先用 GitHub `login`，**不要**用 `name`（可能为空、可能是真名）。
- 运行时只读 JSON，`<img>` 走 `avatars.githubusercontent.com`（图片不受 `host_permissions` 限制，
  默认 CSP 也不拦 https 图片）。
- 点头像或名字 → `chrome.tabs.create(html_url)`。

> 为什么不在运行时拉：① 60/h 配额是**按 IP 共享**的，面板每开一次就发请求很快撞限流；
> ② 贡献者名单不是更新之类的高频事实，构建期固化完全够。

完成判据：断网打开「关于」tab，头像与名字仍能显示（证明零运行时请求）。

### Step 8 · 文档、ADR、闸门

- 新 ADR（`docs/decisions/` 下编号 `0036`，文件名 `0036-auto-update.md` 见 §2 清单）：
  记录**为什么改**旧决策 6（远程版本查询 ≠ 远程配置）、
  为什么选 FS Access、为什么不用 crx/native host、以及"一次目录授权"这个代价是被接受的。
- 更新 `docs/README.md` 的 ADR 索引表（`check-docs` 会双向对账，漏了就红）。
- 更新 `docs/02-ui-spec.md`（「关于」tab 的版式与三态文案）。
- `README.md` 的"装好之后"补一句：更新走面板「关于」tab，不需要重新解压。

完成判据：`node scripts/verify.mjs` **完整档** 21 项全绿（不加 `--fast`：动了 `wxt.config.ts` 与 `scripts/`）。

---

## 4. 「关于 / 更新」要不要独立 tab（需求 5 的评估）

**现有约束（实测，不是估计）**：面板宽 **280px**；`sidebar.ts` 的注释已经算过 ——
`.tab` 是 `flex: 1 1 0`，4 格时每格 **61.5px**，加第 5 格降到 **48px**，
而「画质」在 13px 字号下约 26px，**48px 仍然够**。

| 方案 | 评价 |
| --- | --- |
| **A. 独立 tab「关于」（推荐）** | 低频但**内容自成一体**（版本、更新、仓库、贡献者）。塞进别的 tab 会让那个 tab 变杂物间。只加 1 格，宽度有实测余量 |
| B. 塞进「显示」tab 底部 | 省一格，但「显示」是页面净化与入口开关，加"关于"以后用户找不到 |
| C. 给"更新"单独再开一个 tab | ❌ 5 格变 6 格（40px，中文两字 26px + padding 已经贴边），且更新与关于是同一件事的两面 |

**结论：方案 A**，tab 名「关于」，排在最后，**默认不选中**；有新版本时格子上加红点。
更新三个按钮（检查 / 立即更新 / Releases）放该 tab **顶部**，贡献者放底部 —— 用户是为"更新"来的，
不会为了看头像而来。

---

## 5. 风险与应对

| # | 风险 | 应对 |
| --- | --- | --- |
| 1 | **写到一半失败 ⇒ 扩展损坏**（半新半旧，`manifest.json` 与 `background.js` 版本不一致） | 下载与解压全部在内存完成后才开始写；写入阶段每个文件写后复核 `size`；失败时不 reload、原地报错并给"手动重新解压覆盖"的兜底。P2：写入前把将被覆盖的文件备份到 `<dir>/.pluma-backup/` |
| 2 | **用户选错目录**（选了 Downloads 里的旧解压目录） | 本地只能做浅校验；**真正的判据是 Step 6 的版本自检**，生效失败必须明确说"目录选错了" |
| 3 | **GitHub 限流 60/h（按 IP 共享）** | 每日一次 + ETag；`403/429` 时**不**把结果当"无新版本"落库，只延后重试；失败一律静默（不弹错） |
| 4 | **下载重定向到未授权域** | 资产 URL 会 302 到 `release-assets.githubusercontent.com`；`host_permissions` 要同时给 `https://github.com/*` 与 `https://*.githubusercontent.com/*` |
| 5 | **权限扩张** | 新增 3 条 host。unpacked 扩展 reload 时不弹权限对话框，但**要在 ADR 与 README 写明为什么需要连 GitHub** |
| 6 | **自我覆写的信任面** | 我们下载并执行的是**自己 Release 的产物**，无签名校验可言——中间人可以同时改 zip 与站点。**必须写进 ADR 的"局限"**：这不是安全机制，是本项目对自己分发物的便利通道 |
| 7 | **`chrome.runtime.reload()` 会关掉 update 窗口与面板** | 预期行为。写入成功 → 立刻 reload，不等用户；重开面板时用 Step 6 的结果说话 |
| 8 | **贡献者数据过期** | 构建期生成 ⇒ 发版才更新。可接受（名单变化不影响功能） |
| 9 | **`queryPermission` 退回 `prompt`**（Step 0 实测会摆动） | 不许假定 `granted`；每次在点击手势里 `requestPermission`。**不要**为了"少一次确认"去做自动重试 —— 无手势调用必失败（`SecurityError`） |

---

## 6. 语义细节（最容易写错的三处）

### 6.1 "每天首次加载检查一次 + 每隔几天再检查"怎么落成一个数

只有一个闸门：`shouldCheck = now - state.lastCheckAt >= intervalDays * 86400e3`。

- `intervalDays = 1`（默认）⇒ 每天第一次打开/启动时检查一次，当天后续不再查。
- 用户改成 `3` ⇒ 每三天一次。
- **手动「检查更新」无视闸门**，但有 60s 冷却（防风狂点把 60/h 配额抽干）。
- 时钟回拨（`now < lastCheckAt`）按"该检查"处理，别让用户改系统时间把自己锁死。

### 6.2 版本比较不许用字符串

`'1.10.0' > '1.9.9'` 在字符串比较下是 **false**。必须逐段转数字比较；
`tag_name` 先剥掉前缀 `v`；预发布后缀（`-beta`）直接视为比同号正式版**旧**，且本方案不消费预发布。

### 6.3 三个"开关/状态"不是一回事，别合并

| 名字 | 作用域 | 谁改 | 默认 |
| --- | --- | --- | --- |
| `autoCheckEnabled` | **只**决定"要不要自动发起检查" | 面板「关于」tab 的开关 | `true` |
| 手动检查冷却（60s，内存级即可） | 只压「检查更新」按钮的连点 | 点击产生 | —— |
| `dismissedVersion` | 只压提示条/红点对**这一个大版本**的重复出现 | 点提示条上的「×」 | 空 |

三条互不影响的判据（实施时逐条写成单测）：

1. `autoCheckEnabled = false` ⇒ `shouldCheck()` 恒 `false`，**不发任何网络请求**；但手动检查仍发。
2. 关掉再打开 ⇒ 不清 `lastCheckAt`，于是**开启后立刻触发一次检查**（用户刚打开就是想让它工作）。
3. 手动检查发现新版本 ⇒ 红点照常出现，哪怕 `autoCheckEnabled = false`（否则"手动查了也白查"）。

> 别把它做成"总开关"：代理那个总开关控制的是是否接管播放，二者在 UI 上必须分开表述，
> storage key 也要分开（不要复用 `proxyEnabled` 之类的字段）。

---

## 7. 已定（2026-11-15 23:58 用户拍板）

| # | 事项 | 决定 | 落地位置 |
| --- | --- | --- | --- |
| 1 | 一次目录授权 | **接受** | §1.2 采用 FS Access；Step 5 的 `ensureHandle()` |
| 2 | 自动检查间隔默认值 | **1 天** | §6.1；`intervalDays` 默认 1，仍可配置 |
| 3 | 贡献者里的 Bot 账号 | **过滤掉** | Step 7 的过滤规则 |
| 4 | 自动检查开关 | **要，默认开启** | §6.3 + Step 4 的 ② 行 |

附带的口径变更：旧决策 6「不做远程配置」被本方案修订 —— 只做**版本查询**，不做任何配置下发，
理由写进 Step 8 的新 ADR。

下一步：按 Step 0 起手，**探针不过就不往下写**。

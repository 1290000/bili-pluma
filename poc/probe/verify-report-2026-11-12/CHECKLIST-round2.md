# 二次验收判据清单 · 2026-11-12

> **状态**：待命。等 Lead 的「工作区静默」通知后执行。
> **不做的事**：不跑真机、不 reload、不刷新、不定论。本文件只是清单与脚本。
>
> **为什么先写清单不先建环境**：`task-12/13/14` 会改 `src/background/**`，
> engineer 提交后代码就变了，现在建好的「干净起点」会**失效**。
> 正确顺序：清单 → 等工作区静默 → reload → 刷新 → 建干净起点 → 开始验。

---

## 0. 上次踩的坑（本次必须避开）

| # | 坑 | 本次怎么做 |
| --- | --- | --- |
| 1 | **用恒为 0 的判据判"窗口不存在"** —— `Get-CimInstance Win32_Process \| ? CommandLine -match 'incognito'` 在 Edge 下永远 0（无痕是同进程另一 profile，不是独立进程） | 一律用 `EnumWindows`+`GetWindowText` 匹配标题 `InPrivate`；脚本见 `tools/check-incognito-window.ps1` |
| 2 | **在孤儿 content script 上观测** —— reload 后没刷新页面 | 固定顺序：**reload → 刷新页面 → 等页面就绪 → 才开观测计时** |
| 3 | 拿「面板说 ok」当通过 | 每条「成功」结论都必须有**独立于面板的**物理证据（窗口枚举 / 进程 / 截图 / 真实规则表） |
| 4 | 观测期间工作区被改 | 开验前跑静默检查；验到一半发现别人在写就停 |

### 0.1 判据探针必须先验证「能看到存在」

> 2026-11-12 的假阴性，根因不是"看错了"，是**从来没验证过探针能不能看到"存在"**。
> 一个恒为 0 的探针，和一个"真的没有"，在输出上长得一模一样。

**已完成的探针验证**（`evidence/probe-validation.txt`）：

| 对照 | `check-incognito-window.ps1` 输出 |
| --- | --- |
| 阳性（窗口存在） | `INCOGNITO_COUNT=1` · `hwnd=20123414 size=420x600 title=登录播放账号 - [InPrivate]` |
| 阴性（关掉后） | `INCOGNITO_COUNT=0` |
| 旧坏判据（窗口存在时） | **0** ← 恒假阴性 |

⇒ 探针两个方向都灵，可以使用。

**规程**：二次验收每次用这个探针判「窗口不存在」之前，**先确认当次环境里确实有过一个窗口被封探针数到**（或直接跑一次阳性对照）。



---

## 1. 开验前的前置门（全过才动手）

```powershell
# 1.1 仓库身份（AGENTS.md §0）
git rev-parse --show-toplevel
Get-ChildItem AGENTS.md, docs/decisions/ | Select-Object Name
Select-String -Path package.json -Pattern '"name": "bili-pluma"' -Quiet

# 1.2 工作区静默（Lead 宣布静默后仍要自查一次）
$now = Get-Date
Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.js,*.mjs,*.md,*.json,*.css,*.html `
  -Path src,entrypoints,tests,docs,scripts,poc 2>$null |
  Where-Object { $_.LastWriteTime -gt $now.AddMinutes(-10) } |
  ForEach-Object { "recent`t$($_.LastWriteTime.ToString('HH:mm:ss'))`t$($_.FullName)" }

# 1.3 记录基线 SHA（验完要能证明我没动源码）
git status --porcelain
foreach ($f in @('src/background/login-window.ts','src/background/login-handshake.ts',
                 'entrypoints/background.ts','src/platform/http/dnr.ts',
                 'tests/unit/content/panel/feed-account-effective-state.test.ts')) {
  if (Test-Path $f) { "sha`t$f`t$((Get-FileHash $f -Algorithm SHA256).Hash)" }
}

# 1.4 基线 verify
node scripts/verify.mjs
```

---

## 2. 建干净起点（固定顺序，不许省步）

```powershell
# 2.1 重载扩展（会重建 .output/chrome-mv3）
node poc/probe/reload-extension.mjs

# 2.2 ★ 关键：刷新页面，让 content script 重新注入
#     （不刷新 = 孤儿态，诊断页会整片「读取失败」、面板消息不通 —— 上次就是栽在这）
#     用 bsk 刷新目标 B站 标签

# 2.3 等播放器就绪（约 10s），然后确认 content script 是新鲜的：
#     面板能正常读、诊断页无 "Extension context invalidated"
```

**干净起点自检（三条全过才算干净）**：

| 检查 | 通过的样子 |
| --- | --- |
| 面板能读到状态 | 账号 Tab 显示主账号昵称，不是「读取中…」卡住 |
| 诊断页三项可读 | `InPrivate 权限` / `窗口列表` / `cookie 分区` **都不是**「读取失败（background 未返回这一项）」 |
| 无 context invalidated | `凭据状态` 不显示 `Extension context invalidated` |

---

## 3. task-12 · `assumed` 判定路径

> Lead 改卡后：**先取 `reason:'assumed'` 的出现频率**，常发生才改代码。

### 3.1 取证（频率优先，不预设结论）

| 步骤 | 判据 |
| --- | --- |
| T12-1 | 干净起点下，点「扫码登录取流账号」，记录 `login/open` 应答 JSON（含 `reason`） |
| T12-2 | **OS 级窗口枚举**确认 `登录播放账号 - [InPrivate]` 是否存在（`tools/check-incognito-window.ps1`） |
| T12-3 | 读诊断日志里 `windows.create returned` 那行（`windowsBefore/After`、`loginTabs`） |
| T12-4 | 统计：N 次点击里 `reason='assumed'` 出现几次；其中**窗口真不存在**的有几次 |

### 3.2 判定规则（先定死，避免事后解释）

```
if (assumed 出现次数 == 0)
    → 本卡不成立（或只需加注释说明该分支实测不触发）
else if (assumed 出现 且 窗口确实不存在 的次数 > 0)
    → 本卡成立，按卡修（失败必须回 opened:false 让面板说真话）
else (assumed 出现 但 每次窗口其实都在)
    → 本卡不成立：assumed 是保守误报，不是用户可见故障
      （但可在注释里记一笔「该分支目前总是猜对」）
```

### 3.3 陷阱

- ❌ 不许用 `Win32_Process ... CommandLine -match 'incognito'`（恒 0，上次的错）
- ❌ 不许拿「面板没有错误提示」当「窗口开了」的证据（面板正是被怀疑撒谎的一方）
- ✅ 必须：窗口枚举 + 截图，两者一致才算「窗口存在」
- ✅ 必须有：**窗口不存在**的正例样本，否则没法证明你能观测到"不存在"

---

## 4. task-13 · 恒真断言删除后的保护仍在

### 4.1 前置确认

| 步骤 | 判据 |
| --- | --- |
| T13-1 | `feed-account-effective-state.test.ts:96-113` 那条恒真用例**已删除**（或改成有效断言） |
| T13-2 | 同文件 `:59-71`（`★★★ 真机那个矛盾态`）**仍在** |
| T13-3 | `need-incognito-copy.test.ts` 的 134 → 103 已改 |

### 4.2 ★ 核心判据：变异必须让 `:59-71` 变红

```powershell
# 用 tools/mut.mjs（编码安全，SHA 校验，拒绝多重匹配）
$t = 'poc/probe/verify-report-2026-11-12/tools'
# old: checked: actions.hasCredential && actions.feedAccountEnabled,
# new: checked: actions.feedAccountEnabled,
node "$t/mut.mjs" apply 'src/content/panel/tabs.ts' <oldFile> <newFile>

node node_modules/vitest/vitest.mjs run `
  tests/unit/content/panel/feed-account-effective-state.test.ts --reporter=verbose

node "$t/mut.mjs" restore 'src/content/panel/tabs.ts'
```

**通过判据**：

| 项 | 期望 |
| --- | --- |
| `★ 真机那个矛盾态` | **× 红** ← 必须 |
| 全文件 | 不能"0 条测试"（那说明删过头把整个 describe 删了） |
| 还原后 SHA | 与变异前**逐字节一致** |
| 还原后该文件 | 全绿 |

> ⚠️ **反向陷阱**：如果删掉恒真用例后 `:59-71` 在变异下**不红**了，
> 说明删的时候连带改坏了 `:59-71` —— **那就是改测试让它过**，必须退回。

---

## 5. task-14 · 诊断页在干净环境下是否真有问题

> **Lead 授权**：若干净环境下三项都正常，直接判「本卡不成立，建议关闭 task-14」。

### 5.1 取证（必须干净起点）

| 步骤 | 判据 |
| --- | --- |
| T14-1 | 干净起点（§2 三条自检全过）下，打开面板 → 显示 → 诊断 |
| T14-2 | 读 `InPrivate 权限` / `窗口列表` / `cookie 分区` / `凭据状态` / `manifest incognito` |
| T14-3 | 点「重新采集」，再看一次 |
| T14-4 | 若想验「SW 休眠」：让 SW 空闲足够长时间后重进诊断页，观察是否仍可读 |

### 5.2 判定规则（先定死）

```
if (干净环境下 三项全部可读 且 重新采集正常)
    → **本卡不成立**，建议关闭 task-14
      （上次的「读取失败」= content script 孤儿态，是观测环境问题，不是产品缺陷）
else if (干净环境下 仍有一项读不到)
    → 本卡成立，转 engineer，附：哪一项、干净起点的自检证据、SW 状态
else (只能复现于 SW 休眠态)
    → 降级为「边界场景」，由 Lead 定优先级
```

### 5.3 陷阱

- ❌ 不许在孤儿态下取证（那就是上次的错误来源）
- ✅ 必须在报告里**明确写出干净起点的自检结果**（否则别人无法判断你测的是什么态）

---

## 6. 收尾（每次验完必做）

```powershell
# 6.1 证明没动源码
git status --porcelain
foreach ($f in <§1.3 记录的同一批文件>) {
  "sha`t$f`t$((Get-FileHash $f -Algorithm SHA256).Hash)"   # 与 §1.3 对比
}
Get-ChildItem -Recurse -Filter "*.verabak"    # 必须为空

# 6.2 全量回归
node scripts/verify.mjs
```

| 收尾项 | 判据 |
| --- | --- |
| 源码 SHA | 与 §1.3 基线**完全一致**（除了 engineer 自己的改动本身） |
| `.verabak` | 无残留 |
| `verify.mjs` | 全绿 |
| InPrivate 权限 | **ON**（若为验 task-12 曾关过，必须恢复并记录） |

---

## 7. 报告落点

延续 `poc/probe/verify-report-2026-11-12/`：
- 二次验收结果追加为 `REPORT-round2.md`（不覆盖 round1，保留历史）
- 证据放 `evidence/round2/`

**每条结论必须有独立于被验对象的证据。** 这是上一轮的教训底线。

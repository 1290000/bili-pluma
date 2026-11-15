# task-22 独立验收报告（verifier）

- **验收对象**：engineer-panel 对 task-22「三处静默失败」的实现
- **验收者**：verifier（**只审不写**；本报告目录外未落任何文件）
- **日期**：2026-11-12
- **结论先行**：**有条件成立** —— 三处改动本身全部成立且反向验证为真红；**但有一条实质性问题：缺陷 2 修的 `already-open` 分支在用户真机的常态路径上根本走不到**，用户原来栽的那个场景大概率仍然无反馈。

---

## 0. 一句话结论

| # | 声称 | 裁定 |
| --- | --- | --- |
| 1 | `create` 的空 catch 已改 try/catch + 写 diag | ✅ **成立** |
| 2 | `login-outcome` 新增 `already-open` 分支 | 🟡 **代码成立，但覆盖不到真机现状**（见 §3，这是本报告的核心） |
| 3 | `incognito-disabled` 文案改为陈述事实 | ✅ **成立** |
| A | `node scripts/verify.mjs` 21/21 | ✅ 我复跑一致 |
| B | 自己做反向验证 | ✅ 做了 3 条，全部**真红**，且还原 SHA 逐字节一致 |
| C | 未跟踪文件 | ✅ 已用 `git status --porcelain` 核；engineer 的提醒是对的 |
| D | 写域 | ✅ task-22 改动均在工作区内，无越界 |
| E | 真机可行性 | 🟡 场景 1/2 成立；**场景 3 大概率不出现 `already-open`** |

**最终裁定：有条件成立。** 不退回代码（代码本身没错），但 §3 那条必须在给用户"修好了"之前处理或至少如实告知。

---

## A. 复跑 verify（我自己跑的，不是转述）

```
[verify] ✅ 21 项全绿（共 31.2s，并行墙面 31.2s，串行合计 69.0s）
```

完整输出：`verify-output.txt`（本目录）。

---

## B. 我自己做的反向验证（3 条，全部真红）

脚本：`rv2.mjs`（本目录）。做法：单文件 → 备份 → 精确单点变异 → 跑测试 → **备份还原** → 校验 SHA256。
**全程未使用 `git checkout` / `git stash` / `git reset`**（AGENTS 禁令）。

### RV1 —— 缺陷 1：把 `create` 改回空 catch（花括号配平，不是字符串截断）

```
file=entrypoints/background.ts
sha_before =9d9597a27abb6840e7e66bf112d27a617b10df035ee7f6cb8d24908df7bef868
sha_mutated=da0740645ee913a6e56fc33efc8b71d0b5336ec602d97bfd0b6dc96b22221f1c
FAIL ★★★ 该分支内**不许**再有 `.catch(() => {})` 这种空 catch
FAIL ★★★ 被拒绝时，错误原文必须进日志（不是只记"失败了"）
Tests  2 failed | 18 passed (20)
是否 "no tests"（假红）: false
是否 语法错误（假红）: false
sha_restored=9d9597a2… 与变异前一致: YES ✅   残留 .rvbak: none ✅
```

### RV2 —— 缺陷 2：停用 `already-open` 分支

```
file=src/content/panel/login-outcome.ts
sha_before =c52ef4edcf523e1261993da7243983bb57a8293bac422e4ed1ad66a1ba4a2208
sha_mutated=1425e5c44ebd44cf81ef7def3fb5c52f3dd5e444123b1f3bf70cf63a005ab62f
FAIL ×4（already-open 四条全红，含 ok:false 两条）
  AssertionError: expected '扫码窗口已打开，请用手机扫码…' not to be '扫码窗口已打开，请用手机扫码…'
  AssertionError: 没告诉用户窗口在哪: expected '扫码窗口已打开…' to contain '已经开着'
  AssertionError: expected true to be false   ← ok:false
Tests  4 failed | 16 passed (20)
是否 "no tests"（假红）: false
是否 语法错误（假红）: false
与变异前一致: YES ✅   残留: none ✅
```

> 这条同时也是 engineer 自报「RV2 第一次是假红（语法错误→`no tests`）」的**交叉证实**：
> 我这次用花括号配平的写法，拿到的是带完整 stack trace 的 **4 条 AssertionError**，不是 `no tests`。
> engineer 的自述属实，且它最终那版确实拿到了真红。

### RV3 —— 缺陷 3：把「再点一次」加回文案

```
file=src/content/panel/login-outcome.ts
sha_mutated=26dc590d376524791d7dca5a9cf18b1e4fbab80b1646a2969389962c23237d68
FAIL ★★★ 文案里**不许**出现「再点一次」这类错误指令
Tests  1 failed | 19 passed (20)
是否 "no tests": false    是否 语法错误: false
与变异前一致: YES ✅   残留: none ✅
```

**三条 RV 全部真红、全部精确还原。** 工作区源码 SHA 恢复后与变异前一致，无 `.rvbak` 残留。

---

## C+D. 未跟踪文件与写域

`git status --porcelain`（全量，未截断）中，task-22 相关文件：

```
 M entrypoints/background.ts                    ← task-22 改动 1
 M src/content/panel/login-outcome.ts           ← task-22 改动 2、3
 M entrypoints/content-panel.content.ts         ← task-22（showNotice 调用点，本次未改方向）
 M src/content/panel/panel.ts                   ← 既有 task-8/9 改动（showNotice/clearNotice）
 M tests/unit/content/panel-login-outcome.test.ts ← task-22 新增用例
?? tests/unit/background/need-incognito-create-diag.test.ts  ← task-22 新测试（未跟踪！）
?? tests/unit/content/panel/                            ← 既有轮次
```

**关键确认**：`tests/unit/background/need-incognito-create-diag.test.ts` 是 `??` 状态，**`git diff --stat` 确实看不到**。
engineer 的这条提醒正确且重要 —— 若只靠 `git diff` 核对"改了哪些文件"，会漏掉 task-22 的主要测试文件。

其余 16 个 `M` + 5 个 `??` 属于 task-3/4/5/8/9/10/11 与历次取证目录，**已排除，不计为 task-22 越界**。

### 三处既有测试的断言方向反转（上一轮 task-6 的遗留，非 task-22 所为）

| 文件 | 反转 | 判定 |
| --- | --- | --- |
| `tests/unit/content/panel-tabs.test.ts` | `toContain('先扫码登录取流账号')` → `not.toContain(...)` | ✅ 需求变了 —— 源码 `src/content/panel/tabs.ts` 里该 `appendChild` 已删除（HEAD 有，工作区只剩注释），不是"改测试让它过" |
| `tests/unit/content/panel-tabs.test.ts` | `toContain('打开后，首页推荐换成取流账号的')` → `not.toContain(...)` | ✅ 同上，源码 `hint` 已整个删除 |
| `tests/unit/content/panel/feed-account-effective-state.test.ts` | 恒真断言 | ✅ 上一轮已判"直接删"，task-13 已处理，**task-22 未触碰此文件** |

---

## 3. 🔴 本报告最重要的一条：`already-open` 在真机上走不到

### 3.1 代码路径

`src/background/login-window.ts:79-87`：

```ts
if (currentWindowId !== null) {
  try {
    await chrome.windows.update(currentWindowId, { focused: true });
    return { ok: true, reason: 'already-open' };   // ← 只有这条路才出 already-open
```

而 `currentWindowId` **只有一处赋值**：`login-window.ts:137`，位于情况 1（`created?.id != null`）。

### 3.2 真机取证：情况 1 从未发生过

工程内全部真机日志样本里，`login/open` 的 `reason` **一律是 `assumed`**，没有任何一条 `already-open`：

```
poc/probe/logout-login/REPORT.md:                                   login/open  {"ok":true,"reason":"assumed"}
poc/probe/logout-login-round2/raw/repro5/diag-instances.txt:        login/open | {"ok":true,"reason":"assumed"}
poc/probe/logout-login-round2/raw/repro5/diag-latest-14-49-50.txt:  login/open | {"ok":true,"reason":"assumed"}
poc/probe/logout-login-round2/PERMISSION-FLIP-REPORT.md:            4 次全部紧跟 login/open {"ok":true,"reason":"assumed"}
```

`login-window.ts:70` 的文件头注释也写明了：`create()` 的 Promise 解析成 `undefined`——拿不到 id。

### 3.3 推论（这是本条的价值所在）

`assumed` 路径**不设** `currentWindowId` ⇒ 用户即使屏幕上已经有那个 460×420 的说明页窗口，
再点「扫码登录」也**不会**进 `already-open`，而是：

1. 重新 `isIncognitoAllowed()` → 若此刻读到 `false` ⇒ 走 `incognito-disabled` + **再建一个说明页窗口**；
2. 若读到 `true` ⇒ 又走一遍 `create()`，`create()` 返回 `undefined`，再报 `assumed`，
   `handleLoginOpen` 返回 `{opened:true, reason:'assumed'}` ⇒ 面板显示
   **「扫码窗口已打开，请用手机扫码。成功后这里会自动更新」**——
   **屏幕上没有任何新东西、也没有新窗口，用户看到的仍然是"没反应"。**

**engineer 的诊断（缺陷 2 = 窗口已开着时只说"已打开"）方向是对的，但它修的分支不是用户实际走的那条。**
本次改动**不会**让用户原来那个场景出现「已经开着了，请去那个窗口操作」的提示。

### 3.4 我确认这**不是** engineer 的过错

- 任务卡写的是"新增 `already-open` 分支"，它照做了，且写得对；
- `currentWindowId` 拿不到是 task-12 已定稿的**已知限制**（跨分区不可观测），
  改它需要新 storage 握手协议，超出本卡范围；
- **但"提示已加上"和"用户能看到提示"是两件事** —— 这正是独立验收该分开说的。

### 3.5 建议（交 Lead 派单，verifier 不动手）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| **高** | `assumed` 文案单独区分 | `assumed` 时我们**无法确认**窗口真的开了，却说"扫码窗口已打开"是**过度断言**。建议改成中性且可行动的措辞（例如：「已经发出打开请求 —— 请在上面那个窗口扫码；若没看到窗口，回来说明页检查 InPrivate 权限」）。改动点：`src/content/panel/login-outcome.ts` 新增 `assumed` 分支 + 对应测试 + RV |
| 中 | 把 `assumed` 也当作"可能已开着" | 若能读到"说明页窗口是否已存在"的任何弱信号（哪怕只是"上一次点击刚发过 create"），可让第二次点击走 `already-open` 语义。**这属于新能力，须先报 Lead/用户** |
| 低 | `controller` 为 null 仍静默 | 我同意 Lead 的判断：`controller === null` 只在面板被摘除后发生，而点按钮需要面板存在。**本次不改，正确** |

---

## 4. 逐条核实（改动 1/2/3）

### 改动 1 —— `entrypoints/background.ts`：✅ 成立

核对脚本：`check-exact.mjs`（本目录），字符级状态机剥离注释后判定。

- 剥注释后，`incognito-disabled` 分支内 **无** `.catch(() => {})` ✅
- 分支内 `catch (e)` 存在，错误原文进 `createError` ✅
- `create` 之后有 `await diag(...)`，带 `id=` 与 `url=` ✅
- 错误分支 `error=` 进日志（`createError.slice(0,200)`）✅

**关键细节（engineer 没提，但我认为是对的）**：剥注释后全文仍**有 3 处** `.catch(() => {})`
（`background.ts` 原第 190/197 行启动自愈、以及第 240 行那个带注释体的 catch），
它们**不在**本缺陷分支内，因此测试的"分支切片"判据没有被它们污染。测试用
`if (result.reason === 'incognito-disabled')` 到 `reason: 'unknown'` 切片，边界正确。

### 改动 2 —— `already-open` 分支：🟡 代码成立 / 覆盖不到（见 §3）

文案与 `ok:false` 本身符合任务卡。`ok:false` 的后果我已顺着读通：

- `content-panel.content.ts:205` `if (controller) controller.showNotice(r.text, r.ok)` —— **无条件**先显示；
- `:208` `if (!r.ok) return;` —— 只跳过轮询，**不影响提示显示**；
- `showNotice`（`panel.ts:851`）挂在 `root` 上，`ok:false` ⇒ 加 `.danger` 类，**红字常驻不自动消失**（只有 `ok:true` 才 `setTimeout` 消除）。

⇒ **engineer 给的理由成立**：`ok:false` 既不影响提示可见性，又能跳过无意义的 3 分钟轮询。
唯一副作用是语义上把这次点击标成"没成功"，而文案本身说"去那边继续" —— 对用户是自洽的。

### 改动 3 —— `incognito-disabled` 文案：✅ 成立

剥注释后（`check.mjs` 输出）：

| 检查 | 结果 |
| --- | --- |
| 代码里还有「再点一次」 | **false** ✅（原文 `login-outcome.ts` 里 1 处出现全在注释中） |
| 含「关着的」 | true ✅ |
| 含「扩展详情页」/「InPrivate」 | true / true ✅ 路径指引保留 |
| 归因词（你关闭/你关掉/你手动/被系统/浏览器自动） | 全 false ✅ |

⚠️ **一处措辞瑕疵（不阻塞）**：新文案结尾是「…把它打开 —— **打开后回到这里重新点「扫码登录」**」。
「重新点」与已删的「再点一次」语义**极其接近**。测试守的是字面量 `再点一次`，
所以字面换成「重新点」不会被 catch。考虑到本卡的整个立论是"权限值会自己掉，
让用户再点是无用指令"，这句话有把同一个错误指令换个说法带回来的风险。
**建议（低优先级）**：要么删掉这半句，要么让测试守语义（断言用户不被要求再点）。**不构成退回理由**，因为原文确实删掉了「再点一次」，且保留了必要的修复路径。

---

## 5. engineer 自报三个坑的核实

| 自报 | 我的核实 | 结论 |
| --- | --- | --- |
| ① RV2 第一次字符串截断 → 语法错误 → `no tests`（假红） | 我用花括号配平写法拿到 4 条真 AssertionError；`是否 "no tests": false` / `是否 语法错误: false` | ✅ **属实**，最终版是真红 |
| ② `stripComments()` 双向有效 | 我独立验证：假红方向（注释含目标/代码无）→ 剥离后 false；**假绿方向**（注释含 `id=`/代码无）→ 剥离后 **false** ✅；字符串里的 `/*` 未被误吞；块注释后代码保留 | ✅ **双向有效** |
| ③ `git stash` 做 RV3 后 task-4 改动仍在 | **我无法独立复核** —— engineer 的 `git stash` 已发生且已 `pop`，历史不可回溯；**我也没有使用 stash**（改用备份文件 + SHA256 校验），这本身是更安全且可校验的做法 | ⚠️ **无法取证，但无需取证**：当前工作区 task-4 相关文件（`src/background/login-window.ts` 等）改动都在、verify 全绿 |

---

## 6. E. 真机可行性判断（三个场景）

| 场景 | 用户会看到什么 | 判定 |
| --- | --- | --- |
| ① 权限开着 → 点扫码 | 走 `create` → 多半返回 `undefined` → `assumed` → 面板绿字「扫码窗口已打开，请用手机扫码」+ 屏幕上 460×420 说明页窗口出现 | ✅ 与既有实测一致（task-6 轮已截图证明窗口确实开出来） |
| ② 权限 false → 点扫码 | 不弹窗口，面板**红字**「扩展的「在 InPrivate 中允许」现在是关着的…请到扩展详情页把它打开…」+ 弹说明页窗口；diag 里新增 `need-incognito 窗口创建结果 id=… url=… error=…` | ✅ 成立。且这次**若说明页没弹出来**，日志终于能区分"没权限"和"create 被拒" |
| ③ **说明页已开着 → 再点**（用户原来栽的地方） | **见 §3：大概率不会出现「已经开着了」提示。** 实际会走 `incognito-disabled`（权限已掉）或 `assumed`（权限还在），前者弹**第二个**说明页窗口、后者显示「扫码窗口已打开」 | 🔴 **这是本卡唯一没被真正解决的问题** |

**关于"提示是否可见"**：`showNotice` 是 root 级、跨 `replaceChildren` 存活、红字常驻，可见性没有问题。
问题不在可见性，在**这条提示会不会被走到**。

---

## 7. 最终裁定

### **有条件成立**

- ✅ 改动 1、改动 3 成立，三条 RV 均为真红，工作区零污染；
- ✅ `already-open` 分支代码本身正确，`ok:false` 的理由成立；
- 🔴 **但缺陷 2 的目标场景在真机常态路径（`assumed`）上不会触发该分支** ⇒
  用户报告的「点扫码完全没反应」**不会被这次改动消除**，只会在"权限刚好读到 false"时变成另一句红字。

**不退回代码**（三处改动都符合任务卡，没有一条是错的）。
**但建议 Lead 在告知用户之前，明确说清：这次的修复让日志能查清原因、让权限 false 时文案不再误导，
而"窗口其实已经开着、用户又点了一次"这个具体场景，需要 §3.5 的高优先级补丁才真正有反馈。**

### 待修清单（交 Lead 派 engineer）

1. **【高】** `assumed` 单独文案分支：不许再断言"扫码窗口已打开"（我们无法确认）。附 RV（改回旧文案需变红）。
2. **【中】** 评估"说明页是否已存在"的弱信号，让第二次点击能走 `already-open` 语义 —— 新能力，须先报 Lead/用户。
3. **【低】** `incognito-disabled` 文案里的「重新点「扫码登录」」与已删的「再点一次」语义接近，建议改措辞或加语义断言。
4. **【信息】** `controller === null` 时仍静默：**同意 Lead，本次不改。**

---

## 附：本目录产物

| 文件 | 说明 |
| --- | --- |
| `verify-output.txt` | 我复跑 `node scripts/verify.mjs` 的完整输出（21/21） |
| `check.mjs` | 剥注释后核对三处改动 + `stripComments` 双向自检 |
| `check-lines.mjs` / `check-exact.mjs` | 逐处列出空 catch 的精确位置与分支边界判定 |
| `rv2.mjs` | 我用的反向验证脚本（备份→变异→跑测→还原→SHA256 校验） |

**声明**：本报告所有数值均来自本机实际执行；未取到的项已标注（§5 第③条）。我未修改任何源码或测试，运行 RV 后已用 SHA256 逐文件确认工作区恢复原状（无 `.rvbak` 残留）。

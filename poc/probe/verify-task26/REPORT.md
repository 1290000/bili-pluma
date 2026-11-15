# task-27 独立复核报告：`logsMeta` 可信度声明 + 孤儿态自证失效

- **卡片**：task-27（revision 2，owner=verifier，验 task-26）
- **被验对象**：engineer-panel 的 task-26（`src/content/panel/diagnostics.ts` +167 / `src/content/panel/panel.ts` +670/−93 / `tests/unit/content/panel-diag-wiring.test.ts` +154）
- **verifier 写域**：`poc/probe/verify-task26/`（本文所在目录）
- **结论先行**：**有条件成立，可以收**。五条判据里 1/2/3/4 成立，**第 5 条（`logsMeta` 缺字段不许崩渲染）不成立** —— `diagnosticsPane()` 在 `logsMeta` 缺失时**仍然抛 `TypeError`**，且抛点在**两处**。这是一条真实的、可被"调用方传错/老代码调用"触发的崩溃面，不是纸面判据。
- **我没有引用 engineer 的任何数字**：本报告的 verify / vitest / 探针 / RV 全部由我自己跑出。

---

## 0. 一句话给用户

> 诊断页现在能分清"确实没日志"和"日志读不出来"了，导出的错误信息也不会再把凭据带出去；但**诊断面板在拿到残缺数据时还会直接崩**，这一处需要工程修。

---

## 1. 我做了什么（可复跑）

| 步骤 | 命令 | 产物 |
| --- | --- | --- |
| A 全量门 | `node scripts/verify.mjs` | `verify-21-green.txt` |
| B 全量单测 | `node node_modules\vitest\vitest.mjs run` | `vitest-full.txt` |
| C 探针（我写的） | `node node_modules\vitest\vitest.mjs run --config poc\probe\verify-task26\vitest.probe.config.ts` | `probe-final.txt` |
| D 反向验证 | `node poc\probe\verify-task26\rv.mjs` | `rv-result.json` / `rv-console.txt` |
| E 判据 5 分步归因 | `node poc\probe\verify-task26\seq-check.mjs` | `seq-check.txt` |

**A**（我自己跑的）：`✅ 21 项全绿（共 35.8s，并行墙面 35.8s，串行合计 80.8s）`，exit 0。
**B**（我自己跑的）：`Test Files 111 passed (111)` / `Tests 1840 passed (1840)`，零红。

> ⚠️ 本机**没有 `npx`**（`CommandNotFoundException`）。vitest 必须走 `node node_modules\vitest\vitest.mjs run`。
> Vite 的 CJS 弃用警告会打到 stderr 并让 PowerShell 报 exit=1，是噪声，判绿看 stdout 的 `Test Files N passed`。

---

## 2. 五条判据逐条裁定

### 判据 1 · `ok` 必须来自真实读取结果，不许由 `logs.length` 推出 —— ✅ 成立

判据要求区分三种情形。engineer 那三条守卫只能造"两处都挂"，**造不出"探针成功但真读失败"这一格**。我的探针 `ok-is-real-signal.test.ts` 用**按 key 分派**的 storage stub 把它造出来了（探针一定 `get(null)`，`readDiag()` 一定 `get('pluma:diag')`）：

| 情形 | 期望 | 实测 |
| --- | --- | --- |
| 探针成功 + 真读成功 + 0 条 | `ok:true, err:null, count:0` | ✅ 通过 |
| 探针抛 + 真读抛（真实孤儿态） | `ok:false, err:'Extension context invalidated.'` | ✅ 通过 |
| **探针成功 + 真读抛** | `ok:false` | ✅ 通过 |
| **探针抛 + 真读成功** | `ok:false` | ✅ 通过 |

实现里的对应代码（我自己读的）：

- `src/content/panel/panel.ts:409-425` `probeLogsReadability()`：`failure !== undefined` → `ok:false`；否则 `try { await chrome.storage.local.get(null); return {ok:true, err:null} } catch { return {ok:false, ...} }`
- `src/content/panel/panel.ts:662-664`：`const logsMeta = {...probeLogsReadability(), count: 0}` → `const logs = await readDiag()` → `diagData = { rows, logs, logsMeta: {...logsMeta, count: logs.length} }`

⇒ **`ok` 是"探针成功 ∧ 真读成功"的与，不是从 `length` 推的**。判据 1 成立。

> 但见 §4 附加题 B：`readDiag()` 本身会**吞异常返回 `[]`**（`src/platform/storage/diag-store.ts`），所以"真读失败"必须靠前置探针才能发现 —— 这是实现里唯一能发现它的路径，也解释了为什么探针必须在 `readDiag()` 之前（`:658-661` 有注释）。

### 判据 2 · 孤儿态下不许再说「还没有日志。」 —— ✅ 成立

**我选"渲染输出"而非"剥注释后的源码"，理由**：判据 2 问的是**用户看到什么**（"不许再说还没有日志"）。源码级断言只能证明"代码里有那几句字"，证明不了分支真的按 `ok` 分流 —— task-25 刚吃过这个亏（判据写在源码里对、运行时走不到）。
但渲染输出有它自己的假绿风险：`.not.toContain('还没有日志')` 在**页面一片空白**时恒真。所以我的每条断言都**成对**写：既断言"不许出现"，也断言"必须出现"的正面文案（`自检信息` 这个诊断页骨架）。`render-robust.test.ts` 里我自己就因为漏了这一步，第一次跑出一个"断言写错导致的红"，见 §5 教训 3。

| 情形 | 断言 | 实测 |
| --- | --- | --- |
| 探针抛 + 真读抛 | 含 `诊断日志读取失败` / `刷新` / `Extension context invalidated.`，且**不含** `还没有日志` | ✅ 通过 |
| 探针成功 + 真读抛 | 不含 `还没有日志`，含 `诊断日志读取失败` | ✅ 通过 |
| 探针成功 + 真读成功 + 0 条 | 含 `还没有日志`，不含 `诊断日志读取失败` | ✅ 通过 |

用户侧原文（`src/content/panel/diagnostics.ts:344-351`）：`诊断日志读取失败` + `页面里的扩展已经失效（扩展可能刚更新过）—— 刷新页面后重开面板再看`，`err !== null` 时追加 `（Extension context invalidated.）`。**这句话说的是用户能做的事，不是内部错误原文**，符合 §5.2。

### 判据 3 · `err` 白名单端到端 —— ✅ 成立

engineer 的验收是"`describeLogsError()` 返回 `'unknown'`" + "源码里返回值只能来自白名单"。前者只测函数本身，后者只证明代码长什么样。**用户真正拿到的是导出的 JSON**，所以我的 `err-whitelist.test.ts` 从"面板点导出 → 捕获 Blob → 解析 JSON"走端到端，并额外喂三类"能骗过看着像白名单"的输入：

| 输入 | 期望 `err` | 导出 JSON 全文 |
| --- | --- | --- |
| `Error('token=abc123')` | `'unknown'` | 不含 `abc123` ✅ |
| `{toString:()=>'SESSDATA=deadbeef'}`（非 Error） | `'unknown'` | 不含 `deadbeef`/`sessdata` ✅ |
| `Error('outer', {cause: Error('token=abc123')})` | — | 不含 `abc123` ✅ |
| `Error('Extension context invalidated.')` | 固定串 | 命中枚举 ✅ |

另加一条"`err` 只允许固定枚举值"的断言（`Extension context invalidated.` / `chrome.runtime is undefined` / `The message port closed` / `unknown` / `not-read-yet`），实测通过。

### 判据 4 · `limit` 不许写死 30 —— ✅ 成立（但有一处**注释级**写出）

- `src/content/panel/panel.ts` 里 `DIAG_LIMIT` 出现 3 次，**字面量 `30` 出现 0 次**。
- `src/content/panel/diagnostics.ts` 里 `DIAG_LIMIT` 只在**注释**出现 1 次（`:58`「环形缓冲上限（`DIAG_LIMIT`，从 `diag-store` 导入，不写死）」），字面量 `30` 只在**注释**出现 1 次（`:121`「主日志是 30 条环形缓冲」），代码里用的是 `data.logsMeta.limit`（`:365`）。

我的验证方式是**改 mock 导出的 `DIAG_LIMIT` 为 7**（不是 30），然后看两个出口：
1. 导出 JSON 的 `logsMeta.limit` → 实测 `7` ✅
2. 面板标题「诊断日志（最近 8 条，已达上限 **7** 条，更早的被挤掉了）」→ 实测跟着走 ✅，不含「最近 30 条 / 上限 30 条」

> `diagnostics.ts:121` 那句注释把上限写成了字面量 `30`。**不是代码缺陷**（代码读的是 `DIAG_LIMIT`），但一旦常量改成 7，注释就开始说谎。见 §6 待修清单 #4（低）。

### 判据 5 · `logsMeta` 缺字段不许崩渲染 —— 🔴 **不成立**

我的探针 `render-robust.test.ts` 直接调 `diagnosticsPane()`，故意**不传 `logsMeta`**（摸拟"调用方忘了传/老调用点"）：

```
AssertionError: diagnosticsPane 在缺 logsMeta 时抛了：
  TypeError: Cannot read properties of undefined (reading 'ok'): expected ... to be null
  at Module.diagnosticsPane (src/content/panel/diagnostics.ts:341:22)
```

而且**抛点不止一处**。我用 `seq-check.mjs` 做了分步归因（备份 → 只补第一处 → 跑 → 再补第二处 → 跑 → 还原 → SHA256）：

| 步骤 | 探针结果 |
| --- | --- |
| 未变异 | `stage=caught: TypeError ... (reading 'ok')` @ `diagnostics.ts:341` |
| 只补 `.ok` 防御 | `stage=caught: TypeError ... (reading 'err')` @ `diagnostics.ts:357` |
| **两处都补** | `stage=called`，`Tests 16 passed (16)` ✅ |

⇒ 判据 5 的红是**真实的**，且要**两处一起修**才算修完：
- `src/content/panel/diagnostics.ts:341` `if (!data.logsMeta.ok) {`
- `src/content/panel/diagnostics.ts:357` `if (data.logsMeta.err !== null) {`  ← 这两行是同一个函数里的连续两次解引用

**这一条正是有人说的"新加必验项"，验出来是真的**。

---

## 3. 反向验证（我自己开的 5 组 + 1 组归因）

脚本 `poc/probe/verify-task26/rv.mjs`（底层 `rv-lib.mjs`）。流程：**备份 → 单点变异（断言变异点出现次数必须 =1，否则直接抛）→ 跑守卫 → 备份还原 → SHA256 逐字节核对**。**全程没用过 `git checkout` / `git stash` / `git reset`**。

判定"真红"必须同时满足三条，缺一不算：① 有用例失败 ② 失败的是预期那个用例 ③ **失败原因里带着预期断言的措辞**。第 ③ 条是必须的 —— 变异体语法/类型不合时可能挂在更早的地方，那种红不代表判据守住。

| 组 | 变异点 | 期望红 | 实测 |
| --- | --- | --- | --- |
| **RV1** | `panel.ts:423` `{...base, ok:false, err:describeLogsError(error)}` → `{...base, ok:true, err:null}`（**`ok` 恒 true**） | 2 条 | ✅ **真红**：`读失败被渲染成了"还没有日志。"——这正是用户误判的成因` + `logs 是空数组但 ok 却是 true —— 假正常` |
| **RV2** | `panel.ts:662-664` 改成 `ok: logs.length > 0`（**由 length 推出 ok**） | 我的判据 1(a) | ✅ **真红**：`读到 0 条被误判成"读失败": expected false to be true` |
| **RV3** | `diagnostics.ts:94` `return 'unknown'` → `return raw`（**白名单失效，回退原始串**） | `abc123` 断言 | ✅ **真红**：`expected 'Error: token=abc123' to be 'unknown'` + 端到端 `not to contain 'abc123'` |
| **RV5** | `diagnostics.ts:94` 改成旧写法 `raw.length > 64 ? raw.slice(0,64)+'…' : raw`（**只截断长度、不做白名单**） | `abc123` 断言 | ✅ **真红**：同上两条 + `describeLogsError 返回了白名单之外的值` |
| **RV6-A** | 判据 5 分步第一步（只补 `.ok`） | 仍红且红点后移 | ✅ `reading 'err'` |
| **RV6-B** | 判据 5 分步第二步（两处都补） | 变绿 | ✅ `Tests 16 passed` |

- **基线**：未变异时守卫 `31 passed (31)` 全绿、探针只有"判据 5"一条红 —— 所以上面每一组"红"都是变异带来的。
- **还原**：6 组全部 `restored: true`，`panel.ts` SHA256 `6D0FB632…71D94C85`、`diagnostics.ts` SHA256 `BE73B539…9793452B` 变异前后逐字节一致；`.rvbak` 备份目录收工时已清空。

---

## 4. 两道附加判题

### 附加题 A · engineer 的"源码级断言不许出现 `String(e)`"改成"所有 return 只能来自白名单或 `'unknown'`"够不够强？

**够，而且我在 `tests/unit/content/panel-diagnostics-export.test.ts` 里复跑确认过它的边界。** 三层闭环：

1. **函数级**：`describeLogsError(new Error('token=abc123')) === 'unknown'`
2. **端到端**：导出的 JSON 全文不含 `abc123` / `sessdata`
3. **源码级（剥注释后）**：所有 `return` 只能是 `'unknown'` 或 `label`，且 `const KNOWN = [` 存在

RV3（`return raw`）与 RV5（长度截断）**两种绕过方式都被这三层一起抓住**（RV5 尤其关键：它是"看起来像白名单、实际只截断"的写法，只有第 3 层能抓）。
engineer 自己在注释里写明了为什么不断言"不许出现 `String(e)`"：`String(e)` 在函数开头用于**输入归一化**（非 Error 异常也要能读），那是合法的 —— **这个理由我认可**。

**唯一可加强的一点（低）**：第 3 层用的是正则 `/^(?:'unknown'|label)$/`，`label` 是 `KNOWN` 表的循环变量名。将来有人把循环变量改名（`label` → `lbl`），守卫会**假红**而不是漏报 —— 方向是安全的，但会产生噪声。建议把正则放宽成"标识符必须在 `KNOWN` 的 `for` 解构里声明过"，或直接把 `$KNOWN` 的条目数断言上。**不影响本次收卡。**

### 附加题 B · "mock 缺依赖就悄悄变 `ok:false`"这个边界要不要守住？

**要守，但本次的修法已经守住了，不需要新增代码。** 三个理由：

1. `probeLogsReadability()` 的语义本来就是"**试着读一次**，读不到就如实报 `ok:false`"。mock 缺 `chrome.storage` → 探针抛 → `ok:false` → 这正是**正确行为**，不是缺陷。
2. **真正的风险不是 `ok:false`，是 `ok:true` 但 `logs` 是空的**（"假正常"）。RV1 证明这条已经被守住了。
3. 需要守住的是**"缺依赖不能静默成成功"**，而现在的实现里 `ok:true` 只有一个来源：`try { await chrome.storage.local.get(null); return {ok:true, err:null} }`（`panel.ts:419-421`）。没有任何 catch 外的路径能给出 `ok:true`。

**但我确认 engineer 对那 5 条红真因的解释成立**（Lead 要求我独立确认、不许引用他的说法）：`panel-diag-wiring.test.ts` 的 mock 里 `chrome.storage.local.get` 在 `beforeEach` 里被 stub，而 `instanceId()` / `DIAG_LIMIT` 早期没 mock 时，`probeLogsReadability()` 的 `const base = { instanceId: instanceId(), ... }` 会直接抛 → 探针 `catch` → `ok:false` → 渲染失败态 → 断言"含刷新按钮"扑空。**我复跑 `tests/unit/content/panel-diag-wiring.test.ts` + `panel-diagnostics-export.test.ts`，31 条全绿**，与上述机制一致。他没说错，但**他的解释来自推理，我的结论来自复跑**。

---

## 5. 我认为他做对了什么

1. **探针放在 `readDiag()` 之前**，并且注释写清了"后者会吞异常，之后就没有线索"（`panel.ts:658-661`）—— 这是判据 1 能成立的**唯一前提**。
2. **catch 分支里也调探针**（`panel.ts:692`，传 `failure` 而不重试），并解释"此时 `chrome.storage` 可能都不存在，探针本身的异常不代表日志通道的原因"（`:411-415`）—— 这个区分是对的。
3. **`err` 用固定白名单 + 全量 `'unknown'` 兜底**，没有走"截断长度"那条看似够用的路。RV5 证明截断不够。
4. 端到端导出用例里 `URL.createObjectURL` / `revokeObjectURL` 的 stub **故意不还原**，因为 `downloadJson()` 的 `setTimeout` 排在用例之后 —— 这个细节写对了。

---

## 6. 待修清单

| # | 级别 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **高** | `src/content/panel/diagnostics.ts:341` **和** `:357` | `diagnosticsPane()` 在 `data.logsMeta` 缺失时抛 `TypeError`（两处连续解引用）。判据 5 不成立。 | 两处都要防：进入函数先 `const lm = data.logsMeta ?? { ok:false, err:'not-read-yet', count:0, limit: DIAG_LIMIT, instanceId:'', readAt: 0 }`，之后统一用 `lm`。**只补一处不算修完**（RV6-A 已证明）。修完请附守卫 + 该守卫的 RV。 |
| 2 | 中 | `src/content/panel/panel.ts:1064-1071` | 导出按钮的兜底 `logsMeta: diagData?.logsMeta ?? { ok:false, err:'not-read-yet', ... }` 是**正确的**，但它产生的是"值对象"；`diagnosticsPane()` 侧没有任何等价兜底。两处兜底不对称。 | 跟着 #1 一起收口，或在 `LogsMeta` 上加 `describeLogsMetaFallback()` 让两侧共用。 |
| 3 | 低 | `tests/unit/content/panel-diagnostics-export.test.ts` 源码级断言 | 正则 `/^(?:'unknown'|label)$/` 依赖循环变量名 `label`，改名会**假红**。 | 改成"标识符必须出现在 `KNOWN` 的 for 解构里"，或在断言里直接数 `KNOWN` 条目。 |
| 4 | 低 | `src/content/panel/diagnostics.ts:121` | 注释里把上限写成字面量「30 条环形缓冲」，常量一改注释就失真。 | 改成「`DIAG_LIMIT` 条环形缓冲」。 |
| 5 | 低（方法学） | 全卡 | 本卡的判据 5 是**后加的**（Lead 说"这是刚才那次真崩溃，新加的必验项"）。它一加就红，说明**当初那三处修复没有一条守住了"缺字段"这个面**。 | 沿用 task-25 定下的规则：**新增判据必须同时新增守卫 + 守卫要有 RV**。本卡再补一条：**"函数的入参是可空/可缺"这种假设必须写成守卫**，否则下一次调用方改一下又会崩。 |

**没有越界项**：`src/shared/types/` 全程为空（`git status --porcelain -- src/shared/types` 无输出）；`shouldPoll` / `LogsMeta` 都没溢出到 `src/shared/types`。

---

## 7. 写域核对

| 时点 | `git status --porcelain` 行数 | 说明 |
| --- | --- | --- |
| 开工（`git-status-baseline.txt`） | 48（不含我的目录） | 21 M + 27 ??，全部属 task-3/4/5/8/9/10/11 遗留 + task-26 |
| 收工 | 49 | 唯一增量：`?? poc/probe/verify-task26/`（我的） |

收工时的源码侧状态与开工一致：`src/content/panel/panel.ts` `6D0FB632…71D94C85`、`src/content/panel/diagnostics.ts` `BE73B539…9793452B`，**与我在 RV 开工前记录的 SHA256 完全一致**。`.rvbak` / `.rv-manual` 两个临时目录都已删除。

---

## 8. 方法学教训（给我自己，也给下一轮）

1. **"变异后没变红"不等于"守卫没用"** —— 我第一次做判据 5 的 RV 时，加了 `.ok` 防御后探针**仍然是红的**，差点得出"这条守卫是假的"的结论。真相是抛点有**两处**（`:341` `.ok` 和 `:357` `.err`），只补一处当然还红。**归因前先看抛错点后移到了哪一行**（`reading 'ok'` → `reading 'err'` 就是铁证）。
2. **"真红"要看断言消息，不能只看测试名**。变异体语法/类型不合时，用例可能挂在 import 或更早的断言上；那种红与判据无关。
3. **我自己写的 `.not.toContain()` 也是假绿源**。判据 2 第一版我断言"采集失败时页面含 `InPrivate 权限`"，实际 `panel.ts` 的 catch 分支把 `rows` 置空 → 那条断言红在**我自己写错**上。渲染输出的"不许出现"必须配一条"必须出现"。
4. **`node -e "..."` 里带中文/双引号/花括号的替换在 PowerShell 下会被拆词**（踩了 4 次）。改文件一律走 `edit`/`write` 工具或独立 `.mjs` 脚本。
5. **探针目录的 vitest config 三处硬坑**：`root` 必须指向探针目录（否则相对 `include` 解析到仓根）；`URL(p, import.meta.url)` 的基是**文件**，`../../../` 是三层不是四层；跑 RV 必须 `cache: false`，否则同一模块变异后可能读旧代码。

---

## 9. 附：产物清单

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 本报告 |
| `verify-21-green.txt` | `node scripts/verify.mjs` 全绿输出 |
| `vitest-full.txt` | 全量 vitest 111 文件 / 1840 条 |
| `git-status-baseline.txt` / `git-status-baseline-raw.txt` | 写域基线 |
| `probe-final.txt` | 我写的 16 条探针的最终状态（15 绿 / 1 红 = 判据 5） |
| `ok-is-real-signal.test.ts` | 判据 1，5 条，全绿 |
| `render-robust.test.ts` | 判据 2（3 条）+ 判据 5（1 条，红） |
| `err-whitelist.test.ts` | 判据 3（4 条）+ 判据 4（3 条），全绿 |
| `vitest.probe.config.ts` | 探针专用 config（`root` / 别名 / `cache:false`） |
| `rv.mjs` + `rv-lib.mjs` | 反向验证框架（备份→变异→跑→还原→SHA256） |
| `rv-result.json` / `rv-console.txt` | 5 组 RV 的逐条结果 |
| `seq-check.mjs` + `seq-steps.mjs` + `seq-check.txt` | 判据 5 的分步归因（只补一处→仍红；两处都补→变绿） |

# task-40 验收报告 · task-37 文案反转 + task-39 同步孤儿守卫

> 验收人：verifier（只审不写，写域仅本目录）
> 时间：2026-11-12 20:2x–20:5x　|　`node scripts/verify.mjs` → **✅ 21 项全绿（35.1s）**
> 工作区并发核对：RV 前 / 中 / 后三次 `git status --porcelain` **逐行相同（58 行）**，无他人的在途改动。

## 一句话结论

**A（task-37）接受**——两条断言反转有独立证据支撑，不是为绿改测试。
**B（task-39）🔴 未验收：它没落地。** `entrypoints/content-panel.content.ts` 里**没有任何 `chrome.runtime?.id` 代码**，只有注释（`L778`）；`git status` 与该文件 `mtime`（20:10:17，早于新建的 `orphan-hint.test.ts` 20:11:21）、SHA（`BC117D16…`，与 task-34 收工时逐字节一致）全部表明它没被改。新增的 `tests/unit/content/panel/orphan-hint.test.ts` 里也没有"runtime 为 undefined"的用例——**测不到一个不存在的守卫**，所以它现在全绿不代表任何事。

## A · task-37 两条断言反转：**接受**

### A1 先纠正卡里的描述（事实错误，非结论）

卡上写"两条 task-22 断言**口径反转**（`not.toContain` → `toContain`）"。**实测没有这回事**：
- `git show HEAD:tests/unit/content/panel-login-outcome.test.ts` = **83 行**，`describe` 只有一个（`★★ login/open 应答 → 用户提示`），**不含** `再点一次`，也**不含** `not.toContain('再点一次')`。那两条 task-22 断言从未进过 HEAD。
- 工作区是 **378 行 = HEAD 83 行 + 新增 295 行**，新增部分**纯追加**，**没有删除或翻转任何既有断言**。
- 所以准确说法是：**"删过的断言又被加回来"不是本次发生的事；发生的是"新写了一条正向断言 `toContain('再点一次')`"**。判"翻烧饼"的风险因此比卡里担心的低——但前提未验证，见 A3。

### A1.5 补充（20:3x）：这条注释是**未提交的**，没有历史可查

`git log -S '仍非空' -- entrypoints/content-panel.content.ts` 与 `git log -S 'chrome.runtime.id'` **均无任何提交命中** ⇒ 这段注释只存在于**工作区未提交的改动**里（更早的卡写的），所以：
- 无法用 git 追溯它是哪张卡、在什么实测下写的；
- 全仓 `git grep -e 仍非空 -e 部分形态` 只有 `:779` 这一处（另一处 `:498` 是 `hasCredential` 的无关用途）；
- ⇒ 它是**项目自己的一句话，且无出处**。"孤儿态下 `chrome.runtime.id` 非空"这条既没有实测记录，也没有被任何脚本验证过。

### A2 代码改动与证据的关系（这是判断的关键）

真机文案 `HEAD` 版（`src/content/panel/login-outcome.ts`）：

> 需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」），**再点一次**

工作区版：**然后再点一次「扫码登录」**。→ **删过的「再点一次」其实早就回来了**，本次只把宾语写全（「扫码登录」）。

证据链我**自己重跑**了（`read-flips-output.txt`，`node poc/probe/incognito-api-probe/read-flips.cjs`）：
- `[isAllowedIncognitoAccess reads] 658` / `[unique reads] 24` / `flips = 17` / `[true]=11 [false]=13` / `[instances] 23`
- 关键形态：**同一个值在一次观测里被两个不同的 SW 实例读出相反结果**（`11:19:13 true from=83dww9` → `11:19:35 false from=7anxdy`；`06:40:33 false from=0jyphl` → `06:41:46 true from=np5nnr`）。这是"读数抖动"最直接的样子——**权限值不可能在 22 秒内真的翻转两次后用户毫无感知**。

代码侧独立佐证（`src/background/login-window.ts:246-269`）：权限值**只写 diag、不做分支裁决**，`const allowed = await isIncognitoAllowed(); await diag('isAllowedIncognitoAccess', String(allowed));`，注释 `:264`「**权威判据是 `windows.create()` 本身**」。⇒ 「点多少次都读到 false」这条因果链确实断了 ⇒ 「再点一次」是**正确指令**。

⚠️ 一处口径出入（不影响结论）：注释里写「22 次去重、10/12、15 次翻转、21 个实例」，我**现在**重跑得到 **24 / 11/13 / 17 / 23**。日志在增长，两次都是"同一权限在多个 SW 实例上读出相反值"，结论方向一致；但**报告里的数字是某个时刻的快照，不能当常量引用**。

### A3 我的 RV 铁证（`rv-a.mjs`，备份复制 + SHA256 还原，未用 stash/checkout/reset）

| RV | 变异 | 结果 |
| --- | --- | --- |
| baseline | — | `Test Files 2 passed` / `Tests 27 passed` |
| **A2** | 把文案改回「…启用」）**（即删掉「再点一次」这一动作） | **1 failed / 26 passed**，红在 `★★★ 必须包含"再点一次"这个后续动作`：`expected '需要先在扩展详情页打开「在 InPrivate 中允许」（Chrome 叫…' to contain '再点一次'`；`restore 逐字节一致 = true` |

⇒ 这条新断言**能杀变异**，不是恒真。RV 后 `src/content/panel/login-outcome.ts` SHA `54280CA0…`、`tests/…/panel-login-outcome.test.ts` SHA `D8C86A1A…`，与 RV 前一致。

### A4 A 的边界（要写进结论里的限制）

- 「再点一次」是**正确指令**成立，但 **engineer 用来说明它的那条"popup 被拦"的真机证据我没能复核**：`poc/probe/incognito-api-probe/` 下只有 `read-flips.cjs` 一个文件，**task-36 的会话文件解码报告/脚本不在**。所以"用户看到的是说明页被拦、不是扫码窗"这条**是转述，未取到原始证据**。
- 我自己**从未**复现过「权限读到 false」到用户面前的完整链路，因此这条反转的**用户价值**我只能说"指令正确"，不能说"用户一定会照着做成功"。

## B · task-39 同步孤儿守卫：**未验收（代码不存在）**

### B1 现状（硬事实）

| 检查 | 结果 |
| --- | --- |
| 全仓 `runtime\s*\??\.\s*id` 的**代码**命中 | **1 处，且是注释**（`content-panel.content.ts:778`） |
| `entrypoints/content-panel.content.ts` | 未修改：`git status` 的 `M` 来自更早的 task-33；`mtime 20:10:17` **早于** `orphan-hint.test.ts 20:11:21`；SHA `BC117D167F3FDD3C…` = task-34 收工时值 |
| `.output/chrome-mv3/content-scripts/content-panel.js` | `mtime 20:19:54`，grep `runtime?.id` = 3 处，**均非守卫**（`showOrphanHint` 0 处、`openLogin` 0 处，已压缩/改名，无法据此判定） |
| `tests/unit/content/panel/orphan-hint.test.ts` 新增用例 | 探针场景只有 `send: 'throw-orphan' / 'ok'`，**没有 runtime 为 undefined 的用例** |

⇒ 卡里 B 的四条要求（①同步生效 ②RV 真红 ③假绿陷阱 ④stub 与真机一致）**无对象可验**。

### B2 但 B 有一个比"没落地"更值钱的发现：**这张卡的方案本身大概率是空操作**

`content-panel.content.ts:776-779`（task-33 写的）原文：

> 判据只有一条：**消息能否往返**。`chrome.runtime.sendMessage` 在孤儿上下文里会抛 `Extension context invalidated`，而 `chrome.runtime` 对象本身、`chrome.storage` 的旧监听器都还在 —— 所以只查 `chrome.runtime.id` 不足以判定（**它在部分形态下仍非空**）。

即：**项目内既有的、更早的真机结论是「孤儿态下 `chrome.runtime.id` 仍非空」**。若成立，`if (chrome.runtime?.id == null) return;` 在真机孤儿态下**恒不成立**——加进去等于 `if (false)`，正是 task-35 抓过的那类"看起来处理过了"的假象。

我**没有**独立实测"孤儿态下 `chrome.runtime.id` 到底是不是非空"（需要真实重载扩展 + 已注入页面，属真机取证），因此这条我标 **未确证**，但它必须先被证伪，task-39 才有意义。

### B3 另一个无论守卫加不加都存在的缺陷：**同步守卫加在入口也救不了**

`openLogin` 当前顺序（`entrypoints/content-panel.content.ts:190-220`）：

```
:192  stopPolling();                 ← 纯本地，不碰 chrome
:211  controller?.clearNotice();     ← 同步，碰 controller
:220  await readAccountMid()…        ← 异步边界之后才碰 chrome.runtime
:222  chrome.runtime.sendMessage(...)
```

若「浏览器重载扩展后**面板本身还在**」（用户当前场景），一条**同步** `if (chrome.runtime?.id == null)` 放在 `:191` **会执行**；但若面板 controller 已失去上下文、`clearNotice` 先抛，守卫就永远轮不到——守卫**必须挂在函数第一行**（`stopPolling()` 之前，或至少 `clearNotice` 之前）。这是可验证的顺序约束，不需要真机。

### B4 第三条会掩盖问题的路径（卡里点名要排的假绿陷阱）

`:249 if (!isOrphanHintShown()) controller?.showNotice(…)` 与 `:257 if (!isOrphanHintShown() && controller === null) showOrphanHint();` 两条都会在**主守卫失效**时给出提示。要构造"只有主守卫能救"的场景，必须同时满足：`sendMessage` 抛孤儿错 **且** `controller !== null` **且** `isOrphanHintShown()` 恒 `false`——此时 `:249` 会走 `controller.showNotice`（不是 `showOrphanHint`），`:257` 因 `controller !== null` 不成立，**于是 `showOrphanHint` 的调用次数只可能来自主守卫**。engineer 现有探针把 `controller` 设成 `'null'`，恰好没覆盖这个组合。

## 待修清单

| 级别 | 项 |
| --- | --- |
| **高** | task-39 **重开**：先回答「孤儿态下 `chrome.runtime.id` 是否为 null」——这是方案成立的前提；项目内既有注释（`content-panel.content.ts:778`）说**非空**。前提不成立就换判据（例如入口处 `try { chrome.runtime.id } catch` 或直接复用 `sendMessage` 的可达性判定）。 |
| **高** | 守卫**必须挂在 `openLogin` 第一行**（`stopPolling()` / `controller?.clearNotice()` 之前），否则面板半失活时轮不到它（B3）。 |
| 中 | task-39 的 RV 必须用 `controller !== null + isOrphanHintShown() 恒 false` 的组合，否则 `:249`/`:257` 会替他兜底造成假绿（B4）。 |
| 中 | 卡里 A 的描述「两条 task-22 断言口径反转」与事实不符（HEAD 里没有那两条断言，工作区是纯追加），请 Lead 更正记录，避免下一张卡继续按错误前提推理。 |
| 中 | 「孤儿态 runtime.id 非空」这条**只有注释、没有取证记录**；task-36 的解码证据（`need-incognito.html` 6 条窗口记录等）也不在仓库里。建议把这两类原始证据落盘，否则它们会一直以"转述"形式被引用。 |
| 低 | A 部分注释里的读数快照（22 次 / 10 / 12 / 15 / 21）已过期（现为 24 / 11 / 13 / 17 / 23），建议改写成"工具输出为准"或去掉具体数字。 |

## 产物

`REPORT.md`、`rv-a.mjs`（A2 反向验证，含 SHA256 双向核对）、`probe-orphan-shape.mjs` + `probe-orphan-shape-result.txt`（孤儿三形态探针）、`read-flips-output.txt`、`verify-output.txt`（21 项全绿）、`status-RV0-baseline.txt` / `status-before-B.txt` / `status-mid.txt` / `status-pre-restore.txt` / `status-final.txt`（并发核对）。

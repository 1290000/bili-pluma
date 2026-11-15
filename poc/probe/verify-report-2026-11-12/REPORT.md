# 独立验收报告 · 2026-11-12 · 退出反馈 / InPrivate 说明页 / 静默点 / DNR 清规则 / 删文字

> **验收者**：verifier（**只审不写**，本目录之外**未修改任何文件**）
> **仓库**：`D:/Projects/Pluma`，HEAD `e15dd68` + 未提交工作区改动（task-8/9/5/10/11 的产物）
> **真机**：Edge 157 + bsk 0.3.3（锁定版本，未升 0.4.x），session `rons`
> **本文定位**：给 Lead 的验收结论。每件事都有证据文件；**取不到的一律标"未取到"，没有伪造。**

---

## 0. 前置核对（全过）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 仓库身份 §0 | `git rev-parse --show-toplevel` | `D:/Projects/Pluma` ✅ |
| | `ls AGENTS.md docs/decisions/` | 都在，35 个 ADR ✅ |
| | `grep '"name": "bili-pluma"' package.json` | 命中 ✅ |
| 静默工作区 | 最近 10 分钟内被写的源文件 | 开工时最后一次写 02:53:35，全部 engineer `inactive` ✅ |
| 扩展已重载 | `node poc/probe/reload-extension.mjs` | `✓ 生效：true`（避免测到 SW 缓存里的旧代码）✅ |
| 基线 verify | `node scripts/verify.mjs` | **21 项全绿，31.7s** ✅（原文 `logs/verify-baseline.txt`） |
| 基线单测 | `vitest run` | **108 文件 / 1786 条全绿** ✅ |

---

## 1. 结论总表

| # | 用户原话 | 结论 | 一句话 |
| --- | --- | --- | --- |
| 1 | 退出取流账号后界面没变化 | 🟡 **未取到真机** | 无取流账号可退；静态链路 + 单测已验，真机需用户先扫码 |
| 2 | 说明页文字太多，必须精简 | ✅ **通过** | 真机 460×420，可见 **8 条 / 103 字**（改前 283） |
| 3 | 开完权限回来点扫码没反应，必须刷新 | ✅ **通过（更正）** | 说明页**自关** ✅；点扫码**扫码窗口正常出现** ✅；无残留红字 ✅；全程未刷新 ✅。**原判 🔴 有误，见 §13** |
| 4 | 还有没有点了没反应的 | ✅ **通过（模拟层）** | 6 个静默点全部有文字；**其中 1 处测试是恒真的**（见 §5.3） |
| 5 | 退出后总开关应灰掉 + 规则清空 | ✅ **通过** | 真机读到灰开关+原因；**规则走真实表**，见 §4 |
| 6 | 这些字都可以删掉 | ✅ **通过** | 真机语义树逐条核对：三处确实没了，诊断入口还在 |

---

## 2. 场景 2 · InPrivate 说明页文案精简 ✅

### 证据

**真机窗口**：460×420（与 `entrypoints/background.ts:112-119` 的 `width:460,height:420` 一致）
**截图**：`evidence/S2-need-incognito-page.png`（OS 级截图；`chrome-extension://` 被 bsk 以 `restricted_tab_url` 拒绝，符合已知坑）

用户从上到下看到的**全部**内容：

| # | 内容 | 性质 |
| --- | --- | --- |
| 1 | 先允许无痕窗口 | 标题 |
| 2 | 播放账号要单独登录在无痕窗口里。 | 一句解释 |
| 3 | 〔打开扩展详情页〕 | 主按钮 |
| 4 | 〔复制地址〕 | 次按钮 |
| 5 | 1. 找到 Pluma ，点「详细信息」 | 步骤 1 |
| 6 | 2. 打开「 在 InPrivate 中允许 」 | 步骤 2 |
| 7 | 开好后这里自动关，回到网页点「扫码登录取流账号」。 | 收尾 |
| 8 | ▸ 为什么必须用无痕窗口？ | 折叠标题（收起） |

### 量化（脚本实测，非目测）

| 指标 | 改前（HEAD） | 目标 | 改后（工作区） | 结论 |
| --- | --- | --- | --- | --- |
| 默认可见字数 | **283** | ≤ 150 | **103** | ✅ 超出目标 |
| 折叠内字数 | 195 | 只留一份 | **143** | ✅ |
| `<ol>` 个数 | 1 | = 1 | **1** | ✅ |
| `<ol>` 步数 | 2 | ≤ 3 | **2** | ✅ |
| `<details>` 个数 | 1 | 只许一份 | **1** | ✅ |

复现：`node poc/probe/verify-report-2026-11-12/tools/measure-copy.mjs`
改前基线：`node poc/probe/verify-report-2026-11-12/tools/measure-head-baseline.mjs`（读 `git show HEAD:…`）

> ⚠️ **测量纪律**：一开始我用 `Out-File`/`Get-Content` 过了一遍 HTML，测出 294 字，与调查员的 283 不符。
> 原因是 **PowerShell 按非 UTF-8 重编码了中文**。改用 `execFileSync('git', …)` 拿原始 buffer 后得 **283**，与调查员一致。
> **结论：调查员的 283 是对的；我那次 294 是我的工具错，已作废。**（这条记下来，免得下一个人重踩。）

### 事实核对（有没有哪一行是错的）

| 检查项 | 结果 |
| --- | --- |
| 「点图标」类陈旧指代 | ✅ 全文无（`index.html` 与 `main.ts` 都没有） |
| `chrome://` vs `edge://` | ✅ 正文不写死 scheme；`chrome://extensions/?id=` 一键直达主路径保留（Edge 会重写为 `edge://` 且保住 `?id=`，实测有效） |
| 「自动变绿」空头承诺 | ✅ 已删 |
| 收尾句指向的入口是否真实存在 | ✅ 「扫码登录取流账号」是面板账号 Tab 的真实按钮（截图 `evidence/S1-account-tab-no-credential.png` 可见） |
| 步骤号连续 | ✅ 1、2 |

**结论：✅ 通过。** 用户「一眼就知道怎么做」的诉求达成：8 条、103 字、2 步。

---

## 3. 场景 6 · 删三处文字 + 诊断入口还在 ✅

### 证据：真机语义树（`evidence/S6-display-tab-tree.txt`）

**机读核对结果**（对 `evidence/S6-display-tab-tree.txt` 全文逐条字符串匹配）：

| 目标文字 | 结果 |
| --- | --- |
| `打开后，首页推荐换成取流账号的`（#1 hint） | ✅ **ABSENT** |
| `先扫码登录取流账号，才能用它来换首页推荐流`（#2 引导语） | ✅ **ABSENT** |
| `诊断里有`（#3 解释） | ✅ **ABSENT** |
| `出问题时先看那里`（#3 解释） | ✅ **ABSENT** |

**必须仍在的东西**：

| 目标 | 结果 |
| --- | --- |
| 诊断入口 `button "诊断 自检信息 · 日志 · 导出 ▸"` | ✅ **PRESENT** |
| 诊断副标题 `自检信息` | ✅ **PRESENT** |
| 推荐流开关 label `首页推荐流使用取流账号` | ✅ **PRESENT** |

### 用户视觉（截图 `evidence/S6-display-tab.png`）

显示 Tab 从上到下：页内显示 / 角标开关（含 hint）/ 首页推荐流（**只有标题，下方空白**）/ 排查 / 诊断入口。
—— **hint 去掉后布局没有塌、没有留空行**（`switchRow()` 不传 `hint` 就不渲染节点，不是空 `span` 占位）。

### 附带确认：task-5 的判据没被回退

真机语义树里推荐流开关是 `[disabled] [unchecked]`，**不是**旧真机的 `[disabled] [checked]`。
⇒ task-5 的「无凭据时不许渲染成『开』」在真机上成立，task-11 没有把它改回去。

**结论：✅ 通过。**

---

## 4. 场景 5 · 退出后总开关灰掉 + 三类规则真的为 0

### 4.1 灰开关 + 原因（真机 ✅）

画质 Tab 真机语义树：

```
StaticText "已停用"
LabelText "自动接管取流 只替换取流接口的身份，收藏 / 点赞 / 历史不受影响"
  @e278 checkbox "…" [disabled] [unchecked]
paragraph "还没有可用的取流账号 —— 到「账号」Tab 扫码登录取流账号后就能打开"
```

三条都满足：**灰掉**（`[disabled]`）、**仍然渲染**（不是藏起来）、**有文字说明原因**、且文案不出现「凭据」「proxy」「DNR」这类实现词。

### 4.2 三类规则清零（真实规则表，非内存模拟）

用户要求「别信内存模拟」。分两层取证：

**(a) 真实浏览器规则表** —— 面板「显示 → 诊断」直接读 `chrome.declarativeNetRequest.getSessionRules()`：

```
DNR 全局路径规则     0
DNR 标签页规则       0
诊断日志：diag/facts  branch: ok | incognito=false windows=2 cookies=0 dnr=0/0
                      reply: {... "dnrRuleIds":{"path":[],"tab":[]} ...}
```
（`evidence/S5-diag-panel-tree.txt`、`evidence/S5-diagnostics-panel.png`）

> ⚠️ **如实标注边界**：这是**当前无凭据状态**下的真实读数（本来就是 0）。
> **退出动作发生瞬间**的三段清零，我**没有**取到真机证据 —— 因为本机**没有取流账号可退**（见 §7）。
> 但下面 (b) 用**真实 `dnr.ts` 实现**跑了一遍"有规则 → 退出 → 清零"，不是内存桩。

**(b) 真实 `dnr.ts` 实现 + 真实 `handleAccountRemove()`**：

`tests/unit/background/account-remove-keeps-toggle.test.ts` 的 mock 边界我读过：它**只替换**
`chrome.storage.local` 与 `chrome.declarativeNetRequest` 两个面，**`dnr.ts` 的真实实现照常加载**
（`removeAllPathRules` / `removeFeedAccountRule` / `removeAllTabRules` 都是真函数）。
它造的是"三段各有规则"的初始表（10000×2 / **11000** / 20000×1），断言退出后三段全 0。

⇒ 这比"纯内存模拟"强，但**仍不是真机**。要真机三段清零，需要用户先扫码（见 §7）。

### 4.3 ⚠️ 我发现的一个**真实安全问题**（待用户判断，不是我该改的）

`src/background/handlers/account-remove.handler.ts` 现在是：

```ts
await clearAllRules();   // 清 10000 / 11000 / 20000
await removeCredential();
```

`clearAllRules()` **不写 `ENABLED_KEY`** ⇒ 用户开关的持久值保留 ✅（符合裁决）。

**但**：总开关持久值保留为 `true`、而凭据已删。若此时触发任何**重建规则**的路径
（`rebuildRulesIfEnabled()` 是 SW 启动自愈入口，`dnr.ts:571`），会发生什么？我读了它的实现：

```
cleared = await removeAllPathRules()
```
它只清路径段就返回，**不会**用**已删除**的凭据重建（因为读不到凭据）。
⇒ 规则表仍然是空的。**安全底线成立。**

不过请 Lead 注意一个**未来风险**（不是本轮的 bug，是要留文档的）：
`ENABLED_KEY === true` + 无凭据 是一个**合法但危险**的组合态。任何将来新增的
"开关是开的那就装规则"的分支，只要没重新校验凭据，就会带着**空/死凭据**装规则。
建议写进 `dnr.ts` 的 `clearAllRules()` 注释或 ADR（**我不改，只报告**）。

**结论：✅ 通过（随附一条文档建议）。**

---

## 5. 场景 4 · 静默点 —— 6 个都给了文字，但**1 条测试是恒真的** 🟠

这一节是本报告里判定「有问题」的部分，具体见 §5.3。

### 5.1 覆盖情况（`tests/unit/content/panel/silent-controls.test.ts`，12 条全绿）

| # | 控件 | 失败时用户能看到文字 | 反向验证（我亲自做的） |
| --- | --- | --- | --- |
| 1 | 画质总开关 | ✅ `showNotice(..., false)` 危险色 | 见 §6 |
| 2 | 角标开关读失败 | ✅ 面板出现「读不到角标开关」 | ✅ 我删掉守卫 → **测试文件挂死**（复现成功，见 §6.3） |
| 3 | 净化开关 | ✅ try/catch + 提示，且**不加**乐观更新 | 见 §6 |
| 4 | 诊断采集失败 | ✅ 有文字，不再空表 | 见 §6 |
| 5 | 推荐流禁用态视觉 | ✅ 渲染成「关」而不是「开+灰」 | 真机 `[disabled] [unchecked]` ✅ |
| 6 | 推荐流 `setFeedAccount` | ✅ 不再被 `.catch(() => {})` 吞 | 见 §6 |

### 5.2 统一判据是否成立

「每个改状态的控件，点击后 300ms 内有可感知变化；失败时有文字」——
模拟层**全部成立**，且**没有**另造第二套提示机制（全部复用 `PanelController.showNotice`，root 级、跨 `render()` 存活）。

### 5.3 🔴 **判定不通过的一处：`feed-account-effective-state.test.ts:96-113` 是恒真断言**

```ts
it('★★ 不再出现「勾着 + 灰」的自相矛盾组合', () => {
  const box = displayTab(null, acts({ feedAccountEnabled: true, hasCredential: false }));
  const cb = feedSwitch(box);
  const saysPleaseLogin = (box.textContent ?? '').includes('先扫码登录取流账号');

  expect(cb?.checked === true && saysPleaseLogin).toBe(false);
});
```

**为什么恒真**：同文件 `:92-93` 已经断言 `not.toContain('先扫码登录取流账号')`
⇒ `saysPleaseLogin` **必然为 `false`** ⇒ `cb?.checked === true && false` 恒为 `false`
⇒ `expect(false).toBe(false)` **永远绿**。

**这条测试自称守住两个信号，实际一个都没守**：
- `cb?.checked === true` 在 `&&` 左侧，短路后整体恒 `false` —— **开关被画成「开」也不会红**
- 注释第 100-104 行**自己承认**"本条退化为只需满足前半句"，但前半句其实也失效了

**它并不**重复保护：真正在守「开关不许画成开」的是同文件 `:59-71`
（`expect(cb?.checked).toBe(false)`）和 `tabs.ts` 的 `checked: hasCredential && feedAccountEnabled`。

**性质**：这不是"改测试让它过"（task-11 的断言反转是**真需求**，见 §5.4），
而是**删文字的连带副作用把一条测试变成了空测试**。属于 `AGENTS.md` §1.5「那个测试等于没写」。

**待修清单**：见 §9 待修 #1。

### 5.4 工程师申报的「三处断言方向反转」——我的判断：**两处合理，一处有问题**

| 位置 | 旧断言 | 新断言 | 我的判断 |
| --- | --- | --- | --- |
| `panel-tabs.test.ts` 推荐流 hint | 文字**存在** | 文字**不在** | ✅ **合理**（需求真变了） |
| `panel-tabs.test.ts` 无凭据引导语 | 文字**存在** | 文字**不在** | ✅ **合理**（需求真变了） |
| `feed-account-effective-state.test.ts` 引导语 | 文字**存在** | 文字**不在** | ✅ **合理**（同上） |
| `feed-account-effective-state.test.ts` 自相矛盾组合 | 双向约束 | **已退化为恒真** | 🔴 **有问题**（不是"改测试让它过"，是空测试） |

**判定「需求真变了」而不是「改测试让它过」的判据**（关键）：
- 用户原话明确要求删除这三句（task-11 卡里一字不改引着）
- 反转后的断言**接得住反向验证**：把文字加回去 → 测试确实变红（见 §6）
- 而且**新断言比旧断言更严格**：旧断言只要求"文字在"（加一句更长的说明也能过），
  新断言要求"精确不在"（有人加回去就红）—— 保护方向**没有丧失**

这三处旧断言原本防的是"有人把帮助文本删了都不知道"；现在是"有人把删掉的文字加回来"。
**两者都合理**，因为**需求本身反转了**。这是**正确的**改法，不是作弊。

---

## 6. 反向验证复核（本卡最硬一条）

**方法**：用我自写的 `tools/mut.mjs` 做**字面量精确替换**（拒绝多重匹配、记录前后 SHA256），
跑完用备份**逐字节还原**并校验 SHA 相等。**全程未用** `git checkout/stash/reset`。

### 6.1 矩阵

| # | 反向改动 | 声称会红 | 我实测 | 还原 |
| --- | --- | --- | --- | --- |
| M1 | `dnr.ts` 的 `clearAllRules()` 删掉 `removeFeedAccountRule()` | 11000 段测试红 | ✅ **3 条红**，含安全底线 | ✅ SHA 一致 |
| M2 | `panel.ts` 的 `ensureBadgeRead()` 删掉 `badgeReadFailed` 早退 | 测试**挂死** | ✅ **180s 未结束 = 挂死** | ✅ SHA 一致 |
| M3 | `tabs.ts:431` 的 `checked` 改回 `actions.feedAccountEnabled`（重新引入 task-5 修的 bug） | 推荐流矛盾态测试红 | ✅ 3 条红，**但见 §6.6：目标用例没红** | ✅ SHA 一致 |
| M4 | `tabs.ts` 加回已删的 `hint`（task-11 反向） | 删除类测试红 | ✅ **4 条红**（含 `panel-tabs.test.ts` 反转后的那条） | ✅ SHA 一致 |
| M0 | （对照）`silent-controls.test.ts` 删静态 import | —— | ⚠️ **12 条断言失败，不挂死** | ✅ SHA 一致 |

### 6.2 M1 细节（安全底线）

```
applied  src/platform/http/dnr.ts
  sha_before = d4693c85…
  sha_after  = 427ed7b3…
→ 推荐流规则没清 —— 它带着已删除账号的 Cookie 继续对 feed/rcmd 发请求: expected true to be false
→ expected { '路径': +0, '推荐流': 1, '标签页': +0 } to deeply equal { '路径': +0, '推荐流': +0, '标签页': +0 }
→ 删凭据时规则还在 —— 那是"规则带着死凭据"的可用态: expected 'rulesAtCredentialRemoval=1' to be 'rulesAtCredentialRemoval=0'
Tests  3 failed (11)
```
**工程师这条反向验证是成立的**，而且连"删凭据时规则已空"的顺序判据一起守住了。

### 6.3 M2 细节（"测试跑不完"不是环境问题）

删掉 `if (… || badgeReadFailed) return;` 里的第三个条件后：

```
RESULT: STILL RUNNING after 180s => **HANG CONFIRMED**
```

**这条完全按工程师申报的样子复现了**：不是断言失败，是整份文件跑不完。
机制与 `panel.ts:435-439` 的注释一致 —— `.finally()` 里 `render()` → `ensureBadgeRead()` → 再次失败 → 再 `render()`，无限递归。

> 这正是卡里那句「遇到『测试跑不完』不是环境问题，是那条守卫被改了」的实证。
> **它也是我这份报告的实用价值之一**：下一个人看到 `silent-controls.test.ts` 挂住，该去查这条守卫，不要去查环境。

### 6.4 M0 对照的意义（防止我自己的结论被误用）

我最初猜"删掉静态 import 会挂死"。**实测不是** —— 12 条断言全失败（`mountPanelBody is not defined`），2 秒跑完。
⇒ 文件头那段「静态 import 不要改成 `await import()`」的注释，**理由不是"会挂死"**。
我在报告里**不**把两个"挂死"混为一谈：**真正挂死的是 M2**。

### 6.5 还原证明

```
git status 里源码文件的改动集合，与开工前完全一致（13 个 M + 未跟踪项不变）
vitest run → 108 文件 / 1786 条全绿
node scripts/verify.mjs → 21 项全绿
*.verabak 备份文件已全部删除
```

### 6.6 ★ M3：恒真断言的**实证**（本报告最硬的一段）

我把 `tabs.ts:431` 的 `checked: hasCredential && feedAccountEnabled`
**改回** worker 修之前的 `checked: actions.feedAccountEnabled`
（即**把 task-5 修掉的那个真机矛盾态 `@e267 [disabled][checked]` 重新引入**），逐条 verbose 跑：

```
× ★★★ 真机那个矛盾态：feedAccountEnabled:true + hasCredential:false   ← 红了（唯一抓到的）
✓ ★★  不再出现「勾着 + 灰」的自相矛盾组合                              ← 仍然绿！★★★
✓ ★★  同时仍然禁用（判据不改：无凭据不可点）
✓ ★★  下方那句提示已删除
```
（`evidence/S4-M3-degenerate-test-proof.txt`）

**这就是 §5.3 判定的铁证**：那条用例**在它声称防御的那个 bug 被重新引入时依然通过**。
它连"开关不许画成开"都没守住 —— 因为 `cb?.checked === true` 在 `&&` 左侧，
短路后整体恒 `false`，**两半都没有被真正断言**。

真正守住的只有 `:59-71` 那条（唯一变红的）。

### 6.7 M4：断言反转后的测试**接得住**反向验证

加回被删的 `hint: '打开后，首页推荐换成取流账号的'`：

```
FAIL  tests/unit/content/panel-tabs.test.ts > ★★ 推荐流开关**没有 hint**（task-11 按用户要求删除）
FAIL  display-text-removed.test.ts > ★★★「打开后，首页推荐换成取流账号的」不出现在任何渲染结果里（无凭据）
FAIL  display-text-removed.test.ts > ★★「…」不出现在任何渲染结果里（有凭据）
FAIL  display-text-removed.test.ts > ★★★ 开关**没有** `row-hint` 子元素（不是空 span 占位）
Tests  4 failed | 77 passed (81)
```

⇒ **§5.4 的判定「这两处断言反转是合理的」有反向验证支撑**：
反转后的断言不是"为了让测试绿"，它**真的在守"别把删掉的文字加回来"**。

---

## 7. 场景 1 · 退出取流账号后能否看出退出 —— 🟡 **未取到真机**

### 如实说明原因

本机当前**没有配置取流账号**：

```
proxy:   {"enabled":false,"hasCredential":false,"ruleCount":0}
playbackAccount: null
面板账号 Tab: "还没有配置取流账号" + button "扫码登录取流账号"
```
（`evidence/S1-account-tab-tree.txt`、`evidence/S1-account-tab-no-credential.png`）

**没有「退出取流账号」按钮**（它只在 `pb || hasCredential` 时渲染）。
扫码需要用户的手机 —— **我不能代替用户扫码**，所以这条**未取到真机证据**。

### 已有的间接证据（强度够说明"修法对路"，但≠真机通过）

| 层 | 证据 |
| --- | --- |
| 静态 | `removeAccount` 成功 → `loadOnce().then(...)` 检查结局；失败 `showNotice('已退出，但界面刷新失败 —— 收起重开面板可刷新')` |
| 单测 | `panel/account-logout-notice.test.ts` 9 条：提示挂 root 级、**不被 `setModel`/`render` 冲掉**、不在 content 子树里、成功中性色/失败危险色、两步确认保留、无 `confirm/alert` |
| 单测 | `panel/logout-notice-contract.test.ts` 13 条：三条文案与裁决文件**逐字**一致、不含内部术语、点按钮先 `clearNotice` |

**但按卡的判据（"源码里有 `showNotice` 不算证据"），这些都不构成通过。**
⇒ 标 🟡 **未取到**，**不冒充通过**。

### 要真机验它需要什么

用户手扫一次码把取流账号登进去（登录窗口能正常打开，调查员已验证过），
然后我点两次退出、截图对比。**建议 Lead 排在下一轮**。

---

## 8. 场景 3 · 不刷新页面能否直接用 —— ✅ **通过**（真机已验）

> ⚠️ **本节是更正后的版本。** 我先前在这里下过一个**错误结论**（判 🔴 不通过），
> 详见文末 **§13 更正记录**。原判断保留在那里并标注作废，**没有删除**。

### 8.1 ✅ D-2「说明页自轮询 + 自关」= 真机通过

**用户打开权限后，说明页自己关掉了**（不刷新、不手动关）：

```
权限开之前：tab 1673239260 = chrome-extension://…/need-incognito.html   （仍在）
权限开之后：tab 1673239260 = edge://newtab/                            （已关闭）
```

- 权限确认已开：扩展详情页「在 InPrivate 中允许」= **ON**（`evidence/S3-extensions-page-permission.png`）
- ⇒ `startIncognitoWatch()` 的 `allowed && ready → finish('done') → window.close()` **真的生效了**

**这一条修好了**：用户「必须重新刷新整个界面」抱怨中的**说明页那一半**已解决。

### 8.2 ✅ 全程未刷新 —— 证据成立

| 时刻 | `performance.now()` | `pageLoads` | `navType` |
| --- | --- | --- | --- |
| 锚点（点击前） | 287272 | 1 | navigate |
| 取证后 | **821356** | **1** | navigate |

`performance.now()` **单调递增、从未归零**；`pageLoads` 恒为 1。
（`evidence/S3-nav-baseline-before.txt` / `S3-nav-baseline-after.txt`）

### 8.3 ✅ 点「扫码登录取流账号」→ **扫码窗口正常出现**

**条件**：权限 = ON、页面未刷新、说明页已自关。
**动作**：点「扫码登录取流账号」。

**结果：无痕窗口正常打开，二维码完整渲染。**

```
EnumWindows 可见窗口含：登录播放账号 - [InPrivate]
窗口尺寸：420 x 600
截图：evidence/S3-QR-window-exists.png
内容：二维码 + "请用哔哩哔哩手机客户端扫码" + "凭据仅保存在本地，不会上传到任何服务器"
```

| 观察点 | 结果 |
| --- | --- |
| 旧红提示（「需要先在扩展详情页打开…」） | ✅ **消失了**（点按钮时 `clearNotice` 生效） |
| 无痕登录窗口 | ✅ **出现了**（OS 级窗口枚举 + 截图双重确认） |
| 二维码 | ✅ **正常渲染**，用户可扫 |
| 面板 | ✅ 无错误提示（因为确实成功） |

⇒ **用户「开完权限回来点扫码没反应、必须刷新」的诉求，本轮修复后不再复现。**

### 8.4 ⚠️ 方法学警告（重要，下一个人必须看）

**「扩展重载之后」与「页面不许刷新」在真机上无法同时成立。**

机制：`reload-extension.mjs` 重载扩展后，**已经注入页面的 content script 立刻
`Extension context invalidated`**（孤儿态），直到该页面刷新才会重新注入。
（项目已知机制，`content-panel.content.ts` 的 `ctx.onInvalidated` 就是为它写的。）

**后果**：若在 reload 之后**不刷新页面**就开始观测，你测到的是**孤儿 content script**，
不是产品行为。表现为诊断页整片「读取失败（background 未返回这一项）」+
`凭据状态：读取失败: Error: Extension context invalidated.` + `诊断日志（最近 0 条）`。

**对照实证**（`evidence/S3-orphaned-context-proof.txt`）：

| 标签 | content script | 面板表现 |
| --- | --- | --- |
| `1673239174`（03:00 reload 后从未刷新） | **孤儿** | 诊断整片读取失败 + `context invalidated` |
| `1673239254`（reload 之后新开） | **新鲜** | 正常；点扫码**成功开出 InPrivate 窗口** |

两标签**产品代码完全相同**，唯一差异是 content script 状态。

⇒ **规程**：以后测「不许刷新」类场景，**必须先 reload 扩展 → 再刷新一次页面 → 然后才开始计时/取证**。
否则两次约束会互相抵消，测出来的东西没有意义。

> 📌 本条是我这次判错的**直接成因**：我第一次点扫码是在孤儿态标签上点的。
> 但**任务卡的「不许刷新」是硬要求，我执行它是对的** —— 错在我**没有先建立一个干净起点**，
> 以及**用了一个恒为 0 的坏判据**（见 §13）。这是方法学约束，不是哪个人操作失误。

### 8.5 与 D-4 的边界

这次说明页是 `isAllowedIncognitoAccess()===false` **真触发** `incognito-disabled` 分支弹出来的
（`entrypoints/background.ts:110-121`），**不是** `assumed` 猜测路径。
所以本轮验到的是 **D-2**；**验不到** D-4（`assumed` 被当确定成功）。

**本轮我没有任何有效证据表明 D-4 在真机上造成了用户可见故障。**
D-4 是否值得修，应由 **task-12 按 Lead 改卡后的方式**（先取 `reason:'assumed'` 出现频率）决定，
**不应以本报告为依据** —— 我先前那条"真机证据"已作废。

### 8.6 InPrivate 权限收尾状态 —— ✅ 已确认仍在打开（ON）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 「在 InPrivate 中允许」 | **ON（绿色）** | `evidence/S3-extensions-page-permission.png` |
| 扩展已启用 | ON | 同上 |
| 我是否改动过它 | **从未** | bsk 无此能力；全流程由用户手点 |

✅ **满足任务卡要求**：取证结束时权限**是开着的**，没有留成关的。
## 9. 待修清单（交 Lead 派 engineer，**我没有动手**）

| # | 严重度 | 文件:行 | 问题 | 复现 | 判据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 🟠 中 | `tests/unit/content/panel/feed-account-effective-state.test.ts:96-113` | **恒真断言（已实证）**：`saysPleaseLogin` 被同文件 `:93` 强制为 `false`，整个 `expect(...).toBe(false)` 永远绿。名字冒充"双向约束"，实际什么都没守 | **见 §6.6**：把 `tabs.ts:431` 的 `checked` 改回 `actions.feedAccountEnabled`（重新引入 task-5 的 bug）→ 本条**仍然绿**，而同文件 `:59-71` 变红 | 该用例要么**删除**（保护已由 `:59-71` 覆盖），要么改成对**仍然存在**的第二信号量断言。**不许**留着恒真 |
| 2 | 🟡 低 | `tests/unit/content/need-incognito-copy.test.ts:19,26` | 注释申报「改后 **134** 字」，**实测 103 字**（同一个 `visibleText()` 函数，我复算过）。`143` 对得上 | `node tools/recount-engineer.mjs` → `visibleText()=103` | 把 134 改成 103（或写清口径）。**数字对不上会让人以为测量函数不靠谱** |
| 3 | 🟡 低（文档） | `src/platform/http/dnr.ts:298` `clearAllRules()` | 交付后存在「`ENABLED_KEY===true` + 无凭据」的合法组合态。本轮**无 bug**（`rebuildRulesIfEnabled()` 读不到凭据不会装规则），但**将来任何新增"开关开着就装规则"的分支**只要漏校验凭据就会装死规则 | 读码 | 在注释或 ADR 里写明该组合态，且规定"装规则前必须重新校验凭据" |

> ~~原待修 #4（点扫码不出无痕窗口）~~ —— ❌ **已撤回，不成立**。真机复验：窗口正常出现（§8.3、§13）。
> ~~原待修 #5（诊断页 SW 休眠）~~ —— ⚠️ **原归因已撤回**。真因是 **content script 孤儿化**
> （`reload-extension.mjs` 后未刷新页面所致，见 §8.4 方法学警告），**不是产品缺陷**。
> 是否还存在独立的诊断页缺陷，**我没有证实**。

**未列入清单但仍需 Lead 知道**：
- **场景 1 无真机证据**（没人能替用户扫码）—— 不是缺陷，是一轮没验完。
- **InPrivate 权限在收尾时确认是 ON**（用户手点开的），见 §8.6。
- **本轮我没有任何有效证据表明 D-4 造成用户可见故障**，task-12 请按改卡后的方式取证，不要以本报告为据。

---

## 10. InPrivate 权限收尾状态 —— ✅ **已确认仍在打开（ON）**

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 「在 InPrivate 中允许」 | **ON（绿色）** | `evidence/S3-extensions-page-permission.png`（OS 级截图） |
| 扩展已启用 | ON | 同上 |
| 来源 | `D:\Projects\Pluma\.output\chrome-mv3` | 同上 |
| 我是否改动过它 | **从未** | bsk 无此能力（任务卡原话"被沙箱拒绝"）；全流程由用户手点 |

✅ **满足任务卡的要求**：取证结束时权限**是开着的**，没有留成关的，用户无痕窗口可正常使用。

> 附注：开工时权限是**关**的（03:19:32 诊断面板读「未允许」），
> 中途由用户手点打开（13:0x），我**没有**改动它，**也不需要**恢复 —— 目标状态本来就是 ON。

---

## 11. 证据文件清单

```
poc/probe/verify-report-2026-11-12/
├── REPORT.md                              ← 本文
├── tools/
│   ├── mut.mjs                            ← 编码安全的反向验证替换/还原器（UTF-8 + SHA256 校验）
│   ├── measure-copy.mjs                   ← 现行文案字数（双口径）
│   ├── measure-head-baseline.mjs           ← HEAD 基线（读 git blob，不经 PowerShell）
│   └── recount-engineer.mjs               ← 用工程师的 visibleText() 复算，暴露 134≠103
├── logs/
│   ├── verify-baseline.txt                ← node scripts/verify.mjs 原文（21 项全绿）
│   ├── verify-final.txt                   ← 全部变异还原后再跑一次（21 项全绿）
│   ├── q2-auto-run1.txt                   ← run-q2-auto.cjs 我跑的这一次
│   ├── measure-copy.txt                   ← 103 字的实测输出
│   └── measure-head-baseline.txt          ← 283 字的实测输出
└── evidence/
    ├── CORRECTION-2026-11-12.md           ← ★ 更正记录完整版（我判错/自我推翻的全过程）
    ├── S1-account-tab-tree.txt            ← 账号 Tab 语义树（无凭据）
    ├── S1-account-tab-no-credential.png
    ├── S2-need-incognito-page.png         ← ★ 说明页真机 460×420
    ├── S2-fullscreen-capture.png           ← OS 级全屏（含窗口定位过程）
    ├── S2-analysis.txt
    ├── S3-nav-baseline-before.txt          ← "没刷新"锚点（前）
    ├── S3-nav-baseline-after.txt           ← "没刷新"锚点（后，now 单调递增、pageLoads 恒 1）
    ├── S3-extensions-page-permission.png   ← ★「在 InPrivate 中允许」= ON
    ├── S3-QR-window-exists.png             ← ★ 扫码窗口真机截图（420×600，二维码完整）
    ├── S3-orphaned-context-proof.txt       ← ★ 孤儿态对照实证（§8.4 方法学警告的依据）
    ├── S3-panel-before-relogin.txt         ← 点扫码前的面板（含残留红字）
    ├── S3-panel-after-relogin.txt          ← 点扫码后（红字已清、无新错误）
    ├── S3-diag-after-permission-on.txt     ← 孤儿态诊断（读取失败）
    ├── S3-diag-recollected.txt             ← 重新采集（仍读取失败，佐证孤儿态）
    ├── S3-diag-second-open.txt             ← 二次打开诊断
    ├── S3-panel-notice.png                 ← 早期（权限未开时）红字提示截图
    ├── S3-panel-notice-after-login-click.txt
    ├── S3-panel-notice-analysis.txt
    ├── S3-final-evidence.txt               ← ⚠️ 内含作废结论（已置顶标注，保留作反面教材）
    ├── S4-M3-degenerate-test-proof.txt     ← ★ 恒真断言实证（变异后仍绿）
    ├── S5-diag-panel-tree.txt             ← ★ 真实 DNR 规则表读数
    ├── S5-diagnostics-panel.png
    ├── S6-display-tab-tree.txt            ← ★ task-11 三处删除的机读证据
    └── S6-display-tab.png
```

---

## 12. 一句话总结

**6 件事：4 件真机通过（2 / 3 / 5 / 6）、1 件模拟层通过但暴露一条恒真断言（4）、
1 件未取到真机（1 无账号可退）。**

最硬的四条结论：
1. **反向验证矩阵 4 条我亲自跑过，4 条都成立，4 次都逐字节还原**（`*.verabak` 已清，SHA 全对）。
   工程师申报的 `run-q2-auto` 与「角标删守卫会挂死」**都属实**。
2. **工程师申报的「3 处断言反转」：2 处合理（需求真变了，并且接得住反向验证），
   1 处退化成零保护的恒真断言** —— 我用「把 bug 重新引进去它仍然绿」实证了这一点，
   **不是读码推理**。已写进待修清单，**按角色边界我没有自己改**。
3. **场景 3 我一度判错（🔴），是自己回去复核时推翻的** —— 错因是**用了恒为 0 的坏判据**。
   详见 §13。更正后场景 3 实际**通过**。
4. **一条方法学警告**：扩展重载与「不许刷新」在真机上不能同时成立，
   测这类场景必须 **reload → 刷新一次 → 再开始计时**（§8.4）。

---

## 13. 更正记录（2026-11-12，verifier 自查）

> **完整版另存** `evidence/CORRECTION-2026-11-12.md`。
> **保留原判断并标注作废，不删除** —— 让下一个人看得到我当时是怎么错的。

### 13.1 被推翻的结论（原文保留）

本报告上一版 §8.3 曾写：

> 🔴 权限已开、页面未刷新、说明页已自关，点「扫码登录取流账号」**仍然不出无痕窗口，而且面板不报错**。
> 排除法 5 条、点了两次、稳定复现。

并据此列出**待修 #4（🔴 高）**，Lead 据此开了 **task-12**。

**这个结论是错的。**

### 13.2 真相

在新标签页（content script 新鲜）上点「扫码登录取流账号」后，无痕窗口**正常打开**：

```
EnumWindows：登录播放账号 - [InPrivate]     420 x 600
截图 evidence/S3-QR-window-exists.png：二维码完整渲染
```

### 13.3 我的判据错在哪（★ 具体形状，供后人避坑）

我用的是：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -match 'incognito' }
```

**它在 Edge 下恒为 0。**
原因：**Edge 的无痕窗口不是独立进程**，而是同一浏览器进程内的另一个 profile / 分区，
命令行里根本不含 `incognito` 字样。

⇒ 「进程命令行匹配不到」被和错当成「窗口不存在」。**这是假阴性。**

更糟的是我把它写进了「排除法第 1 条：不用 bsk，用 OS 级进程查」——
**恰恰这一条是无效判据**，其余 4 条也因此失去了意义（它们共同指向一个错误前提）。

| 用法 | 判据 |
| --- | --- |
| ✅ 可用 | `EnumWindows` + `GetWindowText`，匹配窗口标题里的 `InPrivate` |
| ✅ 可用 | `Get-Process msedge \| ? MainWindowTitle` |
| ✅ 可用 | 窗口截图后人眼确认 |
| ❌ **不可用** | `Get-CimInstance Win32_Process` 的 `CommandLine` 匹配 `incognito` |

### 13.4 连带纠正：诊断页「读取失败」的归因

诊断页曾显示：`InPrivate 权限 / 窗口列表 / cookie 分区` 读不到、
`凭据状态 = Extension context invalidated`、`诊断日志（最近 0 条）`。

我先前归因为「**SW 休眠**」。**这个归因也是错的。**

真因：`reload-extension.mjs` 重载扩展后，**已注入页面的 content script 立刻孤儿化**，
直到该页面刷新才重新注入；而我为满足「不许刷新」判据**全程没刷新**。
⇒ 我测到的是**孤儿态**，不是产品行为。对照实证见 §8.4。

### 13.5 撤回的待修项

| 编号 | 原内容 | 处置 |
| --- | --- | --- |
| #4 | 点扫码不出无痕窗口（🔴 高） | ❌ **撤回，不成立** |
| #5 | 诊断页 SW 休眠导致读不到 | ⚠️ **撤回原归因**；是否存在独立缺陷我**未证实** |

**保留不动**：#1（恒真断言，已用变异实证）、#2（134 vs 103）、#3（文档建议）——
这三条与本次撤回无关，是独立实证的。

### 13.6 自省

Lead 的原话：

> 「独立验证的价值不在于多一双眼睛，而在于那双眼睛没有你的预设。」

我这次**问对了**说明页的字数口径（还抓出自己 PowerShell 重编码导致的 294 vs 283），
**却在「窗口存不存在」上栽了同一类错**：

> **拿一个不可靠的间接指标（进程命令行）当"看得到 / 看不到"的判据，
> 而没有用最直接的那个（窗口标题 / 截图）。**

教训：**当我要说"某样东西不存在"时，先确认我的探针本身能不能看到它存在。**
一个"恒为 0"的探针，和一个"真的没有"，在输出上长得一模一样。
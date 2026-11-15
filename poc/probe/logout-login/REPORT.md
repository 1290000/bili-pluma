# 取证报告 · 退出取流账号无反馈 / InPrivate 权限开了仍点不动

> **调查员**：investigator（只读，**未修改任何源码**）
> **时间**：2026-11-12
> **仓库**：`D:/Projects/Pluma`，HEAD `e15dd68`（AGENTS.md §0 三步已过）
> **真机**：Edge + bsk 0.3.3（daemon ok，扩展已连接），会话 `nckw`，页面 `bangumi/play/ep341217`
> **本文定位**：给 task-2（裁决）与 task-3/4/5（实现）提供**根因判据 + 修法边界**。**不是修法方案。**

---

## 0. 先修正一条既有认知（会影响后续所有真机取证）

handoff §5 写「面板是 `mode:'closed'` shadow → **DOM 测量全部失效**」。实测**要收窄**：

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 面板宿主元素 | ✅ 可查、可量 | `#pluma-panel-host` 存在；折叠态 `x=0 y=503.55 w=8.91 h=73.81`，展开后 `x=0 y=442.02 w=310.71 h=196.86` |
| 面板内部 `querySelector` | ❌ 拿不到 | `shadowRoot === null`，`childCount === 0` |
| **`bsk snapshot` 语义树** | ✅ **能读到面板内所有文本与控件** | 拿到 `@e262 tab 画质/净化/显示/账号`、`@e266 button 扫码登录取流账号`、全部 `paragraph` |
| 几何字段 | ⚠️ 部分缺失 | 快照末尾固定 `@warning geometry incomplete: some page or frame content has no top-level coordinates` |

**结论**：后续验证**不需要**只靠像素扫描。用 `bsk click "@e<ref>"` 点面板控件是可靠的（本次全部点击均成功）。截图仍用于"用户视觉上能不能看出来"的最终判据。

### 0.1 读面板语义树的可用命令

```powershell
$out = & "$env:USERPROFILE\.local\bin\bsk.exe" snapshot --session <sid> --tab-id <tab> --json 2>$null
$j = [string]::Join("`n", $out)
$j.Substring($j.IndexOf("Pluma"))     # 只取面板那一段
```

⚠️ 不要 `| Out-String` 再 `JSON.parse`（UTF-16LE 那条坑依旧成立）。按行数组 join 后**直接做字符串定位**最稳。

---

## 1. 真机环境的一个硬限制（**必须先读，它决定了 A/B 的取证深度**）

本次调查时，该浏览器**没有配置任何取流账号**：

```
自检信息（面板「显示 → 诊断」，截图 shots/06-diagnostics.png）
  取流账号凭据         未配置
  播放代理总开关       已关闭
  DNR 全局路径规则      0
  DNR 标签页规则        0
```

面板账号 Tab 的语义树：

```json
paragraph "还没有配置取流账号"
@e266 button "扫码登录取流账号"
paragraph "主账号无需配置，自动沿用浏览器当前登录状态"
```

**没有 `退出取流账号` 按钮**（它只在 `pb || a.hasCredential` 时为真才渲染，`tabs.ts:566` / `:880`）。

因此：

| 问 | 状态 |
| --- | --- |
| **A. 退出无反馈** | 🔴 **未取到真机点击证据**（没有可退出的账号）。链路已静态坐实到行号，见 A 节 |
| **B. pb / hasCredential 矛盾态** | 🟡 **部分实测**（无凭据侧已实测一致）+ 有凭据侧仅静态证据 |
| **C. need-incognito 说明页** | 🔴 **未取到真机证据**（本机 InPrivate 权限**已开**，不会弹说明页）。文案体积已实测，见 C 节 |
| **D. 开了权限仍点不动 + 残留红提示** | ✅ **真机证据充分**（含 `diag()` 日志原文） |
| **E. 静默失败控件清单** | ✅ 静态全扫 + 两个真机实证 |

> **拿到 A / C 完整真机证据需要什么**（交 Lead 决定，见 §6）：
> - A：用户手扫一次码把取流账号登进去（登录窗口本次已能正常打开）
> - C：临时关掉 Edge 对该扩展的「在 InPrivate 中允许」，复现后再恢复

---

## A. 退出取流账号 → 确认退出 → 界面看起来"没有任何变化"

### 现象

用户原话：「有些时候点击退出取流账号之后再次确认退出，可是扩展的弹窗界面没有任何变化，导致用户不知道到底有没有真的退出了」

### 证据

#### A.0 ✅ **真机取证已完成**（2026-11-12 约 00:38，用户扫码后）

证据文件：`supp/A0-before-logout{.png,-tree.txt}`、`supp/A1-confirm-state{.png,-tree.txt}`、`supp/A2-after-logout{.png,-tree.txt}`、`supp/A-evidence-summary.txt`

**① 退出前（有凭据）**

```json
proxy:           {"enabled":true,"hasCredential":true,"ruleCount":4}
playbackAccount: {"uname":"{{取流账号昵称}}","mid":{{取流账号mid}},"vipLabel":"annual","expireAt":1811520000000,"healthy":true}
```

面板账号 Tab 语义树：

```
StaticText "主" / "读取中…" / "收藏 · 点赞 · 评论 · 历史" / "只读"
StaticText "取" / "{{取流账号昵称}}" / "仅取流 · 6 个月后到期" / "1 分钟前校验" / "年度大会员"
@e327 button "取流：扩展账号"
@e328 button "重新登录"
@e329 button "退出取流账号"
```

**② 第一步点击后（确认态）—— 有明确可见反馈**

```
@e328 button "重新登录"
@e329 button "确认退出"      ← 文案变
@e330 button "取消"          ← 多出取消按钮
```

**③ 第二步点击后：高频轮询 22 次（t = 393ms … 110711ms）**

```
     t   card logoutBtn  note login
   393   False     False False 扫码登录
  2799   False     False False 扫码登录
  ...
110711   False     False False 扫码登录
```

**每一次采样都是同样的结果**：取流卡片已消失、退出按钮已消失、无提示条、按钮已是「扫码登录取流账号」。

⇒ **`.acct-result`（「已退出取流账号，取流回退到主账号身份」）一次都没有被观测到。**

（采样间隔实际约 2.5s —— `bsk snapshot` 单次开销约 2.5s，不是脚本里的 120ms。所以只能证明"存活 < ~2.5s"，不能精确到毫秒。）

**④ 退出后最终状态**

```json
proxy:           {"enabled":false,"hasCredential":false,"ruleCount":0}
playbackAccount: null
```

```
StaticText "主" / "读取中…" / "收藏 · 点赞 · 评论 · 历史" / "只读"
paragraph "还没有配置取流账号"
@e327 button "扫码登录取流账号"
paragraph "主账号无需配置，自动沿用浏览器当前登录状态"
```

#### A.0.1 🔴 **真机结论修正了静态推理的优先级**（重要，task-3 必读）

静态分析时列出了 4 处"本应可见的变化"。**真机证实前 3 处全都真的发生了**：

| # | 变化 | 真机结果 |
| --- | --- | --- |
| 1 | 取流卡片整块消失 | ✅ **发生了**（`card=False`） |
| 2 | 按钮「重新登录」→「扫码登录取流账号」 | ✅ **发生了** |
| 3 | 「主账号无需配置…」出现 | ✅ **发生了** |
| 4 | `.acct-result` 文案 | ❌ **没看到**（与预测一致） |

⇒ **只要 `loadOnce()` 成功，用户一定能看出退出了。** 用户报告"没有任何变化"，**只可能是 `loadOnce()` 失败（路径 ①）** —— 面板停在旧模型，卡片还在、按钮还是「重新登录」。

**因此 task-3 的第一优先级是修静默 `catch`（A-2），`.acct-result` 位置（A-3）是次要的。** 只修 A-3 而不修 A-2，用户报告的问题**不会消失**。

> ✅ **落状态核对（2026-11-12 00:50 复查工作区）**：engineer-panel（task-3）**已按这个优先级改完**：
> - **A-2**：`content-panel.content.ts:422-452` 的 `catch` 不再裸返回 —— 失败时 `showNotice('界面数据刷新失败 —— 收起重开面板可重试', false)`
> - **A-2'**：`:263-265` 退出后 `loadOnce().then((r) => …)` 检查结局，失败时 `showNotice('已退出，但界面刷新失败 —— 收起重开面板可刷新', false)`
> - **A-3**：`.acct-result` 改为 `notifyResult` → `showNotice`（root 级），`tabs.ts:1018-1040`
> - **A-6**：文案改为「已退出取流账号，**取流回退到浏览器当前账号**」，`tabs.ts:1038`
>
> ⇒ **A 节的修法已被落地。本节的证据与判据保留作为"为什么这样修"的依据，行号请以当前文件为准（`tabs.ts` 的旧 941 已漂移到 1038）。**

#### A.0.2 ⚠️ 新增发现：退出会**主动关掉总开关**，而代码里的成功文案说的是"回退"

**证据分两半，强度不同，不要混用**：

| 部分 | 强度 |
| --- | --- |
| `proxy.enabled` 由 `true` → `false`（`ruleCount` 4 → 0） | ✅ **真机实测** |
| 成功文案的内容「取流回退到主账号身份」 | ⚠️ **静态**（该文案是 `.acct-result`，真机 22 次采样**从未渲染出来** —— 见 A.0.1 ③） |

真机实测的字段变化：

```
退出前  proxy: {"enabled":true,  "hasCredential":true,  "ruleCount":4}
退出后  proxy: {"enabled":false, "hasCredential":false, "ruleCount":0}
```

判据：

```ts
// src/background/handlers/account-remove.handler.ts:29-39
export async function handleAccountRemove(): Promise<ResponseMsg> {
  try {
    // 先关代理再删凭据：反过来会有极短的一瞬"规则在、凭据没了"
    await disableProxy();          // ★ 主动关掉总开关
    await removeCredential();
    ...
    return { type: 'account/remove:ok' };
```

而代码里成功分支写的文案是（`tabs.ts:941-943`）：

> 「已退出取流账号，**取流回退到主账号身份**」

**文案与事实不符**：实际是**整个扩展的代理被关闭**（画质增强全没了），不是"回退到主账号身份继续取流"。

`disableProxy()` 本身是有意设计（`:4-13` 的表格第 2 行："不清 DNR 规则 → 规则还带着已经没主的 Cookie 注入请求"），**不该改**。**该改的是这句文案** —— 它让用户以为还留着点什么。

#### A.0.3 静态链路（与真机结论一致，保留作为行号依据）

**成功路径本应产生的 4 处可见变化**（读码得出，全部有行号）：

| # | 变化 | 判据 |
| --- | --- | --- |
| 1 | 「取流」账号卡片**整块消失** | `tabs.ts:566` `if (pb \|\| a.hasCredential)` — 退出后两者皆假 |
| 2 | 按钮文案「重新登录」→「扫码登录取流账号」 | `tabs.ts:860` `pb ? '重新登录' : '扫码登录取流账号'` |
| 3 | 出现「主账号无需配置，自动沿用浏览器当前登录状态」 | `tabs.ts:960-962` `if (!pb)` |
| 4 | 提示条「已退出取流账号，取流回退到主账号身份」 | `tabs.ts:941-943` |

**变化 1/2/3 依赖 `loadOnce()` 成功；变化 4 无论成败都会被冲掉。**

> **真机已证实**：`loadOnce()` 成功时 1/2/3 **全部可见**（见 A.0.1）。所以路径 ① 是用户报告现象的唯一解释。

两条独立的失效路径：

#### 路径 ①（🔴 **真机推断的唯一根因**）：`loadOnce()` 失败 → 面板**保持旧模型** → 看起来"什么都没变"

```
entrypoints/content-panel.content.ts:225-232
  res.type === 'account/remove:ok'  →  void loadOnce()   ← 不 await
                                      return { ok: true }

        ↓ loadOnce() 内部

entrypoints/content-panel.content.ts:357-389
  const loadOnce = async () => {
    if (!controller) return null;
    try {
      const model = await loadPanelModel({...});     // ← 可能失败
      if (!controller) return null;
      controller.setModel(model);                    // ← 只有成功才重画
      return { pageStateKind: ... };
    } catch {
      return null;                                   // ← ★ 静默，不 setModel，不提示
    }
  }
```

`catch` 分支**既不重画也不提示**。此时面板**保留上一帧的模型** —— 旧模型里 `hasCredential` 仍是 `true`、`pb` 仍非空 → **取流卡片还在、按钮还是「重新登录」** → 用户看到的就是**"点了没反应"**。

这与用户说的「**有些时候**」完全吻合：`loadPanelModel()` 内部并发发 4 条消息（`panel-data.ts:604-610`），任一环节失败即整条 `throw`。

#### 路径 ②：提示条只活到下一次 `render()`

```
src/content/panel/tabs.ts:936-944
  let note = box.querySelector('.acct-result');
  if (!note) { note = el('p','acct-result'); box.appendChild(note); }
  note.textContent = '已退出取流账号，取流回退到主账号身份';
  note.classList.toggle('danger', !r.ok);

  // :946-950 的注释自己承认了这件事：
  //   成功后不用这里手动刷新：logout 的实现会重新取数并重画面板，
  //   这一块会随整棵树重建。

        ↓ 而"整棵树重建"就是：

src/content/panel/panel.ts:642-656
  case 'account':
    replaceChildren(content, [ accountTab(...) ]);   // ← 整个 box 被丢弃
```

`.acct-result` 是 `box` 的子节点，`replaceChildren` 把 `box` 整个换掉 → **刚写的文案随旧树一起消失**。

竞态：`:928` 的 `.then` 与 `:230` 的 `void loadOnce()` **并行**。谁先完成决定文案能否被看到一瞬。

> **真机结果**：22 次采样**一次都没看到**（见 A.0.1 ③）。因为采样间隔约 2.5s，只能证明**存活 < ~2.5s**，不能精确到毫秒。但结合代码（`replaceChildren` 必然丢弃 `box` 子节点），可以判定：**这条文案在成功路径下也基本看不到** —— 它是设计性缺陷，不是偶发竞态。

> ⚠️ 两条路径**不互斥**：路径 ② 是设计性缺陷（`.acct-result` 必然被冲掉），路径 ① 是失败静默（发生时用户得不到**任何**信息）。
>
> **但真机区分了它们的地位**：路径 ② 影响的是"退出成功的提示语"，路径 ① 影响的是"**用户根本看不出退出了**"。用户报告的正是后者 ⇒ **修 A-2 优先于修 A-3**。

### 根因判据（文件:行号）

> ⚠️ **下表的行号是取证时刻（HEAD `e15dd68`）的快照。** task-3/4 已在 2026-11-12 00:39 后改动了 `tabs.ts` / `panel.ts` / `content-panel.content.ts` / `need-incognito/**`，**A-2 / A-3 / A-6 已修**（见 A.0.1 末尾的核对）。按行号定位前**先 grep 当前的符号名**（如 `已退出取流账号`），不要直接跳行。

| # | 位置 | 问题 | 真机验证 |
| --- | --- | --- | --- |
| A-1 | `entrypoints/content-panel.content.ts:230` | `void loadOnce()` 不 await，成败与退出结果解耦（本意合理，但失败无出口） | ✅ 链路成立 |
| **A-2** | `entrypoints/content-panel.content.ts:385-388` | `catch { return null; }` —— **取数失败静默**，不重画、不提示 | 🔴 **用户现象的唯一解释（P0）** |
| A-3 | `src/content/panel/tabs.ts:936-951` | 结果文案写在会被 `replaceChildren` 丢弃的 `box` 里 | ✅ 22 次采样未观测到 |
| A-4 | `src/content/panel/panel.ts:642-656` | `render()` 每次全量重建账号 Tab（`replaceChildren`）— 设计如此，**但 A-3 依赖它存活** | ✅ |
| A-5 | `src/content/panel/panel.ts:703-725` | 已有 `showNotice()` 挂在 `root` 级（**跨 `replaceChildren` 存活**，注释 `:697-698` 明说）—— 退出路径**没用它**，只有 `openLogin` 用了（`content-panel.content.ts:181`） | ✅ 结构成立 |
| **A-6** | `src/content/panel/tabs.ts:941-943` + `account-remove.handler.ts:32` | 文案说「取流回退到主账号身份」，实际 `disableProxy()` 把总开关关了 | ✅ 字段变化**真机实测**；文案内容为静态（`.acct-result` 真机未渲染出） |

**最强的一条判据**：`showNotice` 的存在本身就证明了「什么位置能活过重画」这个判断在项目里已经有答案，而退款（退出）路径没有复用它。

### 修法边界（给 task-3）

**该改**：
- `entrypoints/content-panel.content.ts`（`removeAccount` 与 `loadOnce` 的失败出口）
- `src/content/panel/tabs.ts`（退出按钮与结果提示）
- `src/content/panel/panel.ts`（若需给 `showNotice` 增加"退出"语义文案）

**不许碰**：
- ❌ `confirm()` / `alert()`（`docs/02-ui-spec.md` §7）——**两步确认交互必须保留**（`tabs.ts:869-879` 明确写了为什么：误触会让番剧页立刻掉回 1080P）
- ❌ `src/background/**`、`src/platform/http/dnr.ts`、`src/shared/types/messages.ts`（默认不新增消息类型）
- ❌ `entrypoints/need-incognito/**`（task-4 写域）
- ❌ 不要给 `refreshModel()` 硬编码身份常量（见 B 节 B-2）

**关键提醒**：修 A-2 时不要把 `loadOnce` 的返回值改成 `throw` —— 它被 `open-cycler` 当作"普通失败，不排重试"消费（`:354-355` 注释）。要的是**让失败可见**，不是**让失败变响**。

---

## B. 退出后是否出现 "pb 非空但实际已没凭据"（或反之）

### 现象

任务卡问：退出后是否进入过「`pb` 非空但实际已没凭据」或相反的状态。

### 证据

#### B.1 ✅ 真机实测（无凭据侧）：**一致，无矛盾态**

```
账号 Tab 语义树（未配置状态）
  StaticText "主" / "读取中…" / "收藏 · 点赞 · 评论 · 历史" / "只读"
  paragraph "还没有配置取流账号"
  @e266 button "扫码登录取流账号"        ← pb=null 时才用这个文案（tabs.ts:860）
  paragraph "主账号无需配置，自动沿用浏览器当前登录状态"   ← if (!pb) 才渲染（tabs.ts:960）

自检信息
  取流账号凭据   未配置                  ← hasCredential = false（proxy/status）
```

按钮文案落在「扫码登录取流账号」分支 ⇒ `pb === null`；同时 `hasCredential === false`。**两者一致**。

#### B.2 为什么"`pb` 残留"不会发生（推翻任务卡的候选根因之一）

任务卡候选：*「退出按钮条件是 `pb || a.hasCredential`；退出后重取若 `pb` 仍非空，卡片看起来没变化」*。

**这个具体假设不成立**：`loadPanelModel()` **每次都重新发消息取数**，不存在复用旧快照：

```ts
// src/content/panel/panel-data.ts:604-610
const [proxyRes, acctRes, statsRes, pageState] = await Promise.all([
  chrome.runtime.sendMessage({ type: 'proxy/status' }).catch(() => null),
  chrome.runtime.sendMessage({ type: 'account/summary' }).catch(() => null),
  ...
]);
```

`pb = snapshot?.account ?? null`（`panel-data.ts:384`），来源是 `account/summary` 的**新鲜应答**。

⇒ **真正的失效不是"pb 残留"，而是"整个模型没被替换"（loadOnce 失败，A 节路径 ①）。** 修法应冲着失败可见性，不是冲着清 `pb`。

#### B.3 ⚠️ 静态发现：**"pb 为 null 但 hasCredential 为 true" 会渲染出矛盾卡片**

这是任务卡设想的**反方向**，且代码里确实存在：

```ts
// src/content/panel/tabs.ts:566
if (pb || a.hasCredential) {          // ← hasCredential 单独为真也会进这块
// :580
bMain.appendChild(el('span','acct-name', pb?.uname ?? '取流账号已配置'));
// :608
pb ? (exp ? `仅取流 · ${exp}` : '仅取流 · 无到期日') : '读不出账号资料 · 点下方重新登录'
// :626
playbackRow.appendChild(el('span','acct-tag accent', pb ? VIP_TAG[pb.vipLabel] : '已配置'));
```

`pb === null && hasCredential === true` 时用户看到：昵称「**取流账号已配置**」+ 标签「**已配置**」+ 副标题「**读不出账号资料 · 点下方重新登录**」——**同一张卡上"已配置"和"读不出"并存**。

`pb` 为 null 的成因至少有两种（`account/summary` 失败、账号资料读不出），代码把它们**合并成同一句话**。这类"已配置但读不到"是否发生需真机在有凭据时验证 —— **本次无凭据，未取到**。

#### B.4 ⚠️ 静态发现：`refreshModel()` 不传 `streamingIdentity` → 身份 `page` 时会被误判成"未配置"

任务卡候选根因**这一条成立**，已定位到行号：

```ts
// src/content/panel/panel.ts:487-499
const refreshModel = async (): Promise<void> => {
  const next = await loadPanelModel({
    pageKind: model?.pageKind ?? 'other',
    primary: model?.account.primary ?? { ... },
    // ← 没有 streamingIdentity ！！！
  });
  model = next;
  render();
};
```

对照 `loadOnce()` 传了（`content-panel.content.ts:371-375` `streamingIdentity: streamingIdentityCache ?? null`）。

后果在两处：

**(a) `configured` 判据被喂了假身份**

```ts
// src/content/panel/panel-data.ts:330-332
configured:
  (account?.configured ?? false) ||
  isStreamingReady(streamingIdentity ?? 'extension', proxy.hasCredential),
//   ↑ 缺省 'extension'

// src/shared/constants/streaming-identity.ts:125-127
export function isStreamingReady(identity, hasCredential) {
  return identity === 'page' || hasCredential;
}
```

`streamingIdentity === 'page' && hasCredential === false` 时：真实答案 `true`（`page` 身份本来就不需要凭据），但 `refreshModel` 缺省成 `'extension'` → 得 `false` → **误判"未配置"**。

**(b) `snapshot.streamingIdentity` 缺失 → 画质 Tab 说假话**

`panel-data.ts:711` 的透传条件 `...(streamingIdentity !== undefined ? {...} : {})` —— `refreshModel` 没传，于是 `undefined`，`describePopup()` 里 `if (snap.streamingIdentity === 'page')` 的短路**永不触发**。这正是该参数注释（`panel-data.ts:680-689`）里写的「画质 Tab 说假话」问题的**原样复发**。

**触发时机**：`refreshModel()` 由 `toggleProxy`（`panel.ts:460`）、`writeOption`（`:444`）、`writeCategory`（`:454`）调用。即：**用户拨总开关或净化开关后，账号 Tab / 画质 Tab 会退回到"缺省身份"判据**。这在 `page` 身份下表现为"切了身份的设置，一拨开关就显示错"。

### 根因判据

> ✅ **落地状态核对（2026-11-12 00:50 复查）**：**B-1 已修** —— `panel.ts:545-562` 的 `refreshModel()` 现通过 `actions.currentStreamingIdentity()` 取身份（读 `streamingIdentityCache`），且 `:541-543` 的注释明确写了「**不许在这里写死 `'extension'` / `'page'`**」，与本报告给的边界一致。
> **B-2 / B-3 因此随之消解**（不再走缺省身份）。**B-4 是否已改未核实**（不在本轮 A/B 主线）。

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| B-1 | `src/content/panel/panel.ts:487-499`（旧）→ 现 `:545-562` | `refreshModel()` **不传 `streamingIdentity`**（`loadOnce` 传了） | ✅ 已修 |
| B-2 | `src/content/panel/panel-data.ts:332` | 缺省 `'extension'` → `page` 身份被误判未配置 | ✅ 随 B-1 消解 |
| B-3 | `src/content/panel/panel-data.ts:711` | 身份缺失 → 画质 Tab 走"缺省身份"分支 | ✅ 随 B-1 消解 |
| B-4 | `src/content/panel/tabs.ts:580,608,626`（旧行号，已漂移） | `pb === null` 时三种文案（已配置 / 读不出 / 已配置）互相矛盾 | ⚠️ 未核实 |

### 修法边界

**该改**：`src/content/panel/panel.ts`（`refreshModel` 补参数）、`src/content/panel/tabs.ts`（B-4 文案分支）。

**不许碰**：
- ❌ **不要在 `refreshModel()` 里写死 `'extension'` 或 `'page'`** —— 参数必须来自唯一真相源（`content-panel.content.ts` 的 `streamingIdentityCache`），与 `loadOnce` 同口径。`panel-data.ts:698` 的注释说清了原因（"缺省 = 调用方没给 → 走既有判据"）。
- ❌ 不许改 `isStreamingReady()` 的实现（`streaming-identity.ts:115-120`：**"这是一条判据，只许有一处实现"**，四个调用方依赖它）。
- ❌ 不许把 `needsProxy()` 和 `isStreamingReady()` 合并（`streaming-identity.ts:101-113` 完整论证）。

---

## C. 未开 InPrivate 权限 → 点「扫码登录取流账号」

### 现象

用户原话：「没有开启在 InPrivate 中允许时，点击扫码登录取流账号时弹出来这个弹窗中的文字内容太过杂乱，太过多了，必须精简，精简再精简」

### 证据

#### C.1 🔴 **未取到说明页真机证据** —— 原因如实说明

本机 InPrivate 权限**已开启**，因此点击走的是**成功路径**，说明页不会出现。真机实测（`shots/04-after-login-click.png` + 诊断日志）：

```
00:26:39  isAllowedIncognitoAccess        true
00:26:39  windows.create returned         id=undefined incognito=undefined windowsBefore=3 windowsAfter=3 loginTabs=0
00:26:39  create 返回 undefined 且窗口数未变，交给握手判定
00:26:39  login/open                      {"ok":true,"reason":"assumed"}
00:26:39  create 返回 undefined 但权限正常 → 按已创建处理
```

并且 Windows 进程层面确认窗口**真的开了**：

```
PS> Get-Process msedge | Where-Object { $_.MainWindowTitle } | Select Id, MainWindowTitle
   Id MainWindowTitle
27664 登录播放账号 - [InPrivate]
```

⇒ `reason:'assumed'` 是**乐观判断**，本次它是对的（窗口确实在）。**但要复现 C 必须临时关闭权限**，那是改用户的浏览器设置，**未获授权，未执行**。

#### C.2 ✅ 文案体积已实测（静态统计，可复现）

用脚本对 `entrypoints/need-incognito/index.html` 去标签后统计：

| 区域 | 字符数 | 内容 |
| --- | --- | --- |
| **默认可见**（`<details>` 外） | **283** | 标题 + lead 段 + 步骤标题 + 两按钮 + hint + 两步 `ol` + footnote |
| **折叠内**（`<details>`） | **195** | `why-title` + 两段 `why-body` |
| **合计** | **478** | |

（复现：对本文件 `<body>` 去 `<!-- -->`、去 `<script>`、去 `<details>` 后 `[regex]::Replace($html,'<[^>]+>',' ')` 取长度。）

#### C.3 结构问题（读 HTML 逐条对，**未取到渲染截图**）

| # | 位置 | 问题 |
| --- | --- | --- |
| C-1 | `index.html:20-24` lead 段（**92 字**） | 与 `:63-74` 折叠内的两段 `why-body`（**195 字**）**解释的是同一件事**（"为什么必须无痕"）。lead 说"同一浏览器只能有一份 Cookie"，why-body 又说"写入就会覆盖同一份 Cookie"。**重复**（277 字讲一个理由） |
| C-2 | `index.html:39-42` hint | 与 `:35` 主按钮「打开扩展详情页」**语义重复**（都在说"怎么到扩展页"） |
| C-3 | `index.html:55` 步骤 2 | 「开好后这一步会自动变绿」—— 这个"自动变绿"由 `main.ts:130-134` 实现，但只在**说明页还活着**时生效；见 D 节（8 秒后监听器摘除、页面可能已被关） |
| C-4 | `index.html:53-55` | 同时写「在 InPrivate 中允许」（Edge）与「在无痕模式下启用」（Chrome）—— 对单浏览器用户是**一半无关信息**，但项目 v1 支持两个浏览器（`AGENTS.md` §3 决策 9），**不算 bug，是取舍** |
| C-5 | `index.html:59` footnote | 「设置一次即可，之后点图标会直接打开登录窗口」—— 而实际入口是**面板里的按钮**（popup 只剩悬浮开关，ADR 0033）。**术语漂移**：说"点图标" |

> C-5 是**真 bug（文案与事实不符）**，不是风格问题。`main.ts:172` 的提示也写「开完记得重新点图标」，同一处漂移。

### 根因判据

| # | 位置 | 问题 |
| --- | --- | --- |
| C-1 | `entrypoints/need-incognito/index.html:20-24` vs `:63-74` | lead 与 why-body 重复解释同一件事（合计 277 字讲一个理由） |
| C-2 | `entrypoints/need-incognito/index.html:39-42` vs `:35` | hint 与按钮语义重复 |
| C-3 | `entrypoints/need-incognito/index.html:59`、`main.ts:172` | **"点图标"与实际入口（面板按钮）不符** |
| C-4 | `entrypoints/need-incognito/main.ts:130-134` | "自动变绿"依赖说明页仍存活，而 D 节证明它可能已被摘监听/被关 |

### 修法边界（给 task-4）

**该改**：`entrypoints/need-incognito/index.html`、`entrypoints/need-incognito/style.css`、`entrypoints/need-incognito/main.ts`

**不许碰**：
- ❌ **`chrome://extensions/?id=` 一键直达主路径**（`main.ts` 文件头：实测 Edge 会重写为 `edge://` 且保住 `?id=`）—— 实测有效，别动
- ❌ 不许按 UA 分支（`AGENTS.md` §3 决策 9 + `main.ts` 文件头已记录"不用按浏览器分支"）
- ❌ 不许改注入方式 / 新增依赖
- ❌ 不许删 `docs/02-ui-spec.md` §7 相关约束

**给裁决的建议边界（不是我的决定，供 task-2 参考）**：
- C-1 的重复**必须先定"保留哪一份"再删** —— 两处都讲"为什么"，删错了会丢信息。建议：`lead` 保留一句结论（≤30 字），`why` 折叠保留完整技术理由（那是给维护者/好奇用户的）。
- C-3 是**必须修**的（事实错误），不受精简风格讨论影响。

---

## D. 开完权限回到网页再点「扫码登录取流账号」→ 没反应 + 仍有红字

### 现象

用户原话：「我通过弹出来的弹窗跳到了扩展界面打开了在 InPrivate 中允许后，再返回原本的网页，此时点击扫码登录取流账号没有反应，且还有红色文字提示让我打开在 InPrivate 中允许，可我实际上已经打开了，必须重新刷新整个界面之后再次点击扫码登录取流账号，才能真正的弹出扫码界面」

### 证据

#### D.1 ✅ **残留红提示是真实的、且会常驻**（强证据）

真机在"登录轮询超时"后，账号 Tab 底部出现红提示，**截图 `shots/05-stale-red-notice.png`**，语义树原文：

```json
paragraph "等了 3 分钟还没检测到新账号 —— 扫码成功了吗？也可以点「重新登录」再试一次"
```

而且**同一时刻按钮实际写的是「扫码登录取流账号」**（不是「重新登录」）：

```json
@e266 button "扫码登录取流账号"
```

⇒ 提示里的「点「重新登录」」**在指向一个不存在的按钮**。这是用户"看不懂 / 不知道点哪"的直接来源之一。

常驻机制（已坐实）：

```ts
// src/content/panel/panel.ts:703-725
showNotice(text, ok) {
  let bar = root.querySelector('.panel-notice');
  if (!bar) { bar = el('p','panel-notice'); root.appendChild(bar); }
  bar.textContent = text;
  bar.classList.toggle('danger', !ok);

  if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }

  if (ok) {                                  // ★ 只有 ok 才设自动消失
    noticeTimer = setTimeout(() => {
      if (bar.textContent === text) bar.remove();
    }, NOTICE_TTL_MS);                        // NOTICE_TTL_MS = 5000（:204）
  }
  // ok === false → 永不自动消失
}
```

#### D.2 ✅ 实测：新提示**会替换**旧提示（所以"残留"不是替换失败）

真机连续两次点击「扫码登录取流账号」，**点击前后对比**：

| 时刻 | 面板底部 `paragraph` |
| --- | --- |
| 点击**前** | `等了 3 分钟还没检测到新账号 —— 扫码成功了吗？也可以点「重新登录」再试一次`（红） |
| 点击后 2s | `扫码窗口已打开，请用手机扫码。成功后这里会自动更新`（蓝） |

⇒ `showNotice` 复用同一个 `.panel-notice` 元素，**新提示替换旧的**。所以"回来还看到红字"的真实成因**不是**替换失败，而是下面 D.3 —— **这一次点击本身失败了，又写了一条红字，两红字长得一样，用户分不清是新是旧**。

（对应 `content-panel.content.ts:180-184`：`const r = describeLoginOutcome(res); if (controller) controller.showNotice(r.text, r.ok); if (!r.ok) return;`）

#### D.3 ✅ **根因：`markLoginReady()` 无条件写入，`assumed` 是猜测**

真机日志（`shots/06-diagnostics.png` 面板「显示 → 诊断」页原文，已存 `diag-log-evidence.txt`）：

```
00:26:39  isAllowedIncognitoAccess         true
00:26:39  windows.create returned          id=undefined incognito=undefined windowsBefore=3 windowsAfter=3 loginTabs=0
00:26:39  create 返回 undefined 且窗口数未变，交给握手判定
00:26:39  login/open                       {"ok":true,"reason":"assumed"}
00:26:39  create 返回 undefined 但权限正常 → 按已创建处理
```

读码对照：

```ts
// src/background/login-window.ts:142-151
// 情况 3：返回 undefined 且本实例看不到窗口数变化。
// 这**不能**判定为失败 —— 无痕窗口可能对当前分区实例不可见
await diag('create 返回 undefined 且窗口数未变，交给握手判定');
// 重要：即便如此也要**乐观地**报告"可能成功"。
return { ok: true, reason: 'assumed' };        // ★ 猜测成功

        ↓ 调用方

// entrypoints/background.ts:97-101
if (result.ok || result.reason === 'already-open' || result.reason === 'assumed') {
  if (result.reason === 'assumed') { await diag('create 返回 undefined 但权限正常 → 按已创建处理'); }
  await markLoginReady();                      // ★ 无条件写 ready 标记
  return { type: 'login/open:ok', opened: true, ...(result.reason ? { reason: result.reason } : {}) };
}
```

**问题**：`assumed` 的语义是"我猜它开出来了"。但 `markLoginReady()` 把它当成"确定开出来了"写标记。这个标记驱动 `need-incognito` 页**自动关闭**（`main.ts:155-158` → `window.close()`）。

⇒ **说明页会自己关掉（因为看到 ready），而二维码窗口可能根本没开** → 用户看到的正是「**说明页没了、二维码也没有 = 点了没反应**」。

#### D.4 ✅ **根因：`watchForLoginReady` 8 秒后永久摘监听器**

```ts
// src/background/login-handshake.ts:57-82
export function watchForLoginReady(onReady, timeoutMs = 8000) {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    cleanup();              // ★ 永久清掉（clearTimeout + removeListener）
    // 超时不做任何事——说明页保留，让用户看到指引
  }, timeoutMs);
  const listener = (changes, area) => {
    if (area !== 'local' || !(READY_KEY in changes)) return;
    if (done) return;
    done = true; cleanup(); onReady();
  };
  ...
  chrome.storage.onChanged.addListener(listener);   // ← 只注册一次
  return cleanup;
}
```

调用方：

```ts
// entrypoints/need-incognito/main.ts:151-176
function closeIfReadyElsewhere(): void {
  if (!tipEl) return;
  watchForLoginReady(() => { window.close(); });     // ★ 默认 8000ms
  void readLoginReady().then((m) => { if (m) window.close(); });
  window.setTimeout(() => {                          // 另一个 8s 定时器
    void readLoginReady().then((m) => {
      if (m) return;
      if (tipEl.classList.contains('ok')) return;
      tipEl.textContent = '登录窗口还没打开 —— 上面的权限应该没生效，开完记得重新点图标。';
      tipEl.classList.add('show');
    });
  }, 8000);
}
```

**用户体验时间线**（这是用户原话里"必须重新刷新整个界面"的机制）：

| 时刻 | 发生什么 |
| --- | --- |
| T+0 | 说明页弹出，`watchForLoginReady` 注册 |
| T+0～8s | 用户在找 `edge://extensions` → 本扩展 → 详情 → 拨「在 InPrivate 中允许」。**8 秒通常不够**（本次实测：从点按钮到看到窗口标题，人操作远超 8s） |
| **T+8s** | `cleanup()` **永久摘掉监听器**；另一定时器把提示改成「登录窗口还没打开 —— 上面的权限应该没生效，开完记得重新点图标」 |
| T+8s 之后 | 用户开好权限、回到网页、再点「扫码登录取流账号」→ `background` 走**成功路径**（权限已 true）→ 写 `login-ready` → **但说明页早已不监听** → 说明页**不会自己关** |
| 用户看到 | 说明页还在（"红色提示让我打开 InPrivate，可我实际上已经打开了"）+ 二维码窗口可能开着但被说明页挡着 / 或在另一个窗口 |

⇒ **"必须刷新整个界面"= 说明页只能靠重新加载才能重跑 `closeIfReadyElsewhere()` 那一次 `readLoginReady()`**（`main.ts:161-163` 的"进页面时就已经就绪"分支）。

#### D.5 ⚠️ 加剧因素：`chrome.windows.onRemoved` **无条件**清 `login-ready`

```ts
// entrypoints/background.ts:513-517
// 登录窗口被用户手动关掉时清理状态
chrome.windows.onRemoved.addListener(() => {     // ★ 没有判断关的是哪个窗口
  forgetLoginWindow();
  void clearLoginReady();                        // ★ 清掉 ready 标记
});
```

注释说的是"登录窗口被关掉时清理"，但**监听器不区分窗口 ID**。用户关掉**任何**窗口（关掉 B站标签所在窗口、关掉新建标签页窗口）都会清 `login-ready`。

后果叠加 D.4：即便说明页还在 8 秒窗口内，一次无关的窗口关闭也能让它**永远不会自关**。

#### D.6 ⚠️ 加剧因素：`reason` 没有区分"已开"与"没开"，`describeLoginOutcome` 只能猜

真机两次点击都得到 `{"ok":true,"reason":"assumed"}`，用户看到的是**同一条蓝色成功提示**。而 `assumed` 的真实含义是"**没看到窗口，但权限允许，所以我猜它开了**"。

⇒ 当猜测**错了**（窗口没开），用户收到的仍是"扫码窗口已打开，请用手机扫码" —— **与实际不符**。这是"点了没反应"里"没反应"的最直接解释之一。

### 根因判据

| # | 位置 | 问题 |
| --- | --- | --- |
| D-1 | `src/background/login-handshake.ts:57-65` | `watchForLoginReady` **8 秒后永久摘监听器**；用户开权限通常 >8s |
| D-2 | `entrypoints/need-incognito/main.ts:155` | 用默认 8000ms 调 `watchForLoginReady`，超时后说明页**再也无法自关** |
| D-3 | `entrypoints/background.ts:513-517` | `windows.onRemoved` **不判窗口 ID** 就清 `login-ready` |
| D-4 | `entrypoints/background.ts:97-101` + `login-window.ts:151` | `assumed`（猜测）被当作确定成功 → 无条件 `markLoginReady()` |
| D-5 | `entrypoints/content-panel.content.ts:180-184` | 失败提示 `ok:false` → **常驻不消失**（`panel.ts:718` 只在 ok 时设 timer） |
| D-6 | `src/content/panel/tabs.ts:860` vs `content-panel.content.ts:198` | 提示文案说「重新登录」，按钮实际叫「扫码登录取流账号」——**指向不存在的按钮** |
| D-7 | `entrypoints/need-incognito/main.ts:172` | 「开完记得重新点图标」——实际入口是**面板按钮**，不是图标 |

### 修法边界（给 task-4 / task-3）

**该改**：`entrypoints/need-incognito/**`（D-2/D-7 在 task-4 写域）、`src/content/panel/**` 与 `entrypoints/content-panel.content.ts`（D-5/D-6 在 task-3/5 写域）。

**⚠️ D-1 / D-3 / D-4 在 `src/background/**` —— 已裁决「本轮不修，只记录」。** 详见 §9.1。

**不许碰**：
- ❌ **不许把 `assumed` 改成 `false`** —— `login-window.ts:59-67` 记录了实测事实：split 模式下从普通实例创建无痕窗口，**窗口确实建出来了但 `create()` 返回 `undefined`**。改成 false 会误弹说明页（注释 `:84`「不能**用返回值判断成败**，否则会误弹说明页」）。
- ❌ 不许改 ADR 0012（无痕分区登录）与 `AGENTS.md` §3 决策 11。
- ❌ 不许在 `need-incognito` 里用 Shadow DOM 之外的注入方式 / 按 UA 分支。
- ❌ 不许把失败提示改成 `alert`/`confirm`。
- ⚠️ **修 D-5 的正确方向不是"给红字加超时"**（那会让用户错过原因 —— `panel.ts:687-696` 明确论证了失败常驻的用意），而是**让这次的失败与上次的失败可区分**（例如：点按钮时先清掉旧提示；或文案带上时间/动作）。

---

## E. 所有"点了可能没有任何可见反馈"的控件

### 现象

用户原话：「你再看看还有没有类似的问题，尤其是点击之后没有反应的情况」

### 全表（逐控件，含行号与实证强度）

| # | 控件 | 位置 | 点击后的实际反馈 | 失败时用户看到什么 | 实证 |
| --- | --- | --- | --- | --- | --- |
| E-1 | **画质总开关** `toggleProxy` | `panel.ts:457-461` | 乐观? **否** —— 直接发消息后 `refreshModel()` | **什么都没有**：`.catch(() => null)` 完全吞掉；成功时靠 `refreshModel` 读回真实值（若失败则开关**视觉不动**，看起来"点了没反应"） | 静态（行号确凿） |
| E-2 | **取流身份胶囊** `toggleStreamingIdentity` | `panel.ts:324-334` | ✅ 乐观更新（先切后发） | 回滚 + `setStreamingIdentity` 里 `showNotice`（`content-panel.content.ts:276`）→ **有提示** | 静态 |
| E-3 | **推荐流开关** `toggleFeedAccount` | `panel.ts:350-360` | ✅ 乐观更新 | 回滚 + 提示（无凭据时**开关本身是 `disabled`**） | ✅ **真机**：`@e267 checkbox [disabled] [checked]` |
| E-4 | **角标开关** `toggleBadge` | `panel.ts:274-284` | ✅ 乐观更新 | 静默回滚（`catch` 内无提示）；且 `ensureBadgeRead` 失败后 `badgeEnabled` 永久 `null` → **开关永久禁用且不说明原因**（`panel.ts:262-271`） | 静态 |
| E-5 | **净化各开关** `writeOption` / `writeCategory` | `panel.ts:431-455` | ❌ 无乐观更新 | **异常直接冒泡**，`render()` 不会跑 → 开关**视觉不动**，无文字 | 静态 |
| E-6 | **退出取流账号** | `tabs.ts:905-952` | 第一步有文案变化（→「确认退出」）；第二步**只有按钮 `disabled`** | 见 A 节：成功文案被 `replaceChildren` 冲掉；失败静默 | 静态（A 节） |
| E-7 | **扫码登录取流账号** `openLogin` | `content-panel.content.ts:166-207` | 蓝色提示（成功）/ 红色提示（失败） | ✅ **有提示** | ✅ **真机**（D.2 点击前后对比） |
| E-8 | **诊断入口** `openDiag` | `panel.ts:622-637` | 立刻显示「正在采集诊断信息…」 | 失败 → `diagData = { rows: [], logs: [] }`（`panel.ts:412-415`）→ **空表**，无归因 | ✅ **真机**：诊断页正常渲染（`shots/06-diagnostics.png`） |
| E-9 | **面板收起/展开** | `panel.ts` / `sidebar` | 视觉变化明显 | 无失败路径 | — |
| E-10 | **Tab 切换** | `panel.ts:661-666` | 视觉变化明显 | 无失败路径 | — |

### 两个真机实证的补充

#### E-3 实证：推荐流开关「已勾选但灰掉不可点」

```json
@e267 checkbox "首页推荐流使用取流账号 打开后，首页推荐换成取流账号的" [disabled] [checked] ="on"
paragraph "先扫码登录取流账号，才能用它来换首页推荐流"
```

用户看到的是**一个勾着的、点不动的开关**。`tabs.ts:325` `disabled: !actions.hasCredential` 是真的，但**视觉上"勾选 + 灰"读起来像"已开启"**，与下方"先扫码登录"的说明**矛盾**。

任务卡把「开关可点性取决于是否有凭据」列为本轮关注点之一 —— 这是它的真机样本。

#### E-8 实证：诊断页里两条**误导性文案**

真机（`shots/06-diagnostics.png`）：

| 项 | 显示 | 问题 |
| --- | --- | --- |
| 主账号基线 · ep:341217 P1 | **有数据但解析不出轨道** | 页面上正放着该集（播放器在跑） |
| 主账号昵称（页面读取） | **（未读到，可能未登录或页面还没就绪）** | **主账号明明已登录**（导航栏头像「129」可见，截图 `00-baseline-bangumi.png`） |

第二条尤其糟：它把"主账号已登录"这个**确定事实**说成"可能未登录"。而账号 Tab 的「主账号」卡片同时卡在 **`读取中…`**（语义树 `StaticText "读取中…"`）—— 两者很可能是同一个取数失败（`readPrimary`），但**诊断页把失败归因给了用户（"可能未登录"）**。

> 这条与 C/D 的用户体验问题同源：**取数失败被呈现成用户的配置问题**。

### 静默点汇总（按"用户完全得不到任何信息"排序）

| 严重度 | 控件 | 判据 |
| --- | --- | --- |
| 🔴 最高 | **E-1 画质总开关** | 这是扩展最核心的开关，失败**一个字都没有**（`panel.ts:459`） |
| 🔴 高 | **E-4 角标开关永久禁用** | `badgeEnabled === null` 时 `disabled` 但**永不解释原因**（`panel.ts:291`） |
| 🟠 中 | **E-5 净化开关** | 异常冒泡，开关不动、无文字 |
| 🟠 中 | **E-6 退出** | 见 A 节 |
| 🟡 低 | **E-8 诊断空表** | 有"正在采集…"→ 空表，无"采集失败" |

### 修法边界（给 task-5）

**该改**：`src/content/panel/panel.ts`、`src/content/panel/tabs.ts`、`entrypoints/content-panel.content.ts`

**不许碰**：
- ❌ 不许把失败提示写成 `alert` / `confirm`（`docs/02-ui-spec.md` §7）
- ❌ 不许新增消息类型（`messages.ts` 是白名单，`scripts/check-messages.mjs` 会红）
- ❌ 不许新增依赖
- ❌ 不许改 Tab 名 / 改 Tab 布局（`AGENTS.md` §3 + handoff §4"不改 tab 名"）
- ❌ 不许改 `entrypoints/need-incognito/**`（task-4 写域）
- ✅ **统一走 `PanelController.showNotice`**（`panel.ts:703`，root 级、跨 `render()` 存活）。**不要另造第二套提示机制** —— 这正是 A 节 A-5 指出的问题。

---

## 6. 裁决状态（已定，详见 §9）

本节的原始"待裁决"项**均已由 Lead 裁决**，不再保留悬空结论：

| 原待裁决项 | 裁决 | 落地位置 |
| --- | --- | --- |
| A 缺真机证据 → 需扫码 | ✅ **已扫码，A 真机取证完成** | §A.0 |
| C 缺真机证据 → 需临时关 InPrivate 权限 | ⏭ **移交 task-6**（取证时工作区正被改动） | §9.4 |
| D-1/D-3/D-4 在 `src/background/**` 无卡覆盖 | ✅ **本轮不修，登记已知遗留** | §9.1 |
| A 两条失效路径选哪条 | ✅ **同时修**（但请读 §A.0.1 的优先级输入） | §9.2 |
| E-3 推荐流 `[disabled] [checked]` | ✅ 判据认可，归 task-5 | §9.3 |

---

## 7. 证据文件清单

```
poc/probe/logout-login/
├── REPORT.md                        ← 本文
├── diag-log-evidence.txt            ← 面板「显示 → 诊断」日志原文（含 login/open 应答）
├── shots/                           ← 第一轮取证（A 缺凭据阶段 + D/E）
│   ├── 00-baseline-bangumi.png      ← 番剧页基线（主账号已登录，导航栏头像 129）
│   ├── 01-panel-opened.png          ← 面板展开（画质 Tab）
│   ├── 02-ax.json                   ← 首次语义树（含面板元素）
│   ├── 03-account-tab.png           ← 账号 Tab：还没有配置取流账号
│   ├── 03-account-tab-ax.json       ← 账号 Tab 语义树
│   ├── 04-after-login-click.png     ← 点「扫码登录取流账号」后：蓝提示「扫码窗口已打开…」
│   ├── 05-stale-red-notice.png      ← ★ 残留红提示常驻（「等了 3 分钟…」）
│   └── 06-diagnostics.png           ← ★ 诊断页：InPrivate=已允许、凭据=未配置、login/open 日志
└── supp/                            ← ★ 第二轮取证（用户扫码后，A 的退出全过程）
    ├── A-evidence-summary.txt       ← A 的逐条数据汇总（退出前/确认态/轮询/退出后）
    ├── A0-before-logout.png         ← 退出前：有凭据（{{取流账号昵称}} / 年度大会员）
    ├── A0-before-logout-tree.txt    ← 退出前语义树（含「退出取流账号」按钮）
    ├── A1-confirm-state.png         ← 第一步点击后：确认态（「确认退出」+「取消」）
    ├── A1-confirm-state-tree.txt    ← 确认态语义树
    ├── A2-after-logout.png          ← 退出后：卡片消失、按钮变「扫码登录取流账号」
    ├── A2-after-logout-tree.txt     ← 退出后语义树
    ├── C0-diag-before.png           ← C 前置：InPrivate 权限「已允许」的现场
    └── C0-diag-before-permission-off.txt ← C 前置状态（incognitoAllowed:true 原文）
```

### 关键真机数据（可直接引用，无需回看截图）

**A：退出全过程（用户扫码后，`supp/`）**
```
【退出前】proxy: {"enabled":true,"hasCredential":true,"ruleCount":4}
          playbackAccount: {"uname":"{{取流账号昵称}}","vipLabel":"annual","healthy":true}

【第一步】@e329 button "确认退出" + @e330 button "取消"    ← 有可见反馈

【第二步后 22 次轮询 t=393..110711ms】card=False logoutBtn=False login=扫码登录（每次都一样）
          => .acct-result「已退出取流账号，取流回退到主账号身份」一次都没被观测到

【退出后】proxy: {"enabled":false,"hasCredential":false,"ruleCount":0}   ← ★ 总开关被主动关闭
          playbackAccount: null
          面板：paragraph "还没有配置取流账号" + button "扫码登录取流账号"
```
**面板自检（`06-diagnostics.png`）**
```
InPrivate 权限                      已允许
主账号基线 · ep:341217 P1           有数据但解析不出轨道
取流账号（页面 playurl 响应）        尚未收到 playurl 响应
对比结论                            无法比较（缺一侧数据）
主账号昵称（页面读取）               （未读到，可能未登录或页面还没就绪）
可见窗口数                           3
无痕窗口数（当前分区可见）           0
可见 cookie 分区                     0
取流账号凭据                         未配置
播放代理总开关                       已关闭
DNR 全局路径规则                     0
DNR 标签页规则                       0
manifest incognito                   split
```

**`diag()` 日志原文（时间正序，取自同一次采集）**
```
00:22:23  isAllowedIncognitoAccess        true
00:22:25  windows.create returned         id=undefined incognito=undefined windowsBefore=3 windowsAfter=3 loginTabs=0
00:22:25  create 返回 undefined 且窗口数未变，交给握手判定
00:22:25  login/open                      {"ok":true,"reason":"assumed"}
00:22:25  create 返回 undefined 但权限正常 → 按已创建处理
00:26:39  isAllowedIncognitoAccess        true
00:26:39  windows.create returned         id=undefined incognito=undefined windowsBefore=3 windowsAfter=3 loginTabs=0
00:26:39  create 返回 undefined 且窗口数未变，交给握手判定
00:26:39  login/open                      {"ok":true,"reason":"assumed"}
00:26:39  create 返回 undefined 但权限正常 → 按已创建处理
00:29:02  diag/facts                      branch: ok | incognito=true windows=3 cookies=0 dnr=0/0
```

**窗口层实证**
```
PS> Get-Process msedge | ? { $_.MainWindowTitle } | select Id, MainWindowTitle
   Id MainWindowTitle
27664 登录播放账号 - [InPrivate]
```
⇒ `reason:'assumed'` 这一次**猜对了**（窗口确实存在）。但代码路径无法区分"猜对"与"猜错"，两者都会写 `login-ready`（D-4）。

---

## 8. 结论摘要（一句话版）

| 问 | 结论 | 最关键判据 |
| --- | --- | --- |
| **A** | ✅ **真机已完成**（用户扫码后）。第一步确认态可见；**退出成功后 1/2/3 三处变化全都发生了**，只有 `.acct-result` 22 次采样未见 ⇒ **用户说"没变化"只能是 `loadOnce()` 失败（静默 catch）**。另发现退出会**主动关掉总开关**而文案说"回退" | `content-panel.content.ts:385-388`（静默 catch，**P0**）、`tabs.ts:936-951`、`panel.ts:642-656`、`account-remove.handler.ts:32` |
| **B** | 任务卡的"`pb` 残留"假设**不成立**（每次都重取）。真问题换成两条：**(a)** `refreshModel()` 不传 `streamingIdentity` → `page` 身份被误判未配置；**(b)** `pb===null && hasCredential` 时卡片自相矛盾 | `panel.ts:487-499`、`panel-data.ts:332`、`tabs.ts:580/608/626` |
| **C** | 🔴 未取到说明页真机证据（本机权限已开；且工作区在取证时正被 task-4 改动，见 §9.3）。**e15dd68 版本**实测 **283 字可见 + 195 字折叠 = 478 字**；`lead` 与 `why` 重复；**「点图标」与实际入口不符（真 bug）** | `index.html:20-24` vs `:63-74`、`:59`、`main.ts:172` |
| **D** | ✅ **证据最充分**。三个真因：**①** `watchForLoginReady` **8 秒后永久摘监听器**（用户开权限 >8s）**②** `windows.onRemoved` **不判窗口**就清 `login-ready` **③** `assumed`（猜测）被当确定成功 → 无条件写 ready。加上失败提示常驻 + 文案指向不存在的按钮 | `login-handshake.ts:57-65`、`background.ts:513-517`、`background.ts:97-101`、`panel.ts:718` |
| **E** | 10 个控件全扫。**最严重是画质总开关**（`.catch(()=>null)` 完全静默，`panel.ts:459`）与**角标开关永久禁用不解释**。真机两次抓到推荐流开关 `[disabled] [checked]`（有凭据时、退出后各一次） | `panel.ts:459`、`:262-284`、`:431-455`、`tabs.ts:325` |

**D 节是"用户开了权限还要刷新"的核心答案**。其中 D-1/D-3/D-4 在 `src/background/**`，已裁决**本轮不修**（见 §9.1）。

---

## 9. 裁决落地（Lead 2026-11-12 已定，本节为定稿表述）

> 本节只记录**裁决结果**，不改动 §A–E 的既有证据与结论。

### 9.1 D-1 / D-3 / D-4：**本轮不修，登记为已知遗留**

**裁决**：不修。

**原因**：这三条要动的是**无痕分区登录握手**（ADR 0012 的核心）。`login-window.ts:59-67` 记录的实测事实说明 `assumed` **不能简单改成 `false`**（split 模式下窗口真的建出来了但 `create()` 返回 `undefined`，改 false 会误弹说明页）。本轮用户诉求是"不用刷新"，而 D-2（说明页自己轮询）能在 `entrypoints/need-incognito/**` 写域内**单独**解决这个痛点，不必撬动握手协议。

**将来要修时改哪一行**：

| # | 文件:行号 | 修法方向 |
| --- | --- | --- |
| D-1 | `src/background/login-handshake.ts:57-65` | `watchForLoginReady` 的 8 秒超时不应 `cleanup()` 后就永久失效 —— 改为"超时后转低频轮询"或去掉超时（由调用方负责停止） |
| D-3 | `entrypoints/background.ts:513-517` | `chrome.windows.onRemoved` 回调**没有拿到 `windowId`**。应改为 `(windowId) => { if (windowId !== currentWindowId) return; … }`，只清登录窗口自己的 ready 标记 |
| D-4 | `entrypoints/background.ts:97-101` + `src/background/login-window.ts:151` | `assumed` 表示"**猜测**已打开"，但被当成确定成功无条件 `markLoginReady()`。需要引入"**未证实**"这一态（例如写 `login-ready` 时带 `confirmed: false`），让说明页据此做"可能没开成"的提示，**而不是**把 `assumed` 改成 `false` |

> ⚠️ 这三条**都还没修**。任何基于"说明页能自己关"的结论都应同时知道：**D-3 未修时，关任何窗口都会清 `login-ready`**，D-2 的实现必须能容忍这一点（例如以 `isAllowedIncognitoAccess()` 为准，而不是只信 `login-ready`）。

### 9.2 A 节两条失效路径：已采纳，task-3 同时修

**裁决**：task-3 同时修 ①（静默 `catch`）和 ②（文案位置）。调查员**不需要再论证哪个更可能**。

**（本节由 Lead 裁决；但 A.0.1 真机证据另有一层信息需要 engineer 知道）**：真机证明 ① 是**用户报告现象的唯一解释** —— 若只修 ②，用户的问题不会消失。这不是"再论证"，是**修法优先级的输入**。

### 9.2.1 ✅ 落地状态总表（2026-11-12 00:50 调查员复查工作区，供 verifier 对照）

调查员在收尾时复查了工作区，逐条核对本报告的判据**是否已被落地**。**这是核对，不是验收** —— 验收归 task-6。

| 判据 | 主题 | 状态 | 当前落点 |
| --- | --- | --- | --- |
| **A-1** | `void loadOnce()` 不 await | ✅ 已改 | `content-panel.content.ts:263` `loadOnce().then((r) => …)` |
| **A-2** | 静默 `catch { return null }`（**P0**） | ✅ **已修** | `content-panel.content.ts:422-452` 失败时 `showNotice('界面数据刷新失败 —— 收起重开面板可重试', false)` |
| **A-2'** | 退出后重取失败的出口 | ✅ 已加 | `content-panel.content.ts:263-265` `showNotice('已退出，但界面刷新失败 —— 收起重开面板可刷新', false)` |
| **A-3** | 结果文案写在会被丢弃的 `box` 里 | ✅ **已修** | `tabs.ts:1018-1040` 改走 `actions.notifyResult` → `showNotice`（root 级） |
| **A-5** | 未复用 `showNotice` | ✅ 已复用 | 同上 |
| **A-6** | 文案说"回退"但实际关总开关 | ⚠️ **部分**：文案已改 | `tabs.ts:1038` 现为「取流回退到**浏览器当前账号**」。但 `disableProxy()` 仍会关总开关 —— **"关开关"这个事实仍未被文案表达**（措辞更易读了，事实仍是"扩展停止工作"而非"回退") |
| **B-1** | `refreshModel()` 不传 `streamingIdentity` | ✅ **已修** | `panel.ts:545-562` 走 `actions.currentStreamingIdentity()`，注释明确禁写死 |
| **B-2 / B-3** | 缺省身份导致误判 | ✅ 随 B-1 消解 | — |
| **B-4** | `pb===null` 时卡片文案自相矛盾 | ⚠️ 未核实 | — |
| **C-1** | lead 与 why 重复 | 🔄 task-4 改动中 | 新文案约 10 条 / 131 字（调查员实测工作区） |
| **C-3** | 「点图标」与实际入口不符 | ✅ 已修 | footnote 现为「开好后这里自动关，回到网页点『扫码登录取流账号』」 |
| **D-2** | 说明页 8 秒后无法自关 | 🔄 task-4 改动中 | 新增 `entrypoints/need-incognito/incognito-watch.ts`（5179 字节） |
| **D-1 / D-3 / D-4** | background 三条 | ⏸ **本轮不修**（§9.1） | 未动 |
| **D-5** | 失败提示常驻 | ⚠️ 未核实 | 裁决方向见 D 节"不许碰" |
| **D-6** | 提示说「重新登录」按钮却叫别的 | ⚠️ 未核实 | — |
| **E-3** | 推荐流 `[disabled] [checked]` | 🔄 归 task-5 | — |
| **E-1** | 画质总开关完全静默 | 🔄 归 task-5 | — |

> ⚠️ **A-6 需要 verifier 特别确认**：文案从「主账号」改成「浏览器当前账号」解决的是**用词可读性**，**没有**解决"用户以为取流还在、其实整个代理被关了"这个**事实层面**的误导。真机实测 `enabled:true→false`（见 A.0.2）。如果裁决认为"退出=停用一切"是预期且用户能接受，那只需在裁决文件里写明；如果不然，文案仍需补一句"画质增强同时已关闭"。


### 9.3 E-3（推荐流开关 `[disabled] [checked]`）：判据已认，归 task-5

**裁决**：判据是 `tabs.ts:325` 的 `disabled: !hasCredential`；"勾着但灰"是 UI 语义问题，已写进 task-5。

**补充一条更细的判据**（按要求只补一句，不展开）：

真机在**两个不同状态**下都复现了同一形态 —— **有凭据时**（`A0` 前）与**退出后无凭据时**（`C0` 后、`A2` 后）都是 `[disabled] [checked]`。后者说明：**`checked` 来自持久化的 `feedAccountEnabled=true`，与 `hasCredential` 无关**；`tabs.ts:318` 传的是 `checked: actions.feedAccountEnabled`，`:325` 单独用 `disabled: !hasCredential` 判可否点 —— 两者正交，于是"持久化的偏好"与"当前能否用"被画成了一个控件。**建议 task-5 让 checked 在 disabled 时不表达"已开启"语义**（例如渲染为未勾选 + 说明"登录后可用"），而不是仅加提示文字。

### 9.4 C 节：真机取证**移交 task-6**（verifier 最终验证时做）

**原因**：C 天然属于验收（task-6 完成判据本就含"说明页截图 + 数可见文字条目数与字数"）；且本次取证期间 `entrypoints/need-incognito/**` 正被 task-4 改动（见 §9.5），此刻测到的是**未定稿的中间态**，不该作为取证基线。

**交给 task-6 的验收清单（请 verifier 照此执行）**：
1. 关闭 Edge 对该扩展的「在 InPrivate 中允许」→ 记 `isAllowedIncognitoAccess` 值 + 扩展页状态
2. 面板账号 Tab 点「扫码登录取流账号」→ 说明页应出现
3. **数可见文字条目数与总字数**（去空白），给出"一眼能否读完"的判断（窗口 460×420）
4. **核对每一行是否属实**：入口是否为「面板按钮」（不是"点图标"）、`chrome://` vs `edge://`、步骤号、按钮名
5. **重点验 D-2**：开权限耗时 **>8 秒**，看说明页**能否自己关**（这是本轮修复的核心判据）
6. 完成前**必须恢复**「在 InPrivate 中允许」，并记一次状态证明已恢复

### 9.5 ⚠️ 取证期间工作区状态（记录，供 verifier 与 Lead 追溯）
2026-11-12 00:39–00:41 期间，工作区被其他成员改动（**非调查员所为**，调查员写域仅 `poc/probe/logout-login/`）：

```
 M entrypoints/need-incognito/index.html      (00:41:29)
 M entrypoints/need-incognito/main.ts         (00:41:29)
 M entrypoints/need-incognito/style.css       (00:39:43)
 M src/content/panel/panel.ts
 M src/content/panel/tabs.ts
?? entrypoints/need-incognito/incognito-watch.ts (00:41:46)
?? tests/unit/content/need-incognito-copy.test.ts
?? tests/unit/content/need-incognito-watch.test.ts
```

**影响**：
- **A 的证据不受影响** —— A 取证在 00:38 完成，早于上述改动；且退出链路涉及的文件（`content-panel.content.ts`、`account-remove.handler.ts`）**未被改动**。
- **C 的文案数字对应 `e15dd68`**（旧版 478 字）。工作区实际已是新文案（约 **10 条 / 131 字**，标题「先允许无痕窗口」、footnote 已修成「回到网页点『扫码登录取流账号』」）。**新文案的具体数字以 task-4 完成后的实测为准。**


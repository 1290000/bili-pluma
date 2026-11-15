# task-34 · 独立复核报告（被验：task-33 孤儿态主动探测 + 永不静默）

> verifier 只审不写。本报告全部结论来自本人亲手跑的探针/变异/verify，未采信 engineer 自述的任何一条。

## 一句话结论

**能收，但"用户实测的那条路径"在 guard 层面只有部分被守** —— 运行期探针证明 `controller===null + 孤儿态` 确实会出提示（判据 A/B/D 通过），源码形状守卫对 RV2/RV3 真红，但**同一段代码的"孤儿分支"本身没有任何守卫能杀**（RV1 三连全绿，见下），且 **判据 E 的心跳被 `ctx.onInvalidated` 从没触发这一事实架空**（见 E-iii 裁决）。

---

## 二、五条判据

### 判据 A（主）· `sendMessage` 抛孤儿态 → 真的有可见提示 ✅

**我怎么验的**：不读源码文本，**运行期**把 `openLogin` 的调用点真的跑起来。
`poc/probe/verify-task33/runtime-probe.mjs` 从 `entrypoints/content-panel.content.ts` 按花括号配平切出 `const openLogin = async () => { … }` 的函数体 → 去掉 TS 注解/`as` 断言 → `new Function` 重建 → 注入 fake `chrome.runtime.sendMessage`（**抛 `new Error('Extension context invalidated.')`**）、fake `document`（记录 appendChild）与 spy 化的 `showOrphanHint` / `isOrphanError` / `describeLoginOutcome`。

**结果**（`runtime-probe-baseline.txt`）：

```
[判据A] controller 存在 + 抛孤儿态 → 调用记录： ["showOrphanHint"]     → 有提示 ✅
[判据D] 正常返回             → 调用记录： []                          → 不误报 ✅
```

**反向验 RV1**：把 `if (isOrphanError(e))` 改成 `if (false && isOrphanError(e))`（**保留 `showOrphanHint()` 字样**，这正是"源码形状对、运行期静默"的典型假象）→
`Tests 13 passed (13)`，**engineer 的 13 条守卫全绿**。见下方 RV 表。
还原 `SHA 304084F4…771967` 逐字节一致。

> 结论：**行为是对的**（探针证明），**但守卫守不住它**。

### 判据 B（主）· `controller === null` 时仍有反馈 ✅ ← 用户实际遇到的形状

**运行期探针**（同一脚本，`controller` 参数传 `null`）：

```
[判据B] controller===null + 抛孤儿态 → 调用记录： ["showOrphanHint","showOrphanHint"] → 有提示 ✅
```

调了**两次** `showOrphanHint`：一次来自 catch 里的 `isOrphanError` 分支（`:237-239`），一次来自兜底 `:256`。`showOrphanHint()` 内部按 `ORPHAN_HOST_ID` 幂等（`orphan-hint.ts:71-72`），所以用户只看到一个提示条。**两条路都在是好事**（任一被删另一条还能顶）。

**反向验 RV2（我自己写的变异，不是照抄 engineer 的）**：不是改 `if (false && …)`，而是把**整条兜底语句**短路：

```ts
if (false && !isOrphanHintShown() && controller === null) showOrphanHint();
```

→ `Tests 1 failed | 12 passed`，真红：

```
× controller 为 null 且非孤儿时也要有反馈（兜底那条 if，钉完整前缀）
→ expected '{ stopPolling(); …' to match /if\s*\(\s*!isOrphanHintShown\(\)\s*&&…/
```

**engineer 自报的"第一轮假绿"复核**：他说旧正则 `/controller\s*===\s*null\)\s*showOrphanHint\(\)/` 能命中 `if (false && controller === null) showOrphanHint();`。**成立**——旧正则是子串匹配，短路前缀在它左边，够不着。现在的完整前缀正则抓得住（我实测红）。这条**它的自述属实，且它确实修好了**。

⚠️ 但注意 RV2 只杀"兜底那条"；**判据 B 的真实保障来自 catch 分支**（探针里第一次调用就是它），而那条 **RV1 杀不掉**——这是本卡最该修的洞。

### 判据 C · 提示条不依赖 controller、不被面板生命周期影响 ✅

- `orphan-hint.ts:70-126` `showOrphanHint()` 挂 `document.body ?? document.documentElement`（`:74`），自带 `attachShadow({mode:'closed'})`（`:84`），**签名零参数**；`hideOrphanHint` 按 `#pluma-orphan-hint` 摘除（`:130`）。
- 面板宿主 `#pluma-panel-host` 与 `#pluma-orphan-hint` 是**两个独立节点**，`removePanelHost()`（`ctx.onInvalidated` 里调用）不碰孤儿提示。**摘掉面板后提示仍在**——这是纯 DOM 结构事实，且 engineer 的 `orphan-hint.test.ts` 有直接覆盖（`document.body.innerHTML=''` 后重新 `showOrphanHint()` 可见）。
- 未做真机复验（时间盒/需要用户配合切权限），**如实标：这一条是源码 + jsdom 层证据，非真机**。

### 判据 D · 正常路径不污染 ✅

- 运行期探针：正常返回时 `showOrphanHint` **0 次调用**。
- 额外往返：`login/open` 之外**多了 `probeAlive()` 的 `proxy/status`**（启动一次 + 每 20s + 每次 document 点击 capture 阶段一次）。这是本卡**有意的设计**，不是污染，但**成本必须记账** → 见判据 E。
- ⚠️ 一条 13 条守卫里的**休眠断言**（不构成判据失败，但下一张卡要注意）：

```ts
expect(ORPHAN_HINT_TEXT).toContain('刷新页面');   // orphan-hint.test.ts:178
```

`ORPHAN_HINT_TEXT = '扩展已更新，页面里的旧面板已经失效 —— 请刷新页面（F5）后重新打开面板'` 是**常量**，`String.prototype.toContain` 在 node24/jsdom 下都**不存在**（→ `TypeError`），而 vitest 的 `expect().toContain` 对本条永远通过。**它证明不了任何事**，真正证明文案在产物里的是我下面这条 build grep。

### 判据 E · 20 秒心跳的成本与正确性 🟡（裁决：**不保留 20s 心跳，改成"只在点击时探"**）

**(i) `proxy/status` 是否只读 —— ✅ 是**，但我追到了第三层：
- `src/background/handlers/proxy.handler.ts:66-113` `handleProxyStatus()`：三个独立 try 块，只调 `isProxyEnabled()`、`readPersistedCredential()`、`describeRules()`。
- `describeRules()`（`src/platform/http/dnr.ts`）= `chrome.declarativeNetRequest.getSessionRules()` + `filter/map`，**纯读**。
- `readPersistedCredential` 读 `chrome.storage.local`。
- 写操作只出现在 `handleProxySet`（`:115-144`：`disableProxy()` / `enableProxy()`），**不在 status 路径上**。
- ⇒ **心跳不写 storage、不改 DNR 规则、不产生探测副作用**。engineer 的说法成立。
- ⚠️ 附注：`proxy.handler.ts:98` 调 `describeRules()` 会给 SW 打一次 `getSessionRules`（微秒级），**但这是每 20 秒一次、每个开着 B 站页面的标签页一次**。

**(ii) 页面隐藏时是否仍在跑 / 会不会泄漏 —— 🔴 会跑，且清理代码是死代码**：
- 无 `document.hidden` / `visibilitychange` 判断（全文件 grep 无命中）⇒ 后台标签页**永远每 20 秒唤醒一次 SW**。
- 另一个标签页开着 B 站 ⇒ 多一条心跳；用户开 5 个 B 站页面 = 每分钟 15 次 SW 唤醒。
- `ctx.onInvalidated()`（`content-panel.content.ts:834-846`）里的 `clearInterval(heartbeat)` 与 `removeEventListener('click', onAnyClick, true)` **语句是对的**，但 `:773` 的注释自己承认 **`ctx.onInvalidated` 实测从不触发** ⇒ **这两行清理在生产环境从没执行过**。
- 因此守卫里那条 `预期心跳定时器与点击兜底都在 onInvalidated 里清理` 是**源码形状断言**，它守的是一个不会运行的块。

**(iii) 裁决：`setInterval` 去掉，改为"只在点击时探 + 面板可见时低频探"**

理由（按重要性）：
1. **20s 心跳解决的是一个已经被点击兜底解决的问题**。用户的动作永远以"点击"开始；`document` capture 阶段的 click 探活（`:822-823`）能在业务 handler 之前弹出提示。心跳 20s 以内轮到的概率，对"用户坐下→点按钮"这个动作链来说**增量价值接近 0**，而它对每个后台标签页的常驻成本是确定的。
2. **它是"用户没点也在跑"的唯一一条路径**，恰好也是本卡唯一一条会持续消耗电量的路径。B 站视频页常开后台上几小时是常态。
3. 若担心"用户没点、但面板已经死了"这一态需要主动暴露，**正确做法是 `visibilitychange` + 回到前台探一次**，而不是 20s 常轮询：成本从"每 20s"降到"每次切回页面 1 次"，覆盖面反而更准。
4. 清理是死代码（见 ii），**心跳一旦启用就再没有回收点**——被卸掉的面板不会停表。

**最小改法**：删 `:808` 的启动探 + `:809` 的 `setInterval`；保留 `onAnyClick`（capture）。若仍要"回前台探一次"，加 `document.addEventListener('visibilitychange', () => { if (!document.hidden) probeAlive(); })` 并在同一处随 click 一起摘。

> 这一条**不影响本卡功能正确性**，是成本裁决，可放进下一张卡；但它属于"用户没要求、代理自己加的常驻行为"，按 §3 的纪律应当先问用户。

---

## 三、三件必须核对的事

### 1. 写域 ✅（零违规）

基线 `git status --porcelain` = 56 行；收工 56 行，**唯一差异是新增 `poc/probe/verify-task33/`**（我的写域），基线里那个临时文件 `verify-task33-baseline.tmp` 已被我收拾掉。

`src/background/**`、`src/platform/**`、`src/shared/types/**`、`entrypoints/need-incognito/**`、`vitest.config.ts` 的 `M` 行**全部属于 task-3/4/5/8/9/10/11/33 之前的既有改动**（本卡开工前就在），本卡只新增了 `src/content/panel/orphan-hint.ts` 与 `tests/unit/content/panel/orphan-hint.test.ts`（`??` 且 `?? src/content/panel/orphan-hint.ts` 与 engineer 自述一致）。

**`@vitest-environment jsdom` 文件头 ✅ 生效**：`vitest.config.ts:30` 仍是 `environment: 'node'`（未被改动），而 `orphan-hint.test.ts` 单独跑 `13 passed` 且真的建了 DOM host（`document.getElementById(ORPHAN_HINT_HOST_ID)` 断言通过）——若文件头不生效，`document` 会是 undefined 直接炸。

### 2. `node scripts/verify.mjs` —— **我自己跑的** ✅

```
[test] test   ✅ 22.3s
[verify] ✅ 21 项全绿（共 33.6s，并行墙面 33.6s，串行合计 75.7s）   exit=0
```
全量 vitest：`114 passed (114)` / `1864 passed (1864)`。

### 3. 构建产物 ✅

`.output/chrome-mv3/content-scripts/content-panel.js`：`LastWriteTime = 2026-11-12 19:54:42`（19:5x ✅）。
grep：`扩展已更新`=**1**、`刷新页面`=**4**、`Extension context invalidated`=**3**、`proxy/status`=**5**、`pluma-orphan-hint`=**1** —— 与 engineer 自述**完全一致**。
⇒ 文案与宿主 id 真的在产物里（这条比单测里那个恒真的 `toContain` 有力）。

---

## 四、RV 表（全部我自己写变异、自己跑、逐字节还原）

| # | 变异 | 结果 | 判定 |
|---|---|---|---|
| **RV1** | `if (isOrphanError(e))` → `if (false && isOrphanError(e))`（**保留 `showOrphanHint()` 字样**，运行期静默） | `13 passed (13)` | 🔴 **假绿：guard 杀不掉** |
| **RV2** | `if (!isOrphanHintShown() && controller === null) showOrphanHint();` → 前加 `false &&` | `1 failed \| 12 passed`，红在 `controller 为 null 且非孤儿时也要有反馈` | ✅ 真红 |
| **RV3** | 探活消息 `proxy/status` → `account/summary` | `1 failed \| 12 passed`，红在 `主动探活只发一条只读消息` | ✅ 真红 |
| 还原 | 三次 `Copy-Item` 备份还原 | `SHA 304084F4FCDDABCA1F11E17B174E0639207524C7A1DA112731E41CA654771967` | ✅ 逐字节一致 |

**RV1 为什么是这一卡最该修的洞**：engineer 的 `login/open` catch 守卫是 `expect(code).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/)` 与 `expect(code).toContain('showOrphanHint(')` —— **两条都是"字符串在不在"**。任何把 `if (isOrphanError(e))` 短路、把 `showOrphanHint()` 挪进永假分支的写法都活着。而这一段恰恰是**用户实际遇到的那条路径的唯一保障**（判据 B 探针里第一次调用就来自它）。

✅ **修法（已写进待修清单）**：把"字符串在不在"换成**运行期探针**（即 `runtime-probe.mjs` 的做法：切片 + `new Function` + spy `showOrphanHint`），或至少补一条"孤儿分支内不许出现 `false &&` / 不许被 `try{}catch{}` 吞掉"的结构断言。**工程内已有先例**：`orphan-hint.test.ts` 的 `stripComments` + `braceBlock` 就是这套手法，只差把 spy 接到运行期。

---

## 五、待修清单

| 级别 | 问题 | 建议 |
|---|---|---|
| **高** | **孤儿 catch 分支无有效守卫**（RV1 假绿）。用户报告的就是这条路径，而它是唯一一条"源码形状对、运行期静默"还能全绿的 | 把 `openLogin` 的运行期探针搬进 `tests/unit/content/panel/orphan-hint.test.ts`（可直接抄 `poc/probe/verify-task33/runtime-probe.mjs`），断言 spy `showOrphanHint` 在"`sendMessage` 抛孤儿 + `controller===null`"下被调用 |
| **高** | **判据 E(iii) 裁决**：20s 常量心跳会被每个后台 B 站标签页永久运行，且 `ctx.onInvalidated` 从没触发 ⇒ 清理是死代码，没有回收点 | 删 `setInterval`，保留 click capture 探活；若需回前台探，改 `visibilitychange`。**若坚持保留常驻心跳，须先问用户**（§3 纪律：代理不许自己加用户没要求的常驻行为） |
| **中** | `orphan-hint.test.ts:178` `expect(ORPHAN_HINT_TEXT).toContain('刷新页面')` 恒真（对常量对象断言 toast 方法），证明力为零 | 删掉，或如实改成 `expect(ORPHAN_HINT_TEXT).toContain(ORPHAN_HINT_ACTION)`（后者是真实字符串断言） |
| **中** | 心跳清理守的是 `ctx.onInvalidated` 这个**不会执行的块**；且无 `document.hidden` 判断 | 与上一条合并处理：若心跳保留，清理挂到真正会跑的路径上 |
| **低** | 判据 C 只有源码 + jsdom 证据，**真机未验**（需用户切 InPrivate 权限配合） | 留给 Lead 决定是否要真机复验 |
| **低** | `orphan-hint.test.ts` 13 例中 11 例是源码文本匹配 | 逐步向运行期探针迁移，至少把 A/B 两条主判据迁完 |

---

## 六、给 Lead 的一句话

**能收**——用户点下去会看到提示（运行期探针实证），文案与产物都已到位，verify 全绿、写域干净。
**但别对外说"这条路径已经守住"**：能杀掉"孤儿分支"的测试现在一条都没有，下一张卡里它随时可能被"顺手整理"掉而无人报警。心跳那条我建议**撤掉常驻**，理由在 E(iii)。

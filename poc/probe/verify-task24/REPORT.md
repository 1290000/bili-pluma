# task-24 独立复核 —— verifier

**日期**：2026-11-12 · **复核对象**：engineer-panel 的 task-24（方案 A：心跳探测已开着的 InPrivate 扫码窗口）
**复核者立场**：只审不写。本目录之外**零改动**（`git status` 只有 `?? poc/probe/verify-task24/`）。

---

## 最终裁定：**有条件成立**

三条核心改动都做对了，四项 RV 全部是真红（不是假红），写域干净，verify 21/21。
**但方案的地基（`inIncognitoContext`）是假设，且它的失败模式是"首次点击就开不出窗口"** —— 我实测复现了这个模式。用户真机验证前必须知道这条。

| # | 重点 | 结论 |
| --- | --- | --- |
| ① | `inIncognitoContext` 恒 false 的失败模式 | 🟡 **风险存在，代码没有阻止，兜底兜的不是这个方向** |
| ② | 心跳时序竞态 | ✅ 首次点击必走 `create()`（已实测）；🟡 强杀后 90 秒误判 |
| ③ | `already-open` 的 `ok:false` | 🟡 **判断成立但会显示红字常量级常驻**，见待修 1 |
| ④ | 写端测试是否假绿 | 🟡 **`stripComments` 有效、真红可复现；但它证明不了"运行时真的在跑"** |

---

## A. `node scripts/verify.mjs`（我自己跑的）

```
[verify] ✅ 21 项全绿（共 27.3s，并行墙面 27.3s，串行合计 56.2s）
[status: completed, exit code: 0]
```

与 engineer 自报一致（他报 26.6s，我 27.3s，正常波动）。
**注意**：verify 全绿**不能**作为"方案成立"的证据 —— 它只证明测试与产品代码自洽，不代表 `inIncognitoContext` 在真机上可用。这一点是本次复核的核心分歧。

---

## B. 写域核对（C 项）

`git status --porcelain` 中 task-24 相关的：

| 文件 | 状态 | 是否在卡内写域 |
| --- | --- | --- |
| `src/background/login-window.ts` | `M` | ✅ |
| `src/content/panel/login-outcome.ts` | `M` | ✅ |
| `entrypoints/login-window/main.tsx` | `M` | ✅ |
| `tests/unit/background/login-heartbeat-probe.test.ts` | `??` | ✅ |
| `tests/unit/background/login-heartbeat-wiring.test.ts` | `??` | ✅ |
| `tests/unit/content/panel/` | `??`（目录） | ✅ |

**无越界**。其余 16 个 `M` + 5 个 `??` 属 task-3/4/5/8/9/10/11 的历史遗留，与 task-24 无关。

---

## C. 自己做的反向验证（B 项）

脚本：`rv.mjs`（读原文 → 单点替换 → 跑测试 → 写回原文 → SHA256 比对）。
**未使用** `git checkout` / `git stash` / `git reset`。判据区分「真红（AssertionError）」与「假红（no tests / 语法错误）」。

| RV | 改回什么 | 结果 | 红的测试 |
| --- | --- | --- | --- |
| **RV1** | `isIncognitoInstance` 恒返回 `false`（拆掉安全闸） | **真红（AssertionError）** | 1 条：`无痕实例即使能看到自己的心跳也**不探测**`<br>`expected { at: … } to be null` @ `login-heartbeat-probe.test.ts:153` |
| **RV2** | `probeExistingLoginWindow()` 恒返回 `null`（回到 task-22 死分支） | **真红（AssertionError）** | 1 条：`心跳活着时返回 already-open，且**不调用** windows.create`<br>`expected 'assumed' to be 'already-open'` @ `:164` |
| **RV3** | 删掉 `assumed` 的中性文案分支（回到"扫码窗口已打开"） | **真红（AssertionError）** | 3 条：`不得出现「已打开」`、`必须给出下一步`、`与确定打开必须不同`<br>`expected '扫码窗口已打开，请用手机扫码…' not to contain '已打开'` @ `panel-login-outcome.test.ts:257` |
| **RV4** | `main.tsx` 不再周期写心跳（**注释里仍保留 `writeLoginHeartbeat` 字样**） | **真红（AssertionError）** | 2 条：`必须用 setInterval 周期写`、`间隔必须取自 LOGIN_HEARTBEAT_INTERVAL_MS`<br>`expected 'useEffect(() => {…' to contain 'setInterval'` @ `:120` |

**RV4 额外证明**：我在变异体里**故意留下** `writeLoginHeartbeat` 的注释字样，测试仍然变红 ⇒ `stripComments()` **确实有效**，不是靠注释骗过的假绿。

**还原证明**（逐字节）：

| 文件 | 复核后 SHA256 | 与 engineer 申报 |
| --- | --- | --- |
| `src/content/panel/login-outcome.ts` | `F7AC5334…4FB5C68C` | ✅ **完全一致** |
| `src/background/login-window.ts` | `8017F606…01FE96B` | ❌ **不一致**（他报 `60880BEC…0430031`） |
| `entrypoints/login-window/main.tsx` | `954D1AC8…CF7C9B9ED4` | 他未申报 |

`login-window.ts` 的 SHA 不符**不代表文件被污染**：我的四个变异都已逐字节还原（`restored=true`），且全文搜索 `RV1 mutated` / `RV2 mutated` / `RV3 mutated` / `RV4 mutated` **零命中**，无 `.rvbak` 残留。
**唯一解释**：engineer 申报 SHA 时与交付时的文件内容不同 —— 大概率是他申报后**又改过**这个文件（例如 review 时补注释），没更新 SHA。**这条是记录性问题，不是代码问题**，但说明"申报的 SHA"这个证据链他维护得不够严。

---

## D. 重点 ① —— 🔴 `inIncognitoContext` 恒为 false 的失败模式

### D.1 代码里有没有被阻止？**没有。**

`src/background/login-window.ts:152-158`：

```ts
function isIncognitoInstance(): boolean {
  try {
    return chrome.extension.inIncognitoContext === true;
  } catch {
    return false;
  }
}
```

`probeExistingLoginWindow()`（`:184-201`）的第一句就是 `if (incognito) { diag('probe/skip', …); return null; }`。
**这是唯一的闸门**。API 恒为 `false` ⇒ 闸门恒失效 ⇒ 无痕实例也去读心跳。

### D.2 兜底对不对？——**兜住的是"多开一个窗口"，兜不住"开不出窗口"**

engineer 的注释（`:149-150`）写：

> 读不到就当**普通实例**（`false`）。理由：普通实例是"探测 + 建窗"的那一侧，判错的后果是"多重开一个窗口"。

**这个推理只覆盖了一半。** 判错有两种方向：

| 判错方向 | 后果 | 兜住了吗 |
| --- | --- | --- |
| 无痕实例被判成**普通**（`true`→`false`） | 无痕实例也去探测 → **读到自己写的心跳** → `already-open` → **不建窗** | ❌ **兜不住** |
| 普通实例被判成**无痕**（`false`→`true`） | 普通实例跳过探测 → 走到 `create()` → 多开一个 | ✅ 兜住了 |

engineer 说的"多开一个窗口"是**第二种**，而 `inIncognitoContext` 恒 false 产生的是**第一种**（最糟的那种）。**注释把两个方向混为一谈了。**

### D.3 我实测复现了这个模式

用 `race-sim.test.ts`（只 import 产品代码，不 mock 被测函数；用同一份 storage bag + 可切换的 `inIncognitoContext` 模拟两个分区实例 —— 等价性论证见文件头注释）：

```
S2 🔴 inIncognitoContext 恒为 false 时的失败模式
  ✓ 无痕实例"看不到自己是无痕" → 写入心跳后下一次点击直接 already-open（窗口开不出来）
    → expect(r).toEqual({ ok:true, reason:'already-open' })
    → expect(createMock).not.toHaveBeenCalled()   ✅ 真的没建窗
  ✓ 🔴 更糟：首次点击时窗口已开着（上一个会话残留心跳）→ 直接 already-open
  ✓ ✅ 心跳过期后仍能恢复（TTL 是唯一的恢复路径）
```

**7/7 全绿** —— 即"失败模式确实存在，且唯一恢复路径是等 90 秒 TTL 过期"。

### D.4 能不能不碰浏览器就从文档判断？——**部分能，结论是"文档支持，但真机未验证"**

我实际去查了，不是"猜文档"：

1. **项目自带的类型定义** `node_modules/@types/chrome/index.d.ts:4790`：
   > `True for content scripts running inside incognito tabs, and for extension pages running inside an incognito process. **The latter only applies to extensions with 'split' incognito_behavior.**`
   ⇒ 语义上**正好就是**我们要用的场景（split 模式下的扩展页面）。

2. **Chromium 源码** `chrome/common/extensions/api/_api_features.json`：
   ```json
   "extension.inIncognitoContext": {
     "contexts": ["privileged_extension", "unprivileged_extension", "content_script"]
   }
   ```
   ⇒ 它在 **privileged_extension** 上下文可见 —— MV3 service worker 属于这一类，**不是** content-script-only。

3. **实现路径找到了**：`extensions/renderer/extensions_renderer_client.h` 有 `virtual bool IsIncognitoProcess() const = 0;`，`chrome/renderer/extensions/chrome_extensions_renderer_client.cc:68-70` 实现为 `process_state::IsIncognitoProcess()`。
   `extensions/renderer/bindings/api_binding.cc:468-472` 的注释确认：
   > `// …It's only used, it seems, for lastError and inIncognitoContext, which are both handled with custom bindings.`

**但我没能定位到"把 `IsIncognitoProcess()` 赋给 `inIncognitoContext` 的 MV3 SW 那条具体代码路径"** —— 我搜了 `dispatcher.cc` / `script_context.cc` / `module_system.cc` / `service_worker_data.cc` / `api_bindings_system.cc` 等 12 个文件，`incognito` 命中均未落在赋值处。**这是搜索不完整，不是"文档矛盾"**。

**结论**：文档与源码结构都**支持**它在 MV3 SW 里可用，**没有**任何证据说它会恒 false。
**但它仍然没有被本机实测过** ⇒ 必须真机验证，而且验证方法 engineer 已写在注释里（`:144-147`）且**是正确的**：

> 点一次扫码登录，看诊断日志 `probe/instance` —— 一次点击应产生**两条**（`incognito=false` / `incognito=true`）。若两条都是 `false`，说明 API 不可用。

### D.5 给真机验证的一句判据

**这一条是本次复核最有用的产出**：真机第一次点击后，查日志
```
probe/instance | incognito=false
probe/instance | incognito=true
```
**两条都出现 = 方案成立**。**只有 `false` 的一条 = 方案有缺陷，必须先修 D.2 再交给用户**。

> ⚠️ 但抓这两条日志需要窗口已开、再点一次 —— 而"已经开着再点"正是用户要测的场景，所以这次真机测试**恰好能同时验证这个地基**。不需要额外实验。

---

## E. 重点 ② —— 心跳时序竞态

### E.1 首次点击是否永远走 `create()`？——**是，已实测**

```
S1 首次点击（无心跳）→ 走 create，返回 assumed
  ✓ createMock 调用 1 次，返回 { ok:true, reason:'assumed' }
S3 窗口刚 create、页面还没加载完（无心跳）→ 立即再点一次仍走 create
  ✓ 两次都 assumed，createMock 调用 2 次
```

**这是对的**：扫码窗口是异步加载的，首次点击时一定没有心跳 ⇒ 一定走 `create()`。engineer 的注释承认了这一点，实测也符合。
**副作用**：窗口刚开、页面还在白屏的 ~几百毫秒内连点两次，会开**两个**窗口。这条**原本就存在**（task-22 之前就是这样），不是 task-24 引入的退化。

### E.2 页面被强杀时 —— 🟡 90 秒内误判，用户看到的是**又一次"点了没反应"**

```
S3 页面写完心跳后立刻探测到（窗口被强杀时 unload 清不掉，只能等 TTL）
  ✓ 返回 already-open
```

`main.tsx:133-137` 的 cleanup 只在**正常卸载**时跑：

```ts
return () => {
  cancelled = true;
  window.clearInterval(timer);
  void clearLoginHeartbeat();
};
```

崩溃 / 进程被杀 / 浏览器崩溃 ⇒ cleanup 不跑 ⇒ 心跳残留 ⇒ **90 秒内**用户再点扫码，看到的是：

> 「扫码登录窗口已经开着了 —— 它就是上面那个窗口，请直接在那里操作」

**而他屏幕上根本没有那个窗口。** 这**正是本轮要修的那个症状**（"点了没反应 / 说了不存在的事"），只是原因从"探测不到"换成了"探测错了"。

**为什么我认为这不是"必改"**：90 秒后自愈，且是常见浏览器崩溃场景而非日常路径。**但它必须在真机验证清单里**，而不是当成已解决。

---

## F. 重点 ③ —— `already-open` 的 `ok: false`

### F.1 engineer 的理由成立吗？——**一半成立**

`src/content/panel/login-outcome.ts:106-113` 的理由：
1. "这次点击没有达成用户想要的结果（没打开新窗口）" ⇒ **成立**
2. "`if (!r.ok) return;` 会跳过轮询重启，窗口本来就在跑自己的轮询，这里再启一轮只会多一份重复请求" ⇒ **成立**（我读了 `entrypoints/content-panel.content.ts:205-210`，确认 `if (!r.ok) return` 在 `startLoginPolling(...)` 之前）

### F.2 但代价是「好消息显示成红字且常驻」

`src/content/panel/panel.ts:851-873`：

```ts
bar.classList.toggle('danger', !ok);   // ok=false → 红色
if (ok) {
  noticeTimer = setTimeout(() => { … bar.remove(); }, NOTICE_TTL_MS);  // 只有 ok=true 才自动消失
}
```

⇒ `ok:false` 的提示 **用危险色、且永不自动消失**。

我的判断：**探测到窗口已开着、把它聚焦过去，是一个"信息"而不是"失败"。** 用户看到红色常驻的「扫码登录窗口已经开着了」，第一反应是"又出错了"，而他其实只需要去那个窗口扫码。

**但是**：改成 `ok: true` 会连带打开轮询（`if (!r.ok) return` 之后就是 `startLoginPolling`），多开一条 3 分钟轮询。这个副作用是真的。

**⇒ 正确解法不是"改 ok"，而是把它们解耦**（见待修 1）。

---

## G. 重点 ④ —— 写端测试是不是假绿

### G.1 `stripComments()` 真的有效吗？——**有效，我做了反向验证**

RV4 的变异体**故意在注释里保留** `LOGIN_HEARTBEAT_INTERVAL_MS` 字样（`// RV4 mutated: …`），只删掉真正的 `setInterval(beat, LOGIN_HEARTBEAT_INTERVAL_MS)` 调用 → 测试**照常变红**。

⇒ 不存在"注释里写了就假绿"的问题。
另外 `login-heartbeat-wiring.test.ts:37-65` 的 `stripComments` 是**字符级状态机**（不是单条正则），处理了字符串里的 `/*` 这类常见坑。

### G.2 但它能证明什么、不能证明什么？——**必须说清**

| 能证明 | 不能证明 |
| --- | --- |
| `main.tsx` 源码里**存在**周期写心跳的代码 | 这段代码在**运行时真的被执行了** |
| `setInterval` 用的是导出的常量（不是硬编码） | 无痕实例里 `chrome.storage.local.set` **真的写成功了** |
| cleanup 里有 `clearInterval` + `clearLoginHeartbeat` | 两个分区的 `storage.local` **真的共享**（这是方案地基的另一半） |

**这不是"测试写得不好"**，是静态断言的**固有限制**，且 engineer 在文件头（`:17-25`）**主动写明了**"为什么是读源码而不是跑组件"（`main.tsx` 末尾 `render(<App/>, root)` + `document.getElementById` 在 node 下无法安全加载，重构又超出本卡范围）。**这个取舍是诚实且合理的。**

**但任务卡要求"说明 `--allow 无痕分区 SW 独立实例` 这个假设你怎么验证的"—— 这条写端测试回答不了它**，因为它只是静态断言。

### G.3 跨分区 `storage.local` 共享 —— **有既有实证，风险较低**

`src/background/login-handshake.ts:5-8` 文件头：
> `incognito: "split"` 下普通/无痕 background 是两个**互不通信**的实例…**只有 `chrome.storage.local` 是共享的（官方文档明确说明）**

且真机存储里**确实存在过**无痕实例写入的 `pluma:login-ready` 记录（task-12 取证）。⇒ 这条**不是纯假设**，是本项目踩过之后记录的实测结论。**这是本方案里最扎实的一环。**

---

## H. 待修清单（交 Lead 派 engineer）

> 我**没有改任何源码**。以下全部是建议，由 Lead 决定是否开卡。

### 待修 1【中】`already-open` 的 `ok:false` 会把好消息变成常驻红字

- **问题**：`login-outcome.ts:115-118` 用 `ok: false`，而 `panel.ts:851-873` 对 `ok:false` 用危险色且**永不自动消失**。
- **建议**：文案与"是否轮询"解耦。例如让 `describeLoginOutcome` 返回 `{ text, tone: 'info'|'danger', shouldPoll: boolean }`，`already-open` 用 `tone: 'info'` + `shouldPoll: false`。
- **不改的代价**：用户看到红色常驻「窗口已经开着了」，以为是错误。
- **注意**：这是**改公共类型**，影响 `openLogin` / `removeAccount` 等 5 处调用点，要单开卡。

### 待修 2【中】`inIncognitoContext` 是假设，且失败模式没有被兜住

- **建议 A（低成本，推荐）**：保留现状，**但把真机日志判据写进交付说明** —— 第一条日志出现两条 `probe/instance` 才算方案解锁（判据见 D.5）。
- **建议 B（防御性）**：在 `probeExistingLoginWindow()` 里补一层"无痕实例自证"—— 例如心跳里带 `instance` 标识，若读到的 `beat.instance` 与**本实例的 `instanceId()` 相同**，说明是自己写的，按"没探测到"处理。
  ⚠️ **但注意**：两个分区是两个独立 SW，`instanceId()` 大概率本来就不同 ⇒ **这层防御可能完全无效**，实现前必须先确认 `instanceId()` 在两个分区是否不同。**不要直接实现。**

### 待修 3【低】`login-window.ts` 申报的 SHA256 与实际不符

- 他报 `60880BEC…0430031`，实际 `8017F606…01FE96B`。
- 这**不影响代码正确性**（我的 RV 已逐字节还原并验证），但说明"用 SHA 证明还原"这条证据链他没维护好。**提醒即可，不必返工。**

### 待修 4【低】强杀场景 90 秒误判

- 窗口崩溃后心跳残留，90 秒内点扫码会返回 `already-open` 并说"请去上面那个窗口操作"，而窗口不存在。
- **建议**：本轮**不改**（自愈路径清晰），但**写进用户真机验证清单**：「如果窗口崩了，等 1.5 分钟再点」。

---

## I. 给 Lead 的一句话

**方案在"第二次点击不再静默"这个目标上是成立的，四条 RV 全部真红，测试不是假绿。**
**唯一必须先过的是 D.5 那条日志判据**：真机第一次测时看 `probe/instance` 是否出现 `incognito=true`。出现了，直接交用户；只有 `false`，先修待修 2 再交。

---

## 附：本目录产物

| 文件 | 用途 |
| --- | --- |
| `REPORT.md` | 本报告 |
| `race-sim.test.ts` | 7 条场景模拟（S1 正常态 / S2 失败模式 / S3 时序），7/7 全绿 |
| `vitest.probe.config.ts` | 只跑本目录测试的独立配置（不污染产品测试集合） |
| `rv.mjs` | 四条反向验证：单点变异 → 跑测 → 写回 → SHA256 |
| `rv-result.json` | RV 原始结果（含每条红的断言消息与还原 SHA） |
| `verify-21-green.txt` | `node scripts/verify.mjs` 完整输出 |

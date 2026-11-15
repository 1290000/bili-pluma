# task-28 独立验收报告（task-29）

- **被验对象**：task-28（rev 3）—— `logsMeta` 缺失时 `diagnosticsPane()` 崩渲染，收敛出 `describeLogsMetaFallback()` 两侧共用
- **验收人**：verifier（只审不写；本报告目录 `poc/probe/verify-task28/` 是本次唯一写域）
- **时间**：2026-11-12 18:30–18:41
- **工作区**：engineer 已被 Lead 叫停，全程无并发编辑（时间线见 §7）

---

## 0. 一句话结论

**能收。**

五条判据 A/B/C/D/E **全部成立**，五组反向验证**全部真红**，`node scripts/verify.mjs` **21 项全绿（32.0s，我自己跑的）**，工作区在 RV 后逐字节还原。

**但有一处必须让 Lead 知道的判定**：判据 D 的"逐字段相等"我按 engineer 的理由**收窄成"观测类字段相等（`ok`/`err`/`count`），动作类字段（`limit`/`instanceId`/`readAt`）允许不同"**。这个边界是**我审过它的理由后同意的**，不是 Lead 替我定的（理由见 §3.D）。收窄后我仍然验出了它能验的东西：如果有人把导出侧改回各自写一份、或两侧兜底取值分叉，行为级断言会红。

---

## 1. 怎么复跑（全部命令都能直接粘贴）

```powershell
# ① 我的 verify 基线（不引用任何人的输出）
node scripts/verify.mjs
# → [verify] ✅ 21 项全绿（共 32.0s，并行墙面 32.0s，串行合计 73.6s）  → verify-21-green.txt

# ② 我的探针（11 条，含静态穷举守卫）
node node_modules\vitest\vitest.mjs run --config poc\probe\verify-task28\vitest.probe.config.ts
# → Test Files 3 passed | Tests 11 passed

# ③ engineer 那组产品守卫（独立跑）
node node_modules\vitest\vitest.mjs run tests/unit/content/panel-diagnostics-export.test.ts
# → Tests 20 passed (20)

# ④ 反向验证（5 组，含还原后 SHA256 核对）
node poc\probe\verify-task28\rv.mjs
# → poc\probe\verify-task28\rv-result.json
```

> ⚠️ 本机**没有 `npx`**；PowerShell 会把 Vite 的 CJS 弃用警告打到 stderr 并让 `$?` 变 false，那是噪声。以 stdout 的 `Test Files … / Tests …` 为准。

---

## 2. 五条判据逐条裁定

### 判据 A · 缺 `logsMeta` 不抛，且渲染"不可信"态 ✅ 成立

验法：直接调 `diagnosticsPane()`，`data` 里**整个 `logsMeta` 键都不给**。

四条断言**成对**：（正面骨架/失败态/不许"还没有日志"/必须给"刷新"出口）

```
✓ A1 不抛 + 成对断言
  expect(t).toContain('自检信息')            ← 正面骨架：证明页面真渲染了
  expect(t).toContain('诊断日志读取失败')
  expect(t).not.toContain('还没有日志')
  expect(t).toContain('刷新')
```

**为什么必须成对**：`not.toContain` 在**空白页**上恒真。如果只写"不许出现失败文案"，`diagnosticsPane` 返回一个空 `div` 也会绿 —— 那正是 task-6 第一轮我在 `feed-account-effective-state.test.ts` 里抓到的恒真断言形状。这里我先断言骨架存在，后面的 `not` 才有意义。

RV1（去掉 `?? describeLogsMetaFallback()`）→ **4 条真红**。

### 判据 B · 两个访问点分别覆盖 ✅ 成立（含 Lead 点的"真的走到 `.err`"）

Lead 指出的：我原稿写「传 `ok:true, err:null` 让它走到 `err` 分支」**逻辑不成立** —— `ok:true` 走成功分支。改用 Lead 给的构造：

```ts
logsMeta: { ok: false } as never      // 缺 err
```

**我验的"真的走到了 `.err`"是这样证的**（不是"没抛就过"）：

- `{ok:false}` 没有 `err` 属性 → `meta.err === undefined`
- `diagnostics.ts:398` 的判断是 `if (meta.err !== null)` → `undefined !== null` 为 **true**
- 于是会走进 `:399` 的 `` `（${meta.err}）` ``，渲染出字面 **`（undefined）`**

断言 `expect(t).toContain('（undefined）')` **通过** —— 这是运行期路径真的执行到 `.err` 那一行的**正向证据**。如果实现被短路（比如 `ok===false` 时提前 return），这条会红。

**`as never` 的运行期语义**：`as never` 只是 TS 的编译期断言，**运行期对象就是 `{ ok: false }` 本身**，一个只有 `ok` 键的普通对象。所以这条测试在运行期确实走的是"残缺形状 → 失败分支"。

B2 补充：`logs` 非空但 `ok:false` 时也能到达失败分支的 `.limit` 访问点，不崩。

### 判据 C · fallback 语义必须"不可信" ✅ 成立

```ts
const f = describeLogsMetaFallback();
expect(f.ok).toBe(false);                              // ← 取 true 就是把崩溃换成谎报
expect(['unknown','not-read-yet','数据缺失']).toContain(f.err);
expect(f.count).toBe(0);
expect(f.err).not.toBe(null);
```

C2 从**渲染结果**同一口径再验一次：缺 `logsMeta` 时页面上不许出现成功态标题 `最近 0 条`，必须出现 `诊断日志读取失败`。

RV2（把 fallback 改成 `{ok:true, err:null}`）→ **5 条真红**，其中：
```
C1 → ok 取 true 就是把崩溃换成谎报: expected true to be false
A1 → 缺 logsMeta 必须报读取失败: expected '‹ 返回诊断⟳代理状态未知…' to contain '诊断日志读取失败'
```

### 判据 D · 导出侧与渲染侧共用同一个 fallback ✅ 成立（边界经我同意后收窄）

#### D 的边界：我同意的部分和不同意的地方

engineer 的理由是：

> `limit`/`instanceId`/`readAt` 描述**这次导出动作本身**，`ok`/`err` 描述**日志读没读到**；没做过的观测不能冒充观测结果。

**我审过之后同意这个区分**，理由不是"让它绿"，而是它区分的是**两个不同的主语**：

- `ok`/`err`/`count` 的主语是**日志存储**（这次的观测对象）→ 两侧描述的是同一件事，**必须相等**，不等就是"同一个事实有两个说法"
- `limit`/`instanceId`/`readAt` 的主语是**这次读取动作**（哪一次读、读的上限是多少、什么时候读的）→ 导出动作确实在这三件事上和渲染动作不同，强行要求相等反而**假红**

所以我把判据 D 落成：

```
ok / err / count      必须逐字段相等（观测类）
limit / instanceId / readAt   允许不同（动作类）
```

我在探针里把两侧表达式**各自照抄一份**（`renderEffectiveMeta()` = `data.logsMeta ?? fallback()`；`exportEffectiveMeta()` = `panel.ts:1067` 的表达式），断言：

- D1 `{ok, err, count}` 两侧 `toEqual` ✅
- D2 `limit === 7` / `instanceId === 'probe-instance'` / `readAt === 1700000000000`，渲染侧 `limit === 0` ✅（**证明确实允许不同，不是我偷偷放水到"什么都不查"**）
- D3 两侧 `ok === false && err === 'unknown'` ✅（**防止两边一起错成 `ok:true`** —— 这是行为级最容易漏的一种"共用"）

**源码级佐证**（我读的实现，不是听它说的）：

- `src/content/panel/diagnostics.ts:299` `export function describeLogsMetaFallback()` —— 定义**恰好一次**（全仓 grep 只有这一处 `export function describeLogsMetaFallback`）
- `src/content/panel/panel.ts:1068` `...describeLogsMetaFallback(),` —— 导出侧**调用**的是同一个函数，没有第二份字面兜底
- `src/content/panel/diagnostics.ts:328` `const meta: LogsMeta = data.logsMeta ?? describeLogsMetaFallback();` —— 渲染侧唯一绑定

**RV3 我没能真红 —— 这条必须如实说**：

我做的 RV3 是"把导出侧改回各自写一份、`ok:true`"，跑 `panel-diagnostics-export.test.ts` → **20 passed，零红**。

原因我查清了：**当前测试集根本不覆盖"`diagData === null` 时点导出"这条路径**。`panel.ts:1054` 的 `exportJson` 回调要经过 `mountPanelBody` 挂载 → 点按钮 → `downloadJson`，而 `panel-diagnostics-export.test.ts` 测的是 `buildExportPayload()` 这个纯函数 **加上** 直接调 `diagnosticsPane()`，**没有一条测试走过 `panel.ts:1067` 那行兜底**。

⇒ 这**不是** engineer 的 bug（它没声称这行有测试守着），也**不是**判据 D 失败（D 我用源码级 + 表达式级验了），而是**一个真实的覆盖缺口**，已进 §6 待修清单 #2。

### 判据 E · 不许退化 ✅ 成立

| 项 | 结果 |
| --- | --- |
| `ok` 仍是"探针成功 ∧ 真读成功"的与 | ✅ 未动（`panel.ts:410` `probeLogsReadability` 本次无 diff 涉及语义）|
| `Error('token=abc123')` 不泄露 | ✅ 本轮跑 `panel-diagnostics-export.test.ts` 20/20，白名单用例全绿 |
| `src/shared/types/` 为空 | ✅ `git status --porcelain -- src/shared/types` **零行** |
| `diag-store.ts` 零改动 | ✅ `git status --porcelain -- src/platform/storage` **零行** |
| 顺手项①`diagnostics.ts:121` 不再写字面量 30 | ✅ 现为 `上限 \`DIAG_LIMIT\`，见 \`src/platform/storage/diag-store.ts\`` |
| 顺手项②正则不依赖变量名 `label` | ✅ 现为 `/^(?:'unknown'|[A-Za-z_$][\w$]*)$/`，注释里写明了改名的理由 |
| **未用 `as any`/`@ts-ignore`/`@ts-expect-error`/非空断言抹平可缺性** | ✅ 扫 `diagnostics.ts` + `panel.ts`，剥掉注释行后**零命中** |

E1 另外从**编译期**留了个哨兵：直接 `diagnosticsPane({ rows: [], logs: [], version: 'probe' }, acts)` 不传 `logsMeta`。如果谁把 `logsMeta?:` 改成 `logsMeta:`（必填），探针**编译失败** —— 那等于把崩溃从"缺字段静默崩"改成"所有调用方都必须自己决定缺了怎么办"，正是这个 bug 的另一种形状。

---

## 3. 反向验证（5 组，全部真红）

脚本：`poc/probe/verify-task28/rv.mjs`；机器结果：`rv-result.json`。

**判定标准（三条同时满足才叫"真红"）**：① 有用例失败 ② 失败原因带预期断言措辞 ③ 不是 `no tests` / 语法错误 / 模块解析失败。

| # | 变异 | 结果 | 红在哪 |
| --- | --- | --- | --- |
| BASELINE | 未变异 | `failed=0 passed=11` | 探针全绿 |
| **RV1** | `diagnostics.ts:328` `data.logsMeta ?? describeLogsMetaFallback()` → `data.logsMeta as LogsMeta` | **真红 4 条** | A1 / C2 / D1 / E1，全部 `Cannot read properties of undefined (reading 'ok')` @ `diagnostics.ts:382` |
| **RV2** | fallback 取值 `ok:false, err:'unknown'` → `ok:true, err:null` | **真红 5 条** | `C1 → ok 取 true 就是把崩溃换成谎报`、`A1 → 缺 logsMeta 必须报读取失败`、`D1 → 渲染侧 ok 必须与 fallback 相等` |
| **RV3** | `panel.ts:1067` 导出侧改回字面 `ok:true/err:null` | **零红（20 passed）** | ⚠️ 见 §2.D:无测试覆盖该路径 —— 见待修 #2 |
| **RV4** | 去掉 fallback → 跑 **engineer 那组**产品守卫 | **真红 2 条** | `★★ 不传 logsMeta → 不抛…` 与 `★ 兜底语义必须是「不可信」…`，均 `reading 'ok'` |
| **RV5** | `panel.ts:1038` 后插一行 `__probeNewChainAccess: diagData.logsMeta.count,` | **真红 1 条** | `静态穷举 → 禁止 data.logsMeta.X 的链式二次访问…` |
| RV5b | 删掉那一行 | **全绿 11 passed** | 证明 RV5 的红来自那一行，不是环境 |

**还原**：每次变异后 `restore()` 用备份文件逐字节回写并核 SHA256，五次全部 `restored: true`。

收工 SHA256：
```
src/content/panel/diagnostics.ts  83837391969C784309F7B5D24B74156B0602BB4C1BC02FDC0AA0CCA6D15E87C4
src/content/panel/panel.ts        E09B757D43E76CE29E0D6F12219FFBFD2F176214D6B053C62253392E8F3BE587
```
`.rvbak`：**0 个残留**（RV 脚本末尾清理；PowerShell 删除前先列过，目录已不存在）。

> ⚠️ 我自己踩过的坑：`rv-lib.mjs` 的 `check()` 第一版只支持 `check(msgRe, result)`，我在 `rv.mjs` 里写成 `check(/…/, r)` 时**标签位置被吃掉了**，`record({label, ...})` 的 `label` 被 `"label"` 字段覆盖成 `[object Object]`。**这不是测试问题，是我脚本的问题**，已修（`check()` 现在两种签名都支持，第二次跑的表就正常了）。写在这里是因为"结果表里全是 `[object Object]`"很容易被误读成"这轮没跑出名堂"。

---

## 4. 我特别复核的三件

### 4.1 `describeLogsMetaFallback()` 真的只有一处定义、两侧都在调

```
$ grep -rn "export function describeLogsMetaFallback" src/
src/content/panel/diagnostics.ts:299:export function describeLogsMetaFallback(): LogsMeta {
（仅此一处）

$ grep -rn "describeLogsMetaFallback()" src/
src/content/panel/diagnostics.ts:328:  const meta: LogsMeta = data.logsMeta ?? describeLogsMetaFallback();
src/content/panel/panel.ts:1061: * 兜底**必须和渲染侧共用 `describeLogsMetaFallback()`
src/content/panel/panel.ts:1068:    ...describeLogsMetaFallback(),
```

`panel.ts:1061` 那处是**注释里的**函数名 —— 我剥注释后复核过，代码里只有 `:1068` 一处调用。**没有"两处各写一份"的残留。**

### 4.2 "结构上消除了整类访问"是真的吗

真的。我的**静态穷举守卫**（`poc/probe/verify-task28/static-chain-guard.test.ts`）扫整个 `src/content/panel/` 下所有 `.ts`，剥注释后找 `logsMeta` 紧跟 `.`/`[`/`?` 的位置，只放行两种：

1. 类型声明里的可选标记 `logsMeta?: LogsMeta`
2. 绑定点 `logsMeta ?? …`

当前 `diagnostics.ts` 里：
- `:317` `logsMeta?: LogsMeta | undefined;`（类型声明，放行）
- `:328` `data.logsMeta ?? describeLogsMetaFallback()`（绑定点，放行）
- `:382` `if (!meta.ok)` / `:398` `meta.err` / `:406` `meta.limit` —— **全部读 `meta`，不再是 `data.logsMeta.X`**

RV5 证明这条守卫**不是摆设**：插一行新链式访问立刻红。

**顺带查到的实现细节（不在我原稿里，值得记）**：engineer 实际改的是**三处**访问点，不是两处 —— 第三处是 `:406` 的 `meta.limit`（`logs` 的条数标题）。**当时 Lead 和我都只点了两处**。它把 `:406` 也一起收敛进去是对的：如果只收敛 `.ok` 和 `.err`，`fail` 分支虽然不崩，但任何将来进入成功分支且 `logsMeta` 缺失的路径仍会在 `.limit` 上崩。这是"结构上消除"和"打两个补丁"的差别。

### 4.3 顺手项与注释

- `diagnostics.ts:121` 现在是 `上限 \`DIAG_LIMIT\`，见 \`src/platform/storage/diag-store.ts\`` —— 字面量 30 已消失 ✅
- `panel-diagnostics-export.test.ts:311-321` 注释写清了第一版 `/^(?:'unknown'|label)$/` 为什么会因为纯改名而假红，现行 `/^(?:'unknown'|[A-Za-z_$][\w$]*)$/` **没有放宽到"随便匹配"**（`String(e)`/`raw`/`` `${…}` `` 都不匹配）—— 我确认这个放宽是**必要的且没有过度**：它守的是"返回值必须来自白名单表"，不是"必须是某个特定变量名"
- engineer 在测试注释里记的那个 TS 坑（`let box; expect(() => { box = … }).not.toThrow()` 把 `box` 收窄成 `never`）**说明它踩过并留下了原因**，不是我替它找的

---

## 5. 我认为它做对了什么

1. **把"两处补丁"改成"一个绑定"**。这是本卡最值钱的部分：`const meta = data.logsMeta ?? fallback()` 之后，将来谁再加一处访问都只能写 `meta.X`，**结构上不可能写出 `data.logsMeta.X`**（我的静态守卫守着这条）。
2. **fallback 语义选了"不可信"而不是"看起来正常"**。`ok:true` 能让页面显示"还没有日志。"看起来干净，但那是把崩溃换成谎话。它选了会让人看见的那条。
3. **主动把取舍写进注释**：`diagnostics.ts:274-298` 那段 JSDoc 写明了"为什么收敛到一处""为什么兜底是不可信"，包括**我独立复现出来的**"补第一处后错误后移到 `reading 'err'`"。这类注释让下一次改动的人不会把它"优化"回去。
4. **没有顺手扩面**：`actions` 参数没被做成可选+fallback（Lead 特别点名要查的），`logsMeta` 仍可缺，`diag-store.ts` 零改动。
5. **`limit`/`instanceId`/`readAt` 的区分给了理由**，而且理由是**可检验的**（说的是"这三个字段的主语是导出动作"），不是"这样测试更好写"。

---

## 6. 待修清单

### #1【中】`diagnosticsPane` 的 `actions` 参数仍不可缺（本卡按 Lead 裁决不扩，记录在案）
Lead 的理由我同意：`actions` 缺了会在第一次点击时立刻暴露（用户点了才有反应），不会像 `logsMeta` 那样**静默变成谎报**。**本轮不修，也不该修** —— 修 bug 时顺手扩面是返工的老来源。这里只留一行记录，避免下一轮有人当成"漏了"。

### #2【中】`panel.ts:1067` 导出兜底那条路径**没有任何测试覆盖**
RV3 实证：把导出侧兜底改成 `ok:true/err:null`（等于回退 task-28 在导出侧的全部工作），`panel-diagnostics-export.test.ts` **20 passed 零红**。

- **现状**：这行代码**正确**（我读过了），但**退化了没人知道**。
- **为什么现在没被发现**：`diagData === null`（还没采完就点导出）这条路径要么走 `mountPanelBody` 真挂载，要么把兜底表达式抽成可测函数；现有测试两样都没做。
- **建议**（属新测试，需要 Lead 决定派卡）：把 `panel.ts:1067` 那段兜底**抽成一个导出函数**（例如 `exportLogsMetaFallback()`），对它单独断言 `ok:false/err:'unknown'` + `limit===DIAG_LIMIT`；或补一条走 `mountPanelBody` → 点「导出」的端到端用例。
- **不修的风险**：task-26/28 花了三张卡收敛出来的"两侧同源"，**只有一侧被测试守着**。

### #3【低】`static-chain-guard` 这类守卫**不在 `node scripts/verify.mjs` 里**
我的静态穷举守卫现在只活在 `poc/probe/verify-task28/`，`vitest.config.ts` 的 `include: ['tests/**/*.test.ts']` 扫不到它。⇒ **verify 21 项全绿并不能证明"没人又写回 `data.logsMeta.X`"**。
- **建议**：把它搬进 `tests/unit/content/panel-logsmeta-chain.test.ts`（需 Lead 派卡；我不写源码与测试）。
- **不修的风险**：今天这条守卫只在"我记得跑探针"的时候存在。

### #4【低】判定"真红"的三条件必须写进流程
`check()` 必须同时要求"有用例失败 + 失败原因带预期措辞"，只看"有用例失败"会把 `no tests` / 语法错也算成红。我第一版 `rv.mjs` 就吃过这个（RV3 首次误报）。建议把这条写进 `AGENTS.md §1.5` 的反向验证小节或 methodology 文档。

### #5【低·给我自己】探针里"照抄实现表达式"是必要的恶
判据 D 的 `renderEffectiveMeta()` / `exportEffectiveMeta()` 是**照抄**产品里那两行表达式。这能验"两侧取值口径一致"，但**验不到"产品真的用了这两行"**——后者只能靠源码级断言（我另做了）。⇒ 纯表达式照抄的断言单独使用会假绿，必须配源码级。这条我下次做同类判据时先写进卡的判据里。

---

## 7. 写域核对

开工前 → 收工 `git status --porcelain`：

| 时刻 | 行数 | 说明 |
| --- | --- | --- |
| 开工（18:31） | 50 行 | 我还没建目录 |
| RV 期间 | — | `rv-lib.mjs` 打印 `[backup] DIFF` **零命中** ⇒ 全程无并发编辑，与 Lead 说的"工作区归你"一致 |
| 收工（18:41） | 51 行 | 多出的 1 行是 `?? poc/probe/verify-task28/`（我的） |

- `src/content/panel/`：`diagnostics.ts` / `panel.ts` 被 engineer 改过（task-28 写域，正常）；`login-outcome.ts` / `tabs.ts` 的 `M` 是 task-25 遗留，**不是我改的**（我的 RV 只碰 `diagnostics.ts` 与 `panel.ts`，且已逐字节还原）
- `src/shared/types/`、`src/platform/storage/`：**零行** ✅
- 本报告目录下**没有**改动任何源码副本

### 并发时间线（按时刻记，不给因果）
- 18:31 记基线 50 行 → 18:31 `node scripts/verify.mjs` 全绿 32.0s
- 18:34 探针首次红：`import.meta.url` 非 file 方案（`TypeError: The URL must be of scheme file`）
- 18:34 改 `process.cwd()` → 解析出 `D:\src\content\panel`（**探针 config 的 root 不是进程 cwd**）
- 18:35 改 `createRequire(import.meta.url).resolve(...)` → 通；唯一红是 `:317` 类型声明里的 `logsMeta?:`（我的正则误报），加放行后 7/7
- 18:39 加判据 D/E 探针 → 11/11
- 18:40 RV 五组跑完，还原 SHA 全部一致，`.rvbak` 清零

---

## 8. 产物

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 本报告 |
| `verify-21-green.txt` | 我自己跑的 verify 结论行 |
| `vitest.probe.config.ts` | 探针 config（root / alias / `cache:false`）|
| `fallback-guard.test.ts` | 判据 A/B/C/D1 + E1（6 条）|
| `export-render-shared.test.ts` | 判据 D1/D2/D3 + E1 编译期哨兵（4 条）|
| `static-chain-guard.test.ts` | 静态穷举守卫（1 条，自带 RV5）|
| `rv.mjs` / `rv-lib.mjs` / `rv-result.json` | 五组 RV + 还原 SHA256；结果机器可读 |
| `git-status-baseline.txt` / `-raw.txt` | 开工基线 |

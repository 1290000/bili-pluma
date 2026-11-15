# 终验报告 · task-11（更新版）

> 验证者：**verifier**（独立审核方，**本轮未修改任何源文件**）
> 时间：2026-11-11 18:47–19:05 · 基线 `main` = `9d18154`
>
> **结论：🔴 1 条必须修（用户可见的错误陈述）。修完即可交付。**

---

## §1 前置：工作区静默证明

Lead 指定命令扫描结果：

| 时刻 | 文件 | 判定 |
|---|---|---|
| 18:45:36 | `poc/verify/result-q2-auto.full.json` | DNR 回归产物，非源码 |
| 18:45:36 | `poc/verify/q2-lab-done.png` | 同上 |
| — | `src` / `entrypoints` / `tests` / `docs` / `scripts` **4 分钟内零改动** | ✅ 静默 |

**等 75 秒后复检，源码侧仍静默** → 判定可开工。

---

## §2 ① 全量 verify × 2

| 遍次 | 原始结论行 |
|---|---|
| 第 1 遍 | `[verify] ✅ 21 项全绿（共 26.1s，并行墙面 26.1s，串行合计 52.7s）` |
| 第 2 遍 | `[verify] ✅ 21 项全绿（共 26.1s，并行墙面 26.1s，串行合计 56.0s）` |

✅ **两遍一致。**

---

## §3 ② 反向验证 × 3（全部实跑，全部变红，全部恢复）

### 3.1 推荐流判据里 `streamingIdentity === 'page'`

**变异**：`feed-identity.ts:116` `if (streamingIdentity === 'page') return 'page-identity'` → `if (false && …)`

**结果：4 条变红**
```
× 🔴 page 身份 + mid 不同 → page-identity，**不**判 ok
× page 身份 + mid 相同 → 也是 page-identity（用户意图优先于 self）
× page 身份 + 游客 → page-identity
× 端到端全矩阵：只有 "extension + 不同号" 该被按取流账号处置
```
**恢复**：`git hash-object` = `08b36f0d…` ✅ 与基线一致

### 3.2 无凭据时不装规则

**变异**：`page.handler.ts:67` `if (!credential)` → `if (false && !credential)`

**结果：1 条变红**
```
× 步骤 2：self 是一等状态 > 未配置凭据 → not-configured（不变）
```
**恢复**：`git hash-object` = `30d52451…` ✅ 与基线一致

### 3.3 删掉 `switchStreamingIdentity` 里的 `applyRulePlan()`

**变异**：`dnr.ts:432` `const applied = await applyRulePlan(); return applied.feedStreaming;` → `return false;`

**结果：14 条变红（跨 2 个文件）**
```
× 切到 page → 两类规则都清空，身份被写入
× 切到 extension → 装回全局路径规则，身份被写入
× 返回值：extension + 有凭据返回 true
× ★ 切换后 tab 规则为 0（要靠页面重新报到才回来）
× 切换后**全局路径规则**被按新身份重建（这层不能丢）
… 共 14 条
```
**恢复**：内容 + 测试双确认（57/57 全绿）。

> ⚠️ **我自己的失误**：这一次变异前**没有记 `git hash-object` 基线**，
> 所以无法用哈希比对。改用「函数体逐行核对 + 57/57 测试全绿 + 无 `return false` 残留」
> 三重确认已恢复。**这正是 `METHODOLOGY.md` 规则 5 说的"必须留基线"——我这次违反了它。**

---

## §4 ③ 交叉一致性：`reason` 全值流向表

**43 个精确消费点**（`grep` 全量，未截断）逐个归类。

| reason | 装规则 | 清 PGC 缓存 | `rewriteGate` | `same-identity` | popup 文案 |
|---|---|---|---|---|---|
| `ok` | ✅ 装 | ❌ 不清 | **true** | ❌ 不产出 | 「已接管」 |
| `disabled` | ❌ | **✅ 清**（`content.ts:2230`） | false | ❌ | 「已停用」 |
| **`page-identity`** | ❌ | **✅ 清**（`:2230`） | false | ✅ 产出（`page-state.ts:107`） | 面板「取流：浏览器账号」 |
| **`self`** | ❌ | **❌ 不清** | false | ✅ 产出 | 「无需代理」+「同一个号」 |
| `not-configured` | ❌ | ❌ | false | ❌ | 「未配置」 |
| `error` | ❌ | ❌ | false | ❌ | 「凭据失效」 |
| `unknown` | — | ❌ | false | ❌ | **「未知」**（新） |

### 4.1 ⭐ `self` vs `page-identity` ——「后果是否相同」单列

| 维度 | `self` | `page-identity` | 相同？ |
|---|---|---|---|
| 成因 | **事实**（mid 相同） | **选择**（用户设的） | ❌ |
| 装规则 | ❌ | ❌ | ✅ |
| **清缓存** | **❌ 不清** | **✅ 清** | ❌ **相反** |
| `rewriteGate` | false | false | ✅ |
| `same-identity` | ✅ | ✅ | ✅ |
| 话术 | 「同一个号」 | 「你选了浏览器账号」 | ❌ |

**三件事全同，唯独「清不清缓存」相反。** 与上轮结论一致，本轮复核**未变**。

### 4.2 ⭐ `describePopup` fail-closed（engineer-b 新改）——**已正确**

`popup-state.ts:507-508`：

```ts
const reasonGiven = snap.lastActivateReason !== undefined && snap.lastActivateReason !== null;
if (reasonGiven && snap.lastActivateReason !== 'ok') return unknownProxyState();
```

- ✅ 只有 `=== 'ok'` 才落「已接管」
- ✅ 任何其他值（含将来的未知值）→ `unknownProxyState()`
- ✅ `undefined` / `null`（调用方没给）不走这道门 —— 与既有纪律一致（缺参数 ≠ 收到未知值）

**这是本轮最好的一处实现**：把方法论规则 8 从"决定副作用"推广到"决定界面该说什么"。

### 4.3 静默 fallthrough 清单

| 位置 | 覆盖方式 | 判定 |
|---|---|---|
| `popup-state.ts:470/472/555/556` | 显式两值 `if` | 🟡 **靠人记**（但 `:508` 的 fail-closed 兜住了） |
| `feed-identity.ts:73` | `=== 'ok'` | ✅ fail-closed |
| `streaming-pill.ts:110` | `=== 'ok'` | ✅ fail-closed |
| `content.ts:2117` `extensionEngaged` | `=== 'ok'` | ✅ fail-closed |
| `content.ts:2116` `switchOn` | `!== 'disabled'` | ✅ 刻意 fail-open（放行不产生新副作用） |
| `page-state.ts:107` | 数组 `includes` | 🟡 靠人记（方向安全） |

> **∴ 🟡-2（上轮提的）已被 `:508` 的 fail-closed 实际覆盖** —— 即使那四处显式 `if` 都漏了，
> 兜底 `:508` 也会把未知值拦到「未知」而不是「已接管」。**可以降级为"已知良好"。**

---

## §5 ④ 文案人工审查（`verify` 零兜底）

### 🔴 必须修：推荐流开关的 hint **与 ADR 0035 直接矛盾**

**位置**：`src/content/panel/tabs.ts:843`

```ts
hint: '打开后，首页推荐流全部使用取流账号的推荐（与上面的取流身份是两个独立设置）',
```

**ADR 0035 的要求**（`:143` 原文）：

> **所以它的授权必须写成"只换滚动加载、首屏不动、刷新即回"，而不是"推荐流已切换"。**

**ADR 0035 的能力边界**（`:57`）：

> ## 能力边界：**首屏不换，只换滚动加载**

**实现注释**（`routes.ts:157`）：

> `⚠️ **只影响滚动加载**：首屏推荐是 SSR 写进 HTML 的（由 Cookie 决定），换这条接口的 Cookie 对首屏无效`

**"全部"是错的。** 首屏 10 张永远是页面账号的，用户刷新后也退回。

**为什么 `verify` 全绿 —— 这是本轮最该报的一条：**

`tests/unit/content/panel-tabs.test.ts:1029-1032`：

```ts
it('hint 写清了作用与独立性', () => {
  const box = renderSwitch({});
  expect(box.textContent).toContain('首页推荐流全部使用取流账号的推荐');
});
```

**测试名说"写清了作用"，断言的却是一个与 ADR 相矛盾的说法。**
它把这个错误**钉住了** —— 任何人想改成正确表述，测试会红。

> **这是"看起来有保护，实际保护了错误的东西"的第 7 例**，
> 而且比前 6 例更隐蔽：前 6 例是"保护不存在"，这一例是**"保护了错误答案"**。

**建议改法**（措辞按 ADR 0035 的要求）：
```ts
hint: '打开后，滚动加载的推荐使用取流账号（首屏仍是当前账号，刷新后需重新滚动才生效）',
```
并同步改测试断言。

### 🟡 语义核对（其余文案均准确）

| 文案 | 位置 | 核对结果 |
|---|---|---|
| 「取流：扩展账号」/「取流：浏览器账号」 | `streaming-pill.ts:71/77` | ✅ 准确，对偶，不是同义反复 |
| 「取流身份：未知」 | `tabs.ts:590` | ✅ 准确（未知就是未知） |
| pill「无需代理」(1) | `popup-state.ts:241` + line「取流账号与当前登录账号是同一个」 | ✅ 准确说明是**事实** |
| pill「无需代理」(2) | `popup-state.ts:268` + line「当前用浏览器账号取流，未使用取流账号」 | ✅ 准确说明是**选择** |
| 「不需要（取流使用浏览器登录身份）」 | `collect.ts:475` | ✅ 用"不需要"而非"未配置"，避免读成故障 |

**两处「无需代理」区分得好**：一句讲事实、一句讲选择，正是 `self` vs `page-identity` 的界面落点。

### Q10 禁用词扫描

| 词 | 用户可见字符串命中 | 判定 |
|---|---|---|
| 解锁 | 1 处：`summary-view.ts:370` `title: '已解锁'` | 🟡 **既存问题，非本轮引入** |
| 开箱即用 / 破解 / 绕过 / 破解版 | 0 处 | ✅ |

> `已解锁` 在 `HEAD` 中就已存在，且 `docs/02-ui-spec.md:109` 明文规定用它
> （"徽章用'已解锁'而非'可用'"）。**属于既存合规问题，与本轮无关**，但值得单独记一笔。

---

## §6 ⑤ 「看起来有保护 / 实际」6 行表逐条确认

| # | 看起来有保护 | 实际 | 本轮核查结果 |
|---|---|---|---|
| 1 | `same-account` 有 `reason` 值 | 零 UI 消费方 | ✅ **已修**：非注释命中 **0 处** |
| 2 | `rewriteGate` 有门控 | 放错层面，否掉 ADR 0020 | ✅ **已修**：第零道 PGC 门控已删（4 处命中全是解释性注释） |
| 3 | `check-messages` 有内联联合检查 | 漏 Prettier 多行形态 | ✅ **已修**：`stripComments()`（`:326`）+ `findInlineUnions()`（`:418`） |
| 4 | 双向约束有正负样本 | 仍有一个维度漏网 | ✅ **已修**：`check-messages-inline-union.test.ts` 含"白名单不许放宽" |
| 5 | `vi.mock` 有全量替换 | 多余导出被静默忽略 | ✅ **已删**（34 处 `vi.mock` 未见全量替换形态） |
| 6 | `streaming/status` 有 handler | 运行时收到 `undefined` | ✅ **已修**：`background.ts:403-408` 正确返回；消费端 `content-panel.content.ts:290` 正确接线；有测试覆盖 |

**6 行全部已处理。**

---

## §7 已知需真机（记「未验证 + 需要什么」）

| # | 项 | 状态 | 需要什么 |
|---|---|---|---|
| M1 | 推荐流开关打开 → 首屏 A=0/B=22/top=255 | **未验证** | bsk daemon（当前已死，需 host 前台任务启动）+ 登录态 |
| M2 | 开关无凭据时灰掉 | **未验证** | 同上 |
| M3 | `pluma:build-proof` 确认跑新代码 | **未验证** | 同上 |
| task-24 | 双向 M1 | **未验证** | 双账号 |
| task-13 | M2/M3/M5 | **未验证** | 登录态 |

> ⚠️ **本轮我没有尝试启动 bsk**：环境约束下需 host 前台任务，且 C 盘只剩 0.63 GB。
> 按要求记为"未验证 + 需要什么"，**不跳过、不推断**。

---

## §8 结论

### 🔴 必须修：1 条

**推荐流开关 hint 说「全部」，与 ADR 0035「首屏不换、只换滚动加载」直接矛盾，
且被 `panel-tabs.test.ts:1031` 的断言钉住。**

修法：改文案 + 改断言（两处必须同时改，否则测试红）。

### 🟡 建议修：0 条新增

上轮的 🟡-2（`popup-state` 四处显式 `if` 靠人记）**已被 `:508` 的 fail-closed 实际覆盖**，降级为"已知良好"。
🟡-1 / 🟡-3 已由 task-17 处理。

### 🟢 已确认无问题（本轮复核）

- 全量 verify 两遍 21/21 一致
- 反向验证 3 条全部有效变红（4 / 1 / 14 条）
- `reason` 七值流向表完整，`self` vs `page-identity` 的"清缓存相反"实现正确
- `describePopup` fail-closed 正确（**本轮最佳实现**）
- 6 行结构性教训表全部已处理
- 其余 5 条新文案语义准确

### 一句话

**除 🔴 那条 hint 外可以交付。** 那条不是"文案不优雅"，是**用户读了会以为整页推荐都换了，
而首屏其实永远是页面账号的** —— 属于"界面陈述错误事实"，
且它被一个**名字叫「写清了作用」的测试**保护着。

**建议**：🔴 修完只需重跑一次全量 verify（改动只涉及 `tabs.ts` 一处字符串 + 一条测试断言），
不必再走完整终验。

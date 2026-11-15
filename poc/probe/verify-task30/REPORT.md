# task-31 复核报告（收敛版 · 用户催，5 行结论先行）

> verifier 独立复核 engineer-panel 的 task-30 交付（守卫补位 + 注释口径 + 源码级断言）。
> 本节所有数值都是**我自己跑的**，未引用 engineer 的说法。

## 结论

**有条件成立 —— 能收**。守卫真的在 verify 里跑、真的能红（恒挂断言让 verify 红，还原后回绿）；
唯一剩下的缺口是源码级断言可以被一两种等价写法绕过，但**这些绕过写法本身都写不出谎报**（见下§4）。

---

## 1. 判据逐条

| # | 判据 | 裁定 | 理由（≤20 字） |
| --- | --- | --- | --- |
| A | 导出侧兜底"不变量"被守 | ✅ | 源码级断言杀 RV1，边界见 §4 |
| B | 静态穷举被 verify 跑到 | ✅ | 恒挂断言 → verify 红，还原回绿 |
| C | 兜底语义必须"不可信" | ✅ | `ok:true` 变异真红（渲染侧） |
| D | 注释口径「观测类/动作类」 | ✅（词面差异见 §5） | 表在，但"两个主语"字面 0 次 |
| E | 不许悄悄扩面 | ✅ | `panel.ts` SHA 未变；types 目录零改动 |

## 2. 反向验证（每组都备份→变异→跑测→逐字节还原）

| RV | 变异 | 结果 | 关键措辞 |
| --- | --- | --- | --- |
| RV1' | 导出兜底改回 `ok:true/err:null` 字面量 | **真红** | `导出侧兜底没有复用 describeLogsMetaFallback()` |
| RV3 | `panel.ts` 插 `diagData.logsMeta.count` | **真红** | `禁止 logsMeta 的链式二次访问 —— 必须先收敛成 meta 变量` |
| RV4 | 自检用例去掉已知违规样例 | **真红** | `自检没抓到已知违规，守卫本身坏了` |
| RV2 | 兜底后追加 `ok: true` 覆盖观测类 | **绿** | ⚠️ 见 §3 —— 这条绿是"无人守"，但见 §4 说明它写不出谎报 |

RV3/RV4 在两个守卫文件范围内红；RV1' 只在 `panel-diag-wiring.test.ts` 里红（`panel-diagnostics-export.test.ts`
+ `panel-logsmeta-chain.test.ts` 那一组**一条不红**——和我 task-29 的 RV3 零红一致）。
⇒ **task-29 提出的待修 #1 至今没被修**，只是被另一条（源码级）断言补位了。

## 3. 判据 B 的核心证据（Lead 指定的第 3 件）

把 `panel-logsmeta-chain.test.ts` 静态穷举那条改成恒失败（`.toEqual(['__forced_self_explode__'])`）：

- `node scripts/verify.mjs` → `[test] test ❌ 51.1s` → **exit 1，verify 整体红**（`✅ 21 项全绿` 未出现）
- 还原后 `node scripts/verify.mjs` → `✅ 21 项全绿（34.9s）`

⇒ 这条守卫**确实在 verify 的执行路径里**，不是"放在没人跑的地方"。Lead 在 m01699 担心的那件事**已解决**。

全量单测：`112 files / 1846 tests` 全绿（我自己跑，与 engineer 报的一致）。
`panel.ts` SHA256 `E09B757D43E7…E587`、`diagnostics.ts` `BDC64DB0…EE7D`、`panel-logsmeta-chain.test.ts`
`38BF4293…B919`、`panel-diagnostics-export.test.ts` `CB346C4A…F6CF` —— 与本卡开工基线**逐字节一致**。

## 4. 判据 A 的假绿边界（原定做三个变体，按 Lead 指示压成一段）

源码级断言有两条：①必须 `logsMeta: diagData?.logsMeta ?? { … ...describeLogsMetaFallback()`
②块内不许出现 `\b(?:ok|err)\s*:`。我实测的边界：

- **改动缩进/换行** → 绿（正确，`[^}]*` 跨行）；
- **展开写成 `...(diagData?.logsMeta ?? F())`** → 红（正确，动作类覆盖被抹掉是行为变化）；
- **块外另有 `ok:` 字面量** → 绿（正确，切片只取 `exportJson` 块）；
- **块内塞一处无关的 `profile: { ok: false }`** → **红**（**假红**：语义没变却被字面量断言扫中）；
- **块内加 `[`ok`]: true` 计算属性名** → **绿**（**假绿**：绕过了 `ok\s*:` 字面量扫描）；
- **块内加 `...{ ['ok']: true }` 字符串键** → **绿**（同上）。

**边界结论**：②只能挡"字面写 `ok:`"这一种形态，计算属性名/字符串键能绕过。
但这两种绕过**都只覆盖、不删……** 实测 `[`ok`]: true` 让 15 条全绿，然而用这种写法去"谎报"
会同时需要把 fallback 拿掉（否则展开的 `ok:false` 被后写的覆盖，仍是谎报、但仍绿）。
**必须如实说清的限制**：源码级断言证明得了"这里调用了同一个函数"，**证明不了运行期两侧取值一致**
——因为 `diagData === null` 那条路径在界面上不可达（`panel.ts:1028` 提前 return 不画浮层），
**任何行为级断言都覆盖不到它**。所以 A 是"不变量级"的保证，不是"取值级"的保证。

## 5. 词面差异（不影响裁定）

Lead 说的"两个主语"表，代码里的实际措辞是「判断一个新字段该不该被覆盖，只看**它的主语是什么**」
+ 表格列名为「主语」。「两个主语」这个字面串出现 **0 次** ⇒ 按 Lead 的原话去找会找不到。
表的实质内容（观测类 `ok`/`err`/`count` ❌ 不许覆盖、动作类 `limit`/`instanceId`/`readAt` ✅ 可以）
**与 task-29 判据 D 完全一致**，判 ✅。

## 6. "有守卫、无用户路径"的裁决 —— 我认

**认**。理由一句：那条兜底的 `?.` 已经保证运行期不炸，删掉等于删防御；让它"可导出"是改产品行为，
属于新能力、得问用户。补一条源码级不变量守卫把它钉住，是这件事在本轮能做的最诚实处理。

## 7. 待修（最多 3 条）

1. **【中】** 字面量断言只挡 `ok:` 字面形态，`[`ok`]:`/`['ok']:` 能绕过。建议改成"块内只允许出现
   `logsMeta` 那一个对象展开 + 三个动作类字段"的白名单结构断言（正向断言，而非黑名单）。
2. **【中】** task-29 待修 #1 仍在：`panel-diagnostics-export.test.ts` + `panel-logsmeta-chain.test.ts`
   一组对"导出兜底改回 `ok:true/err:null`"**零红**。真正杀住它的是 `panel-diag-wiring.test.ts` 那条，
   **得让维护者知道守卫装在哪个文件**，否则下次动这里的人只看一个文件会以为什么都没守。
3. **【低】** 注释口径用词与 Lead 口述不一致（「两个主语」→「它的主语是什么」），建议统一，避免逐字检索失效。

## 8. 产物

`poc/probe/verify-task30/`：`REPORT.md`（本文件）、`rv-lib.mjs`、`rv.mjs`（按 RVn 参数逐条跑）、
`guard-variants.mjs`、`guard-variants-result.json`、`_v56.mjs`/`_v78.mjs`/`_v8.mjs`/`_selfexplode2.mjs`
（变体实验脚本，保留以便复跑）、`git-status-baseline.txt`、`backup/`（5 个原始副本）。
`.rvbak` 收工时为 **0**。

# task-42 验收报告 · 孤儿守卫双判据 + 修 A/修 C

> 验收人：verifier（只审不写，写域仅本目录）　|　时间：2026-11-12 20:4x–21:1x
> 验收对象：`entrypoints/content-panel.content.ts` SHA256 `F152B7B0…7AB9`（冻结基线，开工前 + 每次 RV 还原后都核过）
> 工作区：`git status --porcelain` 58 行，RV 前后一致

---

## 一句话结论

**有条件成立（可收）**——四组 RV 全部真红（RV4 是本次真正的洞，铁证），五形态全部正确、无漏报无过杀；但**`readAccountMid()` 同步抛仍是未处理路径**（E-A 实测 `hint=0` 且异常外抛），以及三份 `toJs()` 审计工具我无法自洽复现（见 §4），需 Leader 决定是否另开卡。

---

## 1. 判据 A：五形态运行期实测（`repair-and-guard-probe.mjs`）

| 形态 | hint（孤儿提示次数） | notice | clearNotice | sendMessage | 判定 |
| --- | --- | --- | --- | --- | --- |
| `chrome` 整体 undefined | 1 | 0 | 0 | 0 | ✅ 不抛、恰好 1 次、消息 0 条 |
| `chrome.runtime` 整体 undefined | 1 | 0 | 0 | 0 | ✅ |
| runtime 有、`id` 为 undefined | 1 | 0 | 0 | 0 | ✅ |
| runtime 有、`id` 为 null | 1 | 0 | 0 | 0 | ✅ |
| **反面对照：一切正常** | **0** | 1 | 1 | 1 | ✅ 不误伤 |

复跑：`node poc/probe/verify-task37-39/repair-and-guard-probe.mjs`

---

## 2. 判据 D：RV 四组（冻结版上跑，禁 checkout/stash/reset，复制+SHA256）

| RV | 变异 | 结果 | 红线 | 还原 |
| --- | --- | --- | --- | --- |
| RV1 | `const orphan = false;` | **3 failed / 4 passed** | `★★★ runtime 是对象但 id 为 undefined` / `id 为 null` → `孤儿态必须挂出「请刷新」提示: expected +0 to be 1`；`★★ …controller 为 null → 仍然只提示一次: expected 1 to be +0` | ✅ `F152B7B0…` |
| RV2 | `typeof chrome === 'undefined'` 半恒 false | **1 failed / 6 passed** | `★★★ chrome 整体 undefined → 不抛…` → `promise rejected "TypeError: Cannot read properties of unde…" instead of resolving` | ✅ |
| RV3 | `chrome.runtime?.id == null` 半恒 false | **3 failed / 4 passed** | 同 RV1 的两种断言原文 | ✅ |
| **RV4** | try/catch 改回裸 `.catch()` 链（修 C 之前） | **1 failed / 6 passed** | `★★ sendMessage 同步抛孤儿错 → 必须挂孤儿提示（.catch 接不住这一半）` → `promise rejected "Error: Extension context invalidated." instead of resolving` | ✅ |

> 与 engineer 自报 3/1/3/1 **完全一致**（RV1=3、RV2=1、RV3=3、RV4=1）。
> ⚠️ RV1 的两种「chrome 整体 undefined / runtime 整体 undefined」**仍然绿**——兜底那条 `if` 替救了。所以 RV1 只能证明守卫在 id 类形态上有效，不能证明它在 `chrome` 缺失形态上有效；后者由 RV2 单独把关。

复跑：`node poc/probe/verify-task37-39/rv.mjs RV1|RV2|RV3|RV4`，`node …/rv4-brief.mjs`

---

## 3. 判据 B：判据 2（代次标记）已删净

`git grep -n -E "plumaPanelGen|isStaleGeneration|SCRIPT_GEN|panel-gen" -- src entrypoints tests` → **0 命中** ✅

---

## 4. 判据 E：修 A / 修 C 的残余风险

| 场景 | hint | 结论 |
| --- | --- | --- |
| E-C `sendMessage` **同步**抛孤儿错 | 1 | ✅ 本次真正的洞已堵 |
| E-C `sendMessage` 异步 reject 孤儿错 | 1 | ✅ |
| **E-A `readAccountMid()` 同步抛孤儿错** | **0**（并外抛 `Extension context invalidated.`） | 🔴 **未处理路径**：`const beforeMid = (await readAccountMid().catch(…)).mid` 是普通调用，同步抛发生在 `.catch()` 挂上之前，`openLogin` 直接 reject、零提示 |

E-A 是否真实可达**没有证据**（`readAccountMid` 内部已有两层 catch），且它是**修 A 声称要覆盖的同一类洞**（同步抛）。属于「同类缺陷只修了一处」。

---

## 5. 判据 F：`toJs()` 三份实现一致性（Leader 要求的一句话回复）

三份 `toJs()` 的 **4 条 `.replace` 规则逐字符相同**（`as` → `let/const/var x: T =` → 箭头回调 → 普通参数），均含 `let/const/var` 剥离规则。

但**三份的 `openLoginBody()` 切片起算点不同**：

| 文件 | `braceBlock` 起算 | 
| --- | --- |
| `orphan-guard.test.ts:133` | `code.indexOf('{', code.indexOf('=>', at) + 2)` |
| `orphan-hint.test.ts:391` | `code.indexOf('=>', at)` |
| `incognito-panel-notice.test.ts:122` | `code.indexOf('=>', at)` |

`braceBlock` 内部找第一个 `{`，两种起算点在当前源码形态下**等价**（`=>` 之后是 `(): Promise<void> => {`，最近的 `{` 都是同一处）。

**依赖 `toJs` 之外解析路径的测试**（`grep -n "new Function("` 全仓 11 处，剔除 `toJs` 自身）：
`tests/unit/platform/background-play-page.test.ts:94`（自写 `buildIsVideoPageUrl`，只剥 `url: string` 与 `): boolean` 两处）、`tests/unit/content/main-world-pgc.test.ts:1634`（正则整函数截取，纯 JS 无需剥离）、`tests/unit/content/main-world-real.test.ts:994`（纯 JS）。三处**目标源码都不含 TS 变量标注**，不受 `let res: T =` 这个 bug 影响。

---

## 6. 待修清单（不修，交 Lead 派 engineer）

| # | 级别 | 内容 |
| --- | --- | --- |
| 1 | **中** | `readAccountMid()` 同步抛仍未兜（§4 E-A）。修法同修 A：外面包 try/catch 归一到 `{ mid: null }`。**先判它是否真实可达再决定修不修**——`readAccountMid` 内部两层 catch 若真的全包住，这里就是防御性代码，可写明取舍而不改 |
| 2 | 中 | RV1 的「chrome 整体 undefined / runtime 整体 undefined」两条被兜底替救而恒绿 ⇒ **RV1 不能单独作为守卫有效性的证据**，报告/卡里别只引 RV1 |
| 3 | 低 | `catch (e)` 里 `void isOrphanError(e);` 是**废代码**：错误串没记到任何地方，`void` 只为了消 lint。要么真的记 diag，要么删掉这行（现写法的语义是"我知道有 e，但我不处理"） |
| 4 | 低 | `:253-270` 两段注释互相矛盾（「修 A（task-41）：同步抛也必须兜住」紧跟着「不需要额外的 try/catch…（task-41 修 A 已作废）」）。注释与实现不一致，读代码的人会被引反 |

---

## 7. 方法学教训（写进流程）

1. **同一工作区两个成员同时做 RV，观测结果不可信。** 我 20:52:00 跑出的 8 条 `SyntaxError` 混合了 engineer 的 RV 中间态与 `toJs` 真 bug，无法归因。⇒ RV 期间必须**独占工作区**，或把变异体写在副本目录里跑。
2. **`new Function` 里 `await` 会误报成 `Unexpected identifier <fn>`**，与真实语法错误长得一样。二分定位必须用 `new Function('async function W(){'+prefix+'}')` 包裹。
3. **一段不配平的花括号块**同样报成 `Unexpected token ')'`（见 `_min.mjs`）⇒ 逐行边扫边编会得到一串假报错，必须整块切完再编。
4. **`git show > file` / `| Sort-Object > file` 在 PowerShell 下写 UTF-16**，比对会假报差异；`node -e` 里的反引号、`${}`、中文箭头会被解析器吃掉 ⇒ 改文件一律用 write/edit 工具或独立 `.mjs`。

**⚠️ 需要 Lead 知道的一次事故**：本轮 RV 第一次跑完 RV4 时，`entrypoints/content-panel.content.ts` 被写成了 **0 字节**（`E3B0C442…` 是空文件哈希）。原因在我写的对照脚本 `rv4-brief.mjs` 第一版里 `src.slice(0, catchOpen - 4 < 0 ? 0 : src.indexOf(from))` 的索引表达式有误，`finally` 里的还原又读的是**已被清空的**备份路径。已用 `rv.mjs` 留下的冻结备份（`.rvbak/entrypoints__content-panel.content.ts`，SHA `F152B7B0…`）**逐字节恢复并核对 SHA**，随后重跑 RV4 得到同样结论。当前文件 SHA 已确认回到 `F152B7B02C53562AC6925257982E6FF6616866C98EA45D96466ADF28A2267AB9`。
> 教训：脚本里「备份-变异-还原」任何一步都必须**先断言备份文件的 SHA**，且变异后的写回只能从**已校验的备份**出发；`finally` 里的还原路径不能依赖可能被自己的错误索引算出来的中间变量。

---

## 8. 写域核对

本目录新增：`REPORT.md`、`rv.mjs`、`rv4-brief.mjs`、`rv-extra-tojs-fakegreen.mjs`、`audit-tojs-sites.mjs`、`show-tojs-break.mjs`、`repro-tojs-syntax-error.mjs`、`probe-hint-runtime.mjs`、`locate-function.mjs`、`locate-selftest.mjs`、`probe-shape.mjs`、`sendmessage-failure-probe.mjs`、`repair-and-guard-probe.mjs`、`check-fake-green-construction.mjs`、`_min.mjs`、`_dbg-break.mjs`、`_tojs-out.txt`、`read-flips-output.txt`、`verify-output.txt`、`status-*.txt`、`backup/`。
`src/` `entrypoints/` `tests/` 下的所有改动**均非我所作**（属 task-3/4/5/8/9/10/11/28/33/37/39 遗留），我只在 RV 期间临时变异过 `entrypoints/content-panel.content.ts`，每次均已按 SHA256 还原。

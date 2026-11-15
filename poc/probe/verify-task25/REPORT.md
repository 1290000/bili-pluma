# task-25 独立验收报告（verifier）

- 日期：2026-11-12
- 被验卡：`task-25`（缺陷 1：`already-open` 走危险色 + 常驻；缺陷 2：强杀窗口后 90 秒误判）
- 交付方：engineer-panel
- 验收方：verifier（**只审不写**；本目录是唯一写域）
- 产物目录：`poc/probe/verify-task25/`

---

## 0. 一句话结论

**可以收 —— task-25 那两处改动本身经得起验。** `ok`/`shouldPoll` 解耦、缺陷 2 只写注释，7 组反向验证 **6 组真红 + 1 组专门用来证明"不红才是对的"**，还原后 SHA256 逐字节一致，类型没溢出写域，TTL 归因确认。

**但有两个必须让 Lead 知道的事实**：
1. 我验收期间工作区**被并发编辑**（task-26）：`verify 21 项全绿` 是 17:22 那一刻的事实，之后 `panel-diag-wiring.test.ts` 变成 5 条红（**与 task-25 无关**，详见 §8）。
2. **`entrypoints/content-panel.content.ts:220` 那一行在 task-25 之前确实没有任何测试守住** —— engineer 的自报是真的，我用 RV8 直接证明了（把新守卫 skip 掉、把调用点改坏，零红）。这也印证了 Lead 说的「这个缺口 task-24 时就存在、我上轮没查出」。**我把这个漏检认下来，见 §7 ⚠️。**

---

## 1. 仓库身份（AGENTS.md §0）

| 判据 | 结果 |
| --- | --- |
| `git rev-parse --show-toplevel` | `D:/Projects/Pluma` ✅ |
| `AGENTS.md` / `docs/decisions/` | 均存在 ✅ |
| `package.json` 的 `"name": "bili-pluma"` | ✅ |

---

## 2. 验收项与结论

| # | Lead 要求的复核项 | 结论 | 证据 |
| --- | --- | --- | --- |
| A | `node scripts/verify.mjs` 复跑 | ✅ 21 项全绿（27.2s，exit 0） | `verify-21-green.txt` |
| B1 | RV1：`already-open` 的 `ok` 改回 `false` → 应红 | ✅ **真红 2 条** | `rv-result.json` / `rv-console.txt` |
| B2 | RV2：调用点改回 `if (!r.ok) return` → 应红（**重点**） | ✅ **真红 2 条** | 同上 |
| B3 | 剥注释是否真有效（不许假绿） | ✅ 有效；并**归位**到真正该验这个的测试 | RV3 + RV6 |
| C | 写域核对（开工前/收工后 M、?? 数） | ⚠️ 见 §3：数字变了，但**不是 task-25 改的** | `git-status-after.txt` |
| D | `shouldPoll` 类型改动是否溢出 `src/shared/types/` | ✅ 未溢出 | §4 |
| E | `already-open` 走 `ok:true` 后 TTL 分支是否只由 `ok` 决定 | ✅ 代码上是；🟡 见 §5 的边界 | RV5 + 源码 |

---

## 3. 写域核对（⚠️ 有变化，已归因）

| 时点 | `git status --porcelain` 行数 | 说明 |
| --- | --- | --- |
| 我开工（17:19 前后） | **45** | 19 `M` + 26 `??` |
| 我收工时（17:31） | **47** | 新增 `M src/content/panel/diagnostics.ts` + `?? poc/probe/verify-task25/` |

- `?? poc/probe/verify-task25/` 是**我自己的产物目录**，在写域内，正常。
- `M src/content/panel/diagnostics.ts`（+151/−15）**不是我改的**，也不是 task-25 的内容：diff 里明确写着 `task-26`、`LogsMeta`、`describeLogsError()`、`poc/probe/diag-export/REPORT.md`。是 engineer-panel 在 task-26 里**在我验收期间**落盘的。
  - 它落在 task-25 卡的写域 `src/content/panel/` 之内，但**内容属于 task-26** ⇒ 严格说这是"两张卡共用写域"的漂移，不是越界；我只做记录，不判违规。
- task-25 卡声明的三处写域（`src/content/panel/` + `entrypoints/content-panel.content.ts` + `tests/unit/content/panel/`）**内**实际被改的：`login-outcome.ts`、`content-panel.content.ts`、`tests/unit/content/panel/entry-wiring.test.ts`、`tests/unit/content/panel-login-outcome.test.ts`；加上**写域之外**但被允许的 `src/background/login-window.ts`（缺陷 2 的注释）。

---

## 4. `shouldPoll` 类型是否溢出写域：**没有**

`git status --porcelain -- src/shared/types` **空**。

`shouldPoll` 全仓出现位置（`git grep -n shouldPoll -- src entrypoints tests`）：

| 文件 | 角色 |
| --- | --- |
| `src/content/panel/login-outcome.ts:74` | **唯一类型声明**（`describeLoginOutcome()` 的内联返回类型），不在 `shared/types` |
| `src/content/panel/login-outcome.ts:77,82,141,145` | 三个分支的取值 |
| `entrypoints/content-panel.content.ts:220` | 唯一消费点 `if (!r.shouldPoll) return;` |
| `tests/unit/content/panel-login-outcome.test.ts` | 断言 |
| `tests/unit/content/panel/entry-wiring.test.ts` | 源码文本断言 |

⇒ 这是**局部形状**，没有进 `messages.ts` / `shared/types`。符合卡上写域。

---

## 5. TTL 只由 `ok` 决定 —— 代码确认

`src/content/panel/panel.ts` 的 `showNotice`（`:851`）：

```ts
851:  function showNotice(text: string, ok: boolean): void {
852:    let bar = root.querySelector('.panel-notice');
...
857:    bar.textContent = text;
858:    bar.classList.toggle('danger', !ok);
860:    // 清掉上一条的定时器
861:    if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null; }
866:    if (ok) {
867:      noticeTimer = setTimeout(() => {
868:        noticeTimer = null;
870:        if (bar.textContent === text) bar.remove();
871:      }, NOTICE_TTL_MS);   // NOTICE_TTL_MS = 5000 (:244)
872:    }
873:  }
```

**结论：颜色与自动消失都由形参 `ok` 直接决定，中间没有任何其它条件。** `clearNotice()`（`:893`）只清旧 timer + 摘节点，不给"这一次"加超时。全文内 `.panel-notice` 的 class/节点只在 `showNotice` 与 `clearNotice` 两处操作（`git grep` 全仓无第三处）。

🟡 **一个边界（不影响本卡结论，但要说清）**：`already-open` 现在 `ok:true` ⇒ **5 秒后提示条自动消失**。用户如果在 5 秒内没抬头，就再也看不到"窗口已经开着了"。这是**设计取舍**（好消息不该常驻），但当窗口被挡在后面时，5 秒可能不够。建议（不阻塞）：若日后用户反馈"提示一闪就没了"，考虑对 `already-open` 这条用更长的 TTL 或带"窗口已聚焦"的动作按钮 —— 这需要改 `showNotice` 的签名，**属于新能力，要先问用户**。

---

## 6. 反向验证（RV）—— 7 组，逐条

脚本：`poc/probe/verify-task25/rv.mjs`（备份 → 单点变异 → 跑测 → 按备份逐字节还原 → 核 SHA256）。
**没有用过** `git checkout` / `git stash` / `git reset`；全部通过 `copyFileSync(backup)` 还原。

### 6.0 还原校验（跑完 RV 后重新对 SHA256）

| 文件 | SHA256（与备份逐字节一致） |
| --- | --- |
| `entrypoints/content-panel.content.ts` | `F76CEF6C…C0BFD74` |
| `src/content/panel/login-outcome.ts` | `71B2C1B3…DD8FBAB` |
| `src/content/panel/panel.ts` | `B006A893…910BA4F` |
| `tests/unit/content/panel/entry-wiring.test.ts` | `28816B93…3E437C` |
| `tests/unit/content/panel-login-outcome.test.ts` | `51972704…907217` |

无 `.rvbak` 残留（`Get-ChildItem -Recurse -Filter *.rvbak` 空）。

### 6.1 RV1 —— `already-open` 的 `ok: true` 改回 `false`

- 变异：`login-outcome.ts` 的 `already-open` 分支 `ok: true` → `ok: false`
- 结果：**`Tests 2 failed | 22 passed (24)`，真红**
  - `AssertionError: expected false to be true` @ `tests/unit/content/panel-login-outcome.test.ts:217`（「`already-open` 是**好消息**（`ok:true`）—— 不许再让它走危险色」）
  - `expected false to be true` @ `:247`（「`ok` 与 `shouldPoll` 正交」那条的组合断言）
- `noTests: false`，还原 ✅

### 6.2 RV2 —— 调用点改回 `if (!r.ok) return;`（**Lead 点名的重点**）

- 变异：`entrypoints/content-panel.content.ts:220` `if (!r.shouldPoll) return;` → `if (!r.ok) return;`
- 结果：**`Tests 2 failed | 32 passed (34)`，真红**
  - `AssertionError: openLogin 不再按 shouldPoll 早退 —— 概念又被粘回去了: expected 'const openLogin = async (): Promise<v…' to match /if\s*\(\s*!r\.shouldPoll\s*\)\s*return/` @ `tests/unit/content/panel/entry-wiring.test.ts:150`
  - `AssertionError: openLogin 仍在用 ok 判是否轮询 —— 没解耦: … not to match /if\s*\(\s*!r\.ok\s*\)\s*return/` @ `:163`
- `noTests: false`、`syntaxError: false`，还原 ✅

### 6.3 RV8 —— 证明 RV2 的红**来自新守卫**（这个不能省）

RV2 红了不等于"红来自新加的两条测试"。所以：

- 变异：把 `entry-wiring.test.ts` 那两条 `it(` 改成 `it.skip(`，**同时**把调用点改坏成 `if (!r.ok) return;`
- 结果：**`Tests 8 passed | 2 skipped (10)`，全绿**
- ⇒ 调用点改坏本身不会让任何别的测试红；RV2 的红**确实全部**来自那两条新守卫。engineer 说的"1831 条全绿"是**真的**，它补的守卫是**真守卫**。
- 还原 ✅

### 6.4 RV3 —— 注释冒充：代码写错、注释里写对

- 变异：调用点改成 `if (!r.ok) return;`，并在其上一行加注释 `/* if (!r.shouldPoll) return; */`
- 结果：**`Tests 2 failed | 8 passed (10)`，真红**（与 RV2 同样的两条）
- ⇒ `openLoginCodeOnly()` 的两段正则（`/\/\*[\s\S]*?\*\//g` + `/\/\/[^\n]*/g`）**确实把注释剥掉了**，"注释里有正确代码"骗不过它。**剥注释是有效的，不是假绿。**

### 6.5 RV6 —— 把 strip 有效性验在**真正需要它的地方**

Lead 要求"自己验一遍剥注释真有效"。我把两类断言分开看：

| 断言类型 | 是否依赖剥注释 | 验证方式 |
| --- | --- | --- |
| `entry-wiring.test.ts:150/:163`（`toMatch` / `not.toMatch`） | **是**（注释里就写着 `if (!r.ok) return;` 的讨论） | **RV3 已验** |
| `panel-login-outcome.test.ts:283-284`（`not.toContain('已打开')` / `not.toContain('窗口已')`）、`:290`（`toContain('再点一次')`） | **否**（断言的是 `describeLoginOutcome()` 的**返回值**，不是源码文本） | **RV6**：把旧文案原句 `/* 假注释：扫码窗口已打开，请用手机扫码。成功后这里会自动更新。再点一次 */` 塞进 `login-outcome.ts` 顶部 → **`Tests 24 passed (24)`，全绿** |

⇒ **结论：`panel-login-outcome` 那一组断言读的是函数返回值，注释塞什么都不影响它 —— 它本来就不需要剥注释，也没有假绿风险。** 这一点我最初也怀疑过，实测排除了。engineer 只在 `entry-wiring.test.ts` 里做剥注释，**范围是对的**。

（补充：`login-outcome.test.ts` 全文有 19 段注释，其中 `:194` `toContain('已经开着')` 的 `已经开着` 这个词确实只出现在 `login-outcome.ts` 的注释里 —— 但断言对象是返回值 `r.text`，不是源码，所以无影响。）

### 6.6 RV4 —— 两行并存（`!r.ok` 在前、`!r.shouldPoll` 在后）

- 结果：**`Tests 1 failed | 9 passed (10)`**
  - `openLogin 仍在用 ok 判是否轮询 —— 没解耦` @ `:163`
- ⇒ "补一条对的、留着一条错的"这种糊弄法也能被抓住。**这对互补断言设计是对的。**

### 6.7 RV5 —— TTL 归属：`panel.ts` 的 `if (ok)` 改成 `if (!ok)`

- 结果：**`Tests 2 failed | 6 passed (8)`**
  - `5 秒后应该自动消失: expected <p class="panel-notice"></p> to be null` @ `panel-notice.test.ts:88`
  - `失败提示不该自动消失: expected null not to be null` @ `:102`
- ⇒ TTL 分支确实由 `ok` 单向决定，且有测试守着。

### 6.8 RV 汇总表

| RV | 变异点 | 期望 | 实测 | 真红/假红 |
| --- | --- | --- | --- | --- |
| RV1 | `login-outcome.ts` `already-open` 的 `ok` | 红 | 2 failed | **真红** |
| RV2 | `content-panel.content.ts:220` 判据 | 红 | 2 failed | **真红** |
| RV3 | 同上 + 注释里写对 | 红（剥注释有效） | 2 failed | **真红** |
| RV4 | 两行并存 | 红 | 1 failed | **真红** |
| RV5 | `panel.ts` `if (ok)` | 红 | 2 failed | **真红** |
| RV6 | 注释里塞旧文案（验 `not.toContain` 那组） | **绿**（证明它们不读源码） | 24 passed | ✅ 符合预期 |
| RV8 | 守卫 skip + 调用点改坏 | **绿**（证明 RV2 的红来自新守卫） | 8 passed / 2 skipped | ✅ 符合预期 |

---

## 7. 对 engineer 自报内容的核对

| engineer 自报 | 我的核对 | 结论 |
| --- | --- | --- |
| 改回 `if (!r.ok) return;` 后 **1831 条全绿**，那一行没人守 | RV8 直接证明了（把守卫 skip 掉后改坏调用点，10 条里 8 passed / 2 skipped，零红） | **成立** |
| 补了 `entry-wiring.test.ts` 2 条、剥注释后断言 | RV3 证明剥注释有效；RV4 证明互补断言能抓"两行并存" | **成立** |
| 缺陷 2 只写注释不改代码（卡片 (a) 方案） | `src/background/login-window.ts:86-103` 有「已知窗口期：强杀窗口后 90 秒内会误判」完整段落，含"本轮不修"的理由与自愈说明；**无逻辑改动** | **成立** |
| `shouldPoll` 是新加的独立字段 | `login-outcome.ts:74` 声明、`:77/:82/:141/:145` 四处赋值，`shared/types` 未涉及 | **成立** |

⚠️ **一处需要说明的：Lead 说"这个缺口 task-24 时就存在、你上轮没查出"—— 属实。** 我上轮复核 task-24 时查了 `entry-wiring.test.ts` 里 `clearNotice` 的接线，**没有逐个核对 `openLogin` 的早退判据**。task-24 卡把 `shouldPoll` 引入时，正需要"引入新判据就必须有守卫"，这一点我没验。这是我这一轮的漏项，已记入待修清单末尾的方法学条目。

---

## 8. ⚠️ 全量测试在验收期间是红的（工作区被**并发编辑**，两次采样看到的是两套不同的代码）

> 这一节最初我写成"6 条红、`panel.ts:698` 少一对括号"。**复查时那行代码已经不存在了**，红的原因也换了。
> 按本项目的纪律（"一个恒为 0 的探针和一个真的没有，输出长得一模一样"），
> 我把它改成**按时刻记录**，而不是给一个会骗人的因果。

### 8.1 时间线

| 时刻 | 采样 | 结果 |
| --- | --- | --- |
| 17:21 前 | 工作区 `git status` | **45 行** |
| 17:22 | `node scripts/verify.mjs` | **✅ 21 项全绿（27.2s）** ⇒ A 项成立 |
| 17:22 后 | `git status` | **47 行**（新增 `M src/content/panel/diagnostics.ts` + `?? poc/probe/verify-task25/`） |
| 17:23 | 全量 vitest | **`Test Files 2 failed / 111`，`Tests 6 failed / 1833`**；报错 `ReferenceError: probeFailedBase is not defined`（`panel.ts` 里 `{ ...probeFailedBase, count: 0 }`） |
| 17:28 | 单独跑那 2 个文件 | 6 failed |
| 17:31 | 再跑 | **5 failed**（`silent-controls` 那条自己绿了） |
| 17:33（复查报告时） | `git grep probeFailedBase -- src` | **零命中**：那段代码已经被删/改走了 |

### 8.2 17:33 复查到的真实红因（与 8.1 的 `probeFailedBase` **无关**）

```
tests/unit/content/panel-diag-wiring.test.ts  → 5 条红
  expected '画质净化显示账号正在采集诊断信息…' to contain 'InPrivate 权限'
  expected 1 to be +0
  expected null not to be null
  expected "spy" to be called 2 times, but got 1 times
  没找到刷新按钮: expected null not to be null
tests/unit/content/panel/silent-controls.test.ts → 已恢复绿
```

⇒ 这是 **task-26（诊断导出改造）的在途改动**：`src/content/panel/panel.ts` 的诊断渲染路径正在被重写，`panel-diag-wiring.test.ts`（断言旧渲染：自检行、返回弹栈、ok/bad class、刷新按钮）跟不上。归属**明确不是 task-25**（task-25 没碰 `diagnostics.ts`，也没碰诊断渲染）。

### 8.3 这说明的三件事

1. **A 项的绿是真的，但只覆盖 17:22 那一刻的工作区。** 之后工作区被 task-26 继续写，绿不再是当前事实。
2. **我这两次采样看到的是两套不同的代码**——中间 `panel.ts` 被改了至少两次（一次引入 `probeFailedBase`，一次删掉它）。**任何一次快照式结论都会在 30 秒内过期**，所以本节只给时刻，不给"现在坏了"这种会过期的断言。
3. 我 `rv.mjs` 的预检**抓到了这个漂移**：最后一次 RV 跑时打印 `[backup] DIFF src/content/panel/panel.ts` —— 备份是 17:21 的，跑 RV 时工作区已被改。RV5 的变异点在 `showNotice`（未被 task-26 触碰），所以 RV5 结论仍成立；**但如果哪天变异点正好落在并发编辑的区域，RV 会出现假红/假绿。以后并发窗口内做 RV，应在跑之前先重新备份。**

---

## 9. 待修清单（交 Lead 派卡，**我不动手改**）

| # | 优先级 | 事项 | 依据 |
| --- | --- | --- | --- |
| 1 | **高（归 task-26）** | `tests/unit/content/panel-diag-wiring.test.ts` 现在 **5 条红**（诊断渲染路径被改，测试跟不上）。task-26 出工前必须把它修绿并重跑全量 `node scripts/verify.mjs`，**不能拿 17:22 那次绿当通行证** | §8 |
| 2 | 中 | `already-open` 的提示 5 秒自动消失；若用户没抬头就错过。建议日后评估是否需要更长 TTL 或可点击的动作，**属于新能力，须先问用户** | §5 🟡 |
| 3 | 低 | 缺陷 2 的 90 秒误判窗口**没有测试看守**（只有注释）。一旦有人"顺手修"成压 TTL，没有东西会红。可考虑加一条对 `LOGIN_HEARTBEAT_TTL_MS` 与 `LOGIN_HEARTBEAT_INTERVAL_MS` 关系的断言（`TTL >= 6 × INTERVAL`） | `login-window.ts:82-109` |
| 4 | 低（方法学） | 我上轮漏查"引入新判据 `shouldPoll` 时有没有守卫"。建议 Lead 在卡里把「新增判据必须同时新增守卫、且守卫要有 RV」写成硬验收项，别依赖 verifier 记性 | §7 ⚠️ |
| 5 | 低（方法学，**给我自己**） | 并发写窗口内做 RV 前应重新备份；否则 `restore()` 会把别人的在途改动**覆盖回旧版本**。本次运气好（变异点未被碰），下次不一定 | §8.3 |

---

## 10. 产物清单

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 本报告 |
| `rv.mjs` | 7 组 RV 脚本（备份→变异→跑测→还原→核 SHA） |
| `rv-result.json` | 每组 RV 的原始结果（totals / 红在哪一行 / 还原校验） |
| `rv-console.txt` | RV 控制台输出（可直接读） |
| `verify-21-green.txt` | `node scripts/verify.mjs` 全绿输出（27.2s） |
| `vitest-full.txt` | 17:23 全量 vitest 输出（2 files / 6 tests 红，源自 task-26） |
| `diag-red-now.txt` | 17:31 复查 diag 两组测试的输出（5 红） |
| `git-status-after.txt` | 收工时 `git status --porcelain` 全量 |
| `backup/` | 5 个被变异文件的原始副本（还原来源） |
| `drift/panel-head.ts`、`drift/diagnostics-head.ts` | **警示：用 `git show >` 在 PowerShell 下写成 UTF-16，不要当源码用**；只作"HEAD 长什么样"的参考 |

---

## 11. 能不能收

**task-25：能收。** 两处改动的行为与语义都对，7 组 RV 全部符合预期（6 组真红 + 1 组"不红才对"），还原逐字节一致，写域没溢出，TTL 归因确认。

**但请 Lead 注意时序**：`node scripts/verify.mjs` 的全绿是 17:22 那一刻的；17:23 之后 task-26 的在途改动把 `panel.ts:698` 写坏了，全量 6 条红。**task-26 出工时必须重跑全量 verify**，不要拿这一次的绿当它的通行证。

# task-47 验收报告 —— 权限 false 不建窗 + `assumed` 不冒充成功

> 验收对象：task-46（engineer-panel）
> 验收者：verifier（只审不写，写域仅 `poc/probe/verify-task46/`）
> 时间：2026-11-15 19:41–19:57
> 仓库身份：`D:/Projects/Pluma` · `bili-pluma` · `AGENTS.md` + `docs/decisions/` 齐备

---

## §0 裁定

**🔴 退回。**

理由一句话：**background 那一半改对了（`assumed` 不再 `opened:true`），面板那一半没改，于是用户看到的字从「已尝试打开…去任务栏找找」退化成了「登录窗口打不开，请重试」。** 从"没确认却说成功"换成"没确认却断言失败" —— 后者更糟，原来至少叫用户去找窗口，现在直接叫他放弃重试。

判据 1 成立；判据 3 成立；判据 2 不成立；判据 4（RV）**未执行**（并发写入窗口内观测不可信，如实标 🟡）；判据 5 不成立（产物早于改动）。

---

## §1 判据 1 ✅ 成立 —— 权限 false 时 `chrome.windows.create` 扫窗调用 === 0

产物：`poc/probe/verify-task46/gate-run.test.ts`（**5/5 通过**）
复跑：`node node_modules/vitest/vitest.mjs run --config poc/probe/verify-task46/vitest.probe.config.ts`

### 四层防假绿（Lead m03711 定，全部做了）

| 层 | 断言 | 结果 |
| --- | --- | --- |
| 1 | 权限 false → create 调用次数 **=== 0** | ✅ |
| 2 | `vi.isMockFunction(create)` **=== true** | ✅ |
| 3 | 权限 false → 闸门之前的副作用 `getAll` **=== 0** | ✅ |
| 4 | 反面对照：权限 true → create **=== 1**（证明计数器能变） | ✅ |

第 3 层我自己也配了 control：权限 true 时 `getAll` **必须被调用**（实测 2 次 —— `openLoginWindow` 里 create 前后各数一次）。**没有这条 control，`getAll === 0` 就是一个从没被验证过的断言。**

### Lead m03723 追加：计数器挂在哪一层 / 有没有 wrapper

**答：挂在最底层的 `chrome.windows.create`，因为那里就是直调。**

源码级断言（`gate-run.test.ts` 最后一条，花括号配平切出 `openLoginWindow` 函数体）：
- `expect(body).toMatch(/chrome\.windows\.create\s*\(/)` ✅ 直调存在
- `expect(body).not.toMatch(/(?:function\s+\w*[Cc]reate\w*\s*\(|const\s+\w*[Cc]reate\w*\s*=\s*(?:async\s*)?\()/)` ✅ 无本地 wrapper

⇒ 若将来有人加了 wrapper，这条断言会先红，**不会让计数器悄悄失去代表性**。

### 返回值
`{ ok: false, reason: 'incognito-disabled' }` ✅

---

## §2 判据 2 🔴 不成立 —— `assumed` 被面板讲成「打不开」

产物：`poc/probe/verify-task46/assumed-copy-v2.test.ts`
复跑：`node node_modules/vitest/vitest.mjs run --config poc/probe/verify-task46/vitest.probe.config.ts`

### 证据链（端到端，中间没有任何手写应答字面量）

加载真实的 `entrypoints/background.ts`（注入 WXT 的 `defineBackground` 全局，截获它注册的 `chrome.runtime.onMessage` 处理器）→ 喂**真实的** `{type:'login/open'}` 消息 → 拿到**真实返回对象** → 原样送进 `describeLoginOutcome()`。

**实测输出（engineer 19:51:05 又改过一次 `background.ts` 之后的复测）：**

```
REPLY assumed  = {"type":"login/open:ok","opened":false,"confirmed":false,"reason":"assumed"}   ← background 侧 ✅ 已改对
TEXT  assumed  = 登录窗口打不开，请重试                                                          ← 🔴 面板侧没改
```

**失败原文：**
```
AssertionError: assumed 被说成「打不开」—— 把"没确认"讲成了"确定失败":
  expected '登录窗口打不开，请重试' not to contain '打不开'
```

### 缺口逐行

| 位置 | 现状 | 后果 |
| --- | --- | --- |
| `src/content/panel/login-outcome.ts:79` | `if (res.opened !== true) { … }` | `assumed` 落进这里 |
| `:84-116` | 里面**只判 `incognito-disabled`** | `assumed` 掉到 `:116` 通用 `'登录窗口打不开，请重试'` |
| `:193-198` | `describeSuccess()` 里 `reason === 'assumed' → ASSUMED_TEXT` | **`:79` 已先 return，永远走不到** |

### 对照组（证明这不是"探针恒红"）
| 场景 | REPLY | TEXT | 判定 |
| --- | --- | --- | --- |
| create 返回窗口对象 | `{"opened":true,"reason":"opened"}` | 含「已打开」 | ✅ 正确 |
| 权限 false | `{"opened":false,"reason":"incognito-disabled"}` | 含「InPrivate」 | ✅ 正确 |
| create 返回 undefined（split 常态） | `{"opened":false,"confirmed":false,"reason":"assumed"}` | 「登录窗口打不开，请重试」 | 🔴 **错** |

---

## §3 判据 3 ✅ 成立 —— 注释与代码不矛盾

`src/background/login-window.ts` 全文 grep：
- 「绝对不许拿它做分支判断」→ **0 命中**
- 「先试再判」→ **0 命中**

task-32 那段禁令注释已被改写，新注释给出了改回来的依据。代码现在确实拿权限值做分支（`if (!allowed) return`），二者一致 ✅。

---

## §4 判据 4 🟡 未执行（如实标注）

RV1/RV2/RV3 **未执行**。原因：执行窗口内工作区有并发写入，观测不可信（详见 §7）。

RV1 曾跑过一次，拿到 `failed:6 passed:7`，但**该数字作废** —— 它撞上的是"备份后文件又被改过"的窗口，且混入了判据 2 早已恒红的用例。**不作为本卡结论依据。**

脚本已就绪（`poc/probe/verify-task46/rv.mjs`，参数式 `RV1|RV2|RV3|clean`，禁 stash/checkout/reset，备份到 `.rvbak/`，变异前断言 `from` 恰好出现 1 次，还原后比 SHA256）。**等复验卡在独占工作区里补做。**

---

## §5 判据 5 🔴 不成立 —— 产物早于改动

`.output/chrome-mv3/background.js` LastWriteTime = **2026-11-12 21:05:30**，`.output` 下所有 js 均为 11-12 21:05:31。

⇒ **产物早于本轮全部改动，grep 产物证明不了新逻辑已编入。** 需重跑 `wxt build` 才能验这一条。

---

## §6 最小必改项（三条，缺一条不算过关）

### 必改 1（P0）· `assumed` 的文案
`src/content/panel/login-outcome.ts` 在 `:79` 的 `if (res.opened !== true)` 分支内**先判 `reason === 'assumed'`**，给既不说"已打开"也不说"打不开"的文案。
**`ASSUMED_TEXT` 那句「已尝试打开扫码登录窗口。没看到的话，去任务栏或 Alt+Tab 里找找那个新窗口」正好符合，直接复用即可。**
并补一条测试守着「`assumed` 不落进 '打不开' 文案」。

### 必改 2（P0）· `:42` 表格注释
`login-outcome.ts:42` 仍写「`opened:true` + `assumed`」，与 `entrypoints/background.ts:139` 的 `opened:false` 矛盾，必须同步。

### 必改 3（P0）· `ASSUMED_TEXT` 的可达性表述
`ASSUMED_TEXT` 只能由 `{opened:true, reason:'assumed'}` 产出，而 `entrypoints/background.ts:139` 已保证 `assumed` 一律 `opened:false` ⇒ **该输入组合今天无任何代码路径能产生**。
修完必改 1 之后它会重新可达；若选择不走这条路，就**删掉它**，不许留。

> 实测补充（不是"死代码"三个字能说完的）：我喂三种候选输入量过 —— `{opened:false,reason:'assumed'}` → 「登录窗口打不开，请重试」、「{opened:true,reason:'assumed'}` → `ASSUMED_TEXT`（这条今天无路径能产生）、`{opened:false,confirmed:false,reason:'assumed'}` → 「登录窗口打不开，请重试」。**函数内部可达，跨文件调用契约上不可达。**

### 另需处理（非本卡判据，但会挡住 verify）
开工时就存在的 **12 条红**（`Tests 12 failed | 1877 passed (1889)`）：`incognito-permission-gate.test.ts` 3 条、`login-heartbeat-probe.test.ts` 1 条、`login-heartbeat-wiring.test.ts` 1 条、`incognito-panel-notice.test.ts` 3 条、`orphan-guard.test.ts` 2 条、`orphan-hint.test.ts` 2 条。
按 Lead m03711 定调：改被撞测试的方向是对的，但必须 (a) 不许 `it.skip`/整条删除 (b) 新断言自己能真红 (c) **证据口径同步更新** —— `incognito-permission-gate.test.ts:1-28` 文件头还写着旧口径「22 次去重读取 true 10 / false 12 / 翻转 15 次 / 21 个 SW 实例」，与 `login-window.ts:249-263` 的新口径**两套互相矛盾的陈述 = 退回项**。

---

## §7 本轮并发事故（方法学留档，不是追责）

### 发生了什么
1. **19:50:02** 我记开工基线：`entrypoints/background.ts` = `74EBD697D89728CC73A7B4C445A3CC566016B819DAD767F642BBAC73028219A2`（27176B），`git status` 64 行
2. **19:50:42** 有人把 `entrypoints/background.ts` 又写了一次
3. **19:51:0x** 我跑 RV1，`backup(TARGETS)` 读到的已经是 **`51B1C369AC750760202B4966D6B62F2A5B2C216A43919D06C0756400A10E5D1F`**（27244B）
4. RV1 结束 `restore()` 把 `51B1C3…` 写回去，并自报「逐字节一致=true」—— **它和我的备份一致，但和队友 19:50:42 之后想要的改动是否一致，我不知道**
5. **19:51:05** engineer 又写了一次（后来实测为 `E0AF7BD6…` / 27304B）

### 我的错在哪（三条，按严重度）

1. **`backup(TARGETS)` 的范围大于 `mutate` 的范围。** 我只变异 `src/background/login-window.ts`，却把 `entrypoints/background.ts` 一起备份**并一起还原**。还原一个我没动过的文件，唯一效果就是**多了一次覆盖别人改动的机会**。
2. **没做"备份后文件是否又被改过"的检查。** `backup()` 时记了 SHA，`restore()` 前却没核"当前文件还是不是那个 SHA"。核了就会发现不一致，可以停下而不是照写。
3. **把"改动已在工作区"当成了"engineer 交付完了"。** 这是 Lead 转述的判断，我照单全收就开工了，没有先用 mtime 确认是否有活跃写入。

### 方法学教训（写进流程）
> **RV 的备份范围必须严格等于变异范围。** 多备份一个文件，就多一个覆盖别人改动的机会，而它带来的收益是零 —— 因为你根本没变异它。
>
> **`restore()` 之前必须核"当前文件 SHA == 备份时的 SHA"**，不等就停手报警，不许照写。
>
> **开工前先用 mtime 扫一遍最近 N 分钟被写的文件**，确认工作区处于静默状态，再开始 RV。

### 现状（交付时实测）
`entrypoints/background.ts` = `E0AF7BD6…` / 27304B / mtime 19:51:05。**待 engineer 确认是否为他想要的那份，不作为本卡结论依据。** `src/background/login-window.ts` = `21A57597…` / 21499B，与我开工前一致 ✅。

---

## §8 探针自身两次翻车（留档 —— 这两条比结论更值钱）

### 翻车 1：v1 假红 —— 模块级状态跨用例存活

`src/background/login-window.ts` 的 `currentWindowId` 是**模块级变量**，跨用例存活。我 v1 的每条用例只换 `chrome` stub，没清模块状态。第 2 条用例把 `{id:7}` 塞进去之后，后续用例一进门就 `chrome.windows.update(7, {focused:true})` 成功 → 返回 `already-open`。

**症状：** `LOGIN_OPEN_REPLY {"type":"login/open:ok","opened":true,"reason":"already-open"}` —— 看起来像"权限 false 没拦住建窗"，**实际是我探针脏了**。

**修法（v2）：** 每条用例开头 `lw.forgetLoginWindow()` 显式重置，并断言 `spied.create.mock.calls.length === 0`（起点干净）。**不依赖"测试文件按顺序跑"这种隐式前提。**

### 翻车 2：v2 假红 —— 数 `create` 总次数把合法行为算成 bug

权限 false 时，`handleLoginOpen()` 会**合法地**调一次 `windows.create` 去弹**说明页**（`need-incognito.html`）：

```
CREATE_CALLS disabled = 1 args=[[{"url":"chrome-extension://fake/need-incognito.html",
  "type":"popup","width":460,"height":420}]]
```

判据 1 说的是"**扫码窗**一次都不许建"，数总数会把一个**正确**的行为判成 bug。

**修法：** 按 URL / `incognito` 过滤，只看 `login-window.html` 或 `incognito === true` 的 create：
```js
const windowCreates = spied.create.mock.calls.filter((c) => {
  const arg = (c[0] ?? {}) as { url?: string; incognito?: boolean };
  return (arg.url ?? '').includes('login-window.html') || arg.incognito === true;
});
expect(windowCreates.length).toBe(0);   // → 实测 []  ✅
```

### 这两条的共性（值得记下来）
> **探针脏了，会把好的说成坏的 —— 而"把好的说成坏的"和"把坏的说成好的"一样有害，因为报告读者没有第二次机会去怀疑那条红。**
> 一个探针在报"这里有 bug"之前，必须先用**对照组**证明它在正确输入下会报"没问题"。v2 里的对照组（create 返回窗口对象 → 必须说「已打开」）就是干这个用的 —— 没有它，上面那条红不能采信。

---

## §9 工作区只读性证明

| 时点 | `git status --porcelain` | `entrypoints/background.ts` | `src/background/login-window.ts` |
| --- | --- | --- | --- |
| 开工 19:50:02 | 64 行 | `74EBD697…` 27176B | `21A57597…` 21499B |
| 交付 19:57 | 见 `status-final.txt` | `E0AF7BD6…` 27304B（engineer 所写） | `21A57597…` ✅ 与开工一致 |

**我改过的源码：`src/background/login-window.ts` —— 已逐字节还原。** 其余源码改动均由 engineer 写入，非我所为。
我的新增文件全部在写域 `poc/probe/verify-task46/` 内。

---

## §10 产物清单（`poc/probe/verify-task46/`）

| 文件 | 用途 |
| --- | --- |
| `REPORT.md` | 本报告 |
| `PREP-baseline.md` | 开工前只读基线（Lead 要求） |
| `vitest.probe.config.ts` | 独立 vitest 配置（`vitest.config.ts` 只扫 `tests/**`，扫不到探针） |
| `gate-run.test.ts` | **判据 1**，5/5 通过，四层防假绿 + 无 wrapper 源码级确认 |
| `assumed-copy-v2.test.ts` | **判据 2**，端到端真实链路，对照组齐备 |
| `assumed-copy.test.ts` | v1，**有已知缺陷（翻车 1）**，留档对照用，不作为结论依据 |
| `rv.mjs` | RV 脚本（就绪未用），`RV1\|RV2\|RV3\|clean` |
| `status-open.txt` / `status-final.txt` | 工作区只读性证明 |

---

## §11 一句话给用户

**扫码窗口那条路修对了一半：现在权限没开时不会再假装开了窗；但窗口到底开没开、我们没确认清楚的时候，面板会对你说「登录窗口打不开，请重试」—— 这是错的，应该说「没能确认窗口打开，去任务栏或 Alt+Tab 找找」。这一句还没改。**

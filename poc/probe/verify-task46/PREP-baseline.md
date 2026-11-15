# task-47 开工前基线（verifier 自查记录，2026-11-15）

> 只读记录。**不是验收结论**。task-47 尚未开工（Lead 会另行通知）。
> 目的：把 engineer 交付前的实现逐字记下来，交付后逐行对比，而不是只看 `git diff` 摘要。

## 0. 仓库身份（AGENTS.md §0）
- `git rev-parse --show-toplevel` → `D:/Projects/Pluma` ✅
- `AGENTS.md` 19759 B、`docs/decisions/` 是目录 ✅
- `package.json:2` `"name": "bili-pluma"` ✅
- `git status --porcelain` → **61 行**（22 M + 39 ??）

## 1. `src/background/login-window.ts` 现状（452 行）

### 1.1 权限闸门已存在（task-46 第一处已落在工作区）
`openLoginWindow()` 内，`currentWindowId` 分支之后（`:280-285`）：

```ts
const allowed = await isIncognitoAllowed();
await diag('isAllowedIncognitoAccess', String(allowed));
if (!allowed) {
  await diag('权限读到 false → 不建无痕窗，直接报 incognito-disabled');
  return { ok: false, reason: 'incognito-disabled' };
}
```

**顺序要点**：这段排在 `probeExistingLoginWindow()`（`:296`）**和** `chrome.windows.getAll()`（`:302`）**和** `chrome.windows.create()`（`:309`）**之前**。
⇒ 断言 `create` 调用次数 === 0 在结构上可满足，但必须证明 mock 真的挂上了。

### 1.2 `assumed` 分支仍在（`:434-436`）
```ts
await diag('create 返回 undefined 且窗口数未变，交给握手判定');
return { ok: true, reason: 'assumed' };
```
⇒ **本层仍然 `ok:true`**。task-46 要求第 2 处（`entrypoints/background.ts`）不许把它当成功。

### 1.3 `create` 抛错分支（`:316-320`）保留
```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await diag('windows.create THREW', msg.slice(0, 120));
  return { ok: false, reason: /incognito|invalid/i.test(msg) ? 'incognito-disabled' : 'unknown' };
}
```

### 1.4 心跳 / 探测（未变）
- `LOGIN_HEARTBEAT_KEY='pluma:login-window-alive'`（`:77`）、`TTL=90s`（`:105`）、`INTERVAL=15s`（`:111`）
- `isIncognitoInstance()`（`:171-177`）读 `chrome.extension.inIncognitoContext === true`，catch→false
- `probeExistingLoginWindow()`（`:203-220`）：无痕实例 `return null`（安全闸）；普通实例 `readLoginHeartbeat()`
- ⚠️ `login-window.ts:429-432` 注释：task-45 取证「心跳那个键**从来没有被写入过**」⇒ 「第二次点击靠心跳判已开」**今天并未生效**

## 2. `entrypoints/background.ts` · `handleLoginOpen()` 现状（`:101-…`）

返回类型已有 `confirmed?: boolean`，`reason` 联合已含 `'opened'`：
```ts
async function handleLoginOpen(): Promise<{
  type: 'login/open:ok';
  opened: boolean;
  confirmed?: boolean;
  reason?: 'incognito-disabled' | 'already-open' | 'assumed' | 'opened' | 'unknown';
}> {
```

**分支顺序（关键）**：`:129` `assumed` 先判，`:145` `result.ok || already-open` 再判。
```ts
if (result.reason === 'assumed') {
  await diag('create 返回 undefined → 交握判定，opened=false（无法确认窗口已开）');
  await markLoginReady();                       // 照旧写（抑制另一实例误弹说明页）
  return { type: 'login/open:ok', opened: false, confirmed: false, reason: 'assumed' };
}

if (result.ok || result.reason === 'already-open') {
  await markLoginReady();
  return { type: 'login/open:ok', opened: true, reason: result.reason ?? ('opened' as const) };
}
```
⇒ **task-46 第二处也已落在工作区**：`assumed` 现在返回 `opened: false` + `confirmed: false`。

**`markLoginReady()` 语义**（`src/background/login-handshake.ts:33`，键 `'pluma:login-ready'`）：一次性就绪标记，作用**只是抑制另一个实例误弹说明页**，不参与 `opened` 判定。`assumed` 分支仍然写它（`background.ts:136`）——这是有意的：`markLoginReady` ≠ 对用户断言成功。

## 3. ⚠️ 开工前已存在的红：`tests/unit/background/incognito-permission-gate.test.ts`（task-32 的卡）

**该文件未改，仍守着 task-32 的口径「权限读 false 不许拦住建窗」——与 task-46 直接矛盾。**

实测（`node node_modules\vitest\vitest.mjs run tests/unit/background/incognito-permission-gate.test.ts`）：
```
Tests  3 failed | 2 passed (5)
```
- `:104` `expected 'incognito-disabled' not to be 'incognito-disabled'` ——「权限读 false + create 成功 → 必须 ok」
- `:119` `expected 'incognito-disabled' to be 'unknown'` ——「权限读 false + create 抛普通错 → 不许谎报 incognito-disabled」
- `:187` `` `allowed` 被用进了分支判断：if (!allowed) { `` ——「剥注释后 `allowed` 只许出现在声明与 diag 里」
  最后这条是**源码级穷举**：`if (!allowed) return …` 的原文形状被 `:191-193` 正则显式禁止。

## 4. ⚠️ 全量 vitest 当前状态（我实测，两次一致）
```
Test Files  6 failed | 111 passed (117)
Tests      12 failed | 1877 passed (1889)
```
12 条红：
| 文件 | 红 | 是否 task-46 引入 |
| --- | --- | --- |
| `tests/unit/background/incognito-permission-gate.test.ts` | 3 | **是**（task-32 口径未改）|
| `tests/unit/background/login-heartbeat-probe.test.ts` | 1 | **是**（「权限读到 false 时**不再**报 incognito-disabled」）|
| `tests/unit/background/login-heartbeat-wiring.test.ts` | 1 | **是**（「探测不许排在权限判定之后」）|
| `tests/unit/content/panel/incognito-panel-notice.test.ts` | 3 | ? |
| `tests/unit/content/panel/orphan-guard.test.ts` | 2 | ?（task-41 已有）|
| `tests/unit/content/panel/orphan-hint.test.ts` | 2 | ?（task-41 已有）|

⇒ **`node scripts/verify.mjs` 现在是红的**（其 `[test]` 步会挂）。这不是"环境问题"，是真实断言失败。

## 5. ⚠️ 文案层已经与 task-46 冲突（engineering 会撞上）
`src/content/panel/login-outcome.ts`：
- `:79` `if (res.opened !== true)` → 返回 `ok:false`。**`assumed` 现在也是 `opened:false`** ⇒ 会落进这个分支。
- `:84-116` `incognito-disabled` 有专门文案；**`assumed` 没有专门分支** ⇒ 会显示 `'登录窗口打不开，请重试'`，**把"没法确认"说成"打不开"**。
- `:193-198` `describeSuccess()` 里 `res.reason === 'assumed' → ASSUMED_TEXT`（`'已尝试打开扫码登录窗口。没看到的话，去任务栏或 Alt+Tab 里找找那个新窗口'`）现在是**不可达死代码**（`opened !== true` 先返回了）。
- `:42` 表格注释仍写「`opened: true` + `assumed`」，与 `background.ts:139` 的 `opened:false` 矛盾。

## 6. 判据设计：怎么证明 mock 真挂上了（本卡最容易假绿的地方）

`toHaveBeenCalledTimes(0)` **在 create 根本没被 mock / 根本没被调用时恒真**。三层防护：

1. **反面对照必做**：权限 `true` 时 `create` 调用次数 === **1**。这是唯一能证明"探针能看见调用"的用例。
2. **调用后立刻断 `isSpy`**：`expect(vi.isMockFunction(callCountProbe)).toBe(true)`，再断言 `=== 0`。
3. **不只看次数，还看"闸门在 create 之前返回"**：断言 `create` 的**前驱副作用**（`chrome.windows.getAll`、`probeExistingLoginWindow` 的 `diag('probe/instance')`）在权限 false 时**也没有发生** —— 若这些都发生了而 create 没发生，说明是别的原因（例如 create 抛错被吞），不是闸门。

## 7. 已知坑（沿用上一轮）
- RV 前**先备份文件副本**；禁 `git stash` / `git checkout` / `git reset`（工作区 61 行未提交改动）。
- RV 后逐字节还原 + 比 SHA256。
- `node -e` 里带反引号 / `${}` / 中文箭头会被 PowerShell 吃掉 ⇒ 改文件用 write/edit 或独立 `.mjs`。
- `git status --porcelain | Sort-Object > file` 写 UTF-16 会假报差异。
- 本机 Vite CJS 弃用警告会让 `pwsh` 报 `[exit code: 1]`，即使测试全绿 —— 要看 `Tests` 行，不看 exit code。

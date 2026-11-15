/**
 * 登录窗口管理 —— **必须开在无痕分区里**。
 *
 * 原因（[ADR 0012](../../docs/decisions/0012-isolated-window-login.md)）：
 * B站凭据只通过 `Set-Cookie` 下发，JS 读不到那个响应头，必须让浏览器真正落地。
 * 而落地就会覆盖同一分区的登录态，所以在普通窗口登录 = 覆盖主账号。
 *
 * ## split 模式的三个反直觉事实（全部实测踩过）
 *
 * 1. **分区隔离是双向的**：普通实例看不到无痕分区，也无痕实例看不到普通分区
 * 2. **普通实例创建无痕窗口后，自己也 `windows.get()` 不到它**（会 reject）
 * 3. **两个实例都会收到 `action.onClicked`**
 *
 * 由此得出两条铁律：
 *   - 验证隔离：只信 `windows.create()` 的返回值，不做二次查询
 *   - 跨实例协调：只信 `chrome.storage.local`（跨分区共享），不信内存变量和窗口列表
 */

import { diag } from '@platform/storage/diag-store';

// 诊断日志（`diag` / `readDiag` / `instanceId`）已下沉到 `platform/storage/diag-store`，
// 因为 options 的「诊断」分区也要读它，而 entrypoints 不许依赖 background。
const LOGIN_WINDOW = { width: 420, height: 600 } as const;

const LOGIN_URL = '/login-window.html';

/** 记住当前登录窗口，避免连点开出一堆（仅本实例可见） */
let currentWindowId: number | null = null;

export interface OpenLoginResult {
  ok: boolean;
  /**
   * - `incognito-disabled`：确定没权限（`isAllowedIncognitoAccess` 为 false）
   * - `already-open`：窗口已存在，已聚焦
   * - `assumed`：权限正常，但 `create` 返回 undefined 且本实例看不到窗口变化。
   *   **按"已创建"处理**——无痕窗口对当前分区不可见，实测窗口确实建出来了
   *   （标题 `登录播放账号-[InPrivate]`）。不要当失败。
   *
   *   ⚠️ **它在真机上是常态，不是例外**（2026-11-12，task-12 实测：4/4 次成功路径
   *   调用都是 `assumed`，`create()` 从未返回过 `id`）。这不是时序问题 ——
   *   普通实例按设计就看不见无痕分区的窗口 / 标签页（`loginTabs` 恒为 0）。
   *
   *   ⚠️ **已知限制**：走到这里时**无法确认窗口真的开了**。`ok: true` 是
   *   有依据的乐观判断（权限在、无痕实例通常能开），不是验证过的结论。
   *   详细论证与"为什么不能改成 false、也不能靠重试/tabs 确认"见
   *   `openLoginWindow()` 情况 3 的注释。
   * - `unknown`：其他异常
   */
  reason?: 'incognito-disabled' | 'already-open' | 'assumed' | 'unknown';
}

/**
 * 扩展是否被允许在无痕/InPrivate 窗口运行。
 *
 * 这是本方案的前置条件，无法绕过。
 */
export async function isIncognitoAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedIncognitoAccess();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 扫码窗口心跳（2026-11-12，task-24 方案 A）
// ---------------------------------------------------------------------------

/**
 * 心跳键 —— **新开一个键，不复用 `pluma:login-ready`**。
 *
 * `pluma:login-ready`（`login-handshake.ts`）是**一次性就绪标记**，
 * 用来抑制另一个实例误弹说明页。真机存储里只出现过**一条**记录
 * （`{at:1.794430174641e+12}`，之后再不更新）⇒ 它不是周期信号，
 * 拿它当"窗口是否还活着"会永远误判。
 */
export const LOGIN_HEARTBEAT_KEY = 'pluma:login-window-alive';

/**
 * 心跳过期时间。超过这个时间没有任何心跳 ⇒ 认为窗口已经关了 / 崩了。
 *
 * 为什么是 90 秒：扫码窗口每 15 秒写一次心跳（见 `LOGIN_HEARTBEAT_INTERVAL_MS`），
 * 90 秒 = 连续漏掉 6 次。够宽容（SW 被挂起、窗口在后台节流都不会误判成"关了"），
 * 又不至于让用户关窗后等太久才能重新打开。
 *
 * ## ⚠️ 已知窗口期：强杀窗口后 90 秒内会误判「已开着」（task-25 记录，本轮不修）
 *
 * 正常关窗时 `closeLoginWindow()` 与页面的 `useEffect` cleanup 都会清心跳。
 * 但窗口被**强杀**（崩溃 / 进程被终止 / 任务管理器结束进程）时 cleanup 不跑 ⇒
 * 心跳残留 ⇒ TTL 过期前 `probeExistingLoginWindow()` 仍返回非 null ⇒
 * 用户会看到「扫码登录窗口已经开着了 —— 它就是上面那个窗口」**而窗口不存在**。
 *
 * **本轮有意不修**（2026-11-12，裁决：用户很急，该窗口期 ≤90 秒且会自愈）：
 * - 兜底要么需要探测"窗口是不是真的还在"（普通实例**看不到**无痕分区窗口，
 *   这正是本机制存在的理由 —— 做不到），
 * - 要么需要把 TTL 压到接近心跳间隔（会让 SW 节流误判成"关了"，
 *   反而导致**多开窗口**，比"少开一次"更糟）。
 *
 * ⇒ 能做的只有缩短窗口期与如实记录。若将来要修，方向是让**心跳写入方**
 * 在 `visibilitychange`/`pagehide` 里也清一次（覆盖面更广但仍盖不住硬杀），
 * 或改成"写入方读-改-写带序号，读取方要求序号在推进"（复杂，需另立卡）。
 * 用户若在这 90 秒内再点一次扫码，会看到"已开着"的提示而窗口不存在 ——
 * 再点一次（等 TTL 过期后）即可恢复。
 */
export const LOGIN_HEARTBEAT_TTL_MS = 90 * 1000;

/**
 * 扫码窗口写心跳的间隔。与 `LOGIN_HEARTBEAT_TTL_MS` 配套：
 * TTL 必须显著大于间隔，否则正常节流就会导致误判。
 */
export const LOGIN_HEARTBEAT_INTERVAL_MS = 15 * 1000;

export interface LoginHeartbeat {
  at: number;
  /** 写心跳的实例标识，出问题时能看出是哪个分区写的 */
  instance: string;
}

/**
 * 由**扫码窗口页面**（`entrypoints/login-window/main.tsx`）周期调用。
 *
 * ## 为什么写 `chrome.storage.local` 而不是 `session`
 *
 * `incognito: "split"` 下无痕分区有**独立**的 `storage.session`，
 * 但也**有独立的 SW 实例** —— 两个 SW 的内存互不可见。要跨分区传递，
 * 只有 `storage.local` 是共享的（`login-handshake.ts` 文件头已记录这条，
 * 且真机存储里 `pluma:login-ready` 的记录证实了共享写入）。
 */
export async function writeLoginHeartbeat(instance: string): Promise<void> {
  const beat: LoginHeartbeat = { at: Date.now(), instance };
  await chrome.storage.local.set({ [LOGIN_HEARTBEAT_KEY]: beat }).catch(() => {});
}

/** 清除心跳（窗口正常关闭时调用，缩短"关了却还以为开着"的窗口期） */
export async function clearLoginHeartbeat(): Promise<void> {
  await chrome.storage.local.remove(LOGIN_HEARTBEAT_KEY).catch(() => {});
}

/**
 * 读心跳。**过期的视为不存在** —— 这是整个探测机制的正确性前提：
 * 没有过期，用户关掉窗口后本实例会永远认为"还开着"，再点扫码永远没有反应。
 */
export async function readLoginHeartbeat(): Promise<LoginHeartbeat | null> {
  const bag = await chrome.storage.local
    .get(LOGIN_HEARTBEAT_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const beat = bag[LOGIN_HEARTBEAT_KEY] as LoginHeartbeat | undefined;
  if (!beat || typeof beat.at !== 'number') return null;
  const age = Date.now() - beat.at;
  if (age < 0 || age > LOGIN_HEARTBEAT_TTL_MS) return null;
  return beat;
}

/**
 * 当前 SW 属于哪个分区。
 *
 * `true` = 无痕分区实例，`false` = 普通实例。
 *
 * ⚠️ **本机未真机验证**（2026-11-12 task-24：卡里禁止 reload 扩展 / 碰用户浏览器）。
 * 依据是 Chrome 官方文档中 `chrome.extension.inIncognitoContext` 的语义
 * （"extension 运行在无痕上下文时为 true"）。**这是假设，不是实测结论。**
 *
 * **真机验证方法**：打开扫码窗口后再点一次扫码登录，看诊断日志里
 * `probe/instance` 那条 —— 一次点击应产生**两条**（普通实例 `incognito=false`、
 * 无痕实例 `incognito=true`）。若两条都是 `false`，说明这个 API 在 MV3 SW 里
 * 不可用，探测分流退化（见下面 `probeExistingLoginWindow` 的兜底说明）。
 *
 * ⚠️ 读不到就当**普通实例**（`false`）。理由：普通实例是"探测 + 建窗"的那一侧，
 * 判错的后果是"多重开一个窗口"；反过来判错会导致该建的窗口不建。
 */
function isIncognitoInstance(): boolean {
  try {
    return chrome.extension.inIncognitoContext === true;
  } catch {
    return false;
  }
}

/**
 * 主动探测"是不是已经有一个扫码窗口开着"。
 *
 * ## 为什么必须有这一层
 *
 * `openLoginWindow()` 原来判断"已开着"的唯一依据是 `currentWindowId`，
 * 而它在 split 模式下**永远拿不到**（`create()` 返回 `undefined`，走 `assumed`）。
 * ⇒ 用户第二次点扫码，既不开新窗也不给提示，**视觉上什么都没发生**。
 *
 * ## ⚠️ 只在普通实例探测（这是本方案的安全闸）
 *
 * split 下**两个实例都会收到 `action.onClicked`**（`login-handshake.ts` 文件头）。
 * 如果无痕实例也去探测，它会读到自己写的心跳 → 返回 `already-open` →
 * **永远不创建窗口**。⇒ 首次点击就再也开不出扫码窗口，功能彻底坏掉。
 *
 * 所以：**无痕实例跳过探测，照旧 `create()`**。
 *
 * ## 保守兜底
 *
 * `isIncognitoInstance()` 判错时最坏是"多开一个窗口"或"少开一次"，
 * **不会**卡死建不出窗口 —— 因为普通实例探测不到心跳时照样往下走 `create()`。
 *
 * @returns 探测到活着的窗口时返回心跳，否则 `null`
 */
export async function probeExistingLoginWindow(): Promise<LoginHeartbeat | null> {
  const incognito = isIncognitoInstance();
  await diag('probe/instance', `incognito=${incognito}`);

  if (incognito) {
    await diag('probe/skip', '本实例在无痕分区，不探测（探测会让它自己不建窗）');
    return null;
  }

  const beat = await readLoginHeartbeat();
  await diag(
    'probe/heartbeat',
    beat === null
      ? 'none（没有活着的扫码窗口心跳）'
      : `alive age=${Date.now() - beat.at}ms instance=${beat.instance}`,
  );
  return beat;
}

/**
 * 打开登录窗口（InPrivate）。
 *
 * ⚠️ **不能只信 `windows.create()` 的返回值**（实测踩过）：
 * 在 split 模式下从普通实例创建无痕窗口，窗口**确实创建出来了**，
 * 但 `create()` 的 Promise 解析成 `undefined`——拿不到 id，也拿不到 incognito 字段。
 *
 * 所以判定"到底有没有开出来"必须靠**间接证据**：
 * 创建前后统计可见窗口数量（本实例能看到的，无痕窗口可能不在其中），
 * 并结合 `chrome.storage.local` 里其他实例的反馈。
 *
 * 这一层的职责就到这里：把"调用结果"如实报上去，由调用方决定怎么解释。
 */
export async function openLoginWindow(): Promise<OpenLoginResult> {
  if (currentWindowId !== null) {
    try {
      await chrome.windows.update(currentWindowId, { focused: true });
      await diag('focus-existing', String(currentWindowId));
      return { ok: true, reason: 'already-open' };
    } catch {
      currentWindowId = null;
    }
  }

  /**
   * ## 权限闸门：读到 `false` 就**不建无痕窗**（2026-11-15，task-46 —— 口径反转）
   *
   * ### 历史：2026-11-12（task-32）曾判定「这个读数不可靠，只能记日志不能裁决」
   *
   * 当时的依据是 diag 里 22 次读取**跨实例**的统计：`true` 10 / `false` 12、
   * 时间序翻转 15 次、来自 21 个不同 SW 实例，而 Edge 侧权限看起来是开着的。
   * 于是结论是「拿它当闸门 = 读到 false 就永不建窗」，改成**先试再判**。
   *
   * ### 那个前提被推翻了（2026-11-15，task-43 / task-46 真机复核）
   *
   * 把统计**按 SW 实例分组**之后，翻转消失了：同一实例
   * `wo1xrs` 连续 90 条 `isAllowedIncognitoAccess=false`、90 条
   * `probe/instance incognito=false`，**一条 true 都没有**。
   * 用户本人也确认「在 InPrivate 中允许」**当时是关的**。
   *
   * ⇒ 原来那份「翻转」统计混了两个不同的事实：**权限真的没开** +
   * 不同实例的读数被当成同一实例的时间序列。读数本身没有抖动。
   *
   * ### 不拦的代价（这就是本卡要修的东西）
   *
   * 权限关着仍然 `create({incognito:true, url:'chrome-extension://…/login-window.html'})`
   * ⇒ 无痕分区里**不存在这个扩展** ⇒ 窗口里那个 URL 无主体可加载 ⇒
   * 渲染成 `ERR_BLOCKED_BY_CLIENT`（用户截图）⇒ 用户看到一张废页，
   * 而 `create()` 跨分区必然返回 `undefined`，最后落进 `assumed` 把结果报成成功。
   *
   * ### 所以现在：`false` 直接返回，**在 `create()` 之前**
   *
   * 调用方（`entrypoints/background.ts`）的 `incognito-disabled` 分支会弹
   * 460×420 的说明页 —— 那条链路一直是好的，只是以前永远走不到。
   *
   * ⚠️ 这个分支**只拦 `create`**，不动别的：`create()` 抛 `/incognito|invalid/i`
   * 的分支仍保留（读数和真实状态仍有可能不一致，两道闸互为兜底）。
   */
  const allowed = await isIncognitoAllowed();
  await diag('isAllowedIncognitoAccess', String(allowed));
  if (!allowed) {
    await diag('权限读到 false → 不建无痕窗，直接报 incognito-disabled');
    return { ok: false, reason: 'incognito-disabled' };
  }

  /**
   * ## 主动探测已开着的扫码窗口（2026-11-12，task-24 方案 A）
   *
   * 放在 `currentWindowId` 检查**之后**、`create()` **之前**：
   * - 在这个实例里自己建过窗（拿到了 id）→ 上面的分支已经处理了，这里不必再探
   * - 走不到上面的分支（split 常态）→ 只能靠心跳判断"另一个分区里是不是还开着"
   *
   * 探测到就**不开新窗**，直接报 `already-open` —— 这正是「第二次点没反应」的修复。
   */
  const beat = await probeExistingLoginWindow();
  if (beat !== null) {
    await diag('probe/already-open', `age=${Date.now() - beat.at}ms`);
    return { ok: true, reason: 'already-open' };
  }

  const before = await chrome.windows
    .getAll()
    .then((ws) => ws.length)
    .catch(() => -1);

  let created: chrome.windows.Window | undefined;
  try {
    created = await chrome.windows.create({
      url: chrome.runtime.getURL(LOGIN_URL),
      type: 'popup',
      incognito: true,
      width: LOGIN_WINDOW.width,
      height: LOGIN_WINDOW.height,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await diag('windows.create THREW', msg.slice(0, 120));
    return { ok: false, reason: /incognito|invalid/i.test(msg) ? 'incognito-disabled' : 'unknown' };
  }

  // 给浏览器一点时间让窗口真正出现
  await new Promise((r) => setTimeout(r, 400));
  const after = await chrome.windows
    .getAll()
    .then((ws) => ws.length)
    .catch(() => -1);

  // 再查一次：本分区能不能看到 login-window 的标签（能看到就说明窗口真在我们这个分区里）
  const visibleTabs = await chrome.tabs
    .query({})
    .then((ts) => ts.filter((t) => (t.url ?? '').includes('login-window')).length)
    .catch(() => -1);

  await diag(
    'windows.create returned',
    `id=${String(created?.id)} incognito=${String(created?.incognito)} ` +
      `windowsBefore=${before} windowsAfter=${after} loginTabs=${visibleTabs}`,
  );

  // 情况 1：拿到了窗口对象
  if (created?.id != null) {
    if (created.incognito === true) {
      currentWindowId = created.id;
      return { ok: true };
    }
    // 建成了但不是无痕 → 危险，关掉
    await chrome.windows.remove(created.id).catch(() => {});
    return { ok: false, reason: 'incognito-disabled' };
  }

  // 情况 2：返回 undefined，但窗口数量增加了 → 窗口其实建出来了
  if (before >= 0 && after > before) {
    await diag('窗口数增加但 create 返回 undefined', `${before} → ${after}`);
    return { ok: true };
  }

  /**
   * ## 情况 3：兜底分支 —— **在本机是常态而非例外**（2026-11-12，task-12 实测）
   *
   * ### 实测统计（`diag('windows.create returned')` 真机样本，跨两天 4 次调用）
   *
   * | 指标 | 实测值 |
   * | --- | --- |
   * | `reason:'assumed'` | **4 次 / 4 次成功路径调用 = 100%** |
   * | `create()` 返回 `id != null` | **0 次** |
   * | `windowsAfter > windowsBefore` | **0 次** |
   * | `loginTabs` | **每一次都是 0** |
   *
   * 每一轮的日志形状都一样：
   * ```
   * windows.create returned id=undefined incognito=undefined
   *                        windowsBefore=3 windowsAfter=3 loginTabs=0
   * login/open            {"ok":true,"reason":"assumed"}
   * ```
   *
   * ### 为什么它会 100% 命中（不是时序问题，是结构问题）
   *
   * 见本文件头第 14-16 行那两条铁律：**分区隔离是双向的**，
   * 普通实例创建无痕窗口后**自己也看不到它**。所以从普通实例发起时：
   *   - `create()` 拿不到窗口对象（无痕窗口属于另一个分区）
   *   - `getAll()` 数不到它 → `windowsAfter === windowsBefore`
   *   - `tabs.query()` 查不到它 → `loginTabs === 0`
   *
   * 三条观测通道**同时失效**，这不是"等一会儿就好"，是跨分区不可见。
   *
   * ### ⚠️ 所以"重试 `create()`"救不了它（2026-11-12，本轮评估后否决）
   *
   * 曾在任务卡里考虑过方案 A（一次 `undefined` 就再试一次）。**否决**，理由：
   *   1. 重试仍从**同一个普通实例**发起 → 按定义还是 `undefined`
   *   2. `create()` 每次调用都会**真的新建一个窗口** —— 若第一次其实成功了，
   *      重试会开出**第二个**无痕窗口（用户看到两个二维码）
   *   3. 无法用"窗口数是否增加"判断第一次成没成（那正是失效的通道）
   *
   * ### 同理 `chrome.tabs.query` 轮询确认也不可行
   * `loginTabs` 恒为 0（4/4 次）—— 目标标签页**永远**在本分区查不到。
   *
   * ### 那么这条路还剩什么保障
   *
   * 1. **`isAllowedIncognitoAccess()` 为真**时才走到这里 —— 权限确定没问题
   *    （2026-11-15 起这道闸是**真闸**，读到 false 在 `create()` 之前就返回了）
   * 2. 真开了窗口时，**无痕实例**会走情况 1/2（它自己的 `create()` 能成功）
   *    并写 `login-ready`；`need-incognito` 页靠 storage 握手看到它
   * 3. 本实例写 `login-ready` 的作用是**抑制另一实例误弹说明页**
   *    （见 `login-handshake.ts` 的双向握手）
   *
   * ### ⚠️ 已知限制（诚实记录，不要当成已解决）
   *
   * **走到这里时，我们无法确认窗口真的开出来了。**
   *
   * > 📌 2026-11-15（task-46）**口径已改**：这里返回的 `ok: true` 仍然表示
   * > `create()` 没抛错，但**调用方不再把它当成"窗口已打开"**。
   * > `handleLoginOpen()` 对 `assumed` 返回 `opened: false` + 独立字段
   * > `confirmed: false`，面板据此显示「没能确认窗口打开」而不是「已打开」。
   * > 详见 `entrypoints/background.ts` 的 `handleLoginOpen()`。
   *
   * 也就是说：这一层「尽力了、没抛错」，**是否真的开了由调用方按 `confirmed`
   * 分流**，不再靠这一段文字给 `ok:true` 洗白。
   *
   * **将来若要真正解决**，需要一条**跨分区可观测**的信号（例如无痕实例在
   * `login-window.html` 里写一个带实例标识的 storage 键，本实例轮询它）。
   * 那要新增 storage 键与握手协议，超出本卡范围。
   *
   * > 📌 2026-11-12 task-24 已实现上面这条：「将来入口」就是本文件的
   * > `probeExistingLoginWindow()` + `pluma:login-window-alive` 心跳。
   * > 但**它只解决"第二次点没反应"**，没有改变本条判定 —— 第一次点击时
   * > 没有心跳可读，仍然走到这里、仍然报 `assumed`。所以这段文字继续有效。
   *
   * > 📌 2026-11-15 task-45 取证：那个心跳键 **从来没有被写入过**
   * > （`poc/probe/heartbeat-check/verify-heartbeat-key.cjs`，带三个对照组）。
   * > 不是跨分区读不到，是扫码窗口里写心跳的那个 `useEffect` 没跑到。
   * > ⇒ 本条的「第二次点击靠心跳判已开」**今天并未生效**，别再假设它在工作。
   */
  await diag('create 返回 undefined 且窗口数未变，交给握手判定');

  return { ok: true, reason: 'assumed' };
}

/** 登录成功后关闭窗口，让 cookie 随分区销毁 */
export async function closeLoginWindow(): Promise<void> {
  // 心跳先清：即使本实例拿不到窗口 id（split 常态），也要让另一个分区
  // 尽快知道"窗口没了"，而不是等 90 秒 TTL 自然过期。
  await clearLoginHeartbeat();
  if (currentWindowId === null) return;
  await chrome.windows.remove(currentWindowId).catch(() => {});
  currentWindowId = null;
}

/** 窗口被用户手动关闭时清理本实例状态 */
export function forgetLoginWindow(): void {
  currentWindowId = null;
}

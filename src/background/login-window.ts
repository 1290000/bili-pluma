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

/**
 * **正在进行的**一次"打开扫码窗口"。
 *
 * `null` = 当前没有进行中的调用。并发调用复用同一个 Promise（见
 * `openLoginWindow()`）。**它不是时间窗口**：一返回就释放，
 * 所以"关窗后立刻再点"永远能进（验收标准 1）。
 */
let inflight: Promise<OpenLoginResult> | null = null;

export interface OpenLoginResult {
  ok: boolean;
  /**
   * - `incognito-disabled`：确定没权限（`isAllowedIncognitoAccess` 为 false）
   * - `already-open`：**扫码窗口刚刚回答了存活探测**（跨分区 ping/pong，
   *   见 `probeExistingLoginWindow()`）⇒ 窗口确实还开着。
   *
   *   ⚠️ 2026-11-15（task-47）之前它不是这个含义：那时只要
   *   `chrome.storage.local` 里有一条 90 秒内的心跳就报 `already-open`，
   *   而心跳的写入方是**页面**，窗口关闭时页面被直接销毁、清理跑不掉 ⇒
   *   一条冻结的旧心跳在 90 秒内会把「没有窗口」谎报成「窗口已开着」，
   *   用户点了没反应（真机日志：连续 14 次 `already-open`，屏幕上 0 个扫码窗）。
   *   现在**只认页面当场应答**，不再认时间戳。
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
// 扫码窗口心跳 + 存活应答（2026-11-12 task-24 起，2026-11-15 task-47 改造）
// ---------------------------------------------------------------------------
//
// ## 两层信号，职责完全不同（**别再把它们混成一层**）
//
// | 层 | 谁写 | 回答的问题 | 可信度 |
// | --- | --- | --- | --- |
// | **心跳**（`LOGIN_HEARTBEAT_KEY`） | 页面 `setInterval` | "最近有没有过扫码窗" | **只是线索**，可能冻结 |
// | **存活应答**（ping/pong） | 页面收到 ping 当场回 pong | "**此刻**那个页面还在跑 JS 吗" | **裁决依据** |
//
// ### 为什么必须两层（真机定位，不是推理）
//
// 2026-11-15 诊断日志（同一实例 `8ai3j9`，21:50 前后连续 14 次点击）：
//
// ```
// 20:50:52.633  probe/heartbeat  alive age=49080ms instance=mwhu0yw0-qn8mwt
// 20:50:52.634  probe/already-open  age=49082ms
// 20:50:52.636  login/open  {"ok":true,"reason":"already-open"}
// ...（到 20:51:05，age 涨到 62190ms，14 次全部 already-open）
// ```
//
// 当时整机**只有一个 Edge 主窗口，没有任何扫码窗**。根因是心跳的清理写在
// 页面 `useEffect` 的 cleanup 里，而**关窗时文档被直接销毁、React 根本不会
// 卸载组件** ⇒ cleanup 不跑 ⇒ 心跳停在最后一次写入 ⇒ 90 秒内所有点击都读到
// "活着" ⇒ 既不建窗也不提示。这就是「有概率弹不出二维码」：
// **距最后一条心跳 90 秒内必失败，超过 90 秒就能开**。
//
// ⇒ 结论：把「时间戳还新」当成「窗口还活着」是错的判据。时间戳只能说明
// "曾经有过窗口"，**证明不了此刻**。而 `chrome.storage` 的 `onChanged`
// 事件是**浏览器投递的事件，不是定时器**，不受后台节流影响 ⇒
// 一个活着的页面一定能当场应答。这就是 ping/pong 的依据。
//
// ### ⚠️⚠️ 「心跳每 15 秒会刷新」**至今没有证实** —— 判据不许依赖它
//
// 2026-11-15 真机采样（Lead 提供，LevelDB 直读）：
//
// ```
// 20:55:19  writes=2  age=23.5s      20:55:35  writes=2  age=39.6s
// 20:55:27  writes=2  age=31.6s      20:55:43  writes=2  age=47.6s
//                                    20:55:51  writes=2  age=55.6s
// ```
//
// 整个存储里**只有两次**心跳写入（20:50:03 / 20:54:56），age 在 32 秒内单调增长、
// **没有任何新写入**。采样时段扫码窗是否还开着未确证（同一时刻 `tasklist /v`
// 只看到主窗口有标题）⇒ **不能据此断定周期写坏了，但也绝不能假定它会刷新**。
//
// ⇒ 由此得到一条硬约束，改判据前先读：
//
// 1. **不许**把"活着"的阈值调小（`age` 足够小）—— 那是在赌周期刷新会准时发生；
// 2. **也不许**升级成"写入序号在推进" —— 同一个未证实前提，只是换了写法；
// 3. **只许**用**正向证据**：问一句，页面当场答。答话不依赖任何定时器。
//
// 判据对"周期刷新坏了"是**免疫**的：它读到的唯一一条记录是**页面挂载时写的那次**
// （有证据 —— 两次开窗恰好两条记录），之后即使 `setInterval` 一次都不触发，
// 只要页面还活着 pong 就会来。反过来，页面文件里那句"必须周期写"的注释
// 只是**保底线索**，不是正确性前提；源码级断言也证明不了定时器真的会跑。

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
 * 心跳新鲜度阈值。**⚠️ 它不是"活着"的判据**（那是 pong 的活），
 * 只用在两处：诊断日志里标注这条记录新不新，以及"从来没有过扫码窗"的快速判空。
 *
 * ## 为什么保持 90 秒、**不缩**
 *
 * 缩 TTL 是这条 bug 最诱人的假修法，代价却更大：
 * * 1. **一个活着的页面也可能 60 秒不写心跳**。窗口被别的窗口完全遮住时，
 *    Chromium 的遮挡检测会把页面判成 hidden，进入 intensive throttling
 *    （隐藏 5 分钟后定时器被压到**每分钟最多唤醒一次**）。心跳间隔 15 秒，
 *    最坏间隔约 60 秒 ⇒ TTL 若压到 20~30 秒，**开着的窗口会被判成"关了"**。
 *    更糟的是：**"周期写会准时发生"这件事本身还没被证实**（见文件头那段采样），
 *    所以任何形如"age 足够小 ⇒ 活着"的判据都是在赌一个未证实的前提。
 * 2. 判成"关了"的后果是**再建一个窗口** ⇒ 用户看到两个二维码。
 *    本项目已明确裁决过：**多开窗口比少开一次更糟**（`openLoginWindow()`
 *    情况 3 的注释里论证过「不许重试 create」同理）。
 * 3. 90 秒 = 15 秒 × 6，对 60 秒的节流上界留了 1.5 倍余量。
 *
 * ⇒ 正确做法不是把 TTL 缩到能覆盖"关窗"（那做不到，关窗是事件不是时长），
 * 而是**另外拿一条不受节流影响的信号来裁决**（见下面的 ping/pong）。
 */
export const LOGIN_HEARTBEAT_TTL_MS = 90 * 1000;

/**
 * 扫码窗口写心跳的间隔。与 `LOGIN_HEARTBEAT_TTL_MS` 配套：
 * TTL 必须显著大于间隔，否则正常节流就会导致误判。
 */
export const LOGIN_HEARTBEAT_INTERVAL_MS = 15 * 1000;

/** 普通实例发存活探测（ping）用的键 */
export const LOGIN_PING_KEY = 'pluma:login-window-ping';
/** 扫码窗口应答存活探测（pong）用的键 */
export const LOGIN_PONG_KEY = 'pluma:login-window-pong';

/**
 * 等 pong 的上限。超时就判「页面不在」。
 *
 * ## 依据：一条真机实测（**单次观测，不是上界**）
 *
 * ```
 * 21:12:48.016  probe/heartbeat  record age=2276ms …
 * 21:12:48.136  ping/pong  nonce=mwhuu7pu-9zi4nz pongNonce=mwhuu7pu-9zi4nz
 * ```
 *
 * ⇒ 从写 ping 到读到 pong 约 **120ms**，其中 100ms 是轮询步长
 * （`LOGIN_PING_POLL_MS`），真正的跨分区往返只有 ~20ms 量级。
 *
 * ⚠️ 这**一个样本**，不是"毫秒量级"的证明，也不构成上界：
 * 页面被节流 / 机器繁忙时可能更慢。所以超时取 600ms（≈ 实测的 5 倍），
 * 既给抖动留余量，又短到用户察觉不到（点在按钮上不会觉得卡）。
 *
 * ⚠️ 曾在这里引用「`login-handshake.ts` 的双向握手在 **8 秒**窗口内完成」
 * 来论证"毫秒量级" —— 那个引用差 13 倍，是**推断不是实测**，已删除。
 */
export const LOGIN_PING_TIMEOUT_MS = 600;

/** 等 pong 时的轮询步长。600 / 100 = 最多 6 次 `storage.local.get` */
const LOGIN_PING_POLL_MS = 100;

export interface LoginHeartbeat {
  at: number;
  /** 写心跳的实例标识，出问题时能看出是哪个分区写的 */
  instance: string;
}

/** ping 载荷。`at` 用于让读方判断"这次 pong 是不是在我发问之后写的" */
export interface LoginPing {
  nonce: string;
  at: number;
}

/** pong 载荷 */
export interface LoginPong {
  nonce: string;
  at: number;
}

/**
 * 校验一个 `storage.onChanged` 的 `newValue` 是不是合法 ping。
 *
 * 页面侧用它过滤脏数据（扩展升级 / 别处写坏），**读不懂就当没收到**。
 * 抽成纯函数是为了能单测：脏数据在真机上表现为"偶尔弹不出二维码"，
 * 只有把判据单独钉住才排查得动。
 */
export function parseLoginPing(value: unknown): LoginPing | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { nonce?: unknown; at?: unknown };
  if (typeof v.nonce !== 'string' || v.nonce.length === 0) return null;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
  return { nonce: v.nonce, at: v.at };
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
 *
 * ⚠️ 心跳**只是线索**：它证明"曾经有过一个扫码窗"，**证明不了此刻**。
 * 裁决用 `requestLoginWindowPong()`。
 */
export async function writeLoginHeartbeat(instance: string): Promise<void> {
  const beat: LoginHeartbeat = { at: Date.now(), instance };
  await chrome.storage.local.set({ [LOGIN_HEARTBEAT_KEY]: beat }).catch(() => {});
}

/**
 * 清除心跳（关窗 / 登录成功关窗时调用）。
 *
 * ⚠️ **它是"尽力而为"，不是"关窗一定被感知"**：
 * `chrome.storage.local.remove` 是异步 IPC，页面正在销毁时可能来不及完成。
 * 所以关窗的正确性**不许**建立在这一句上 —— 真正的裁决是 pong
 * （见 `probeExistingLoginWindow()`）。这一句的作用是让下一次点击
 * **少付 600ms 的探测时间**，并让存储里不留垃圾。
 */
export async function clearLoginHeartbeat(): Promise<void> {
  await chrome.storage.local.remove(LOGIN_HEARTBEAT_KEY).catch(() => {});
}

/**
 * 读心跳记录（**不套 TTL**）。
 *
 * 判据只有一条：形状对不对。时间戳是否过期**由调用方决定** ——
 * `probeExistingLoginWindow()` 即使读到过期记录也会再试一次 pong，
 * 因为"过期"可能只是被节流了，而节流过的窗口**确实还开着**。
 */
export async function readLoginHeartbeatRecord(): Promise<LoginHeartbeat | null> {
  const bag = await chrome.storage.local
    .get(LOGIN_HEARTBEAT_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const beat = bag[LOGIN_HEARTBEAT_KEY] as LoginHeartbeat | undefined;
  if (!beat || typeof beat.at !== 'number' || !Number.isFinite(beat.at)) return null;
  return { at: beat.at, instance: typeof beat.instance === 'string' ? beat.instance : '' };
}

/**
 * 形如"是否新鲜"的纯判据（可单测，不碰 `chrome`）。
 *
 * 时钟回拨（`at` 在未来）也判不新鲜：那种记录只会让 TTL 永远不过期。
 */
export function isHeartbeatFresh(beat: LoginHeartbeat | null, now: number = Date.now()): boolean {
  if (beat === null) return false;
  const age = now - beat.at;
  return age >= 0 && age <= LOGIN_HEARTBEAT_TTL_MS;
}

/**
 * 读心跳，**过期的视为不存在**。
 *
 * ⚠️ 2026-11-15（task-47）起，**生产路径不再用它的返回值做裁决**：
 * `probeExistingLoginWindow()` 改用 `readLoginHeartbeatRecord()` + pong。
 * 保留这个函数是因为"TTL 语义"仍有唯一实现处，且
 * `tests/unit/background/login-heartbeat-probe.test.ts` 直接钉住它 ——
 * 删掉等于让"新鲜度"这条判据失去看守。
 */
export async function readLoginHeartbeat(): Promise<LoginHeartbeat | null> {
  const beat = await readLoginHeartbeatRecord();
  return isHeartbeatFresh(beat) ? beat : null;
}

/**
 * 由**扫码窗口页面**在收到 ping 后立即调用。
 *
 * 这一句就是"我还活着"的全部含义：它不是定时器，而是对浏览器投递事件的
 * 直接响应 ⇒ **不受后台节流影响**，也不会因为"组件没卸载"而假活。
 */
export async function writeLoginPong(nonce: string): Promise<void> {
  const pong: LoginPong = { nonce, at: Date.now() };
  await chrome.storage.local.set({ [LOGIN_PONG_KEY]: pong }).catch(() => {});
}

/** 读 pong（形状不对当没有） */
export async function readLoginPong(): Promise<LoginPong | null> {
  const bag = await chrome.storage.local
    .get(LOGIN_PONG_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const pong = bag[LOGIN_PONG_KEY] as LoginPong | undefined;
  if (!pong || typeof pong.at !== 'number' || !Number.isFinite(pong.at)) return null;
  return { nonce: typeof pong.nonce === 'string' ? pong.nonce : '', at: pong.at };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 发一次存活探测，问"扫码窗口还在不在"。
 *
 * ## 判据是 `pong.at >= ping.at`，**不是** `nonce` 相等
 *
 * `nonce` 相等在并发下会误判：两次点击几乎同时发 ping A(t1) / B(t2)，
 * 页面先回 A 再回 B ⇒ pong 被覆盖成 B 的 ⇒ 读方 A 等不到自己的 nonce，
 * 判"页面不在" ⇒ **又开一个窗口**（正是要消灭的那个副作用）。
 *
 * `pong.at >= ping.at` 表达的是"**我问完之后它还写过字**"，对并发安全：
 * 两个 pong 都晚于两个 ping，谁读到都成立。而**上一次点击留下的旧 pong**
 * 一定早于这次的 ping ⇒ 不会被误认成应答。
 *
 * `nonce` 保留在载荷里只用于诊断日志。
 *
 * ## 🟢 地基已验证（真机，2026-11-15）：`storage.onChanged` **确实跨分区投递**
 *
 * 这一段曾经是**未验证假设**（"普通实例写的 ping，无痕分区的页面能不能收到？"）。
 * 现在是实测结论 —— 判据是同一时段三条日志来自**两个不同主体**：
 *
 * ```
 * probe/instance   incognito=false  (from=aktf4x)         ← 发 ping 的是**普通实例**
 * probe/heartbeat  record instance=mwhuu5yj-o6ik9y       ← 写心跳/回 pong 的是**另一个实例**（无痕分区的页面）
 * ping/pong        nonce=mwhuu7pu-9zi4nz pongNonce=mwhuu7pu-9zi4nz   ← ping 与 pong 的 nonce 完全一致
 * ```
 *
 * ⇒ 普通实例写的 ping **确实被无痕分区页面收到并回写了 pong**。
 * **别再怀疑这条地基**（下一个人若要重开这个疑问，先解释上面三条如何可能同时成立）。
 *
 * ⚠️ 反过来说：pong 侧的 `onChanged` 响应（`main.tsx` 的第二个 effect）
 * 若是坏的，这条链路也会断 —— 但真机的 nonce 双边一致已经排除了那种可能。
 *
 * @returns `true` = 页面当场应答（窗口确实还开着）
 */
export async function requestLoginWindowPong(): Promise<boolean> {
  const ping: LoginPing = {
    nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  };
  const wrote = await chrome.storage.local
    .set({ [LOGIN_PING_KEY]: ping })
    .then(() => true)
    .catch(() => false);
  /** 写不进去 = 问不出去。**不许乐观当活着**（那会把"点了没反应"又请回来） */
  if (!wrote) {
    await diag('ping/write-failed', '写 ping 失败，按"页面不在"处理');
    return false;
  }

  /**
   * ## 先读一次再进轮询（QA 建议，2026-11-15）
   *
   * `set()` 是异步 IPC：pong 有可能在我们 `await` 返回**之前**就已经落库
   * （活窗口的往返只有 ~20ms）。旧写法先 `sleep(100)` 再读 ⇒ 活窗口也要白等
   * 整整一个轮询步长。先读一次没有代价（一次 `storage.get`），
   * 命中就立刻返回。
   */
  const immediate = await readLoginPong();
  if (immediate !== null && immediate.at >= ping.at) {
    await diag('ping/pong', `nonce=${ping.nonce} pongNonce=${immediate.nonce}（首读命中）`);
    return true;
  }

  const deadline = Date.now() + LOGIN_PING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(LOGIN_PING_POLL_MS);
    const pong = await readLoginPong();
    if (pong !== null && pong.at >= ping.at) {
      await diag('ping/pong', `nonce=${ping.nonce} pongNonce=${pong.nonce}`);
      return true;
    }
  }
  return false;
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
 * split 下**两个实例都会收到 `action.always` 之外的事件**（`login-handshake.ts`
 * 文件头）。如果无痕实例也去探测，它会读到**自己的页面**应答的 pong →
 * 返回 `already-open` → **永远不创建窗口**。⇒ 首次点击就再也开不出扫码窗口。
 *
 * 所以：**无痕实例跳过探测，照旧 `create()`**。这条闸**不许动**。
 *
 * ## 判据（2026-11-15，task-47 —— 本次修复的核心）
 *
 * ```
 * 没有心跳记录            → 从没开过窗口，直接返回 null（不付 ping 的延迟）
 * 有记录（新鲜或过期）    → 发 ping，等页面当场回 pong
 *     有 pong             → 窗口确实还开着 → 返回心跳（调用方报 already-open）
 *     没有 pong           → 页面不在了 → 清掉残留心跳 → 返回 null（调用方去建窗）
 * ```
 *
 * ### 为什么"过期也照样 ping"（这一条很容易被"顺手优化"掉）
 *
 * 过期不代表窗口关了 —— 见 `LOGIN_HEARTBEAT_TTL_MS` 的注释：完全被遮住的窗口
 * 会被节流到每分钟一次心跳，一个**活着的**窗口也可能留下 >90s 的旧记录。
 * 若因为"过期"就直接建窗，用户会看到**两个二维码**。
 *
 * ### 为什么"有 pong 才判定活着"能覆盖旧 bug
 *
 * 旧 bug 的失败形态是「页面没了，但心跳还在」。pong 只能由**活着的页面**写出
 * （`onChanged` 是浏览器投递的事件，不靠定时器）⇒ 该形态下必然没有 pong
 * ⇒ 必然去建窗。**关窗后立即点击可以开出新窗口**，不再受 90 秒窗口期约束。
 *
 * ### 它不依赖"心跳会周期刷新"（这条前提**至今未证实**）
 *
 * 本函数只把心跳当**两个状态的线索**：`有记录` / `没记录`。
 * 有记录就多问一句 pong，**不比较 age 大小、也不要求序号推进**。
 * 那条记录本身来自**页面挂载时的第一次写**（真机证据：两次开窗 = 两条记录），
 * 与 `setInterval` 有没有按时触发无关 ⇒ 即使周期刷新完全不工作，
 * 只要窗口还开着 pong 就会来，判定仍然正确。
 * 详见文件头那段 LevelDB 采样与随之而来的三条硬约束。
 *
 * ### 盖不住的情况（如实记录，不要当成已解决）
 *
 * 1. **无痕分区整个不可用**（权限被关）→ 走上面的权限闸，与本函数无关。
 * 2. **`inIncognitoContext` 读数不可靠**：它是本方案的前提假设（见其注释）。
 * 3. **pong 键被别的上下文写脏**：读方只认 `pong.at >= ping.at`，
 *    伪造需要同机同时刻写入 —— 不构成实际风险。
 * 4. **两个窗口同时开着**时 pong 只能证明"有一个活着"，无法区分是谁。
 *    但那种局面本身是上游产生的，本函数不负责收敛。
 *
 * ## 保守兜底
 *
 * `isIncognitoInstance()` 判错时最坏是"多开一个窗口"或"少开一次"，
 * **不会**卡死建不出窗口 —— 因为探测返回 `null` 时照样往下走 `create()`。
 *
 * @returns 探测到**当场应答**的窗口时返回心跳，否则 `null`
 */
export async function probeExistingLoginWindow(): Promise<LoginHeartbeat | null> {
  const incognito = isIncognitoInstance();
  await diag('probe/instance', `incognito=${incognito}`);

  if (incognito) {
    await diag('probe/skip', '本实例在无痕分区，不探测（探测会让它自己不建窗）');
    return null;
  }

  /**
   * 两次读：先读"TTL 内的"（绝大多数情况一次命中，省一次 `storage.get`），
   * 读不到再读"不套 TTL 的原始记录"。
   *
   * ⚠️ **为什么不能只用前者**：过期不代表窗口关了（可能只是被节流）。
   * 只用前者 ⇒ 对**活着的**窗口建第二个窗 ⇒ 两个二维码。
   */
  const fresh = await readLoginHeartbeat();
  const beat = fresh ?? (await readLoginHeartbeatRecord());
  if (beat === null) {
    await diag('probe/heartbeat', 'none（没有心跳记录 = 从没开过扫码窗口）');
    return null;
  }

  const age = Date.now() - beat.at;
  await diag(
    'probe/heartbeat',
    `record age=${age}ms withinTtl=${String(fresh !== null)} instance=${beat.instance}`,
  );

  /**
   * ⚠️ **这一句就是本次修复的判据**：把"时间戳还新"换成"页面当场应答"。
   *
   * 反向验证：把它改成 `return beat;`（即退回旧的"读时间戳就算活着"）⇒
   * `tests/unit/background/login-heartbeat-probe.test.ts` 里
   * 「★★★ 冻结的旧心跳 + 页面已关 ⇒ 必须建新窗」与
   * 「★★★ 硬杀后的残留心跳 ⇒ 必须建新窗」两条变红。
   */
  const alive = await requestLoginWindowPong();
  if (!alive) {
    await diag('probe/no-pong', `age=${age}ms → 页面没应答，判窗口已关，清掉残留心跳`);
    /**
     * 顺手清掉残留记录：下一次点击就不必再等 600ms 的 ping 超时。
     * 清不掉也无所谓 —— 判据是 pong，不是这条记录在不在。
     */
    await clearLoginHeartbeat();
    return null;
  }

  await diag('probe/alive', `age=${age}ms → 窗口应答了，判已开着`);
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
export function openLoginWindow(): Promise<OpenLoginResult> {
  /**
   * ## in-flight 去重：**同一时刻**的并发点击只跑一次（2026-11-15，P0）
   *
   * ### 为什么必须有
   *
   * `entrypoints/background.ts` 的 `login/open` 分支是
   * `handleLoginOpen().then(sendResponse); return true;` —— **完全并发、不排队**。
   * 而 `openLoginWindow()` 内部没有任何去重：`currentWindowId` 在 split 下
   * 恒为 `null`（`create()` 拿不到句柄），探测也要先花 ~120ms。
   *
   * ⇒ QA 用真实 `openLoginWindow()` 探针实测（两次**并发**调用）：
   *
   * | 场景 | `windows.create` 次数 |
   * | --- | --- |
   * | 窗口开着（页面应答） | 0 ✅ |
   * | 关窗后残留心跳（页面不在） | **2** ❌ |
   * | 从没开过窗 | **2** ❌ |
   *
   * **这不是理论风险**：这个用户报 bug 时的原始行为就是连点
   * （真机日志：13 秒内 14 次点击）。旧 build 那些点击被冻结心跳吞掉
   * （所以"没反应"）；新 build 不再吞，同样的连点就会**变成连开窗口**。
   * 我们对外承诺的是"不会多开第二个窗口"，这条不补承诺就是假的。
   *
   * ### 为什么是"复用同一个 Promise"而不是"N 秒内不许再建"
   *
   * 时间窗口会把**"关窗后立刻重试"**一起拦掉 —— 那正是验收标准 1 要的行为，
   * 也是旧 bug 的形态。in-flight 只在**同时进行中**去重：第一个调用一返回
   * （无论成功失败）就释放，下一个点击立刻可进。
   *
   * ⚠️ **`finally` 里必须清空**：`create()` 抛错时若不清，一次失败会把功能
   * **永久卡死**（之后每次点击都拿到那个已 reject 的 Promise）。
   * 反向验证 RV10：删掉 `finally` 里的 `inflight = null` ⇒
   * 「create 抛错之后再点一次仍然能建窗」变红。
   */
  if (inflight !== null) {
    void diag('login/open/inflight', '并发点击 → 复用正在进行的那个 Promise');
    return inflight;
  }
  inflight = openLoginWindowOnce().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * 真正的建窗流程（**只由 `openLoginWindow()` 调用一次**）。
 *
 * 拆出来是为了让 in-flight 去重那一层薄到没有分支 —— 它只做"复用 / 释放"，
 * 不参与任何判定。
 */
async function openLoginWindowOnce(): Promise<OpenLoginResult> {
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
   * - 走不到上面的分支（split 常态）→ 只能靠跨分区的**存活应答**判断
   *   "另一个分区里是不是还开着"
   *
   * 探测到就**不开新窗**，直接报 `already-open` —— 这正是「第二次点没反应」的修复。
   *
   * ⚠️ 2026-11-15（task-47）：`beat` 现在**只可能**来自"页面当场应答了 ping"，
   * 不再是"存储里有条 90 秒内的记录"。所以 `already-open` 有了实证含义，
   * 也所以**关窗后立刻点击会走到下面的 `create()`**。
   */
  const beat = await probeExistingLoginWindow();
  if (beat !== null) {
    await diag('probe/already-open', `age=${Date.now() - beat.at}ms（页面已应答）`);
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
   *
   * > 📌 2026-11-15 task-47 补上了「跨分区可观测」的前半段：现在有
   * > `LOGIN_PING_KEY` / `LOGIN_PONG_KEY` 一对键，扫码窗口会对探测**当场应答**
   * > （`requestLoginWindowPong()`）。**但它仍然没有改变本条判定** ——
   * > 第一次点击时没有任何窗口可以应答，所以仍然走到这里、仍然报 `assumed`。
   * > pong 解决的只有一件事：**"窗口还在不在"终于有了不受节流影响的证据**，
   * > 于是"关窗后 90 秒内点不出来"那条 bug 被关掉。
   * > 「`create()` 到底成没成」依然未知，`assumed` 的口径一个字都没变。
   */
  await diag('create 返回 undefined 且窗口数未变，交给握手判定');

  return { ok: true, reason: 'assumed' };
}

/** 登录成功后关闭窗口，让 cookie 随分区销毁 */
export async function closeLoginWindow(): Promise<void> {
  // 心跳先清：即使本实例拿不到窗口 id（split 常态），也让下一次点击
  // **不必先等 600ms 的 ping 超时**（`probeExistingLoginWindow()` 见无记录就立刻建窗）。
  //
  // ⚠️ 它**不是**正确性的依据：页面 `/login-window.html` 已经被 `close()` 掉时，
  // 清不清得掉心跳都不影响判定 —— 裁决靠 pong，页面没了就没人应答。
  await clearLoginHeartbeat();
  if (currentWindowId === null) return;
  await chrome.windows.remove(currentWindowId).catch(() => {});
  currentWindowId = null;
}

/** 窗口被用户手动关闭时清理本实例状态 */
export function forgetLoginWindow(): void {
  currentWindowId = null;
}

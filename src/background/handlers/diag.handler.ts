/**
 * 诊断环境事实的读取端 —— **必须在 background 里跑**（2026-11-09 真机验收）。
 *
 * ## 为什么不能让面板自己读
 *
 * 面板是 content script，而下面这四个命名空间在 content script 里**整个不存在**
 * （真机实测，不是"权限不足"导致的拒绝调用，是 `undefined`）：
 *
 * ```
 * chrome.extension.isAllowedIncognitoAccess  is not a function
 * chrome.windows               undefined
 * chrome.cookies               undefined
 * chrome.declarativeNetRequest undefined
 * ```
 *
 * 所以面板发 `diag/facts`，由这里代查。
 *
 * ## ⚠️ 每一项独立 try —— 单项失败不影响其他项
 *
 * 这是本文件最重要的结构约束。整体一个 try 的话，`chrome.cookies` 抛错会把
 * 已经读到的 InPrivate 权限也一起丢掉，用户看到的是"全部读取失败" ——
 * 那正是真机验收里那 4 行红字的样子，排查时无法判断到底是哪一项坏了。
 *
 * 单项失败返回 **`null`**，调用方据此产出一条"未知"行（见 `collectFacts()`）。
 *
 * ## ⚠️ DNR 只回 id
 *
 * 整条规则里的 `action.requestHeaders` 是**完整 Cookie 头**。
 * 只挑 `id` 出去，绝不透传整条规则 —— 见 `messages.ts` 里那条注释与
 * `tests/unit/platform/diagnostics-export.test.ts` 的源码级断言。
 */

import type { ResponseMsg } from '@shared/types/messages';
import { diag } from '@platform/storage/diag-store';

/** 我们自己的规则 id 区间（与 `dnr.ts` 的 `PATH_RULE_ID_BASE` / 标签页规则一致） */
export const PATH_RULE_ID_MIN = 10000;
export const PATH_RULE_ID_MAX = 11000;
export const TAB_RULE_ID_MIN = 20000;
export const TAB_RULE_ID_MAX = 30000;

/**
 * 单项读取：失败返回 `null`，不抛，**并把失败原因写进诊断日志**。
 *
 * ## 为什么必须记日志（2026-11-10 复验，第四次）
 *
 * 到这一轮为止，我们已经**猜了三次**为什么这四项读不到：
 *   1. 以为 content script 里没权限 → 改走 background
 *   2. 以为 background 异步通道不通 → smoke 用 `proxy/status` / `account/summary`
 *      **同环境对照**证明通道是通的
 *   3. 于是只剩"background 里这四个 API 本身抛错"，但**抛的是什么不知道**
 *
 * 前三次的共同失败是：**失败信息被 `catch {}` 吞掉了**，只能靠下一次推断。
 *
 * 而 smoke 本轮已经证明 `diag()` 写 → `readDiag()` → 诊断浮层显示 **整条链全通**
 * （`panel/page-state kind=ok` 就在日志里）。所以这里记一行，下一轮就能**直接读到**
 * 「哪个 API 抛了什么错」，不用再猜第四次。
 *
 * ## 为什么 `void` 而**不** `await`
 *
 * 诊断日志不能拖慢主流程。`diag()` 内部是 Promise 链 + 一次 `storage.local.set`，
 * await 它会把这四项的并发变成串行等待。`void` + 内部已 catch 是安全的。
 *
 * @param name 哪一项（`incognito` / `windows` / `cookies` / `dnr`），用来区分日志
 */
/**
 * 单项读取的**超时上限**。
 *
 * ## 为什么必须有（2026-11-10 第六轮，日志定位）
 *
 * 真机日志给出的结论链：
 * ```
 * diag/facts  branch: empty-reply
 * diag/facts  reply: undefined
 * （没有任何 diag/facts <name>: 行）
 * ```
 *
 * 这意味着：
 *   - `dialogFacts()` 被调用了（有 `reply:`）
 *   - `sendMessage` **resolve 成 `undefined`**，不是抛错
 *   - 四个 `attempt` 的 catch **一次都没进** → 四项都没抛
 *   - 也没有 `:err` → `handleDiagFacts()` 没返回任何对象
 *
 * ⇒ `Promise.all` 里**至少有一个 Promise 永不 resolve**，
 *   `.then(sendResponse)` 永不触发。
 *
 * 而 `sendResponse` 永不调用，会让发起方的 `sendMessage` **永久悬着** ——
 * 那比任何单项失败都严重。
 *
 * ## 为什么不是"回调式 API 被当 Promise 用"
 *
 * 核实过 `@types/chrome`：`isAllowedIncognitoAccess` / `windows.getAll` /
 * `cookies.getAllCookieStores` / `declarativeNetRequest.getSessionRules`
 * 都**明确声明了 Promise 重载**（"Can return its result via Promise in MV3"）。
 *
 * 所以原因未知；但"永不 resolve"这个事实成立。**竞速超时同时解决定位与修复**：
 *   - 定位：挂住的那项会在日志里出现 `<name>: Error: TimeoutError`
 *   - 修复：该降级为 `null`，其余三项照常返回，`Promise.all` 不再永久挂起
 *
 * ## 为什么 800ms
 *
 * 这几项都是本地同步类 API（不涉及网络），正常远小于 10ms。
 * 800ms 足够宽松，又远小于 SW 的 30s 休眠窗口。
 * ⚠️ `setTimeout` 在 Service Worker 里是安全的（不是 `alarm`，不需要 `alarms` 权限）。
 */
export const ATTEMPT_TIMEOUT_MS = 800;

/**
 * `handleDiagFacts()` 的**整体**超时上限。
 *
 * 比 4 × `ATTEMPT_TIMEOUT_MS` 宽，正常情况下永远不会触发 ——
 * 它是"`sendResponse` 必须被调用"这一条的最后保险。
 */
export const OVERALL_TIMEOUT_MS = 4000;

/** `handleDiagFacts()` 的两种应答 —— 收窄 `finish()` 的参数类型 */
type DiagFactsReply =
  | Extract<ResponseMsg, { type: 'diag/facts:ok' }>
  | Extract<ResponseMsg, { type: 'diag/facts:err' }>;

/**
 * 单项执行结果的**结构化摘要** —— 用于 `echo` 回显。
 *
 * ## 为什么要区分这四种（2026-11-10 第八轮）
 *
 * 前七轮最大的坑是"**null 有歧义**"：
 *   - "这项读到了，但值就是 null"（如 `view` 为 null）
 *   - "这项抛错了"（被 catch 成 null）
 *   - "这项超时了"（也被 catch 成 null）
 *   - "这项根本没跑"
 *
 * 四种在 HTTP 层面都表现为 `facts.x === null`，**完全同形**。
 * 所以 echo 把它们拆成四个前缀：
 *
 * | 前缀 | 含义 |
 * | --- | --- |
 * | `ok:` | 成功拿到值（后面是值的 JSON） |
 * | `nil:` | 成功执行，但返回值本身就是 null/undefined |
 * | `ERR:` | 抛错（后面是 `Name: message`） |
 * | `TIMEOUT` | 超时竞速命中 |
 */
type AttemptOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'nil' }
  | { kind: 'error'; detail: string }
  | { kind: 'timeout' };

/** 把一次尝试压成 echo 里的一小段 */
function outcomeText(o: AttemptOutcome): string {
  switch (o.kind) {
    case 'ok':
      try {
        return `ok:${JSON.stringify(o.value)}`;
      } catch {
        // 循环引用等极端情况：不因为"日志打不出来"而让整条应答失败
        return 'ok:<unserializable>';
      }
    case 'nil':
      return 'nil';
    case 'error':
      return `ERR:${o.detail}`;
    case 'timeout':
      return 'TIMEOUT';
  }
}

/**
 * 单项读取：失败或**超时**返回 `null`，不抛，并把原因写进诊断日志**与 echo 摘要**。
 *
 * @param name 哪一项（`incognito` / `windows` / `cookies` / `dnr`）
 * @param echoSink 收集"这一项到底怎么了"，供应答里的 `echo` 用
 * @param failures 收集失败原因（拼进 `:err` 的 `detail`）
 */
async function attempt<T>(
  name: string,
  failures: string[],
  echoSink: Record<string, AttemptOutcome>,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    /**
     * ⚠️ 竞速：`fn()` 可能永远不 resolve。
     *
     * 注意 `setTimeout` 的句柄**不需要**清 —— 如果 `fn()` 先完成，
     * 那个定时器 fire 时只会去 reject 一个已经 settle 的 promise（无害），
     * 而它最多存活 800ms。清理逻辑会引入额外的状态与出错面，
     * 在这里不值得。
     */
    const v = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`TimeoutError(${String(ATTEMPT_TIMEOUT_MS)}ms)`));
        }, ATTEMPT_TIMEOUT_MS);
      }),
    ]);

    /**
     * 成功执行但值是 null/undefined —— 与"抛错"必须分开。
     * 这是本轮 echo 最想区分的一件事。
     */
    echoSink[name] = v === null || v === undefined ? { kind: 'nil' } : { kind: 'ok', value: v };
    return v;
  } catch (e) {
    const detail =
      e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : String(e);
    const isTimeout = detail.includes('TimeoutError');
    echoSink[name] = isTimeout
      ? { kind: 'timeout' }
      : { kind: 'error', detail: detail.slice(0, 120) };
    const line = `${name}: ${detail.slice(0, 160)}`;
    // 两路都要：日志（可翻历史）+ 收集后的 detail（一次看全）
    failures.push(line);
    void diag('diag/facts', line).catch(() => {});
    return null;
  }
}

export async function handleDiagFacts(): Promise<ResponseMsg> {
  /**
   * ## 覆盖写一条定位追踪（2026-11-10 第七轮，smoke 的建议）
   *
   * ### 为什么必须单独一条通道
   *
   * `diag()` 是 **30 条环形缓冲**，而 `page/quality` 在播放中每几秒写一轮、
   * 一次 3 条 —— 几分钟就把缓冲冲干净。
   *
   * 于是出现了两次误判：看到"没有 `onMessage` 日志"就以为"代码没执行"，
   * 而实际上它**执行了，只是被挤掉了**。
   *
   * 所以把 `diag/facts` 的**最终结果**覆盖写到独立 key（`pluma:diag-trace`）：
   *   - 覆盖写 → **永远看得见最近一次**，不会被任何高频日志挤掉
   *   - 只有一条 → 不占环形缓冲、不会把 storage 撑大
   *   - 导出 JSON 会带上它 → smoke 一定能读到，不依赖面板渲染
   *
   * @param r 要返回给调用方的应答（**本函数只回 diag/facts 的两种**）
   */
  const finish = (r: DiagFactsReply): DiagFactsReply => {
    /**
     * ## echo：绕开 storage 的调试回显（2026-11-10 第八轮）
     *
     * 前七轮所有"写 storage 再看"的通道都失败了 ——
     * `diag()` 被环形缓冲挤掉、`trace()` 干脆写不进去。
     * 而**消息应答本身一次没丢过**，所以把执行摘要塞进应答。
     *
     * 格式：`entered | incognito=ok:true windows=nil cookies=ERR:TypeError ... dnr=TIMEOUT`
     *
     * ⚠️ **这里不调 `trace()`**（2026-11-10 第九轮）：它与 `diag()` 共用
     * 同一个模块级 Promise 队列，链上任何一次写入卡住就永久悬挂。
     * smoke 已证明 `trace()` 在这个环境从不成功，留着只有风险没有收益。
     * echo 走应答，不需要 storage。
     */
    const order = ['incognito', 'windows', 'cookies', 'dnr'] as const;
    const parts = order.map((k) => `${k}=${outcomeText(echoSink[k] ?? { kind: 'nil' })}`);
    const echo = `entered | ${parts.join(' ')}`;

    return { ...r, echo };
  };

  /**
   * 收集每一项的失败原因，供 `:err` 的 `detail` 用。
   *
   * ⚠️ 与诊断日志**两路都要**：
   *   - 日志（`diag`）→ 用户能在诊断浮层里翻历史
   *   - `detail`     → 一次性就能看到全部四项的原因，不用去翻日志
   *
   * 这一轮（第四次）之所以还要再修，就是因为 `detail` 原来只写
   * "四项环境信息均读取失败" —— **零信息量**，等于把失败藏起来了。
   */
  const failures: string[] = [];

  /**
   * 每一项的执行结果摘要 —— 会拼进应答的 `echo` 字段。
   *
   * ⚠️ 与 `failures` 的区别：
   *   - `failures` 只收**失败**的（成功的不进），用于 `:err` 的 `detail`
   *   - `echoSink` 收**每一项**（成功的也进），用于告诉调用方"这项到底怎么了"
   *
   * 第八轮加 echo 的原因：前七轮所有"写 storage 再看"的通道都失败了，
   * 而**消息应答从没丢过**。所以把调试信息放进应答本身。
   */
  const echoSink: Record<string, AttemptOutcome> = {};

  /**
   * 四项**并行**读。串行会让"打开诊断浮层"明显变慢，
   * 而这四项彼此独立、没有任何依赖。
   *
   * ## ⚠️ 整体还有一道 3 秒兜底（2026-11-10 第六轮）
   *
   * 每个 `attempt` 已有 800ms 单项超时，理论上 `Promise.all` 最多 800ms 就返回。
   * 但**`sendResponse` 永不调用**是比任何单项失败都严重的问题
   * （发起方的 `sendMessage` 会永久悬着），所以再加一道整体保险：
   * 即使 `Promise.all` 因为某种未预料的原因挂住，也要回一个 `:err`。
   *
   * 3200ms > 4 × 800ms 的上限，正常情况下永远不会触发。
   */
  const overall: { value: readonly [boolean | null, unknown, unknown, unknown] | null } = {
    value: null,
  };
  try {
    overall.value = await Promise.race([
      Promise.all([
        attempt('incognito', failures, echoSink, async () => {
          const allowed = await chrome.extension.isAllowedIncognitoAccess();
          return typeof allowed === 'boolean' ? allowed : null;
        }),

        attempt('windows', failures, echoSink, async () => {
          const wins = await chrome.windows.getAll();
          return {
            total: wins.length,
            incognito: wins.filter((w) => w.incognito).length,
          };
        }),

        attempt('cookies', failures, echoSink, async () => {
          const stores = await chrome.cookies.getAllCookieStores();
          return stores.map((s) => s.id);
        }),

        attempt('dnr', failures, echoSink, async () => {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          const path: number[] = [];
          const tab: number[] = [];
          for (const r of rules) {
            if (r.id >= PATH_RULE_ID_MIN && r.id < PATH_RULE_ID_MAX) path.push(r.id);
            else if (r.id >= TAB_RULE_ID_MIN && r.id < TAB_RULE_ID_MAX) tab.push(r.id);
          }
          path.sort((a, b) => a - b);
          tab.sort((a, b) => a - b);
          return { path, tab };
        }),
      ]),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`OverallTimeout(${String(OVERALL_TIMEOUT_MS)}ms)`));
        }, OVERALL_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    void diag('diag/facts', `overall: ${detail.slice(0, 160)}`).catch(() => {});
    return finish({
      type: 'diag/facts:err',
      detail: `整体超时（${detail}）；已收集：${failures.join(' | ') || '无'}`.slice(0, 300),
    });
  }

  const [incognitoAllowed, windows, cookieStores, dnrRuleIds] = overall.value as [
    boolean | null,
    { total: number; incognito: number } | null,
    string[] | null,
    { path: number[]; tab: number[] } | null,
  ];

  /**
   * 四项**全部**读失败才回 `:err`。
   *
   * 只要有一项拿到了（哪怕是 `false` / 空数组），就回 `:ok` —— 让调用方看到
   * "这一项读到了、那一项没读到"。统一回 `:err` 会把部分成功也吞成整体失败，
   * 而那正是这次要修的那类"读不到被当成全坏"的问题。
   */
  if (
    incognitoAllowed === null &&
    windows === null &&
    cookieStores === null &&
    dnrRuleIds === null
  ) {
    return finish({
      type: 'diag/facts:err',
      /**
       * ⚠️ **把四项的真实原因拼进来**，不要写"均读取失败"。
       *
       * 那句零信息量的 detail 让这一轮排查又白猜了一次。
       * 截断到 300 字符：够看到 `TypeError: chrome.x is undefined` 这类关键信息，
       * 又不会把整条应答撑大。
       */
      detail: (failures.join(' | ') || '四项环境信息均读取失败').slice(0, 300),
    });
  }

  return finish({
    type: 'diag/facts:ok',
    facts: { incognitoAllowed, windows, cookieStores, dnrRuleIds },
  });
}

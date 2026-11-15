/**
 * 说明页的**自轮询状态机**（纯函数，无 `chrome.*` / `window`，可单测）。
 *
 * ## 为什么不能再用一次性监听器
 *
 * 原实现依赖 `src/background/login-handshake.ts` 的 `watchForLoginReady()`：
 * 它 8 秒超时后 `cleanup()` **永久摘掉** `chrome.storage.onChanged` 监听器，
 * 之后说明页**再也无法自关**。而用户从"点扫码"到"找到扩展开关拨开"实测远超 8 秒。
 *
 * 用户原话（`poc/probe/logout-login/REPORT.md` D 节）：
 * 「……我实际上已经打开了，必须重新刷新整个界面之后再次点击扫码登录取流账号」
 *
 * 刷新能"修好"的唯一原因，就是刷新会重跑一次 `readLoginReady()`。
 * ⇒ 正确做法是**把那一次读变成持续轮询**，不依赖任何监听器。
 *
 * ## 判据（两个条件**同时**成立才算完成）
 *
 * | 条件 | 来源 | 为什么要它 |
 * | --- | --- | --- |
 * | `allowed === true` | `chrome.extension.isAllowedIncognitoAccess()` | 权限没开，什么都没意义 |
 * | `ready === true` | `readLoginReady()`（`pluma:login-ready` 标记） | 权限开了但窗口没开，说明页关掉会让用户以为"点了没反应" |
 *
 * 只要权限这一项就自动关，就会重现 REPORT.md D.3 的"说明页没了、二维码也没有"。
 * 只要 ready 这一项也不行：`assumed` 是猜测（D.4），权限根本没开时标记也可能被写上。
 *
 * ## 为什么抽成纯函数
 *
 * 状态机是这一轮唯一有分支逻辑的东西（超时 / 两条件 / 幂等停止）。
 * 把 `now` / `setTimer` / `clearTimer` 注入进来，就能用假时钟精确断言
 * "第 N 次 tick 触发"，而不用真等 60 秒。
 */

/** 每轮间隔。1.5s 是裁决文件给的数：比人眼反应慢一档，又不至于让用户多等。 */
export const POLL_INTERVAL_MS = 1500;

/**
 * 持续轮询的总时长上限。
 *
 * 60 秒是裁决文件的**下限**要求（`>= 60s`）。取 90 秒的理由：
 * 用户要点开 `edge://extensions` → 找到本扩展 → 详情 → 拨开关 → 回到网页点按钮，
 * 实测这一串操作经常超过 60 秒（REPORT.md D.4 的时间线表）。多留 30 秒缓冲，
 * 代价只是一次 `storage.local.get`（本地读，无网络）。
 */
export const POLL_TIMEOUT_MS = 90_000;

export type WatchState =
  /** 还在等：权限或窗口任一未就绪 */
  | 'waiting'
  /** 权限已开、窗口就绪 → 应当关闭自己 */
  | 'done'
  /** 超时仍未完成 —— 说明页保留，不再轮询 */
  | 'timeout';

export interface WatchDeps {
  /** 读 `pluma:login-ready` 标记；抛错按 `false` 处理（不该因为一次读失败就放弃） */
  readReady: () => Promise<boolean>;
  /** 读 `chrome.extension.isAllowedIncognitoAccess()`；抛错按 `false` 处理 */
  readAllowed: () => Promise<boolean>;
  /** 状态变化时回调（`waiting` 只在首轮触发一次，见下） */
  onState: (state: WatchState) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface WatchHandle {
  /** 幂等停止；停止后不再有任何定时器，也不再回调 */
  stop: () => void;
  running: () => boolean;
  /**
   * 立刻执行一次检查（供测试推进；页面侧不直接调用 —— 定时器会调它）。
   * 返回本轮结束后的状态，方便测试断言。
   */
  tick: () => Promise<WatchState>;
}

/**
 * 启动轮询。**首轮立即执行**（进页面时标记可能已经在了，不该白等 1.5 秒）。
 */
export function startIncognitoWatch(deps: WatchDeps): WatchHandle {
  const startedAt = deps.now();
  let stopped = false;
  let handle: unknown;
  let scheduled = false;
  let state: WatchState = 'waiting';

  const finish = (next: WatchState): void => {
    if (stopped) return;
    stopped = true;
    if (scheduled) {
      deps.clearTimer(handle);
      scheduled = false;
    }
    state = next;
    deps.onState(next);
  };

  const schedule = (): void => {
    if (stopped) return;
    scheduled = true;
    handle = deps.setTimer(() => {
      scheduled = false;
      void tick();
    }, POLL_INTERVAL_MS);
  };

  const tick = async (): Promise<WatchState> => {
    if (stopped) return state;

    // 两个读取**并行**：它们是两套独立来源（storage 与浏览器权限），串行只是白等。
    const [allowed, ready] = await Promise.all([
      deps.readAllowed().catch(() => false),
      deps.readReady().catch(() => false),
    ]);

    // 读的过程中被 stop 了（页面卸载 / 连调两次）→ 不覆盖状态、不再排定时器
    if (stopped) return state;

    if (allowed && ready) {
      finish('done');
      return 'done';
    }

    if (deps.now() - startedAt >= POLL_TIMEOUT_MS) {
      finish('timeout');
      return 'timeout';
    }

    schedule();
    return 'waiting';
  };

  void tick();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (scheduled) {
        deps.clearTimer(handle);
        scheduled = false;
      }
    },
    running: () => !stopped,
    tick,
  };
}

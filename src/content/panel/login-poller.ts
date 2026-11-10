/**
 * 扫码登录后的**一次性轮询**：等 `account/summary` 里出现播放账号。
 *
 * ## 为什么需要它
 *
 * 扫码窗口在**无痕分区**（`incognito: 'split'`），那里是另一个 background 实例，
 * 两个实例**不能直接通信**，登录窗口无法"通知"面板"我登录好了"。
 *
 * 唯一共享的是 `chrome.storage.local`，而 `account/summary` 读的正是它 ——
 * 所以只能**轮询**。
 *
 * ## ⚠️ 这是**一次性**轮询，不是常驻轮询
 *
 * 只在用户点过「重新登录」之后启动，检测到就停、超时就停。
 * **不做常驻轮询**的理由：面板本来就有"每次展开重新取数"的机制
 * （`open-cycler`），再加一个常驻轮询会双倍请求，而且面板收起后毫无意义。
 *
 * ## 为什么单独一个文件
 *
 * 原来这段逻辑在 `entrypoints/options/sections/account.tsx` 的 `useEffect` 里
 * （那时是 Preact，靠 React 的生命周期自动清定时器）。面板是原生 DOM，没有生命周期，
 * **必须自己管**。而 `content-panel.content.ts` 顶层调用 `defineContentScript()`
 * 在单测里不存在（上一轮踩过），所以逻辑抽到这里才能测。
 *
 * ## 判据：从"没有"到"有"，**或** mid 变了
 *
 * | 场景 | `before` | 检测到 | 结论 |
 * | --- | --- | --- | --- |
 * | 首次配置 | `null` | `{mid: 123}` | ✅ 成功（从无到有） |
 * | 换个号 | `{mid: 123}` | `{mid: 456}` | ✅ 成功（mid 变了） |
 * | 扫了同一个号 | `{mid: 123}` | `{mid: 123}` | ✅ 也算成功 —— 见下 |
 * | 还没扫完 | `{mid: 123}` | `{mid: 123}` | 同上，但 3 分钟后超时 |
 *
 * ⚠️ 最后两行看似矛盾，其实不是：**扫了同一个号也是用户的意图达成**
 * （他就是想重新登录一次）。但我们**无法区分**"扫了同一个号"和"还没扫完"，
 * 所以统一按"mid 没变就继续等"处理，直到超时。
 *
 * 这与原 options 的行为一致（它也是比 mid）。
 * **不做**"只要 `configured` 为 true 就算成功" —— 那样**第一次轮询就会立即成功**
 * （用户还没扫码，账号本来就已经配置着），等于轮询毫无作用。
 */

/** 轮询间隔（原 options 是 3000ms，保持一致） */
export const POLL_MS = 3000;

/**
 * 最多轮询多少次 —— 3 分钟。
 *
 * 原 options 是 60 次 × 3s = 180s。保留这个数：够慢的网络扫完，
 * 又不至于让用户觉得"永远在等"。
 */
export const POLL_MAX = 60;

/** `account/summary:ok` 里面板用得到的部分 */
export interface AccountSnapshot {
  /** 播放账号的 mid；`null` = 没有播放账号（未配置 / 读不到资料） */
  mid: number | null;
}

/** 轮询的结局 */
export type PollOutcome =
  | { kind: 'configured'; mid: number }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; detail: string };

/** 轮询句柄 */
export interface LoginPoller {
  /** 立刻停止（幂等）。**必须在面板收起 / 切 Tab / 销毁时调用** */
  stop(): void;
  /** 是否仍在轮询（诊断与测试用） */
  running(): boolean;
}

/** 轮询的依赖（注入以便测试，不直接碰 `chrome.*` / 全局定时器） */
export interface PollerDeps {
  /** 查一次当前账号状态 */
  read: () => Promise<AccountSnapshot>;
  /** 轮询结束后回调**一次**（成功 / 超时 / 取消都算） */
  onDone: (outcome: PollOutcome) => void;
  /** 定时器三件套，测试里换成假实现 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * 启动一次性轮询。
 *
 * ## 不叠加
 *
 * 每个实例独立；调用方若需要"连点两次只开一个"，**先在启动前 `stop()` 掉旧的**
 * —— 见 `content-panel.content.ts` 里的用法（保留一个 `poller` 变量，
 * 每次先 `poller?.stop()`）。这里不做全局单例，那会让测试互相污染。
 *
 * @param deps  见 `PollerDeps`
 * @param before 点「重新登录」时看到的 mid（`null` = 之前没有播放账号）
 */
export function startLoginPolling(deps: PollerDeps, before: number | null): LoginPoller {
  const { read, onDone } = deps;
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms) as unknown);
  const clearTimer =
    deps.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));

  let ticks = 0;
  let finished = false;
  /** 当前挂着的定时器句柄；`null` = 没有（已停 / 还没排） */
  let handle: unknown = null;

  /** 收尾：无论什么原因结束，都只回调一次、句柄都清掉 */
  const finish = (outcome: PollOutcome): void => {
    if (finished) return;
    finished = true;
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
    onDone(outcome);
  };

  const schedule = (): void => {
    handle = setTimer(() => {
      handle = null;
      void tick();
    }, POLL_MS);
  };

  const tick = async (): Promise<void> => {
    if (finished) return;

    ticks += 1;

    let snap: AccountSnapshot;
    try {
      snap = await read();
    } catch (e) {
      // 单次读失败**不停**轮询 —— 网络抖一下就放弃太脆弱
      if (ticks >= POLL_MAX) {
        finish({ kind: 'timeout' });
        return;
      }
      schedule();
      void e;
      return;
    }

    if (finished) return;

    /**
     * 判据见文件头：**从无到有** 或 **mid 变了**。
     *
     * ⚠️ 这里**不能**用 `if (snap.mid !== null)` —— 那会在第一次轮询就成功
     * （用户还没扫码，账号本来就已经配置着）。
     */
    const isNew = snap.mid !== null && snap.mid !== before;
    if (isNew) {
      finish({ kind: 'configured', mid: snap.mid as number });
      return;
    }

    if (ticks >= POLL_MAX) {
      finish({ kind: 'timeout' });
      return;
    }

    schedule();
  };

  // 第一次不等 3 秒 —— 用户刚扫完可能已经是好了的（省 3 秒感知延迟）
  void tick();

  return {
    stop: () => {
      finish({ kind: 'cancelled' });
    },
    running: () => !finished,
  };
}

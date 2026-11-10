/**
 * 面板的「展开重取」编排 —— 从 `content-panel.content.ts` 抽出来，**可直接单测**。
 *
 * ## 为什么抽成独立模块（2026-11-10 阶段 2 收口）
 *
 * 阶段 2 的节流 / 并发 / `not-ready` 重试原本写在入口文件里，而入口依赖
 * WXT 的 `defineContentScript` 与整套 chrome mock。直接驱动它等于把单测写成
 * 集成测试 —— 失败时分不清是编排错还是 mock 错。
 *
 * 当时的折中是**在测试里镜像一份逻辑**，但那会漂移
 * （`popup-snapshot.ts` 文件头记录过同一类风险：镜像与真实实现悄悄脱节）。
 *
 * 现在把这段搬到这里：**纯逻辑 + 注入依赖**，测试直接测真实实现。
 *
 * ## 三条判据（每条都有对应真机根因）
 *
 * | 判据 | 来源 |
 * | --- | --- |
 * | 每次展开重取一次 | 真机根因 2：取数只在挂载时跑一次，`pageState` 停在初始化态 |
 * | 300ms 节流（leading + trailing） | hover 会连续触发；但**最后一次必须生效** |
 * | 并发时最后一次发起的结果优先 | 旧结果后返回会覆盖新结果，表现为数据倒退 |
 * | `not-ready` 短重试，拿到 ok 立即停 | 展开瞬间数据可能还没到；**不是轮询** |
 *
 * ## 为什么依赖注入而不是直接 import
 *
 * 本模块不碰 `chrome.*`、不碰 DOM —— 因此能在 Node 里直接跑。
 * "取数"由调用方传进来的 `load` 决定。
 */

/** 节流窗口：窗口内重复展开合并成一次尾随取数 */
export const OPEN_RELOAD_THROTTLE_MS = 300;

/** `not-ready` 首次重试的延迟 */
export const NOT_READY_RETRY_DELAY_MS = 800;

/** `not-ready` 最多重试几次（超过就放弃，等用户下次展开） */
export const NOT_READY_MAX_RETRIES = 3;

/**
 * 重试的**总时限**。
 *
 * 单个延迟 × 次数已经能兜住，但用户可能长时间不收起面板，
 * 每次 `load` 又都返回 `not-ready` —— 那时计数会停在 `MAX_RETRIES`，
 * 不会无限重试。这条时限是第二道保险：超过它就不再启动新的一轮。
 */
export const NOT_READY_TOTAL_MS = 10_000;

/** 一次取数的结局 —— 只需要 `pageStateKind` 这一个字段 */
export interface LoadResult {
  pageStateKind: 'ok' | 'not-ready' | 'no-content-script' | 'timeout';
}

export interface OpenCyclerDeps {
  /**
   * 真正取数并落盘到 UI。**必须自己处理异常**（不要抛）；
   * 抛了本模块会当作本次失败、不影响下一次。
   */
  load: () => Promise<LoadResult | null>;
  /** 面板当前是否还挂着（卸掉后不应再取数） */
  isActive: () => boolean;
  /** 定时器（注入以便测试用假时钟） */
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface OpenCycler {
  /** 用户展开面板时调用（hover / 点击 / 键盘都会到这里） */
  open(): void;
  /** 面板收起时调用（目前只用于清理尾随定时器） */
  close(): void;
  /** 面板被卸载 / 开关关闭时调用（清掉所有挂起的定时器） */
  dispose(): void;
  /** 当前是否已有一次取数在飞（测试用） */
  isInFlight(): boolean;
}

export function createOpenCycler(deps: OpenCyclerDeps): OpenCycler {
  const { load, isActive, now, setTimer, clearTimer } = deps;

  let lastLoadAt = Number.NEGATIVE_INFINITY;
  let trailingHandle: unknown = null;
  let retryHandle: unknown = null;

  /** 并发保护：每次取数领一个序号，回来时不是最新就丢弃 */
  let seq = 0;
  let inFlight = false;

  let retries = 0;
  let retryDeadline = 0;

  const clearTrailing = (): void => {
    if (trailingHandle !== null) {
      clearTimer(trailingHandle);
      trailingHandle = null;
    }
  };

  const clearRetry = (): void => {
    if (retryHandle !== null) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
  };

  const resetRetryState = (): void => {
    clearRetry();
    retries = 0;
    retryDeadline = 0;
  };

  /**
   * 立刻发起一次取数。
   *
   * ## 为什么不清空 `inFlight` 就 return
   *
   * 并发时**不丢弃新请求**（那会让"最后一次展开"落空），而是让两次并行跑、
   * 由序号决定谁生效。`inFlight` 只用于对外暴露状态，不参与决策。
   */
  const run = async (): Promise<void> => {
    if (!isActive()) return;
    const my = ++seq;
    inFlight = true;
    let result: LoadResult | null = null;
    try {
      result = await load();
    } catch {
      // 取数失败：保持上一次画面，不影响下一次
      result = null;
    } finally {
      if (my === seq) inFlight = false;
    }

    // 过期结果：后面已经有人发起更新的一次
    if (my !== seq) return;
    if (!isActive()) return;

    scheduleRetry(result);
  };

  /**
   * `not-ready` 时排一次短重试。
   *
   * **不是轮询**：只在 `not-ready` 启动、拿到 `ok` 立即清定时器、有次数上限与总时限。
   */
  const scheduleRetry = (result: LoadResult | null): void => {
    if (result === null || result.pageStateKind !== 'not-ready') {
      resetRetryState();
      return;
    }
    if (retries >= NOT_READY_MAX_RETRIES) return;
    if (retryHandle !== null) return; // 已排队的重试不叠加
    if (retryDeadline === 0) retryDeadline = now() + NOT_READY_TOTAL_MS;

    retryHandle = setTimer(() => {
      retryHandle = null;
      if (!isActive()) {
        resetRetryState();
        return;
      }
      if (now() > retryDeadline) {
        resetRetryState();
        return;
      }
      retries += 1;
      void run();
    }, NOT_READY_RETRY_DELAY_MS);
  };

  return {
    open(): void {
      if (!isActive()) return;
      const t = now();
      const elapsed = t - lastLoadAt;

      if (elapsed >= OPEN_RELOAD_THROTTLE_MS) {
        lastLoadAt = t;
        resetRetryState();
        void run();
        return;
      }

      /**
       * 窗口内：排一次**尾随**。
       *
       * 不能直接丢弃 —— 用户最后一次 hover 必须看到新数据。
       * 尾随只排一次（已有就不重复排），窗口结束时补发。
       */
      if (trailingHandle !== null) return;
      trailingHandle = setTimer(() => {
        trailingHandle = null;
        if (!isActive()) return;
        lastLoadAt = now();
        resetRetryState();
        void run();
      }, OPEN_RELOAD_THROTTLE_MS - elapsed);
    },

    close(): void {
      /**
       * 只清**尾随**，不清重试。
       *
       * 理由：用户收起面板时，`not-ready` 的重试仍然有意义 ——
       * 他可能马上又展开，那时数据已经就绪直接显示。
       * 而尾随取数是"为了一次已经过去的 hover"服务的，该取消。
       */
      clearTrailing();
    },

    dispose(): void {
      clearTrailing();
      clearRetry();
      retries = 0;
      retryDeadline = 0;
      // 让所有在飞的结果作废
      seq += 1;
      inFlight = false;
    },

    isInFlight: () => inFlight,
  };
}

/**
 * 主世界 `hello` / `ready` 的处理时序（S3.4 前置，2026-10-30）
 *
 * ## 为什么单独抽出来
 *
 * 这两条分支的**时序**是硬约束，而且历史上踩过两次真机事故：
 *
 * 1. **`hello` 分支不能 `await`**（2026-10-29）
 *    `window.postMessage` 的监听器是同步的。如果在里面等异步，
 *    `hello` 的回应会被推到事件循环后面，主世界那边已经进入下一步了。
 *    所以做法是：**同步先发一次 `true`**（"hook 已就绪、可以工作"），
 *    再 `void` 异步查总开关，**只在明确关闭时**补发 `false`。
 *
 * 2. **`ready` 分支绝不能回 `cfg`**（2026-10-26，Out of Memory）
 *    主世界收到 `cfg` 回 `ready`，收到 `ready` 再回 `cfg` 就是无限回环。
 *    每轮回环夹带一份完整的 `__playinfo__`，视频页停留几十秒后页面崩溃。
 *    配置只下发一次（`hello` 那一次）。
 *
 * 这两条都是"改一行就出事、但现有测试抓不到"的类型。抽成纯编排函数后可以单测。
 *
 * ## 为什么参数全部注入
 *
 * 它要 `reportQuality` / `tellMainWorld` / `sendToBackground` 三个副作用。
 * 全部由调用方传入，本模块不直接碰它们 —— 这样测试里可以精确观察调用**顺序**，
 * 那正是要守的东西。
 */

/** `hello` 消息里携带的主世界自检标志 */
export interface HelloFlags {
  readyState?: string;
  define?: string;
  hadExisting?: boolean;
  playinfo?: string;
}

export interface HelloDeps {
  /** 上报一条画质/诊断（hello 时记一行现场） */
  reportQuality: (payload: { height: number; note?: string }) => void;
  /** 向主世界下发 cfg */
  tellMainWorld: (enabled: boolean, pgcActive?: boolean) => void;
  /** 查总开关（异步） */
  queryProxyStatus: () => Promise<{ enabled: boolean } | null>;
}

/**
 * 处理主世界的 `hello`。
 *
 * ## 同步/异步的顺序是硬约束
 *
 * ```
 * tellMainWorld(true)            ← 必须同步，先于任何 await
 *   └─ void queryProxyStatus()   ← 异步，不阻塞
 *        └─ 只在明确 false 时 tellMainWorld(false)
 * ```
 *
 * @returns 一个 promise，测试里可以 await 它等异步那半跑完。
 *   **生产代码不应 await 它** —— 那正是第 1 条约束要避免的事。
 */
export function handleHello(flags: HelloFlags | undefined, deps: HelloDeps): Promise<void> {
  deps.reportQuality({
    height: 0,
    note: `主世界就绪 readyState=${flags?.readyState ?? '?'} define=${flags?.define ?? '?'} hadExisting=${String(flags?.hadExisting)} playinfo=${flags?.playinfo ?? '?'}`,
  });

  // ⚠️ 这一行必须同步执行 —— 不能放进 then/catch 里
  deps.tellMainWorld(true);

  /**
   * 只补发 `false`。
   *
   * 不补发 `true`：上面已经发过一次（那是"hook 已就绪、可以工作"的意思），
   * 而 `cfg` 每发一条主世界都会走一遍 `syncHooks()` ——
   * 没必要为"开着"再多触发一次。
   */
  return deps.queryProxyStatus().then((st) => {
    if (!st) return;
    if (st.enabled === false) deps.tellMainWorld(false);
  });
}

/**
 * 处理主世界的 `ready`。
 *
 * ## ⚠️ 这里**什么都不做**，而且是故意的
 *
 * 主世界收到 `cfg` 会回 `ready`，收到 `ready` 再回 `cfg` 就是无限回环
 * （2026-10-26 因此出过 Out of Memory）。
 *
 * 这个函数存在的意义是**把"不许回 cfg"这条约束变成一个有名字、被测试盯着的动作**，
 * 而不是散落在注释里的口头纪律。
 */
export function handleReady(): void {
  // 故意为空。见上面的注释 —— 不要在这里下发 cfg。
}

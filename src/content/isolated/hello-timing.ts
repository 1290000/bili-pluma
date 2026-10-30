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
 *    所以做法是：**同步先发一次**（"hook 已就绪、可以工作"），
 *    再 `void` 异步查总开关，**只在明确关闭时**补发 `false`。
 *
 *    ⚠️ 首发那个值**不能写死 `true`**（2026-10-30，G5）。原先写死时，
 *    在"开关其实关着"的场景里首发的 `true` 会把主世界的 `cfgEnabled`
 *    污染成 `true`，直到异步结果回来才被纠回 —— 那段窗口内的诊断值
 *    和真机现场全都在说谎（真机排查时 `lastCfgEnabled: true` 会把人引向
 *    "消息通道报的是开"）。现在首发值来自**同步可得**的
 *    `localStorage` 关闭标记（见 `HelloDeps.readProxyOffSync`），
 *    判不了（`null`）时仍按 `true` 放行 —— 那是 ADR 0020 的硬约束：
 *    **不许把注入绑在异步通道上**。
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
 * 它要 `reportQuality` / `tellMainWorld` / `sendToBackground` 三个副作用，
 * 外加一个**同步**的关闭标记读取。全部由调用方传入，本模块不直接碰它们 ——
 * 这样测试里可以精确观察调用**顺序**，那正是要守的东西。
 * 同理，本模块不 import `pgc-proxy-off.ts`：那会让单测被迫依赖 jsdom 的
 * `localStorage`，而这里真正要守的是"首发值取自注入的函数"，不是存储本身。
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
  /**
   * **同步**读「总开关关着」的标记（2026-10-30，G5）。
   *
   * 生产实现是 `pgc-proxy-off.ts` 的 `readProxyOffMarkSync()`，测试里换成替身。
   *
   * ⚠️ **必须是同步的**：它决定了首发的 `cfg`，而首发不能等任何异步。
   * 谁把它改成 `Promise`，`tellMainWorld` 就必然被推后 —— 那正是第 1 条约束。
   *
   * @returns `true` = 明确关着；`null` = 判不了（放行）
   */
  readProxyOffSync: () => boolean | null;
}

/**
 * 处理主世界的 `hello`。
 *
 * ## 同步/异步的顺序是硬约束
 *
 * ```
 * v = readProxyOffSync()         ← 同步，决定首发值
 *   └─ tellMainWorld(v !== true) ← 必须同步，先于任何 await
 *        └─ void queryProxyStatus()   ← 异步，不阻塞
 *             └─ 只在**与首发值不同**时补发一次
 * ```
 *
 * 首发值取"不是明确关着"（`true` / `null` 都算），而不是 `=== true` 才算开着 ——
 * 方向与 ADR 0020 一致：**判不了就放行**。
 *
 * @returns 一个 promise，测试里可以 await 它等异步那半跑完。
 *   **生产代码不应 await 它** —— 那正是第 1 条约束要避免的事。
 */
export function handleHello(flags: HelloFlags | undefined, deps: HelloDeps): Promise<void> {
  deps.reportQuality({
    height: 0,
    note: `主世界就绪 readyState=${flags?.readyState ?? '?'} define=${flags?.define ?? '?'} hadExisting=${String(flags?.hadExisting)} playinfo=${flags?.playinfo ?? '?'}`,
  });

  /**
   * 同步探到的开关值。`true` = 明确关着，`null` = 判不了。
   *
   * 包一层 try：这是调用方注入的函数，但它在 `hello` 分支里跑，
   * 抛错会让整条消息分支挂掉。判不了就放行。
   */
  let offMark: boolean | null = null;
  try {
    offMark = deps.readProxyOffSync();
  } catch {
    offMark = null;
  }
  const firstValue = offMark !== true;

  // ⚠️ 这一行必须同步执行 —— 不能放进 then/catch 里
  deps.tellMainWorld(firstValue);

  /**
   * 异步结果只在**与首发值不同**时补发。
   *
   * 不补发相同的值：`cfg` 每发一条主世界都会走一遍 `syncHooks()` ——
   * 没必要重复触发。这同时保住了原来"开关开着时不补发 `true`"那条性质
   * （首发已经是 `true`，异步回 `true` 时不发）。
   *
   * ⚠️ 异步回 `null`（查不到）时**不发**：此时首发值 `true` 保持不动，
   * 而"判不了"的方向就是放行。
   */
  return deps.queryProxyStatus().then((st) => {
    if (!st) return;
    if (st.enabled !== firstValue) deps.tellMainWorld(st.enabled);
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

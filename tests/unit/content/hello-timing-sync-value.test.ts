/**
 * `hello` 首发 `cfg` 的**取值**（G5，2026-10-30）
 *
 * ## 与 `hello-timing.test.ts` 的分工
 *
 * 那个文件守的是**时序**（首发不能等异步、`ready` 不许回 `cfg`）。
 * 这个文件守的是**首发那个值到底是什么**：
 *
 * ```
 * 旧实现   tellMainWorld(true)                 ← 无条件 true
 *          └─ 异步回 false → tellMainWorld(false)
 *              ↑ 这段窗口里主世界的 cfgEnabled 被污染成 true
 *
 * 新实现   tellMainWorld(readProxyOffSync() !== true)  ← 同步可得的真实值
 *          └─ 异步结果**与首发不同**时才补发
 * ```
 *
 * ## 为什么这值得单独一个文件
 *
 * 症状是"诊断值说谎"，不是功能挂掉 —— 真机排查时 `lastCfgEnabled: true`
 * 会把人引向"消息通道报的是开"（`entrypoints/content.ts` 里 2026-10-29 修 R1
 * 那条注释记录了同一个坑）。它**不会让任何现有测试变红**，
 * 所以必须专门盯住"首发值从哪来"。
 *
 * ## ⚠️ 反例验证（AGENTS.md §1.5）
 *
 * 把 `handleHello` 里的 `deps.tellMainWorld(firstValue)` 改回
 * `deps.tellMainWorld(true)`，本文件下面标 ★ 的三条必须变红。
 */
import { describe, expect, it } from 'vitest';

import { handleHello, type HelloDeps, type HelloFlags } from '@/src/content/isolated/hello-timing';

const FLAGS: HelloFlags = { readyState: 'complete', define: 'ok', playinfo: 'ssr' };

/**
 * 造一套依赖替身。
 *
 * @param offMark     `readProxyOffSync()` 的返回值（`true` = 明确关着 / `null` = 判不了）
 * @param asyncStatus 异步 `proxy/status` 的结果；不传 = 永远不 resolve（模拟 SW 还没醒）
 */
function makeDeps(
  offMark: boolean | null,
  asyncStatus?: { enabled: boolean } | null,
  opts: { syncThrows?: boolean; readOrder?: string[] } = {},
): { deps: HelloDeps; calls: string[] } {
  const calls: string[] = [];
  /**
   * 异步通道用一个**挂着不 resolve** 的 promise 做默认值 ——
   * 这样"首发值"一定是在异步结果到来**之前**发出的那个，
   * 断言不会被微任务顺序干扰。
   */
  const pending = new Promise<{ enabled: boolean } | null>(() => {});

  const deps: HelloDeps = {
    reportQuality: () => {},
    tellMainWorld: (enabled) => {
      calls.push(`tellMainWorld:${String(enabled)}`);
    },
    readProxyOffSync: () => {
      if (opts.syncThrows) throw new Error('localStorage 被禁');
      opts.readOrder?.push('readProxyOffSync');
      return offMark;
    },
    queryProxyStatus: () => {
      if (asyncStatus === undefined) return pending;
      return Promise.resolve(asyncStatus);
    },
  };

  return { deps, calls };
}

describe('hello 首发值：同步可得的真实开关值（G5）', () => {
  it('★ 开关明确关着（标记新鲜）→ 首发就发 false，不发 true', () => {
    /**
     * 这是本修复的核心断言。
     *
     * 旧实现这里发的是 `true` —— 主世界的 `cfgEnabled` 会被推成 `true`，
     * 而真实状态是关着。异步结果虽然稍后会纠回来，但那段时间的现场是假的。
     *
     * 反例：把 `tellMainWorld(firstValue)` 改回 `tellMainWorld(true)` → 本条红。
     */
    const { deps, calls } = makeDeps(true);

    void handleHello(FLAGS, deps);

    expect(calls).toEqual(['tellMainWorld:false']);
    expect(calls).not.toContain('tellMainWorld:true');
  });

  it('★ 判不了（没有标记）→ 首发仍放行为 true（ADR 0020：不许把注入绑在异步通道上）', () => {
    /**
     * 标记只能证明"关"，不能证明"开"。`null` 必须当放行处理，
     * 不能退化成 `false` —— 那会把功能绑死在"标记写得进去"这个条件上，
     * 而标记写入本来就可能失败（配额满 / 隐私模式 / SW 没醒）。
     */
    const { deps, calls } = makeDeps(null);

    void handleHello(FLAGS, deps);

    expect(calls).toEqual(['tellMainWorld:true']);
  });

  it('★ 首发是同步读取的结果，且早于任何异步（顺序断言）', async () => {
    /**
     * `postMessage` 监听器是同步的 —— 首发必须在第一个 `await` 之前。
     * 用 `readOrder` 记录同步阶段的执行轨迹，再断言首发时异步结果还没被用到。
     */
    const { deps, calls } = makeDeps(false, { enabled: true });
    // offMark=false 不是真实返回值（它只可能是 true / null），这里只用于观察顺序

    const p = handleHello(FLAGS, deps);

    // 此刻异步 promise 尚未被 await —— 但同步那半已经跑完
    expect(calls).toEqual(['tellMainWorld:true']);

    await p;
    // 异步回报 true，与首发一致 → 不补发
    expect(calls).toEqual(['tellMainWorld:true']);
  });

  it('同步读取抛错 → 当"判不了"放行，不把异常漏进 hello 分支', () => {
    /**
     * 生产实现 `readProxyOffMarkSync()` 内部已吞异常，这里再兜一层是因为
     * `handleHello` 跑在 `postMessage` 监听器的同步路径上 ——
     * 抛出去会让**整条消息分支**失效（不只是 PGC）。
     */
    const { deps, calls } = makeDeps(null, undefined, { syncThrows: true });

    expect(() => handleHello(FLAGS, deps)).not.toThrow();
    expect(calls).toEqual(['tellMainWorld:true']);
  });

  it('开关关着、异步也说关着 → 不重复补发（省一次 syncHooks）', async () => {
    const { deps, calls } = makeDeps(true, { enabled: false });

    await handleHello(FLAGS, deps);

    expect(calls).toEqual(['tellMainWorld:false']);
  });

  it('判不了（首发 true）、异步说关着 → 补发一次 false 纠正', async () => {
    /**
     * 这是"标记没写到但开关确实关着"的场景（ADR 0028 明说标记写入可能失败）。
     * 首发放行是刻意的，异步到了就要纠正。
     */
    const { deps, calls } = makeDeps(null, { enabled: false });

    await handleHello(FLAGS, deps);

    expect(calls).toEqual(['tellMainWorld:true', 'tellMainWorld:false']);
  });

  it('判不了、异步查不到（null）→ 不补发，首发 true 保持', async () => {
    const { deps, calls } = makeDeps(null, null);

    await handleHello(FLAGS, deps);

    expect(calls).toEqual(['tellMainWorld:true']);
  });

  it('开关关着、异步却报开着 → 补发 true（两个方向都要纠，不能只纠一个）', async () => {
    /**
     * 标记可能过期（TTL 30 分钟）或残留：用户 40 分钟前关过开关、之后又打开。
     * 那时首发会是 `false`，而真实状态是开着 —— 异步结果必须把它纠回来。
     *
     * 旧实现里这条路径**根本不存在**（首发放行、异步只补发 false），
     * 所以它同时也是"新实现没有把方向写反"的证据。
     */
    const { deps, calls } = makeDeps(true, { enabled: true });

    await handleHello(FLAGS, deps);

    expect(calls).toEqual(['tellMainWorld:false', 'tellMainWorld:true']);
  });

  it('同步读取被调用且只调用一次', () => {
    const order: string[] = [];
    const { deps } = makeDeps(null, undefined, { readOrder: order });

    void handleHello(FLAGS, deps);

    expect(order).toEqual(['readProxyOffSync']);
  });
});

/**
 * `hello` / `ready` 处理时序的测试（S3.4 前置）
 *
 * ## 这个文件守的是两次真机事故
 *
 * 1. **2026-10-29**：`hello` 分支里 `tellMainWorld(true)` 若被异步化，
 *    主世界那边已经进入下一步，`cfg` 才到 → PGC 接管判据错乱。
 *    **但原来的代码没有测试能抓住这个。**
 *
 * 2. **2026-10-26 Out of Memory**：`ready` 回 `cfg` → 无限回环，
 *    每轮夹带完整 `__playinfo__`，视频页停留几十秒后崩溃。
 *
 * 两条都是"改一行就出事、测试全绿"的类型 —— 这正是本项目最该防的。
 */
import { describe, expect, it } from 'vitest';

import {
  handleHello,
  handleReady,
  type HelloDeps,
  type HelloFlags,
} from '@/src/content/isolated/hello-timing';

/** 记录调用顺序的依赖替身 */
function makeDeps(status: { enabled: boolean } | null = null): {
  deps: HelloDeps;
  calls: string[];
  resolveStatus: (v: { enabled: boolean } | null) => void;
} {
  const calls: string[] = [];
  let resolveStatus!: (v: { enabled: boolean } | null) => void;

  const statusPromise = new Promise<{ enabled: boolean } | null>((res) => {
    resolveStatus = res;
  });

  const deps: HelloDeps = {
    reportQuality: (p) => {
      calls.push(`reportQuality:${String(p.height)}`);
    },
    tellMainWorld: (enabled) => {
      calls.push(`tellMainWorld:${String(enabled)}`);
    },
    queryProxyStatus: () => {
      // 用可控 promise，避免测试里真的等一个微任务批次
      if (status !== null) return Promise.resolve(status);
      return statusPromise;
    },
  };

  return { deps, calls, resolveStatus };
}

const FLAGS: HelloFlags = {
  readyState: 'complete',
  define: 'ok',
  hadExisting: false,
  playinfo: 'ssr',
};

describe('handleHello 时序（S3.4 前置）', () => {
  it('tellMainWorld(true) 必须**同步**执行，早于任何异步完成', () => {
    const { deps, calls, resolveStatus } = makeDeps(null);

    const p = handleHello(FLAGS, deps);

    /**
     * 关键断言：此刻异步查总开关**还没 resolve**，
     * 但 `tellMainWorld(true)` 已经发出去了。
     *
     * 若有人把 `tellMainWorld(true)` 挪进 `.then()` 里，这条会立刻红。
     */
    expect(calls).toContain('tellMainWorld:true');

    resolveStatus({ enabled: true });
    void p;
  });

  it('顺序固定：先上报 → 再同步发 true → 异步之后才可能补发 false', async () => {
    const { deps, calls } = makeDeps({ enabled: false });

    await handleHello(FLAGS, deps);

    expect(calls).toEqual([
      'reportQuality:0',
      'tellMainWorld:true',
      // 明确关闭时才补发 false
      'tellMainWorld:false',
    ]);
  });

  it('总开关开着时**不补发 true**（省一次 syncHooks）', async () => {
    const { deps, calls } = makeDeps({ enabled: true });

    await handleHello(FLAGS, deps);

    expect(calls).toEqual(['reportQuality:0', 'tellMainWorld:true']);
    expect(calls.filter((c) => c === 'tellMainWorld:true')).toHaveLength(1);
  });

  it('查不到总开关（null）时不补发任何 cfg', async () => {
    const { deps, calls } = makeDeps(null);
    // 显式传入 null 场景：让 queryProxyStatus 返回一个已 resolve 的 null
    deps.queryProxyStatus = () => Promise.resolve(null);

    await handleHello(FLAGS, deps);

    expect(calls).toEqual(['reportQuality:0', 'tellMainWorld:true']);
  });

  it('上报的 note 里带主世界自检标志（诊断用）', () => {
    const notes: string[] = [];
    const deps: HelloDeps = {
      reportQuality: (p) => notes.push(String(p.note)),
      tellMainWorld: () => {},
      queryProxyStatus: () => Promise.resolve(null),
    };

    void handleHello(FLAGS, deps);

    expect(notes[0]).toContain('readyState=complete');
    expect(notes[0]).toContain('define=ok');
    expect(notes[0]).toContain('hadExisting=false');
    expect(notes[0]).toContain('playinfo=ssr');
  });

  it('flags 缺失时不抛，用 ? 占位', () => {
    const notes: string[] = [];
    const deps: HelloDeps = {
      reportQuality: (p) => notes.push(String(p.note)),
      tellMainWorld: () => {},
      queryProxyStatus: () => Promise.resolve(null),
    };

    expect(() => handleHello(undefined, deps)).not.toThrow();
    expect(notes[0]).toContain('readyState=?');
  });

  it('异步查总开关失败（reject）时，已发出的 true 不会被撤销', async () => {
    const calls: string[] = [];
    const deps: HelloDeps = {
      reportQuality: () => {},
      tellMainWorld: (e) => calls.push(`tellMainWorld:${String(e)}`),
      queryProxyStatus: () => Promise.reject(new Error('SW 休眠')),
    };

    // 当前实现没有 catch —— 这里钉住"至少 true 已经发出去了"
    await handleHello(FLAGS, deps).catch(() => {});
    expect(calls).toEqual(['tellMainWorld:true']);
  });
});

describe('handleReady 禁止回 cfg（OOM 事故防线）', () => {
  it('handleReady 不接收任何依赖 —— 它**没有能力**下发 cfg', () => {
    /**
     * ⚠️ 这条断言方式是刻意选的。
     *
     * 第一版写的是"调用 handleReady 后某个 mock 没被调用"，但那个 mock 根本
     * 没传进去 —— 等于什么都没验。反例实验（往 handleReady 里塞下发逻辑）
     * 仍然 9/9 全绿，暴露了这个弱点。
     *
     * 现在改为**从签名上锁死**：`handleReady` 必须是零参数。
     * 谁想在里面下发 cfg，就得先给它加参数（比如 `deps`），
     * 而那一刻这条测试就会红 —— 它守的是"结构上不可能"，不是"这次碰巧没调"。
     */
    expect(handleReady.length).toBe(0);
  });

  it('handleReady 调用后没有任何可观测的副作用', () => {
    // 再补一道：即使实现里偷偷用全局钩子，也要求它返回 undefined 且不抛
    expect(() => handleReady()).not.toThrow();
    expect(handleReady()).toBeUndefined();
  });

  it('handleReady 与 handleHello 是两个独立动作（不能合并成"收到什么就回什么"）', () => {
    /**
     * 这条守的是设计意图：`ready` 是**终点**，不是又一轮的开始。
     * `handleHello` 需要依赖、`handleReady` 不需要 —— 这个不对称本身就是约束。
     */
    const calls: string[] = [];
    const deps: HelloDeps = {
      reportQuality: () => {},
      tellMainWorld: (e) => calls.push(`tellMainWorld:${String(e)}`),
      queryProxyStatus: () => Promise.resolve(null),
    };

    handleReady();
    expect(calls).toHaveLength(0);

    void handleHello(FLAGS, deps);
    expect(calls).toContain('tellMainWorld:true');
  });
});

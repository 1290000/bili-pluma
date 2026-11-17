// @vitest-environment jsdom

/**
 * 时间轴**原点**的接线测试（T12，2026-11-17）。
 *
 * ## 为什么单独一个文件
 *
 * `loading-trace.test.ts` 是 `node` 环境、只测纯函数那一半。而"原点真的被画出来"
 * 这件事发生在 `installLoadingTrace()` 里 —— 它要 `document` / `MutationObserver`，
 * 所以必须用 jsdom。
 *
 * ## 这条测的是什么
 *
 * 用户在真机上指着第一行 `1.53s` 问「这之前干什么去了」。答案的一半是
 * "取流请求没被采集"（`recordPlayurl()`，纯函数那一半已覆盖），另一半是
 * "时间轴连原点都没画"。这里守的就是后者：**安装即画出 `nav @ 0`**。
 *
 * 反例（会让这条变红）：把 `recordNavStart(state)` 从 `installLoadingTrace()` 里删掉，
 * 或者把它放进 `if (typeof Observer === 'function')` 分支里 —— 后者在 jsdom
 * （没有 `PerformanceObserver`）下就是"观察器装不上 → 连原点都没有"。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getLoadingSnapshot,
  installLoadingTrace,
  resetLoadingTrace,
  setLoadingTraceProxied,
} from '@/src/content/isolated/loading-trace';

/** 本文件装过的卸载函数；`null` = 当前没装 */
let dispose: (() => void) | null = null;

afterEach(() => {
  // 模块级单例在测试之间是共享的：不清掉，下一条会看到上一条装出来的状态
  dispose?.();
  dispose = null;
  resetLoadingTrace();
});

describe('installLoadingTrace —— 时间轴的原点（nav @ 0）', () => {
  it('★ 安装即画出原点：一条 nav @ t=0', () => {
    dispose = installLoadingTrace();

    expect(getLoadingSnapshot().events).toEqual([{ t: 0, stage: 'nav' }]);
  });

  it('重复安装不会多画一条（幂等）', () => {
    dispose = installLoadingTrace();
    installLoadingTrace();

    const navs = getLoadingSnapshot().events.filter((e) => e.stage === 'nav');
    expect(navs).toHaveLength(1);
  });

  it('卸载后清空；重新安装又是一条（那是新的观测窗口）', () => {
    const first = installLoadingTrace();
    expect(getLoadingSnapshot().events).toHaveLength(1);

    first();
    expect(getLoadingSnapshot().events).toEqual([]);

    dispose = installLoadingTrace();
    expect(getLoadingSnapshot().events.filter((e) => e.stage === 'nav')).toHaveLength(1);
  });

  /**
   * `present` 与 `confidence` 是两个问题，别混。
   *
   * 只有原点时：**观测到了**东西（present = true），但**一条线路都没识别出来**
   * （confidence = 'none'）。若有人为了让 `present` 保持 false 而把 nav 藏起来，
   * 时间轴就又回到"第一行是 1.53s"那个状态了。
   */
  it('只有原点时 present=true、confidence=none、actual=null', () => {
    dispose = installLoadingTrace();
    const snapshot = getLoadingSnapshot();

    expect(snapshot.present).toBe(true);
    expect(snapshot.confidence).toBe('none');
    expect(snapshot.actual).toBeNull();
    expect(snapshot.hosts).toEqual([]);
  });

  /**
   * `setLoadingTraceProxied()` 只写一个布尔，**不产生事件**。
   *
   * 反例：让它顺手补一条 `ext-patch` → 时间轴会在"还没发生任何取流"时
   * 就出现「扩展介入」，那是在陈述一件没发生的事。
   */
  it('setLoadingTraceProxied 只写标记，不往时间轴里塞事件', () => {
    dispose = installLoadingTrace();
    const before = getLoadingSnapshot().events.length;

    setLoadingTraceProxied(true);
    setLoadingTraceProxied(false);

    const after = getLoadingSnapshot();
    expect(after.events).toHaveLength(before);
    expect(after.events.some((e) => e.stage === 'ext-patch')).toBe(false);
  });
});

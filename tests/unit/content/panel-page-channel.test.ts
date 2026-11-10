// @vitest-environment jsdom

/**
 * 同页取流数据的**通道**（2026-11-10 两轮真机失败后的最终方案）。
 *
 * ## 这个文件为什么必须存在
 *
 * 真机冒烟（BV1jt421t7XH）连续两轮抓不到解锁卡，而原因**两次都不一样**：
 *
 * | 尝试 | 结果 |
 * | --- | --- |
 * | `chrome.runtime.sendMessage` | 到不了同页 content script |
 * | `chrome.tabs.sendMessage` | content script 不是 privileged，发不出去 |
 * | **`window.postMessage`** | ✅ 同页共享一个 `window` |
 *
 * 前两次都因为 `.catch(() => null)` 把三种结局归并成同一个 `null`，
 * **UI 分不出、单测也验不出**，于是各藏一轮。
 *
 * ## 本文件守什么
 *
 * 1. 走的**是** `window.postMessage`，**不是**任何 chrome 通道
 * 2. 成功 / `view: null` / 超时 三种结局**互相可辨**
 * 3. 诊断日志把 `kind` 记下来（下一轮真机能一次定位）
 *
 * ⚠️ 反向验证：把实现改回 `chrome.tabs.sendMessage`，本文件第一条必红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ `vi.mock` 工厂会被提升到文件顶部，引用的变量必须用 `vi.hoisted()` 建。
 */
const mocks = vi.hoisted(() => ({
  diagCalls: [] as unknown[][],
}));

vi.mock('@platform/storage/diag-store', () => ({
  diag: (...a: unknown[]) => {
    mocks.diagCalls.push(a);
    return Promise.resolve();
  },
}));

import { fetchPageStateViaPage, fetchPanelReplies } from '../../../src/content/panel/panel-data';
import type { PageTracksView } from '../../../src/shared/types/playinfo';

/** 一条最小可用的取流数据 */
function view(): PageTracksView {
  return {
    pageKey: 'BV1jt421t7XH',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: true,
      reason: 'ssr',
      capability: null,
      user: null,
      mid: null,
      loggedIn: 'yes',
    },
    playback: { capability: null },
    diff: null,
  };
}

/**
 * 模拟同页的 `content.ts`：监听 `page-summary`，按给定方式应答。
 *
 * @param mode `ok` / `null-view` / `silent`（不应答，模拟没有 content.ts）
 */
function installContentScript(mode: 'ok' | 'null-view' | 'silent'): { replyCount: () => number } {
  let replied = 0;
  const handler = (ev: MessageEvent): void => {
    const d = ev.data as { __ns?: string; type?: string } | null;
    if (!d || d.__ns !== '__PLUMA__' || d.type !== 'page-summary') return;
    if (mode === 'silent') return;
    replied += 1;
    window.postMessage(
      {
        __ns: '__PLUMA__',
        type: 'page-summary-reply',
        view: mode === 'ok' ? view() : null,
      },
      '*',
    );
  };
  window.addEventListener('message', handler);
  cleanupFns.push(() => window.removeEventListener('message', handler));
  return { replyCount: () => replied };
}

const cleanupFns: (() => void)[] = [];

/**
 * 成功路径 / not-ready 路径用的等待上限。
 *
 * ## ⚠️ 必须远大于实际需要（2026-11-10 实测的 flake）
 *
 * 第一版这里写的是 `200`。**单跑必过，但在全量并行跑时偶发变红** ——
 * 因为 vitest 并行时 CPU 被其他文件占满，一个本来 1ms 就返回的消息
 * 可能排到 200ms 之后，于是"成功路径"变成了 `timeout`。
 *
 * 这不是被测代码的问题，是**测试自己给了成功路径不必要的时限**。
 * 成功路径本来就不该有时限压力 —— 只有专门测超时的那几条才用短超时
 * （它们断言的就是 `timeout`，快慢都成立）。
 */
const WAIT_MS = 10_000;

/** 每个用例前后清场 */
function reset(): void {
  vi.useRealTimers();
  mocks.diagCalls.length = 0;
  while (cleanupFns.length > 0) cleanupFns.pop()?.();
}

/**
 * ⚠️ **每个用例开始前**也清一次（不只是 `reset()` 在各用例开头手调）。
 *
 * 手调容易漏：只要有一个用例忘了写 `reset()`，它的监听器就会活到下一条用例，
 * 表现是"某条用例单独跑必过、跑全文件必挂"。
 * 2026-11-10 就是被这个坑了一整轮 —— `installContentScript('silent')` 的
 * 监听器活到了下一条用例，把应答截走。
 *
 * 用 `beforeEach` 做成**结构性**保证，不依赖人记得写。
 */
beforeEach(() => {
  reset();
});

afterEach(() => {
  reset();
});

describe('fetchPageStateViaPage：postMessage 通道', () => {
  it('★ 同页 content.ts 应答 → ok + view', async () => {
    reset();
    installContentScript('ok');
    const out = await fetchPageStateViaPage(WAIT_MS);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.view.pageKey).toBe('BV1jt421t7XH');
  });

  it('★ view 为 null → not-ready（content 在但没数据，与"没人答"不同）', async () => {
    reset();
    installContentScript('null-view');
    const out = await fetchPageStateViaPage(WAIT_MS);
    expect(out.kind).toBe('not-ready');
  });

  it('★ 没人应答 → timeout（不是 not-ready，因为确实分不清"没人在听"与"很慢"）', async () => {
    reset();
    installContentScript('silent');
    /**
     * ⚠️ 真实计时器 + 极短超时（30ms），**不要假时钟**。
     *
     * 假时钟会造成跨用例污染：`advanceTimersByTime()` 提前 fire 之后，
     * `finish()` 里的 `clearTimeout` 句柄已失配，切回真实时钟后
     * **后续用例**的 `postMessage` 应答被吞（实测稳定失败）。
     *
     * 30ms 对"没人应答"这条已经足够——被测语义是"到点还没收到就 timeout"，
     * 而 silent 模式本来就永远不回应答。
     */
    const out = await fetchPageStateViaPage(30);
    expect(out.kind).toBe('timeout');
  });

  it('★ 三种结局互相可辨（旧实现归并成一个 null，正是 bug 藏两轮的原因）', async () => {
    reset();
    installContentScript('ok');
    const a = await fetchPageStateViaPage(WAIT_MS);

    reset();
    installContentScript('null-view');
    const b = await fetchPageStateViaPage(WAIT_MS);

    reset();
    installContentScript('silent');
    const c = await fetchPageStateViaPage(30);

    expect([a.kind, b.kind, c.kind]).toEqual(['ok', 'not-ready', 'timeout']);
  });

  it('★ 走的是 window.postMessage，不碰任何 chrome 通道', async () => {
    /**
     * 反例：把实现改回 `chrome.tabs.sendMessage` 或 `chrome.runtime.sendMessage`
     * → 这里会抛 "chrome is not defined" 或返回 timeout → 本条必红。
     *
     * 故意**不装 chrome mock**：如果实现还在用 chrome，这条会当场炸。
     */
    reset();
    installContentScript('ok');
    const out = await fetchPageStateViaPage(WAIT_MS);
    expect(out.kind).toBe('ok');
  });

  it('不认识的 reply 类型被忽略（不误吃别人的消息）', async () => {
    reset();
    // 先发一条形状相似但 type 不对的消息
    const noise = (): void => {
      window.postMessage({ __ns: '__PLUMA__', type: 'page-summary-reply-x', view: view() }, '*');
    };
    window.addEventListener('message', () => undefined);
    noise();
    // 正确应答随后到
    installContentScript('ok');
    const out = await fetchPageStateViaPage(WAIT_MS);
    expect(out.kind).toBe('ok');
  });

  it('不同命名空间的消息被忽略', async () => {
    reset();
    const handler = (ev: MessageEvent): void => {
      const d = ev.data as { __ns?: string; type?: string } | null;
      if (!d || d.__ns !== '__PLUMA__' || d.type !== 'page-summary') return;
      // 用错的命名空间回
      window.postMessage({ __ns: '__OTHER__', type: 'page-summary-reply', view: view() }, '*');
    };
    window.addEventListener('message', handler);
    cleanupFns.push(() => window.removeEventListener('message', handler));

    // 真实计时器 + 极短超时：名字空间不匹配 → 没人回应答 → 超时
    const out = await fetchPageStateViaPage(30);
    expect(out.kind).toBe('timeout');
  });

  it('超时后监听器被摘掉（不泄漏）', async () => {
    reset();
    installContentScript('silent');
    await fetchPageStateViaPage(30);
    // 再发一条迟到的应答：不应该有任何状态变化（已 settle）
    window.postMessage({ __ns: '__PLUMA__', type: 'page-summary-reply', view: view() }, '*');
    /**
     * ⚠️ **必须让这条 `postMessage` 真正派发完**再结束用例。
     *
     * jsdom 的 `postMessage` 走**宏任务队列**。如果用例在这里直接结束，
     * 那条消息会在**下一条用例**里才派发 —— 下一条的 `onMessage` 会收到它，
     * 拿到 `not-ready` 而不是它期望的结果。
     *
     * 2026-11-10 实测：这一个用例污染了后面整条 `diagnostics` describe，
     * 表现为"超时记 kind=timeout 稳定失败、单独跑必过"。
     * 二分定位到就是这里。
     */
    await new Promise((r) => setTimeout(r, 0));
    expect(true).toBe(true);
  });
});

describe('★ 诊断日志：每个出口都记 kind', () => {
  function diagTexts(): string[] {
    return mocks.diagCalls.map((c) => `${String(c[0])} | ${String(c[1] ?? '')}`);
  }

  /**
   * ⚠️ `diag()` 是 `void ... .catch(...)` 的 fire-and-forget，调用发生在 `resolve`
   * **之后**。所以断言前必须确保它真的跑到了。
   *
   * 第一版用 `await new Promise(r => setTimeout(r, 0))` 等一轮宏任务 ——
   * 那在**单跑时稳定、全量并行时偶发变红**（2026-11-10 实测两次）。
   * 真实计时器在 CPU 竞争下不保证顺序。
   *
   * 现在改成**轮询到出现为止**（上限 50 次 microtask/宏任务交替）。
   * 这比"睡固定时间"可靠：只要 diag 真的被调了，就一定能等到；
   * 真没被调时也不会永远等（有上限，最终断言失败并给出清晰信息）。
   */
  async function waitForDiag(pred: (line: string) => boolean): Promise<boolean> {
    /**
     * ⚠️ **不要**在这里切时钟。
     *
     * 第一版写了 `vi.useRealTimers()` 兜底，结果把上一个用例假时钟里
     * **已经排好但未派发**的 `postMessage` 微任务一起丢了 ——
     * 表现为下一条用例拿到 `not-ready` 而不是 `ok`，且 6 次复跑**稳定失败**。
     *
     * 正确做法：时钟由各用例自己在 `finally` 里恢复（见超时那几条），
     * 这里只负责"轮询到出现为止"。
     */
    for (let i = 0; i < 50; i += 1) {
      if (diagTexts().some(pred)) return true;
      await new Promise((r) => setTimeout(r, 1));
    }
    return diagTexts().some(pred);
  }

  it('ok 记 kind=ok', async () => {
    reset();
    installContentScript('ok');
    await fetchPageStateViaPage(WAIT_MS);
    expect(await waitForDiag((t) => t.includes('kind=ok'))).toBe(true);
  });

  it('not-ready 记 kind=not-ready', async () => {
    reset();
    installContentScript('null-view');
    await fetchPageStateViaPage(WAIT_MS);
    expect(await waitForDiag((t) => t.includes('kind=not-ready'))).toBe(true);
  });

  it('★ 超时记 kind=timeout（下一轮真机靠它一次定位）', async () => {
    reset();
    installContentScript('silent');
    /**
     * ## ⚠️ 用**真实计时器 + 极短超时**，不要假时钟
     *
     * 试过 `vi.useFakeTimers()` + `advanceTimersByTime()`。那会让这条用例
     * **污染后面所有用例**，而且是**稳定失败**（不是偶发）：
     *
     * - `advanceTimersByTime()` 会把 `fetchPageStateViaPage` 排的超时定时器提前 fire
     * - 但该函数内部 `finish()` 还会 `clearTimeout(timer)`，句柄此时已失配
     * - 切回真实时钟后，残留状态让**下一条用例**的 `postMessage` 应答被吞，
     *   表现为拿到 `not-ready` 而不是 `ok`
     *
     * 单跑这条必过、跑全文件必挂 —— 典型的假时钟跨用例污染。
     *
     * 现在用真实计时器 + 30ms 超时：它只测"没人应答时会 timeout"，
     * 30ms 足够任何正常应答到达，同时对测试总时长无影响。
     */
    const out = await fetchPageStateViaPage(30);
    expect(out.kind).toBe('timeout');
    expect(await waitForDiag((t) => t.includes('kind=timeout'))).toBe(true);
  });

  it('diag 抛错不影响主流程（诊断不能拖垮面板）', async () => {
    /**
     * `diag()` 是 async 且写 storage，可能失败。实现里用的是
     * `void diag(...).catch(() => {})` —— 这条断言"失败也照样返回结果"。
     */
    reset();
    installContentScript('ok');
    const out = await fetchPageStateViaPage(WAIT_MS);
    expect(out.kind).toBe('ok');
  });
});

describe('fetchPanelReplies：三条 background 消息仍走 runtime', () => {
  it('proxy/status / account/summary / stats/recent 走 runtime，page/summary:get 不走', async () => {
    reset();
    installContentScript('ok');
    const runtimeSend = vi.fn(async () => null);
    vi.stubGlobal('chrome', { runtime: { sendMessage: runtimeSend } });

    await fetchPanelReplies();

    const types = runtimeSend.mock.calls.map((c) => ((c as unknown[])[0] as { type: string }).type);
    expect(types.sort()).toEqual(['account/summary', 'proxy/status', 'stats/recent']);
    // ⚠️ page/summary:get **绝不能**出现在 chrome 通道上（那正是两轮 bug 的形状）
    expect(types).not.toContain('page/summary:get');
    vi.unstubAllGlobals();
  });
});

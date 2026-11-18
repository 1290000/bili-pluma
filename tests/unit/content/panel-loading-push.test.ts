// @vitest-environment jsdom

/**
 * 换集后**主动重取**的接线（2026-11-20）。
 *
 * ## 这一条修的是什么（真机实测的空白，两条数字）
 *
 * | 现象 | 实测 |
 * | --- | --- |
 * | 面板开着累计 900.4 秒 | **0 次取数** |
 * | 换集本身产生的取数 | **0 条**（只有点 ⟳ 或「收起→再展开」才重取） |
 *
 * 于是用户换完集把鼠标快速移到侧边条，时间轴停在旧数据上。修法是推送：
 * `entrypoints/content.ts` 在三处 `resetLoadingTrace()` 之后各发一条
 * `{ __ns, type: 'loading-changed' }`（**不含任何数据**），面板收到就重取。
 *
 * ## 为什么还要一次补救取数
 *
 * 实测时序：reset 在 `pushState` 后 28.0–49.2ms 完成，而**新集首波 `.m4s` 在
 * 577.1–848.1ms 才到** —— 通知到达面板时采集器里几乎必然还是空的
 * （实测空窗期内 `hosts` 恒为 0）。所以第一次重取只拿到"下载视频片段"那两行，
 * 没有「可以播放」「开始播放」。
 *
 * 补救**只排一次**（1200ms），且只在"确实还没到"时才真的再取一次。
 * ⚠️ 不是轮询：项目硬纪律，不许常驻定时器（曾因此挂后台白屏）。
 *
 * ## mutation 检验
 *
 * 把 `panel.ts` 的 `onLoadingPush` 去掉一次 `refreshLoading()`（或让
 * `onLoadingChanged` 恒不回调），本文件三条核心用例立刻转红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody, type PanelController } from '../../../src/content/panel/panel';
import type { PanelModel } from '../../../src/content/panel/panel-data';
import type { LoadingSnapshotLite } from '../../../src/content/isolated/loading-trace';

/**
 * ⚠️ 面板要用**真的** `onLoadingChanged`，但取数必须可数。
 *
 * `refreshLoading()` 内部调的是 `panel-data.ts` 的 `fetchLoadingSnapshot`，
 * 而那条会真的发 `postMessage` 等 2 秒。所以这里 mock `panel-data` 模块 ——
 * **但保留 `onLoadingChanged` 的真实现**（那正是本文件要验的东西）。
 *
 * 手法：`vi.mock` 里用 `importOriginal` 拿到真模块，只覆盖取数那一个导出。
 */
const fetchLoadingSnapshot =
  vi.fn<(input: { pageKind: string; timeoutMs?: number }) => Promise<unknown>>();

vi.mock('../../../src/content/panel/panel-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/content/panel/panel-data')>();
  return {
    ...actual,
    // 只替换"去哪拿"，判据 / 消息形状 / 取消订阅全部走真实实现
    fetchLoadingSnapshot: (input: { pageKind: string; timeoutMs?: number }) =>
      fetchLoadingSnapshot(input),
  };
});

/** 面板动作的公共默认值（本文件不关心胶囊与推荐流） */
const ACTS = {
  login: () => undefined,
  logout: async () => ({ ok: true }),
  streamingIdentity: null,
  toggleStreamingIdentity: () => undefined,
  feedAccountEnabled: false,
  toggleFeedAccount: () => undefined,
  currentStreamingIdentity: () => undefined,
} as const;

/** 一份"只有播放请求、还没有分片"的半成品快照（正是空窗期里拿到的样子） */
function emptyish(): LoadingSnapshotLite {
  return {
    present: true,
    confidence: 'none',
    actual: null,
    hosts: [],
    events: [{ t: 30, stage: 'playurl-req' }],
    truncated: false,
    video: null,
    originT: 0,
  };
}

/** 一份"首波分片已到、已起播"的完整快照 */
function complete(): LoadingSnapshotLite {
  return {
    present: true,
    confidence: 'measured',
    actual: { host: 'a.bilivideo.com', cls: 'official', flavor: 'self-built' },
    hosts: [
      {
        host: 'a.bilivideo.com',
        cls: 'official',
        flavor: 'self-built',
        hostCls: 'official',
        count: 3,
      },
    ],
    events: [
      { t: 0, stage: 'seg-req', host: 'a.bilivideo.com', kind: 'official' },
      { t: 200, stage: 'seg-res', host: 'a.bilivideo.com', kind: 'official' },
      { t: 465, stage: 'canplay' },
      { t: 480, stage: 'playing' },
    ],
    truncated: false,
    video: { readyState: 4, durationSec: 1441, height: 1080, errorCode: 0 },
    originT: 3225000,
  };
}

/** 最小可用模型（本文件只关心 `loading`） */
function model(): PanelModel {
  return {
    quality: {
      pill: '未生效',
      tone: 'neutral',
      line: null,
      unlock: null,
      proxyEnabled: true,
      pageKind: 'play',
    },
    clean: null,
    account: {
      primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
      playback: null,
      unknown: false,
      hasCredential: false,
      proxyEnabled: false,
      needsLogin: true,
    },
    pageKind: 'play',
    pageStateKind: 'ok',
    pageView: null,
  };
}

let controller: PanelController | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  fetchLoadingSnapshot.mockReset();
  controller = mountPanelBody(ACTS);
  controller.setModel(model());
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  vi.useRealTimers();
  document.body.textContent = '';
});

/** 让同页"content.ts"发一条换集通知（走真的 postMessage，判据一起验） */
function pushLoadingChanged(): void {
  window.postMessage({ __ns: '__PLUMA__', type: 'loading-changed' }, '*');
}

/**
 * 把 jsdom 的 `postMessage` 宏任务队列跑干净。
 *
 * ⚠️ 两个坑叠在一起：
 * 1. `await Promise.resolve()` **不够** —— jsdom 的 `postMessage` 派发是一个真实的
 *    **宏任务**，微任务队列清空时监听器还没跑到。
 * 2. 本文件装了**假时钟**，所以不能 `await new Promise(setTimeout)` 去等真时间 ——
 *    那会永远等不到（假时钟不会自己前进），表现是每条用例 5 秒超时。
 *    必须让假时钟自己走一格：`advanceTimersByTimeAsync(0)`。
 */
async function flushPostMessage(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('★★ 换集通知 → 面板重取（推送，不是轮询）', () => {
  it('★★ 收到 loading-changed → 立刻取一次数', async () => {
    fetchLoadingSnapshot.mockResolvedValue({ kind: 'ok', snapshot: complete() });

    pushLoadingChanged();
    await flushPostMessage();

    expect(fetchLoadingSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchLoadingSnapshot.mock.calls[0]?.[0]).toMatchObject({ pageKind: 'play' });
  });

  it('★★ 空窗期（hosts 为空）→ **只补一次** 1200ms 后的取数，且不是轮询', async () => {
    /**
     * 第一次拿到的是空窗期的半成品（`hosts` 空），所以补救取数必须发生。
     * 断言"恰好两次"是本条的关键：**第三次**就说明有人写成了轮询。
     */
    fetchLoadingSnapshot
      .mockResolvedValueOnce({ kind: 'ok', snapshot: emptyish() })
      .mockResolvedValueOnce({ kind: 'ok', snapshot: complete() });

    pushLoadingChanged();
    await flushPostMessage();
    expect(fetchLoadingSnapshot).toHaveBeenCalledTimes(1);

    // 空窗实测 288–932ms；1200ms 之前不许动
    await vi.advanceTimersByTimeAsync(1_199);
    expect(fetchLoadingSnapshot, '1200ms 之前就补取了 — 那时首波分片还没到').toHaveBeenCalledTimes(
      1,
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLoadingSnapshot).toHaveBeenCalledTimes(2);

    // 再等 10 秒：**不许**有第三次（常驻定时器禁令）
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchLoadingSnapshot, '补取之后还在取 — 这是轮询').toHaveBeenCalledTimes(2);
  });

  it('★ 第一次就拿到完整快照（有 hosts + playing）→ **不**补取', async () => {
    fetchLoadingSnapshot.mockResolvedValue({ kind: 'ok', snapshot: complete() });

    pushLoadingChanged();
    await flushPostMessage();
    expect(fetchLoadingSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    // 数据已经齐了，再取一次纯属浪费（而且会让 ⟳ 与推送互相超车）
    expect(fetchLoadingSnapshot).toHaveBeenCalledTimes(1);
  });

  it('★ 收到推送后 `model.loading` 被换掉（速览行与浮层读同一份）', async () => {
    fetchLoadingSnapshot.mockResolvedValue({ kind: 'ok', snapshot: complete() });

    pushLoadingChanged();
    await flushPostMessage();

    /**
     * 速览行（`.ld-quick-title`）走 `describeSnapshotLine()`，结论来自
     * `snapshot.actual` —— 只有 `model.quality.loading` 也被换掉它才会变。
     *
     * ⚠️ 这正是旧实现的隐患：`refreshLoading()` 原本只写 `model.loading`
     * （浮层读的那个），速览行读 `model.quality.loading`，于是"浮层刷新了、
     * 速览行还是旧值"。归零 + 主动推送之后这个偏差会更容易被看见。
     */
    const line = controller?.root.querySelector('.ld-quick-title')?.textContent ?? '';
    expect(line).toContain('B站官方线路');
  });

  it('⛔ 卸载（dispose）之后，再推送**一次都不取**（监听必须被摘掉）', async () => {
    /**
     * `window` 上的监听器不跟着 DOM 走：不摘的话用户每关一次开关就多叠一层，
     * 之后一次换集会触发 N 次重取（N = 曾经挂载过的次数）。
     */
    fetchLoadingSnapshot.mockResolvedValue({ kind: 'ok', snapshot: complete() });
    controller?.dispose();

    pushLoadingChanged();
    await flushPostMessage();

    expect(fetchLoadingSnapshot).not.toHaveBeenCalled();
  });

  it('★ dispose 会清掉待触发的补取定时器（不留下一个悬空 setTimeout）', async () => {
    fetchLoadingSnapshot.mockResolvedValueOnce({ kind: 'ok', snapshot: emptyish() });

    pushLoadingChanged();
    await flushPostMessage();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    controller?.dispose();
    // 补救取数被清掉 → 到点也不该再取
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchLoadingSnapshot).toHaveBeenCalledTimes(1);
  });

  it('⛔ 别的消息（应答 / 别命名空间）不触发取数', async () => {
    // 不发 loading-changed，只发别的形状 —— 一次取数都不该发生
    window.postMessage({ __ns: '__PLUMA__', type: 'loading-snapshot-reply' }, '*');
    window.postMessage({ __ns: 'other', type: 'loading-changed' }, '*');
    window.postMessage({ type: 'loading-changed' }, '*');
    await flushPostMessage();

    expect(fetchLoadingSnapshot).not.toHaveBeenCalled();
  });
});

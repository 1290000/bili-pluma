/**
 * verifier 探针（task-27 判据 2 + 判据 5）：孤儿态文案 + logsMeta 缺字段不崩渲染
 *
 * ## 为什么选「渲染输出」而不是「剥注释后的源码」
 *
 * 判据 2 要回答的是**用户看到什么**（孤儿态下不许出现「还没有日志。」）。
 * 源码级断言只能证明"代码里有那几句字"，证明不了分支真的按 ok 分流 ——
 * 而上一条卡（task-25）刚吃过"源码里判据对了、运行时走不到"的亏。
 * 反过来说渲染输出的**假绿风险**是：断言写成 `.not.toContain('还没有日志')` 时，
 * 只要页面因为别的原因（采集失败、面板没渲染）一片空白，它就**恒真**。
 * 所以下面每条都**成对**断言：既有"不许出现"，也有"必须出现"的正面文案。
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectFacts: vi.fn(),
  readDiag: vi.fn(),
  tipFor: vi.fn(),
  readBadgeEnabled: vi.fn(),
  writeBadgeEnabled: vi.fn(),
  readRawCleanOptions: vi.fn(),
}));

vi.mock('@platform/diagnostics/collect', () => ({
  collectFacts: (...a: unknown[]) => mocks.collectFacts(...a),
  tipFor: (...a: unknown[]) => mocks.tipFor(...a),
  readLastDiagEcho: () => null,
}));

vi.mock('@platform/storage/diag-store', () => ({
  readDiag: (...a: unknown[]) => mocks.readDiag(...a),
  readDiagTrace: async () => null,
  DIAG_LIMIT: 30,
  instanceId: () => 'test01',
}));

vi.mock('@platform/storage/ui-prefs-store', () => ({
  readRawCleanOptions: (...a: unknown[]) => mocks.readRawCleanOptions(...a),
  writeCleanOptionFlags: async () => undefined,
  writeCleanHideCategories: async () => undefined,
  readBadgeEnabled: (...a: unknown[]) => mocks.readBadgeEnabled(...a),
  writeBadgeEnabled: (...a: unknown[]) => mocks.writeBadgeEnabled(...a),
}));

vi.mock('../../../src/content/site-clean/ads', () => ({ applyAdClean: () => undefined }));
vi.mock('../../../src/content/site-clean/home-clean', () => ({ applyHomeClean: () => undefined }));

import { mountPanelBody } from '../../../src/content/panel/panel';
import { diagnosticsPane } from '../../../src/content/panel/diagnostics';
import type { PanelModel } from '../../../src/content/panel/panel-data';

const ACTS = {
  login: () => undefined,
  logout: async () => ({ ok: true }),
  streamingIdentity: null,
  toggleStreamingIdentity: () => undefined,
  feedAccountEnabled: false,
  toggleFeedAccount: () => undefined,
  currentStreamingIdentity: () => undefined,
} as const;

function model(): PanelModel {
  return {
    quality: {
      pill: '未生效',
      tone: 'neutral',
      line: null,
      unlock: null,
      proxyEnabled: true,
      pageKind: 'other',
    },
    clean: {
      options: {
        adEnabled: false,
        adPreserveEventBanner: false,
        adDebug: false,
        homeHideSwipe: false,
      },
      hideCategories: [],
    },
    account: {
      primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' },
      playback: null,
      unknown: false,
      hasCredential: true,
      needsLogin: false,
    },
    pageKind: 'other',
    pageStateKind: 'ok',
    pageView: null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** 把 storage 的 get 换成按 key 行为不同的实现 */
function stubStorage(byKey: (key: unknown) => Promise<unknown>): void {
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
    storage: { local: { get: (k: unknown) => byKey(k) } },
  });
}

/** 进诊断浮层并返回渲染后的可见文本 */
async function renderDiag(): Promise<string> {
  const c = mountPanelBody(ACTS);
  c.setModel(model());
  c.showTab('display');
  [...c.root.querySelectorAll('.sub-entry')]
    .find((e) => e.textContent?.includes('诊断'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
  return c.root.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectFacts.mockResolvedValue([{ label: 'InPrivate 权限', value: '已允许', ok: true }]);
  mocks.tipFor.mockReturnValue('规则齐全。');
  mocks.readBadgeEnabled.mockResolvedValue(true);
  mocks.readRawCleanOptions.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

describe('★ 判据 2：孤儿态浮层文案（成对断言，防空白假绿）', () => {
  it('★★ 探针与真读都抛（真实孤儿态）：说"读取失败" + 能做的事，不出现"还没有日志"', async () => {
    stubStorage(async () => {
      throw new Error('Extension context invalidated.');
    });
    mocks.readDiag.mockRejectedValue(new Error('Extension context invalidated.'));
    const text = await renderDiag();
    // 正面：诊断页确实渲染了（否则下一条"不出现"是空白假绿）
    expect(text, '诊断页没渲染出来，下面的断言会假绿').toContain('自检信息');
    // 采集整体失败时 facts 为空（panel.ts 的 catch 分支），所以不断言 InPrivate 权限；
    // 只靠"自检信息"证明诊断页骨架画出来了 —— 那才是空白假绿的反面。
    expect(text).toContain('诊断日志读取失败');
    expect(text).toContain('刷新');
    expect(text).toContain('Extension context invalidated.');
    expect(text, '孤儿态被渲染成了"还没有日志"').not.toContain('还没有日志');
  });

  it('★★★ 探针成功、真读失败：仍然不许说"还没有日志"（这条是当前实现的红点）', async () => {
    stubStorage(async () => ({}));
    mocks.readDiag.mockRejectedValue(new Error('boom'));
    const text = await renderDiag();
    expect(text, '诊断页没渲染出来，下面的断言会假绿').toContain('自检信息');
    expect(text, '真读失败了，界面却说"还没有日志"').not.toContain('还没有日志');
    expect(text, '真读失败了，界面必须说明读取失败').toContain('诊断日志读取失败');
  });

  it('真的没有日志（读到 0 条且成功）才显示"还没有日志"，且不显示失败文案', async () => {
    stubStorage(async () => ({}));
    mocks.readDiag.mockResolvedValue([]);
    const text = await renderDiag();
    expect(text).toContain('自检信息');
    expect(text).toContain('还没有日志');
    expect(text).not.toContain('诊断日志读取失败');
  });
});

describe('★ 判据 5：logsMeta 缺字段不许崩渲染', () => {
  it('★★★ 直接调 diagnosticsPane：data 里没有 logsMeta 时不许抛', () => {
    const noop = (): void => undefined;
    const data = {
      rows: [{ label: 'InPrivate 权限', value: '已允许', ok: true }],
      logs: [],
      version: '0.0.0-test',
    };
    let box: HTMLElement | null = null;
    expect(typeof diagnosticsPane, 'diagnosticsPane 不是函数，探针坏了').toBe('function');
    let threw: unknown = null;
    let stage = 'call';
    try {
      box = diagnosticsPane(
        // 故意缺 logsMeta —— 模拟"调用方忘了传"（上次真崩溃的形态）
        data as unknown as Parameters<typeof diagnosticsPane>[0],
        { back: noop, exportJson: noop, refresh: noop },
      );
      stage = 'called';
    } catch (e) {
      threw = e;
      stage = `caught:${(e as Error)?.stack ?? String(e)}`;
    }
    // eslint-disable-next-line no-console
    console.log(`[VERIFIER] stage=${stage}`);
    expect(threw, `diagnosticsPane 在缺 logsMeta 时抛了：${String(threw)}`).toBeNull();
    // eslint-disable-next-line no-console
    console.log(`[VERIFIER] threw=${String(threw)} box=${box === null ? 'null' : (box as HTMLElement).textContent}`);
    expect(box, '没画出任何东西').not.toBeNull();
    expect(box?.textContent ?? '', '缺字段时连自检信息都没画出来').toContain('InPrivate 权限');
  });
});

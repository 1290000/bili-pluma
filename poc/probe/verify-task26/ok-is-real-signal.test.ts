/**
 * verifier 探针（task-27）：`ok` 是不是真信号？
 *
 * ## 为什么不能只信 `panel-diag-wiring.test.ts` 那三条
 *
 * 那三条都是**自己把 storage 打挂**（`get` 直接 throw），实现怎么写的都能过 ——
 * 它证明不了"探针成功但真读失败"这一格。
 *
 * 这里用**行为不同**的两次调用区分三种情形：
 * - 探针 `get(null)` 成功、真读 `get(DIAG_KEY)` 成功 → ok 必须 **true**
 * - 探针成功、真读 **抛错** → 探针与真读不一致，ok 必须 **false**（否则导出谎报"读到 0 条"）
 * - 探针抛错、真读成功 → 同样不一致，ok 必须 **false**
 *
 * 判别手段：探针一定调 `get(null)`（读全部），`readDiag()` 一定调 `get(DIAG_KEY)`。
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIAG_KEY = 'pluma:diag';

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
      options: { adEnabled: false, adPreserveEventBanner: false, adDebug: false, homeHideSwipe: false },
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

/**
 * 进诊断浮层 → 点导出 → 返回解析后的导出对象。
 * （`URL.revokeObjectURL` 的 stub 故意留在全局：`downloadJson()` 的 setTimeout 排在用例之后）
 */
async function exportDiag(): Promise<Record<string, unknown>> {
  const c = mountPanelBody(ACTS);
  c.setModel(model());
  c.showTab('display');

  [...c.root.querySelectorAll('.sub-entry')]
    .find((e) => e.textContent?.includes('诊断'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();

  let exported: string | null = null;
  URL.createObjectURL = ((blob: Blob) => {
    void blob.text().then((t) => {
      exported = t;
    });
    return 'blob:fake';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

  [...c.root.querySelectorAll('.sub-entry')]
    .find((e) => e.textContent?.includes('导出'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 30; i += 1) await Promise.resolve();

  expect(exported, '没捕获到导出内容').not.toBeNull();
  return JSON.parse(exported ?? '{}') as Record<string, unknown>;
}

interface Meta {
  ok: boolean;
  err: string | null;
  count: number;
  limit: number;
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

describe('★ 判据 1：ok 必须是真读取信号', () => {
  it('★★ (a) 读到 0 条但读取成功 → ok 必须为 true', async () => {
    // 探针读到 {} ；真读也读到空 → "真的一条都没有"
    stubStorage(async () => ({}));
    mocks.readDiag.mockResolvedValue([]);
    const obj = await exportDiag();
    const meta = obj.logsMeta as Meta;
    expect(obj.logs).toEqual([]);
    expect(meta.ok, '读到 0 条被误判成"读失败"').toBe(true);
    expect(meta.err).toBeNull();
    expect(meta.count).toBe(0);
  });

  it('★★ (b) 读取抛错（孤儿态）→ ok 必须为 false', async () => {
    stubStorage(async () => {
      throw new Error('Extension context invalidated.');
    });
    mocks.readDiag.mockResolvedValue([]);
    const obj = await exportDiag();
    const meta = obj.logsMeta as Meta;
    expect(meta.ok).toBe(false);
    expect(meta.err).toBe('Extension context invalidated.');
  });

  it('★★ (c)【探针成功、真读失败】ok 必须为 false —— 推不出的那一格', async () => {
    stubStorage(async () => ({}));
    mocks.readDiag.mockRejectedValue(new Error('boom'));
    const obj = await exportDiag();
    const meta = obj.logsMeta as Meta;
    expect(meta.ok, '读失败的事实被探针的成功掩盖了').toBe(false);
  });

  it('★★ (d)【探针失败、真读成功】ok 必须为 false —— 反向那格', async () => {
    stubStorage(async (k) => {
      if (k === null) throw new Error('probe exploded');
      return { [DIAG_KEY]: [] };
    });
    mocks.readDiag.mockResolvedValue([]);
    const obj = await exportDiag();
    const meta = obj.logsMeta as Meta;
    expect(meta.ok, '探针失败的事实被真读的成功掩盖了').toBe(false);
  });

  it('★★ (e)【真实孤儿态：两处都抛】ok=false 且 err 是白名单固定串', async () => {
    stubStorage(async () => {
      throw new Error('Extension context invalidated.');
    });
    mocks.readDiag.mockRejectedValue(new Error('Extension context invalidated.'));
    const obj = await exportDiag();
    const meta = obj.logsMeta as Meta;
    expect(meta.ok).toBe(false);
    expect(meta.err).toBe('Extension context invalidated.');
  });
});

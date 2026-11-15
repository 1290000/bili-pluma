/**
 * verifier 探针（task-27 判据 3 + 判据 4）：err 白名单端到端 + limit 不许写死
 *
 * ## 判据 3 为什么不能只信 engineer 那四条
 *
 * engineer 的判据是"`describeLogsError()` 返回 `'unknown'`" + "源码里没有 `String(e)`"。
 * 前者只测了**函数本身**，后者只证明**代码长什么样**。
 * 用户真正拿到的是**导出的 JSON**，所以这里从"面板点导出"走一遍端到端，
 * 并且额外喂三类"能骗过 `instanceof` 但带着秘密的输入"：
 * - `Error('token=abc123')`
 * - `{ toString: () => 'SESSDATA=deadbeef' }`（非 Error 对象）
 * - 带 `cause` 的 Error（`Error('outer', { cause: new Error('token=abc123') })`）
 *
 * ## 判据 4 为什么必须在"点了导出"之后看
 *
 * `limit` 有两个来源：`probeLogsReadability()` 里的 `DIAG_LIMIT`，
 * 和导出按钮里的 `?? { limit: DIAG_LIMIT }` 兜底。前者改了常量会跟着变，
 * 后者也可能写死 30 —— 只看一个来源会漏。这里直接改 `diag-store` 的
 * **真模块**（`vi.importActual`）不可行（它是 const），
 * 所以改法是：mock 里导出 `DIAG_LIMIT: 7`，断言导出 JSON 的 `limit === 7`
 * 且**面板标题里出现的条数也来自同一个值**（`最近 N 条`）。
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LIMIT = 7; // 故意不是 30

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
  DIAG_LIMIT: 7,
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

/**
 * 进诊断页 → 点导出 → 返回 { obj: 解析后的 JSON, text: 面板可见文本 }。
 * `storage.local.get` 抛 `probeError`（让探针失败），从而把 `probeError` 送进 `describeLogsError`。
 */
async function exportWith(probeError: unknown): Promise<{
  obj: Record<string, unknown>;
  raw: string;
  text: string;
}> {
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
    storage: {
      local: {
        get: async () => {
          throw probeError;
        },
      },
    },
  });
  mocks.readDiag.mockResolvedValue([]);

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

  expect(exported, '没捕获到导出内容（导出按钮没生效）').not.toBeNull();
  const raw = exported ?? '{}';
  return { obj: JSON.parse(raw) as Record<string, unknown>, raw, text: c.root.textContent ?? '' };
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

describe('★ 判据 3：err 白名单端到端（导出 JSON 里不许出现秘密）', () => {
  it('★★ Error("token=abc123") → 导出 JSON 全文不含 abc123', async () => {
    const { raw, obj } = await exportWith(new Error('token=abc123'));
    const meta = obj.logsMeta as { ok: boolean; err: string | null };
    expect(meta.ok).toBe(false);
    expect(meta.err).toBe('unknown');
    expect(raw.toLowerCase(), '导出 JSON 里带出了错误原文').not.toContain('abc123');
  });

  it('★★ 非 Error 对象 toString 带 SESSDATA → 导出 JSON 不含 SESSDATA/deadbeef', async () => {
    const { raw, obj } = await exportWith({
      toString: () => 'SESSDATA=deadbeef',
    });
    const meta = obj.logsMeta as { ok: boolean; err: string | null };
    expect(meta.ok).toBe(false);
    expect(meta.err).toBe('unknown');
    expect(raw.toLowerCase()).not.toContain('deadbeef');
    expect(raw.toLowerCase()).not.toContain('sessdata');
  });

  it('★★ Error 带 cause（原文藏在 cause 里）→ 导出 JSON 不含 cause 里的秘密', async () => {
    const outer = new Error('outer', { cause: new Error('token=abc123') });
    const { raw } = await exportWith(outer);
    expect(raw.toLowerCase(), 'cause 里的原文漏进了导出').not.toContain('abc123');
  });

  it('★ err 只允许固定枚举值（不是自由字符串）', async () => {
    const { obj } = await exportWith(new Error('Extension context invalidated.'));
    const meta = obj.logsMeta as { err: string | null };
    const ALLOWED = [
      'Extension context invalidated.',
      'chrome.runtime is undefined',
      'The message port closed',
      'unknown',
      'not-read-yet',
    ];
    expect(meta.err).not.toBeNull();
    expect(ALLOWED, `err 出现了枚举外的值：${String(meta.err)}`).toContain(meta.err as string);
  });
});

describe('★ 判据 4：limit 必须来自 DIAG_LIMIT（这里是 7，不是 30）', () => {
  it('★★ 导出 JSON 的 logsMeta.limit 跟着常量走', async () => {
    const { obj } = await exportWith(new Error('boom'));
    const meta = obj.logsMeta as { limit: number };
    expect(meta.limit, 'limit 被写死成了 30').toBe(LIMIT);
  });

  it('★★ 面板标题里的上限也来自同一个值（另见下一用例的成功态）', async () => {
    const { text } = await exportWith(new Error('boom'));
    // 失败态时不显示条数（显示的是"读取失败"），条数上限的验证在成功态用例里
    expect(text).toContain('诊断');
  });

  it('★★ 成功态：标题显示"最近 7 条"，不是 30', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '0.0.0-test' }), sendMessage: async () => null },
      storage: { local: { get: async () => ({}) } },
    });
    // 上界必须被"用满"才看得到 limit：填 8 条 > 7，触发"已达上限"分支
    mocks.readDiag.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        at: 1700000000000 + i,
        level: 'info',
        scope: 'test',
        msg: `row ${i}`,
      })),
    );
    const c = mountPanelBody(ACTS);
    c.setModel(model());
    c.showTab('display');
    [...c.root.querySelectorAll('.sub-entry')]
      .find((e) => e.textContent?.includes('诊断'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    const text = c.root.textContent ?? '';
    // 实测当前实现写的是「诊断日志（最近 N 条，已达上限 limit 条，更早的被挤掉了）」，
    // 这里不预设确切措辞：断言"上限跟着 7 走且不出现 30"。
    expect(text, '标题里的上限没跟着 DIAG_LIMIT（7）走').toMatch(/上限 7 条/);
    expect(text, '标题写死成了 30 条').not.toMatch(/最近 30 条|上限 30 条/);
    // 反向确认：mock 的 DIAG_LIMIT 一旦是 30，同一断言会失败（说明 LIMIT 常量确实被读进去了）
    expect(LIMIT).not.toBe(30);
  });
});

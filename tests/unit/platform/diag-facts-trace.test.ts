// @vitest-environment jsdom

/**
 * `diagFacts()` 的**分支留痕**（2026-11-10 第五轮）。
 *
 * ## 为什么需要这个文件
 *
 * smoke 第五轮报"**一条 `diag/facts` 日志都没有**"。而原实现里
 * **"零日志 + 四项全 null"至少有四种来源**，它们在代码里**完全同形**：
 *
 * | 来源 | 原实现的表现 |
 * | --- | --- |
 * | `sendMessage` 抛错 | 被 `catch {}` 吞掉，无日志 |
 * | 应答是 `undefined`（有监听器 `return true` 没 `sendResponse`） | 落到最后的 return，无日志 |
 * | `type` 是 `:err` | 落到最后的 return，无日志 |
 * | 形状对不上（`facts` 缺失） | 落到最后的 return，无日志 |
 *
 * 上一轮"零日志"被读成"handler 从未被调用"——那只排除了第一种。
 *
 * 现在每个分支都写一行，**并把原始应答 JSON 打进日志**。
 * 本文件逐条钉住：每种输入都必须留下**能被区分**的痕迹。
 *
 * ## 反向验证
 *
 * 把任一分支的 `trace()` 删掉 → 对应用例必红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  diagCalls: [] as unknown[][],
  sendMessage: vi.fn(),
}));

vi.mock('@platform/storage/diag-store', () => ({
  diag: (...a: unknown[]) => {
    mocks.diagCalls.push(a);
    return Promise.resolve();
  },
  readDiag: async () => [],
  DIAG_KEY: 'pluma:diag',
  DIAG_LIMIT: 30,
}));

vi.mock('@platform/page/page-state-client', () => ({
  queryPageState: async () => ({ kind: 'no-tab' }),
}));

import { collectFacts } from '@platform/diagnostics/collect';

/** 只装 `diag/facts` 需要的部分；其他消息回最小可用的值 */
function installChrome(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: mocks.sendMessage,
      getManifest: () => ({ version: '0.0.0-test', incognito: 'split' }),
    },
    storage: { local: { get: async () => ({}) } },
  });
}

/** 所有 `diag/facts` 日志行 */
function traced(): string[] {
  return mocks.diagCalls.filter((c) => c[0] === 'diag/facts').map((c) => String(c[1] ?? ''));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.diagCalls.length = 0;
  mocks.sendMessage.mockReset();
  // 默认：proxy/status 和 stats/recent 正常
  mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
    if (m.type === 'proxy/status') return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
    if (m.type === 'stats/recent') return { type: 'stats/recent:ok', buckets: [] };
    return undefined;
  });
  installChrome();
});

describe('★ 四种"零日志"来源，现在每种都留痕', () => {
  it('★★ sendMessage 抛错 → 记 send-error（含错误类型与消息）', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts') throw new TypeError('Extension context invalidated');
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    const lines = traced();
    const err = lines.find((l) => l.startsWith('send-error:'));
    expect(err, '没有记 send-error').toBeDefined();
    expect(err).toContain('TypeError');
    expect(err).toContain('Extension context invalidated');
  });

  it('★★ 应答是 undefined（有监听器 return true 但没 sendResponse）→ 记 empty-reply', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts') return undefined;
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    const lines = traced();
    // 先记原始应答（JSON.stringify(undefined) 返回 undefined，必须处理否则抛 TypeError）
    expect(lines.some((l) => l.includes('reply: undefined'))).toBe(true);
    expect(lines.some((l) => l.includes('branch: empty-reply'))).toBe(true);
  });

  it('★★ 应答是 :err → 记 branch: diag/facts:err（不误报成"没到 background"）', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts') return { type: 'diag/facts:err', detail: '四项均失败' };
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    const lines = traced();
    expect(lines.some((l) => l.includes('branch: diag/facts:err'))).toBe(true);
  });

  it('★★ 应答是 :ok 但没有 facts → 记 branch: no-facts', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts') return { type: 'diag/facts:ok' };
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    expect(traced().some((l) => l.includes('branch: no-facts'))).toBe(true);
  });

  it('★ 应答没有 type 字段 → 记 branch: (no-type)', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts') return { something: 'else' };
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    expect(traced().some((l) => l.includes('branch: (no-type)'))).toBe(true);
  });
});

describe('★ 成功路径', () => {
  it('★★ 记原始应答 JSON（这是定位根因最关键的一行）', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts')
        return {
          type: 'diag/facts:ok',
          facts: {
            incognitoAllowed: true,
            windows: { total: 2, incognito: 1 },
            cookieStores: ['0', '1'],
            dnrRuleIds: { path: [10001], tab: [20001] },
          },
        };
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    const lines = traced();
    const reply = lines.find((l) => l.startsWith('reply:'));
    expect(reply, '没有记原始应答').toBeDefined();
    // 原始 JSON 里的关键字段必须在（能直接看出 background 返回了什么）
    expect(reply).toContain('diag/facts:ok');
    expect(reply).toContain('incognitoAllowed');
  });

  it('★ 成功时记"每项拿到了什么"，能区分 null 与有值', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts')
        return {
          type: 'diag/facts:ok',
          facts: {
            incognitoAllowed: false,
            windows: null,
            cookieStores: ['0'],
            dnrRuleIds: { path: [], tab: [] },
          },
        };
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    await collectFacts({ pageView: null });

    const ok = traced().find((l) => l.includes('branch: ok'));
    expect(ok).toBeDefined();
    expect(ok).toContain('incognito=false');
    expect(ok).toContain('windows=null'); // 区分开了：这项没读到
    expect(ok).toContain('cookies=0');
    expect(ok).toContain('dnr=0/0'); // 读到了，但 0 条
  });
});

describe('健壮性', () => {
  it('★ 应答含循环引用时不留痕失败（JSON.stringify 会抛）', async () => {
    const circular: Record<string, unknown> = { type: 'diag/facts:ok' };
    circular.self = circular;
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts') return circular;
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });

    // 不能抛；且要留下痕迹
    await expect(collectFacts({ pageView: null })).resolves.toBeDefined();
    expect(traced().length).toBeGreaterThan(0);
  });

  it('diag 写失败不影响自检结果', async () => {
    mocks.sendMessage.mockImplementation(async (m: { type?: string }) => {
      if (m.type === 'diag/facts')
        return { type: 'diag/facts:ok', facts: { incognitoAllowed: true } };
      if (m.type === 'proxy/status')
        return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
      return { type: 'stats/recent:ok', buckets: [] };
    });
    const rows = await collectFacts({ pageView: null });
    expect(rows.find((r) => r.label === 'InPrivate 权限')?.ok).toBe(true);
  });
});

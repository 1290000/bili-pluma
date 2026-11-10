// @vitest-environment jsdom

/**
 * `collectFacts(opts)` 的**注入 pageView** 语义（阶段 3，2026-11-10）。
 *
 * ## 这个文件守什么
 *
 * `collectFacts()` 原来无条件 `queryPageState()`，那会用 `chrome.tabs.query`
 * 去找一个**视频标签页**。对 options 页是对的（它不在视频页里），
 * 但对**页内面板**是错的：面板自己就在当前页面里，再查标签页会
 *
 *   - 在首页 / 直播页拿到 `no-tab` → 显示"打开任意视频页后可见"（错：面板说的是当前页）
 *   - 在视频页可能拿到**另一个**标签页的数据（更错）
 *
 * ## ⚠️ 核心判据：`undefined` 与 `null` 不能合并
 *
 * | 传值 | 期望 |
 * | --- | --- |
 * | 不传 | **调** `queryPageState()`（options 行为不变） |
 * | `null` | **不调**，报"本页没有取流数据" |
 * | 有 view | **不调**，用传递进来的那份 |
 *
 * 反例：把 `injected !== undefined` 改成 `injected`（真值判断），
 * "显式传 null 不查标签页"那条必红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryPageState: vi.fn(),
}));

vi.mock('@platform/page/page-state-client', () => ({
  queryPageState: (...a: unknown[]) => mocks.queryPageState(...a),
}));

import { collectFacts } from '@platform/diagnostics/collect';
import type { PageTracksView } from '@shared/types/playinfo';

/** 一份最小可用的 view：主账号基线可用、播放账号有 1080P */
function view(overrides: Partial<PageTracksView> = {}): PageTracksView {
  return {
    pageKey: 'BV1jt421t7XH',
    p: 1,
    updatedAt: 0,
    primary: {
      usable: true,
      reason: 'ssr',
      capability: {
        maxHeight: 1080,
        maxFrameRate: 60,
        maxFrameRateAtTopHeight: 60,
        hasHiRes: false,
        hasDolbyAudio: false,
        providesDolbyVision: false,
        topTrack: null,
        videoCount: 3,
        audioCount: 2,
        topQualityIds: [80],
      },
      user: null,
      mid: null,
      loggedIn: 'yes',
    },
    playback: { capability: null },
    diff: null,
    ...overrides,
  };
}

/** 装一套最小的 chrome，让 `collectFacts` 其余各项都能跑通 */
function installChrome(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (m: { type?: string }) => {
        if (m.type === 'proxy/status')
          return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
        if (m.type === 'diag/facts') {
          return {
            type: 'diag/facts:ok',
            facts: {
              incognitoAllowed: true,
              windows: { total: 1, incognito: 0 },
              cookieStores: ['0'],
              dnrRuleIds: { path: [10001], tab: [20001] },
            },
          };
        }
        return { type: 'stats/recent:ok', buckets: [] };
      },
      getManifest: () => ({ version: '0.0.0-test', incognito: 'split' }),
    },
    storage: { local: { get: async () => ({}) } },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.queryPageState.mockReset();
  mocks.queryPageState.mockResolvedValue({ kind: 'no-tab' });
  installChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 找「当前页取流数据」相关的行 */
function pageRows(rows: { label: string; value: string }[]): { label: string; value: string }[] {
  return rows.filter((r) => r.label.includes('当前页') || r.label.startsWith('主账号基线'));
}

describe('★ 不传 pageView：保持 options 的现行行为', () => {
  it('★ 会调 queryPageState()', async () => {
    mocks.queryPageState.mockResolvedValue({ kind: 'no-tab' });
    await collectFacts();
    expect(mocks.queryPageState).toHaveBeenCalledTimes(1);
  });

  it('no-tab 时给出 options 原本那句话', async () => {
    mocks.queryPageState.mockResolvedValue({ kind: 'no-tab' });
    const rows = await collectFacts();
    const pageRow = rows.find((r) => r.label === '当前页取流数据');
    expect(pageRow?.value).toContain('没有打开的 B站视频页');
  });
});

describe('★ 显式传 null：不查标签页（面板在首页 / 直播页）', () => {
  it('★ 不调 queryPageState() —— 这是本参数存在的理由', async () => {
    /**
     * 反例：把 `injected !== undefined` 改成 `injected` 真值判断，
     * `null` 会被当成"没传" → 又去查标签页 → 本条红。
     */
    await collectFacts({ pageView: null });
    expect(mocks.queryPageState).not.toHaveBeenCalled();
  });

  it('报的是"本页没有"，不是"打开任意视频页后可见"', async () => {
    /**
     * 后者是 options 的口径（它在别的标签页里，让用户去开视频页是对的）。
     * 面板**就在当前页**，说"本页没有"才准确。
     */
    const rows = await collectFacts({ pageView: null });
    const pageRow = rows.find((r) => r.label === '当前页取流数据');
    expect(pageRow?.value).toContain('本页没有取流数据');
    expect(pageRow?.value).not.toContain('打开任意视频页');
  });
});

describe('★ 传 view：用传递进来的那份，不查标签页', () => {
  it('★ 不调 queryPageState()', async () => {
    await collectFacts({ pageView: view() });
    expect(mocks.queryPageState).not.toHaveBeenCalled();
  });

  it('★ 渲染出主账号基线那一行，标的是传入的 pageKey', async () => {
    const rows = await collectFacts({ pageView: view() });
    const baseline = rows.find((r) => r.label.startsWith('主账号基线'));
    expect(baseline).toBeDefined();
    expect(baseline?.label).toContain('BV1jt421t7XH');
    expect(baseline?.ok).toBe(true);
  });

  it('传入的是哪份 view，就渲染哪份（不会串成别的标签页）', async () => {
    /**
     * 这条直接钉住"面板显示的是当前页"这个语义：
     * 即便 `queryPageState()` 会返回别的数据，注入时也完全不用它。
     */
    mocks.queryPageState.mockResolvedValue({
      kind: 'ok',
      view: view({ pageKey: 'BV_OTHER_TAB', p: 9 }),
      tabId: 1,
      title: 'other',
    });

    const rows = await collectFacts({ pageView: view({ pageKey: 'BV_MINE', p: 2 }) });
    const baseline = rows.find((r) => r.label.startsWith('主账号基线'));
    expect(baseline?.label).toContain('BV_MINE');
    expect(baseline?.label).not.toContain('BV_OTHER_TAB');
  });

  it('播放账号为 null 时如实说"尚未收到 playurl"', async () => {
    /**
     * ⚠️ `playback === null` 与 `playback.capability === null` 是**两种不同情况**
     * （前者=没收到响应，后者=收到但解析不出轨道），`collect.ts` 原本就分开处理。
     * 这里传前者，验证注入路径没有把这两支搞混。
     */
    const rows = await collectFacts({ pageView: view({ playback: null }) });
    const pb = rows.find((r) => r.label === '播放账号（页面 playurl 响应）');
    expect(pb?.value).toContain('尚未收到');
  });

  it('playback 有对象但 capability 为 null → "收到但解析不出轨道"', async () => {
    const rows = await collectFacts({ pageView: view({ playback: { capability: null } }) });
    const pb = rows.find((r) => r.label === '播放账号（页面 playurl 响应）');
    expect(pb?.value).toContain('解析不出轨道');
  });
});

describe('★ diag/facts 失败 / 部分失败时的降级（2026-11-09 真机验收）', () => {
  /**
   * ## 背景
   *
   * 真机上这 4 项全部读失败，产出了 4 行红字：
   * ```
   * InPrivate 权限   ❌ chrome.extension.isAllowedIncognitoAccess is not a function
   * 窗口列表         ❌ Cannot read properties of undefined (reading 'getAll')
   * cookie 分区      ❌ [...]
   * DNR 规则         ❌ [...]
   * ```
   * 根因是 content script 里那些命名空间**不存在**。现在改走 `diag/facts`。
   *
   * ## 本组守什么
   *
   * | 情况 | 期望 |
   * | --- | --- |
   * | 消息整条失败 | 不崩；那几项产出**中性行**（无 `ok`），**绝不 `ok:false`** |
   * | 部分字段 `null` | 只那一项降级，其余照常 |
   * | DNR 读不到 | **不产出行**（`tipFor()` 靠"行不存在"走中性分支） |
   */

  /** 用自定义的 diag/facts 应答装 chrome */
  function installWithDiagReply(reply: unknown): void {
    installChrome({
      runtime: {
        sendMessage: async (m: { type?: string }) => {
          if (m.type === 'proxy/status')
            return { type: 'proxy/status:ok', enabled: true, ruleCount: 2 };
          if (m.type === 'diag/facts') {
            if (reply instanceof Error) throw reply;
            return reply;
          }
          return { type: 'stats/recent:ok', buckets: [] };
        },
        getManifest: () => ({ version: '0.0.0-test', incognito: 'split' }),
      },
    });
  }

  it('★ 消息抛错 → 不崩，且相关项**不是 ok:false**（未知不是失败）', async () => {
    installWithDiagReply(new Error('Receiving end does not exist'));
    const rows = await collectFacts({ pageView: null });

    const inPrivate = rows.find((r) => r.label === 'InPrivate 权限');
    expect(inPrivate).toBeDefined();
    // ★ 关键：`ok` 必须是 undefined（中性），不能是 false（失败）
    expect(inPrivate?.ok).toBeUndefined();
    expect(inPrivate?.value).toContain('读取失败');
  });

  it('★ 四项全失败时不产出 DNR 那两行（让 tipFor 走中性分支）', async () => {
    installWithDiagReply({ type: 'diag/facts:err', detail: '均读取失败' });
    const rows = await collectFacts({ pageView: null });
    expect(rows.find((r) => r.label === 'DNR 全局路径规则')).toBeUndefined();
    expect(rows.find((r) => r.label === 'DNR 标签页规则')).toBeUndefined();
  });

  it('★ 部分字段 null → 只有那一项降级', async () => {
    installWithDiagReply({
      type: 'diag/facts:ok',
      facts: {
        incognitoAllowed: true,
        windows: { total: 2, incognito: 1 },
        cookieStores: null, // 只有这项失败
        dnrRuleIds: { path: [10001], tab: [] },
      },
    });
    const rows = await collectFacts({ pageView: null });

    expect(rows.find((r) => r.label === 'InPrivate 权限')?.ok).toBe(true);
    expect(rows.find((r) => r.label === '可见窗口数')?.value).toBe('2');
    expect(rows.find((r) => r.label === 'cookie 分区')?.value).toContain('读取失败');
    // DNR 读到了（path 有 1 条）
    expect(rows.find((r) => r.label === 'DNR 全局路径规则')?.ok).toBe(true);
  });

  it('★ DNR 读到了但确实是 0 条 → ok:false（这一支允许报警）', async () => {
    /**
     * 与"读不到"必须区分：这里读到了，规则确实是 0 条 ——
     * 那是 `01` 说的**最危险状态**（以为在代理，其实一条都没有），该报警。
     */
    installWithDiagReply({
      type: 'diag/facts:ok',
      facts: {
        incognitoAllowed: true,
        windows: null,
        cookieStores: null,
        dnrRuleIds: { path: [], tab: [] },
      },
    });
    const rows = await collectFacts({ pageView: null });
    const pathRow = rows.find((r) => r.label === 'DNR 全局路径规则');
    expect(pathRow).toBeDefined();
    expect(pathRow?.ok).toBe(false);
  });

  it('★ InPrivate = false 时是 ok:false（读到了"未允许"）', async () => {
    installWithDiagReply({
      type: 'diag/facts:ok',
      facts: {
        incognitoAllowed: false,
        windows: null,
        cookieStores: null,
        dnrRuleIds: null,
      },
    });
    const rows = await collectFacts({ pageView: null });
    const row = rows.find((r) => r.label === 'InPrivate 权限');
    expect(row?.ok).toBe(false);
    expect(row?.value).toBe('未允许');
  });

  it('★ 应答形状坏掉（facts 缺失）→ 全按未知处理，不崩', async () => {
    installWithDiagReply({ type: 'diag/facts:ok' });
    await expect(collectFacts({ pageView: null })).resolves.toBeDefined();
  });
});

describe('其余各项不受参数影响（改动范围守卫）', () => {
  it('★ 仍产出 InPrivate / 窗口 / 凭据 / 总开关 / DNR / 白名单版本等行', async () => {
    const rows = await collectFacts({ pageView: null });
    const labels = rows.map((r) => r.label);
    for (const k of [
      'InPrivate 权限',
      '播放账号凭据',
      '播放代理总开关',
      'DNR 全局路径规则',
      '代理路径白名单',
    ]) {
      expect(labels, `缺少 ${k}`).toContain(k);
    }
  });

  it('传不传 pageView，非取流行完全一致', async () => {
    const a = (await collectFacts()).filter((r) => !pageRows([r]).length);
    const b = (await collectFacts({ pageView: null })).filter((r) => !pageRows([r]).length);
    expect(a.map((r) => r.label)).toEqual(b.map((r) => r.label));
  });
});

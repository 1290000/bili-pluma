// @vitest-environment jsdom

/**
 * ★★★ **真机假警报的端到端回归**（2026-11-10）。
 *
 * ## 事故
 *
 * 账号 Tab 显示「凭据异常」，而底层数据完全健康：
 * ```json
 * {"hasCredential":true,"healthy":true,"ruleCount":3,"vip":"annual"}
 * ```
 * 代理正常工作（4K 可播、3 条规则）。那是**没有原因、没有动作的假警报**。
 *
 * ## 根因：字段路径不匹配（不是两份数据源）
 *
 * `account/summary` 返回的形状与 UI 层用的 `PopupAccount` **不同**：
 *
 * | 字段 | `AccountSummary`（消息） | `PopupAccount`（UI） |
 * | --- | --- | --- |
 * | 昵称 | `profile.uname` | `uname` |
 * | mid | `profile.mid` | `mid` |
 * | **健康** | **`health.healthy`** | **`healthy`** |
 *
 * 面板用 `as` 直接把前者断言成后者（**`as` 不校验字段**），
 * 于是 `healthy` 是 `undefined` → `!undefined === true` → 报「凭据异常」。
 *
 * ## 为什么单测原先抓不到
 *
 * 单测直接构造 `PopupAccount`（扁平形状），**永远走不到真机那条路径**。
 * 所以本文件的关键是：**喂真实的 `AccountSummary` 形状**，走完整的
 * 消息 → 映射 → 渲染链路。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountPanelBody, type PanelController } from '../../../src/content/panel/panel';
import type { PanelModel } from '../../../src/content/panel/panel-data';
import { accountTab } from '../../../src/content/panel/tabs';
import { toPopupAccount } from '../../../src/content/panel/panel-data';
import type { AccountSummary } from '../../../src/shared/types/account';

const NOW = 1_800_000_000_000;

/** smoke 真机上报的那份数据的**真实形状** */
function realSummary(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    profile: { mid: 10001, uname: 'test-user', avatarUrl: null },
    vipLabel: 'annual',
    expireAt: NOW + 86_400_000 * 23,
    health: { healthy: true, checkedAt: NOW - 30_000, reason: null },
    ...over,
  };
}

describe('★★★ toPopupAccount：真实 AccountSummary → 扁平 PopupAccount', () => {
  it('★★★ 把嵌套的 health.* 正确摊平', () => {
    /**
     * 反例：直接 `return s as PopupAccount`（原来的写法）→ 本条必红，
     * `healthy` 会是 `undefined`。
     */
    const p = toPopupAccount(realSummary());
    expect(p).not.toBeNull();
    expect(p?.healthy).toBe(true);
    expect(p?.checkedAt).toBe(NOW - 30_000);
    expect(p?.reason).toBeNull();
  });

  it('★★★ profile 里的 uname / mid 正确提到顶层', () => {
    const p = toPopupAccount(realSummary());
    expect(p?.uname).toBe('test-user');
    expect(p?.mid).toBe(10001);
  });

  it('★ vipLabel / expireAt 是顶层字段，原样传', () => {
    const p = toPopupAccount(realSummary());
    expect(p?.vipLabel).toBe('annual');
    expect(p?.expireAt).toBe(NOW + 86_400_000 * 23);
  });

  it('★ 传 null → null', () => {
    expect(toPopupAccount(null)).toBeNull();
    expect(toPopupAccount(undefined)).toBeNull();
  });

  it('★★ 缺 health 时**原样传 undefined**（不许默认 true 也不许默认 false）', () => {
    /**
     * - `?? true` → 读不到时报"健康"，是**谎报**
     * - `?? false` → 读不到时报"异常"，正是本次要修的**假警报**
     *
     * 两种默认都错。原样传 `undefined`，让 `describeHealth` 走"未知"分支（整行不渲染）。
     */
    const broken = { ...realSummary(), health: undefined } as unknown as AccountSummary;
    const p = toPopupAccount(broken);
    expect(p?.healthy).toBeUndefined();
  });
});

describe('★★★ 端到端：真实 AccountSummary → 渲染出「刚刚校验」，不是「凭据异常」', () => {
  it('★★★ 账号 Tab 不该出现「凭据异常」', () => {
    /**
     * 这条走的是真机的完整链路：`AccountSummary` → `toPopupAccount` → `accountTab`。
     *
     * 反例：把 `toPopupAccount` 改回 `as` 断言 → 本条必红。
     */
    const box = accountTab(
      {
        primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
        playback: toPopupAccount(realSummary()),
        unknown: false,
        hasCredential: true,
        needsLogin: false,
      },
      NOW,
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );

    expect(box.textContent, '健康的账号被报成了「凭据异常」').not.toContain('凭据异常');
    expect(box.textContent).toContain('校验');
  });

  it('★★★ 反向：真实的 healthy:false 仍然要报异常（不许把真异常也压掉）', () => {
    const box = accountTab(
      {
        primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
        playback: toPopupAccount(
          realSummary({
            health: { healthy: false, checkedAt: NOW, reason: '-101 未登录' },
          }),
        ),
        unknown: false,
        hasCredential: true,
        needsLogin: false,
      },
      NOW,
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('凭据异常');
    expect(box.textContent).toContain('-101');
  });
});

describe('★★★ 端到端：走真实消息路径 fetchPanelReplies → 映射 → 渲染', () => {
  /**
   * ## 为什么必须走 `fetchPanelReplies`
   *
   * 上面那些测试直接调 `toPopupAccount()`，所以**把映射删掉也照样绿**
   * —— 我实测确认过（反例 `nomap` 全绿）。那说明它们守不住"映射漏了"这件事。
   *
   * 而真机的 bug 恰恰就是**映射那一步漏了**：`fetchPanelReplies` 里
   * 用 `as` 把 `AccountSummary` 断言成了 `PopupAccount`。
   *
   * 所以这条测试必须**从消息应答开始**，走完整链路：
   * `chrome.runtime.sendMessage` → `fetchPanelReplies()` → `accountTab()`。
   */

  it('★★★ 真实 account/summary 应答 → 账号 Tab 不出现「凭据异常」', async () => {
    const summary = realSummary();

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: async (msg: { type?: string }) => {
          switch (msg?.type) {
            case 'proxy/status':
              return {
                type: 'proxy/status:ok',
                enabled: true,
                hasCredential: true,
                ruleCount: 3,
              };
            case 'account/summary':
              return { type: 'account/summary:ok', configured: true, account: summary };
            case 'stats/recent':
              return { type: 'stats/recent:ok', buckets: [] };
            default:
              return null;
          }
        },
      },
      tabs: { query: async () => [] },
    });

    const { fetchPanelReplies } = await import('../../../src/content/panel/panel-data');
    const replies = await fetchPanelReplies();

    // ★ 映射层必须已经摊平了 health.*
    expect(replies.account?.account?.healthy, 'fetchPanelReplies 没有摊平 health.healthy').toBe(
      true,
    );
    expect(replies.account?.account?.uname).toBe('test-user');

    // ★ 渲染层不该报假警报
    const box = accountTab(
      {
        primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
        playback: replies.account?.account ?? null,
        unknown: false,
        hasCredential: true,
        needsLogin: false,
      },
      NOW,
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );

    expect(box.textContent, '走完整消息路径后出现了假警报').not.toContain('凭据异常');
    expect(box.textContent).toContain('校验');
  });

  it('★★★ 反向：真实的 healthy:false 走完整路径仍然报异常', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: async (msg: { type?: string }) => {
          switch (msg?.type) {
            case 'proxy/status':
              return { type: 'proxy/status:ok', enabled: true, hasCredential: true, ruleCount: 3 };
            case 'account/summary':
              return {
                type: 'account/summary:ok',
                configured: true,
                account: realSummary({
                  health: { healthy: false, checkedAt: NOW, reason: '-101 未登录' },
                }),
              };
            case 'stats/recent':
              return { type: 'stats/recent:ok', buckets: [] };
            default:
              return null;
          }
        },
      },
      tabs: { query: async () => [] },
    });

    const { fetchPanelReplies } = await import('../../../src/content/panel/panel-data');
    const replies = await fetchPanelReplies();

    expect(replies.account?.account?.healthy).toBe(false);
    expect(replies.account?.account?.reason).toBe('-101 未登录');
  });
});

describe('★★★ 端到端：走完整面板（消息形状进、DOM 出）', () => {
  let controller: PanelController | null = null;

  beforeEach(() => {
    controller = mountPanelBody({ login: () => undefined, logout: async () => ({ ok: true }) });
  });

  afterEach(() => {
    controller = null;
    document.body.textContent = '';
  });

  /** 造一份模型，`playback` 由真实 `AccountSummary` 映射而来 */
  function model(acct: AccountSummary): PanelModel {
    return {
      quality: {
        pill: '已接管',
        tone: 'good',
        line: null,
        unlock: null,
        proxyEnabled: true,
        pageKind: 'play',
      },
      clean: null,
      account: {
        primary: { uname: '主账号', level: 6, loggedIn: 'yes', source: 'live' },
        playback: toPopupAccount(acct),
        unknown: false,
        hasCredential: true,
        needsLogin: false,
      },
      pageKind: 'play',
      pageStateKind: 'ok',
      pageView: null,
    };
  }

  it('★★★ 健康数据 → 面板账号 Tab 显示「校验」，无「凭据异常」', () => {
    controller?.setModel(model(realSummary()));
    controller?.showTab('account');

    const text = controller?.root.textContent ?? '';
    expect(text).not.toContain('凭据异常');
    expect(text).toContain('校验');
  });

  it('★★★ 显示账号昵称（证明 profile.uname 映射对了）', () => {
    controller?.setModel(model(realSummary()));
    controller?.showTab('account');

    expect(controller?.root.textContent).toContain('test-user');
  });
});

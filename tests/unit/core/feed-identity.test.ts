// @vitest-environment jsdom

/**
 * 推荐流身份判据 —— 六态 + 首页侧 mid 复算。
 *
 * > 从 `tests/unit/content/feed-boundary.test.ts` 迁移来的（2026-11-11）。
 * > **分界线功能已取消**，但这套判据与它无关，是任何"按身份做条件渲染"
 * > 的功能都要用的东西。原文件随功能一起删除，**用例全部保留**。
 *
 * 每条断言都配了"反向改回去必须变红"的说明（AGENTS.md §1.5）。
 */

import { describe, expect, it } from 'vitest';

import {
  resolveFeedIdentity,
  shouldSwitchFeed,
  type FeedIdentity,
} from '@/src/core/feed-identity/feed-identity';

describe('shouldSwitchFeed —— 六种身份只有 ok 该按取流账号处置', () => {
  it('ok → true（真的在代理：取流账号存在且 ≠ 页面账号）', () => {
    expect(shouldSwitchFeed('ok')).toBe(true);
  });

  it('⚠️ unknown → **false**（算不出来不等于在代理）', () => {
    /**
     * 反向验证：把 `=== 'ok'` 改成 `!== 'self'` 或加 `|| p === 'unknown'` → 这条红。
     *
     * 这是本文件最容易写错的一条：unknown 看起来"可能"在代理，
     * 但一旦按它处置页面内容，就是在陈述一个事实 —— "可能"不能当断言用。
     */
    expect(shouldSwitchFeed('unknown')).toBe(false);
  });

  it('self → false（两边同一个账号，没有"另一个账号"）', () => {
    /**
     * 反向验证：改成 `p === 'ok' || p === 'self'` → 这条红。
     * 那会让同号用户在页面上看到"按取流账号处置"的结果，而取流账号就是他自己。
     */
    expect(shouldSwitchFeed('self')).toBe(false);
  });

  it('page-identity → false（用户选了浏览器账号取流，扩展没参与）', () => {
    expect(shouldSwitchFeed('page-identity')).toBe(false);
  });

  it('disabled / not-configured / null → 都是 false', () => {
    expect(shouldSwitchFeed('disabled')).toBe(false);
    expect(shouldSwitchFeed('not-configured')).toBe(false);
    expect(shouldSwitchFeed(null)).toBe(false);
  });

  it('六种身份列全：只有 ok 为真（防将来加状态时漏判）', () => {
    const all: FeedIdentity[] = [
      'ok',
      'self',
      'disabled',
      'not-configured',
      'page-identity',
      'unknown',
    ];
    expect(all.filter((s) => shouldSwitchFeed(s))).toEqual(['ok']);
  });
});

describe('resolveFeedIdentity —— 首页侧复算 mid 比较', () => {
  it('extension + 有凭据 + mid 不等 → ok', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: 111,
        pageMid: 222,
      }),
    ).toBe('ok');
  });

  it('extension + mid 相等 → self（同号）', () => {
    /**
     * 反向验证：把三元写反 → 这条红。
     * 写反的后果是"同号时判成 ok"，用户会按取流账号处置而他只有一个号。
     */
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: 222,
        pageMid: 222,
      }),
    ).toBe('self');
  });

  it('⚠️ 游客态（pageMid 为 null）→ unknown，**不是 ok**', () => {
    /**
     * 游客态下 `page.handler.ts` **确实仍在代理**，技术上"在生效"。
     * 但游客没有"我的推荐"这个概念 —— 判成 ok 会按取流账号处置，
     * 而他并不知道谁是谁。
     *
     * 反向验证：去掉 `pageMid === null` 那半个判断 → 这条红。
     */
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: 111,
        pageMid: null,
      }),
    ).toBe('unknown');
  });

  it('⚠️ account/summary 拿不到（credentialMid 为 null）→ unknown', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: null,
        pageMid: 222,
      }),
    ).toBe('unknown');
  });

  it('两个都拿不到 → unknown', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: null,
        pageMid: null,
      }),
    ).toBe('unknown');
  });

  it('开关关 → disabled（优先于"有凭据"）', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: false,
        hasCredential: true,
        credentialMid: 111,
        pageMid: 222,
      }),
    ).toBe('disabled');
  });

  it('无凭据 → not-configured', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'extension',
        proxyEnabled: true,
        hasCredential: false,
        credentialMid: null,
        pageMid: 222,
      }),
    ).toBe('not-configured');
  });

  it('🔴 page 身份 + mid 不同 → page-identity，**不**判 ok', () => {
    /**
     * 这是曾经的一个真实 bug：首版签名里没有 `streamingIdentity`，
     * 于是用户选了「浏览器账号取流」、而扩展账号 mid 恰好 ≠ 页面 mid 时，
     * 会被判成 `'ok'` → 按取流账号处置 → **而取流根本没走扩展账号**。
     *
     * 反向验证：删掉 `if (streamingIdentity === 'page') return 'page-identity';` → 这条红。
     */
    const id = resolveFeedIdentity({
      streamingIdentity: 'page',
      proxyEnabled: true,
      hasCredential: true,
      credentialMid: 111,
      pageMid: 222,
    });
    expect(id).toBe('page-identity');
    expect(shouldSwitchFeed(id)).toBe(false);
  });

  it('page 身份 + mid 相同 → 也是 page-identity（用户意图优先于 self）', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'page',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: 222,
        pageMid: 222,
      }),
    ).toBe('page-identity');
  });

  it('page 身份 + 游客 → page-identity', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'page',
        proxyEnabled: true,
        hasCredential: true,
        credentialMid: 111,
        pageMid: null,
      }),
    ).toBe('page-identity');
  });

  it('page 身份但开关关着 → disabled（关闭优先于身份选择）', () => {
    expect(
      resolveFeedIdentity({
        streamingIdentity: 'page',
        proxyEnabled: false,
        hasCredential: true,
        credentialMid: 111,
        pageMid: 222,
      }),
    ).toBe('disabled');
  });

  it('端到端全矩阵：只有 "extension + 不同号" 该被按取流账号处置', () => {
    type Input = Parameters<typeof resolveFeedIdentity>[0];
    const scenes: { name: string; i: Omit<Input, 'streamingIdentity'> }[] = [
      {
        name: '不同号',
        i: { proxyEnabled: true, hasCredential: true, credentialMid: 111, pageMid: 222 },
      },
      {
        name: '同号',
        i: { proxyEnabled: true, hasCredential: true, credentialMid: 222, pageMid: 222 },
      },
      {
        name: '游客',
        i: { proxyEnabled: true, hasCredential: true, credentialMid: 111, pageMid: null },
      },
      {
        name: '关代理',
        i: { proxyEnabled: false, hasCredential: true, credentialMid: 111, pageMid: 222 },
      },
      {
        name: '没配号',
        i: { proxyEnabled: true, hasCredential: false, credentialMid: null, pageMid: 222 },
      },
      {
        name: '摘要失败',
        i: { proxyEnabled: true, hasCredential: true, credentialMid: null, pageMid: 222 },
      },
    ];
    const combos = (['extension', 'page'] as const).flatMap((si) =>
      scenes.map((s) => ({
        key: `${si}/${s.name}`,
        show: shouldSwitchFeed(resolveFeedIdentity({ ...s.i, streamingIdentity: si })),
      })),
    );
    expect(combos.filter((c) => c.show).map((c) => c.key)).toEqual(['extension/不同号']);
  });
});

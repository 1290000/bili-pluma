// @vitest-environment jsdom

/**
 * 账号卡「已配置 / 读不出」自相矛盾（2026-11-12，task-3 修 B-4）。
 *
 * ## 守的是什么
 *
 * `pb === null && hasCredential === true` 是**真实存在**的组合：
 * `hasCredential` 来自 `proxy/status`（vault 里有没有密文），
 * `pb` 来自 `account/summary`（账号资料读没读出来）。两者各有各的失败方式。
 *
 * ### 旧实现在同一张卡上放了**三句互相矛盾**的话
 *
 * | 位置 | 旧文案 | 读起来 |
 * | --- | --- | --- |
 * | 昵称 | 「取流账号已配置」 | 已配置 |
 * | 标签 | 「已配置」 | 已配置 |
 * | 副标题 | 「读不出账号资料 · 点下方重新登录」 | **没配置** |
 *
 * 用户看到"配好了"和"读不出来"并列，不知道信哪句。
 *
 * ## 裁决边界（定稿 B）
 *
 * **只要求文案不自相矛盾**，不要求改判据结构 —— 所以
 * `if (pb || a.hasCredential)` 一行不动，`AccountView` 形状也不动。
 *
 * ## 反向验证
 *
 * 把副标题改回 `'读不出账号资料 · 点下方重新登录'` → `★` 那条必红。
 */

import { describe, expect, it } from 'vitest';

import { accountTab } from '../../../../src/content/panel/tabs';

/** 有密文、但账号资料读不出来（`pb === null`） */
function viewWithoutProfile() {
  return {
    primary: { uname: '主账号', level: 6, loggedIn: 'yes' as const, source: 'live' as const },
    playback: null,
    unknown: false,
    hasCredential: true,
    needsLogin: false,
  };
}

function actions() {
  return {
    login: () => undefined,
    logout: async () => ({ ok: true }),
    streamingIdentity: null,
    toggleStreamingIdentity: () => undefined,
    notifyResult: () => undefined,
  };
}

function textOf(el: HTMLElement): string {
  return el.textContent ?? '';
}

describe('★★ pb 为 null 但密文在：卡片只能有**一个**结论', () => {
  it('★★★ 不再同时下「已配置」与「未配置」两个结论（旧实现必红）', () => {
    /**
     * ## 判据是"结论"不是"字面"
     *
     * 旧副标题是 `读不出账号资料 · 点下方重新登录` —— 它读起来是
     * **"这个号没配好，去重登一次"**，与同卡的「已配置」是两个相反的结论。
     *
     * 新副标题 `已配置 · 账号资料暂时读不出，收起重开面板可重试` 只说一件事：
     * **配好了**，只是这次资料没读到。它含「已配置」也含「读不出」，
     * 但**不构成矛盾** —— 矛盾在于"是否有结论冲突"，不在于词有没有出现。
     *
     * 所以这里断言的是**结论层面**：
     *   - 卡上说"已配置"（密文在，事实）
     *   - 卡上**不说**"还没有配置"
     *   - 卡上**不说**旧那句暗示"没配好"的措辞
     *
     * 反例：副标题改回 `'读不出账号资料 · 点下方重新登录'`
     * → 第三条断言必红。
     */
    const box = accountTab(viewWithoutProfile(), Date.now(), 'play', actions());

    const text = textOf(box);
    expect(text, '构造前提：密文在，必须说「已配置」').toContain('已配置');
    expect(text, '密文在却说了「还没有配置」—— 与「已配置」并列，自相矛盾').not.toContain(
      '还没有配置取流账号',
    );
    expect(
      text,
      '旧那句「读不出账号资料 · 点下方重新登录」暗示"没配好"，与「已配置」并列',
    ).not.toContain('点下方重新登录');
  });

  it('★★ 卡片仍按「已配置」说话（不是把整张卡说成未配置）', () => {
    const box = accountTab(viewWithoutProfile(), Date.now(), 'play', actions());
    const text = textOf(box);

    expect(text, '密文在却被说成未配置').not.toContain('还没有配置取流账号');
    expect(text).toContain('已配置');
  });

  it('★ 昵称位不拿「取流账号已配置」冒充昵称', () => {
    /**
     * 昵称位写「取流账号已配置」是**占位符冒充昵称**，而下方标签已经说了
     * 「已配置」—— 那句话在昵称位置上一分钱信息都不多给。
     */
    const box = accountTab(viewWithoutProfile(), Date.now(), 'play', actions());
    const name = box.querySelector('.acct-row.playback .acct-name')?.textContent ?? '';

    expect(name).not.toBe('取流账号已配置');
    expect(name, '昵称读不出时应该说清是昵称读不出').toContain('昵称');
  });

  it('★ 给出的动作是用户**真能做**的（收起重开），不是"重新登录"', () => {
    /**
     * 密文在、功能可用 —— 让用户重扫没有理由。
     * 重开面板会走 `loadOnce()` 重取一次，那才是这里的正解。
     */
    const box = accountTab(viewWithoutProfile(), Date.now(), 'play', actions());
    const sub = box.querySelector('.acct-row.playback .acct-sub')?.textContent ?? '';

    expect(sub).toContain('收起重开面板');
    expect(sub, '不该建议重新登录 —— 密文还在').not.toContain('重新登录');
  });
});

describe('★ 有完整资料时文案不受影响（不误伤正常路径）', () => {
  it('★ pb 有值时副标题仍是「仅取流 · …」，不带任何"读不出"字样', () => {
    const box = accountTab(
      {
        ...viewWithoutProfile(),
        playback: {
          uname: '取流账号',
          mid: 999,
          vipLabel: 'annual' as const,
          expireAt: null,
          healthy: true,
          checkedAt: 0,
          reason: null,
        },
      },
      Date.now(),
      'play',
      actions(),
    );
    const text = textOf(box);

    expect(text).toContain('取流账号');
    expect(text).toContain('仅取流');
    expect(text).not.toContain('读不出');
  });

  it('★ 没有密文也没有资料时仍是「还没有配置取流账号」', () => {
    const box = accountTab(
      {
        ...viewWithoutProfile(),
        hasCredential: false,
        needsLogin: true,
      },
      Date.now(),
      'play',
      actions(),
    );

    expect(textOf(box)).toContain('还没有配置取流账号');
  });
});

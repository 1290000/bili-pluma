// @vitest-environment jsdom

/**
 * 三个 Tab 的渲染（1.1.0 阶段 2，T2）。
 *
 * ## 为什么测 DOM 而不是截图
 *
 * 面板在 **shadow root 里**，jsdom 也没有布局。所以这里测的是**可判定的东西**：
 *   - 某个状态下某个元素**在不在**（`unlock-card` 非播放页必须不存在）
 *   - 开关的 `checked` / `disabled` 状态
 *   - 文本内容里有没有出现**不该出现**的话（例如非播放页补一句"当前页不是播放页"）
 *
 * 视觉（颜色/间距）不测 —— 那是真机冒烟的事。
 *
 * ## 反例
 *
 * 把 `tabs.ts` 的 `if (q.unlock)` 改成无条件渲染，或把 `disabled` 判据写死 `false`，
 * 本文件对应条目必红。已在任务报告里贴过实测输出。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  accountTab,
  cleanTab,
  displayTab,
  homeCleanPane,
  qualityTab,
} from '../../../src/content/panel/tabs';
import type { AccountView, QualityView } from '../../../src/content/panel/panel-data';
import {
  DEFAULT_CLEAN_OPTIONS,
  type CleanPreferences,
} from '../../../src/content/site-clean/clean-options';
import { OBSERVED_CATEGORIES } from '../../../src/content/site-clean/home-selectors';

/** 一个「已接管 + 已解锁」的画质视图 */
function quality(overrides: Partial<QualityView> = {}): QualityView {
  return {
    pill: '已接管',
    tone: 'good',
    line: null,
    unlock: {
      title: '已解锁',
      badges: ['4K', '60fps'],
      anchor: '主账号仅可用 1080P',
      improved: true,
    },
    proxyEnabled: true,
    pageKind: 'play',
    ...overrides,
  };
}

/** 一整套默认净化偏好 */
function prefs(overrides: Partial<CleanPreferences> = {}): CleanPreferences {
  return {
    options: { ...DEFAULT_CLEAN_OPTIONS },
    hideCategories: [],
    ...overrides,
  };
}

/** 找一个开关行里的 checkbox（按标签文本定位） */
function checkboxFor(root: HTMLElement, label: string): HTMLInputElement | null {
  for (const row of root.querySelectorAll('.row')) {
    const text = row.querySelector('.row-label')?.firstElementChild?.textContent ?? '';
    if (text === label) return row.querySelector('input');
  }
  return null;
}

describe('画质 Tab', () => {
  it('★ 非播放页不渲染解锁卡，也不补一句"当前页不是播放页"', () => {
    /**
     * `02-ui-spec.md` §3 状态 5 定稿：非视频页**两处都不渲染**。
     * 反例：把 `if (q.unlock)` 改成无条件渲染 → 本条必红。
     */
    const box = qualityTab(quality({ unlock: null, pageKind: 'other', pill: '未生效' }), {
      toggleProxy: () => undefined,
    });
    expect(box.querySelector('.unlock-card')).toBeNull();
    // 不许出现任何解释"你在哪个页面"的话
    expect(box.textContent).not.toContain('当前页');
    expect(box.textContent).not.toContain('视频页');
  });

  it('播放页渲染解锁卡：标题 / 锚点 / 徽章都在', () => {
    const box = qualityTab(quality(), { toggleProxy: () => undefined });
    expect(box.querySelector('.unlock-card')).not.toBeNull();
    expect(box.querySelector('.unlock-title')?.textContent).toBe('已解锁');
    expect(box.querySelector('.unlock-anchor')?.textContent).toBe('主账号仅可用 1080P');
    const chips = [...box.querySelectorAll('.badge-chip')].map((n) => n.textContent);
    expect(chips).toEqual(['4K', '60fps']);
  });

  it('★ proxyEnabled 为 null 时总开关禁用（不画成"关"）', () => {
    /**
     * 把"未知"画成"关"，用户会以为功能自己关掉了 —— 与角标开关同一纪律。
     * 反例：把 `disabled: q.proxyEnabled === null` 改成 `false` → 本条必红。
     */
    const box = qualityTab(quality({ proxyEnabled: null, pill: '未知', tone: 'neutral' }), {
      toggleProxy: () => undefined,
    });
    const cb = checkboxFor(box, '自动接管取流');
    expect(cb).not.toBeNull();
    expect(cb?.disabled).toBe(true);
    // 明确说读取失败，而不是静默显示一个关着的开关
    expect(box.textContent).toContain('状态读取失败');
  });

  it('proxyEnabled 为 true 时开关可用且勾上', () => {
    const box = qualityTab(quality({ proxyEnabled: true }), { toggleProxy: () => undefined });
    const cb = checkboxFor(box, '自动接管取流');
    expect(cb?.checked).toBe(true);
    expect(cb?.disabled).toBe(false);
  });

  it('点总开关会回调（且阻断冒泡）', () => {
    const spy = vi.fn();
    const box = qualityTab(quality({ proxyEnabled: true }), { toggleProxy: spy });
    const cb = checkboxFor(box, '自动接管取流');
    if (!cb) throw new Error('没找到总开关');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('有 line 时才渲染那一行（已接管不写解释）', () => {
    const withLine = qualityTab(quality({ line: '需要重新扫码', tone: 'bad' }), {
      toggleProxy: () => undefined,
    });
    expect(withLine.querySelector('.pane-line')?.textContent).toBe('需要重新扫码');

    const noLine = qualityTab(quality({ line: null }), { toggleProxy: () => undefined });
    expect(noLine.querySelector('.pane-line')).toBeNull();
  });
});

describe('净化 Tab', () => {
  it('一级 Tab 只有广告三项（隐藏顶部大图归二级，不重复出现）', () => {
    /**
     * ⚠️ 任务书写"四个开关"，但 `homeHideSwipe` 属于**首页净化**、与 9 个分类
     * 一起放在二级浮层。一级 Tab 再放一个就是**同一个开关出现在两处** ——
     * 用户在二级改了、回一级看到不一样，会以为其中一个坏了。
     */
    const box = cleanTab(prefs(), {
      toggleOption: () => undefined,
      openSub: () => undefined,
    });
    /**
     * ⚠️ 只数**广告那三项**：阶段 3 之后净化 Tab 底部还有「页内角标」开关，
     * 它不在广告归组里，不该被这条断言算进来。
     * 所以先按标签取前三个，再整体断言顺序。
     */
    const labels = [...box.querySelectorAll('.row .row-label')].map(
      (n) => n.firstElementChild?.textContent,
    );
    expect(labels.slice(0, 3)).toEqual(['删除广告', '保留活动横幅', '调试模式']);
    // 隐藏顶部大图**不该**在一级出现
    expect(labels).not.toContain('隐藏顶部大图推荐');
  });

  it('★ prefs 为 null 时广告三项全部禁用（不把"没读到"当成"全关"）', () => {
    /**
     * 反例：把 `disabled: unknown || dim` 改成 `dim` → 本条必红。
     * 那样用户会在数据还没读到时看到一个"全关"的面板，一点就把真实设置覆盖成关。
     *
     * ⚠️ 只查广告三项的 checkbox（按标签找），不要数全部 input ——
     * 阶段 3 加了角标开关，数总数会让这条断言随无关改动变红。
     */
    const box = cleanTab(null, {
      toggleOption: () => undefined,
      openSub: () => undefined,
    });
    for (const label of ['删除广告', '保留活动横幅', '调试模式']) {
      expect(checkboxFor(box, label)?.disabled, `${label} 应被禁用`).toBe(true);
    }
  });

  it('广告总开关关着时，子项置灰', () => {
    const box = cleanTab(prefs({ options: { ...DEFAULT_CLEAN_OPTIONS, adEnabled: false } }), {
      toggleOption: () => undefined,
      openSub: () => undefined,
    });
    expect(checkboxFor(box, '删除广告')?.disabled).toBe(false);
    expect(checkboxFor(box, '保留活动横幅')?.disabled).toBe(true);
    expect(checkboxFor(box, '调试模式')?.disabled).toBe(true);
  });

  it('广告总开关打开后子项可点', () => {
    const box = cleanTab(prefs({ options: { ...DEFAULT_CLEAN_OPTIONS, adEnabled: true } }), {
      toggleOption: () => undefined,
      openSub: () => undefined,
    });
    expect(checkboxFor(box, '保留活动横幅')?.disabled).toBe(false);
  });

  it('调试模式开着且广告开着时，出现"不会隐藏"的提示', () => {
    const box = cleanTab(
      prefs({ options: { ...DEFAULT_CLEAN_OPTIONS, adEnabled: true, adDebug: true } }),
      {
        toggleOption: () => undefined,
        openSub: () => undefined,
      },
    );
    expect(box.textContent).toContain('不会被隐藏');
  });

  it('二级入口显示已隐藏分类数', () => {
    const box = cleanTab(prefs({ hideCategories: ['番剧', '电影'] }), {
      toggleOption: () => undefined,
      openSub: () => undefined,
    });
    expect(box.querySelector('.sub-entry-hint')?.textContent).toBe('已隐藏 2 类');
  });

  it('点二级入口会调 openSub', () => {
    const spy = vi.fn();
    const box = cleanTab(prefs(), {
      toggleOption: () => undefined,
      openSub: spy,
    });
    box.querySelector('.sub-entry')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('★ 显示 Tab（2026-11-10 新增，真机反馈）', () => {
  /**
   * ## 为什么单开这个 Tab
   *
   * 原来角标开关和诊断入口都塞在**净化** Tab 底部。用户指出位置不对：
   * 角标是**界面偏好**、诊断是**排查工具**，都不是"净化页面内容"。
   *
   * `docs/02-ui-spec.md` §4.3 当初在 options 里就论证过这条 ——
   * 面板里重犯了同一个错。
   */

  function display(badge: boolean | null = true) {
    return displayTab(badge, { toggleBadge: () => undefined, openDiag: () => undefined });
  }

  it('★★ 角标开关在「显示」Tab 里', () => {
    expect(checkboxFor(display(), '页内角标')).not.toBeNull();
  });

  it('★★ 诊断入口在「显示」Tab 里', () => {
    const box = display();
    const entry = [...box.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('诊断'),
    );
    expect(entry, '显示 Tab 里没有诊断入口').toBeDefined();
  });

  it('★★ 净化 Tab 里**不再**有角标开关和诊断入口', () => {
    /**
     * 反例：把角标/诊断放回 `cleanTab` → 本条必红。
     * 两个 Tab 同时有同一个控件，会让用户以为其中一个是坏的。
     */
    const box = cleanTab(prefs(), {
      toggleOption: () => undefined,
      openSub: () => undefined,
    });

    // 角标不在净化里
    expect(checkboxFor(box, '页内角标')).toBeNull();
    // 诊断不在净化里
    const diag = [...box.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('诊断'),
    );
    expect(diag, '净化 Tab 里不该有诊断入口').toBeUndefined();
    // 但首页净化入口还在
    const home = [...box.querySelectorAll('.sub-entry')].find((e) =>
      e.textContent?.includes('首页净化'),
    );
    expect(home, '净化 Tab 必须保留首页净化入口').toBeDefined();
  });

  it('角标为 null 时开关禁用（不画成"关"）', () => {
    expect(checkboxFor(display(null), '页内角标')?.disabled).toBe(true);
  });

  it('拨角标开关会回调', () => {
    const spy = vi.fn();
    const box = displayTab(true, { toggleBadge: spy, openDiag: () => undefined });
    const cb = checkboxFor(box, '页内角标');
    if (!cb) throw new Error('没找到角标开关');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('点诊断入口会回调 openDiag', () => {
    const spy = vi.fn();
    const box = displayTab(true, { toggleBadge: () => undefined, openDiag: spy });
    [...box.querySelectorAll('.sub-entry')]
      .find((e) => e.textContent?.includes('诊断'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('二级浮层：首页净化', () => {
  it('9 个分类全部渲染（来自 OBSERVED_CATEGORIES）', () => {
    const box = homeCleanPane(prefs(), {
      toggleOption: () => undefined,
      toggleCategory: () => undefined,
      back: () => undefined,
    });
    for (const cat of OBSERVED_CATEGORIES) {
      expect(checkboxFor(box, cat)).not.toBeNull();
    }
    expect(OBSERVED_CATEGORIES.length).toBe(9);
  });

  it('隐藏顶部大图在二级页里（不在主 Tab 的四个开关之外再加一个）', () => {
    const box = homeCleanPane(prefs(), {
      toggleOption: () => undefined,
      toggleCategory: () => undefined,
      back: () => undefined,
    });
    expect(checkboxFor(box, '隐藏顶部大图推荐')).not.toBeNull();
  });

  it('已勾选的分类是勾上的', () => {
    const box = homeCleanPane(prefs({ hideCategories: ['番剧'] }), {
      toggleOption: () => undefined,
      toggleCategory: () => undefined,
      back: () => undefined,
    });
    expect(checkboxFor(box, '番剧')?.checked).toBe(true);
    expect(checkboxFor(box, '电影')?.checked).toBe(false);
  });

  it('点分类会回调 cat 与目标值', () => {
    const spy = vi.fn();
    const box = homeCleanPane(prefs(), {
      toggleOption: () => undefined,
      toggleCategory: spy,
      back: () => undefined,
    });
    const cb = checkboxFor(box, '国创');
    if (!cb) throw new Error('没找到国创');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith('国创', true);
  });

  it('点返回会调 back', () => {
    const spy = vi.fn();
    const box = homeCleanPane(prefs(), {
      toggleOption: () => undefined,
      toggleCategory: () => undefined,
      back: spy,
    });
    box.querySelector('.sub-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('账号 Tab', () => {
  function account(overrides: Partial<AccountView> = {}): AccountView {
    return {
      primary: { uname: '主', level: 6, loggedIn: 'yes', source: 'live' },
      playback: {
        uname: '播',
        mid: 2,
        vipLabel: 'annual',
        expireAt: null,
        healthy: true,
        checkedAt: 0,
        reason: null,
      },
      unknown: false,
      hasCredential: true,
      needsLogin: false,
      ...overrides,
    };
  }

  it('双卡都在，A 灰 / B 信息色（class 区分）', () => {
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: async () => ({ ok: true }),
    });
    expect(box.querySelectorAll('.acct-row').length).toBe(2);
    expect(box.querySelector('.acct-row.primary')).not.toBeNull();
    expect(box.querySelector('.acct-row.playback')).not.toBeNull();
  });

  it('★ 等级读不到时写「只读」，不编一个 LV 数字', () => {
    const box = accountTab(
      account({ primary: { uname: '主', level: null, loggedIn: 'yes', source: 'live' } }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    const tags = [...box.querySelectorAll('.acct-tag')].map((n) => n.textContent);
    expect(tags[0]).toBe('只读');
    // 不许出现 LV + 数字
    expect(box.textContent).not.toMatch(/LV\d/);
  });

  it('播放账号显示"仅取流"与会员类型', () => {
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: async () => ({ ok: true }),
    });
    expect(box.textContent).toContain('仅取流');
    expect(box.textContent).toContain('年度大会员');
  });

  it('★ 读不到 account 时显示"读取失败"，不说"未配置"', () => {
    /**
     * 说"未配置"会引导用户去扫一个可能已经存在的号
     * （`messages.ts` 里记过这条的真实后果）。
     */
    const box = accountTab(
      account({ playback: null, unknown: true, hasCredential: false }),
      Date.now(),
      'other',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('账号信息读取失败');
    expect(box.textContent).not.toContain('未配置');
  });

  it('★★ 已配置时**仍然**给「重新登录」和「退出播放账号」（2026-11-10 功能缺失修复）', () => {
    /**
     * ## 这条断言与旧版**相反**，是刻意的
     *
     * 旧实现：`if (a.needsLogin || (!pb && !hasCredential && !unknown))` ——
     * **配置成功之后一个按钮都没有**。
     *
     * 用户真机反馈「账号 Tab 里退出登录和重新登录按钮都没有了」——
     * 这是迁移时的遗漏，不是设计（原 options 的账号页本来有这两个按钮）。
     *
     * 反例：把按钮重新包回那个 `if` → 本条必红。
     */
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: async () => ({ ok: true }),
    });

    const btns = [...box.querySelectorAll('.acct-btn')].map((b) => b.textContent);
    expect(btns).toContain('重新登录');
    expect(btns).toContain('退出播放账号');
  });

  it('★ 未配置时给登录入口，且**不**给退出按钮', () => {
    const box = accountTab(
      account({ playback: null, hasCredential: false, needsLogin: true }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    const btns = [...box.querySelectorAll('.acct-btn')].map((b) => b.textContent);
    expect(btns).toContain('扫码登录播放账号');
    // 没配置时给「退出」会让人莫名其妙
    expect(btns).not.toContain('退出播放账号');
  });

  it('★ 读不到 account（unknown）时一个按钮都不给', () => {
    /**
     * 那时不知道有没有配置：给「重新登录」可能让用户白扫一次，
     * 给「退出」更可能删掉一个其实存在的账号。
     */
    const box = accountTab(
      account({ playback: null, unknown: true, hasCredential: false }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.querySelectorAll('.acct-btn').length).toBe(0);
  });

  // ────────────── 三种"看起来都像没配置"的状态必须分开说（2026-11-10）──────────────

  it('★★ 真没配置 → 「还没有配置播放账号」', () => {
    const box = accountTab(
      account({ playback: null, hasCredential: false, unknown: false }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('还没有配置播放账号');
  });

  it('★★ 有凭据但读不出资料 → 专门文案（不是「没配置」）', () => {
    /**
     * `hasCredential: true` + `playback: null` = 凭据在，但这次没读到资料
     * （网络 / 风控）。
     *
     * 混成"没配置"的后果：用户会以为账号没了，跑去重新扫码 ——
     * 而他其实**只是这次没读到**。原 options 的账号页有这条专门文案，迁移时漏了。
     */
    const box = accountTab(
      account({ playback: null, hasCredential: true, unknown: false }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('已配置，但暂时读不出账号资料');
    // ★ 不能说成"没配置"
    expect(box.textContent).not.toContain('还没有配置播放账号');
  });

  it('★★ 完全读不到（unknown）→ 「读取失败」，既不说没配置也不说已配置', () => {
    const box = accountTab(
      account({ playback: null, hasCredential: false, unknown: true }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('账号信息读取失败');
    expect(box.textContent).not.toContain('还没有配置播放账号');
    expect(box.textContent).not.toContain('暂时读不出账号资料');
  });

  // ────────────── 凭据健康状态（2026-11-10，原 options 有）──────────────

  it('★ 已配置时显示「N 分钟前校验」', () => {
    const now = Date.now();
    const box = accountTab(
      account({
        playback: {
          uname: '年度大会员',
          mid: 42,
          vipLabel: 'annual',
          expireAt: now + 86_400_000 * 23,
          healthy: true,
          checkedAt: now - 5 * 60_000,
          reason: null,
        },
      }),
      now,
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('5 分钟前校验');
  });

  it('★ 凭据异常时显示原因', () => {
    const now = Date.now();
    const box = accountTab(
      account({
        playback: {
          uname: 'x',
          mid: 42,
          vipLabel: 'annual',
          expireAt: null,
          healthy: false,
          checkedAt: now,
          reason: '-101 未登录',
        },
      }),
      now,
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('凭据异常');
    expect(box.textContent).toContain('-101');
  });

  it('★★ 健康状态文案里**不许**出现"可能过期"这类猜测', () => {
    const now = Date.now();
    const box = accountTab(
      account({
        playback: {
          uname: 'x',
          mid: 42,
          vipLabel: 'annual',
          expireAt: now - 86_400_000,
          healthy: true,
          checkedAt: now - 86_400_000 * 3,
          reason: null,
        },
      }),
      now,
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).not.toMatch(/可能|建议|或许|疑似/);
  });

  /**
   * ## 为什么要两步
   *
   * 退出之后取流回退到主账号身份，番剧页会**立刻掉回 1080P**。
   * 误触的代价很大，所以第一次点击只切文案、不发请求。
   *
   * ## 为什么不用 `confirm()`
   *
   * `docs/02-ui-spec.md` §7：`alert` / `confirm` 会阻塞 SW，且在扩展页面里表现异常。
   * 原 options 的账号页就是这么做的（`account.tsx` 的 `confirmRemove` 状态）。
   */

  /** 找到「退出播放账号」按钮 */
  function removeBtn(box: HTMLElement): HTMLElement | undefined {
    return [...box.querySelectorAll<HTMLElement>('.acct-btn')].find(
      (b) => b.textContent === '退出播放账号',
    );
  }

  /** 找到「确认退出」按钮 */
  function confirmBtn(box: HTMLElement): HTMLElement | undefined {
    return [...box.querySelectorAll<HTMLElement>('.acct-btn')].find(
      (b) => b.textContent === '确认退出',
    );
  }

  /** 找到「取消」按钮（只在确认态可见） */
  function cancelBtn(box: HTMLElement): HTMLElement | undefined {
    return [...box.querySelectorAll<HTMLElement>('.acct-btn')].find(
      (b) => b.textContent === '取消',
    );
  }

  it('★★ 第一次点「退出播放账号」**不执行**，只切成「确认退出」+「取消」', () => {
    /**
     * 反例：去掉两步确认（第一次点就 `logout()`）→ 本条必红。
     */
    const logoutSpy = vi.fn(async () => ({ ok: true }));
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: logoutSpy,
    });

    removeBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // ★ 没有发请求
    expect(logoutSpy, '第一次点击就执行了退出 —— 两步确认没生效').not.toHaveBeenCalled();
    // 文案变成确认态
    expect(confirmBtn(box)).toBeDefined();
    expect(cancelBtn(box)).toBeDefined();
    expect(removeBtn(box)).toBeUndefined();
  });

  it('★★ 第二次点「确认退出」才真正执行', () => {
    const logoutSpy = vi.fn(async () => ({ ok: true }));
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: logoutSpy,
    });

    removeBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    confirmBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it('★★ 点「取消」回到非确认态，**不执行**', () => {
    const logoutSpy = vi.fn(async () => ({ ok: true }));
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: logoutSpy,
    });

    removeBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cancelBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(logoutSpy).not.toHaveBeenCalled();
    // 回到原来的样子
    expect(removeBtn(box)).toBeDefined();
    expect(confirmBtn(box)).toBeUndefined();
  });

  it('★ 「确认退出」带 danger 样式（与第一次点击视觉上可区分）', () => {
    const box = accountTab(account(), Date.now(), 'play', {
      login: () => undefined,
      logout: async () => ({ ok: true }),
    });
    removeBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmBtn(box)?.classList.contains('danger')).toBe(true);
  });

  it('★ 未配置时点登录按钮会回调（文案是「扫码登录播放账号」）', () => {
    const spy = vi.fn();
    const box = accountTab(
      account({ playback: null, hasCredential: false, needsLogin: true }),
      Date.now(),
      'play',
      { login: spy, logout: async () => ({ ok: true }) },
    );
    const btn = [...box.querySelectorAll('.acct-btn')].find(
      (b) => b.textContent === '扫码登录播放账号',
    );
    expect(btn).toBeDefined();
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('★ 主账号昵称缺失时走 primaryPlaceholder（播放页写「读取中…」而非「未登录」）', () => {
    /**
     * `primary-card.ts` 的纪律 2：播放页 + `unknown` 必须写「读取中…」。
     * 面板自己拼一句就会在"刚进视频页"那 1.5 秒里显示一个错的结论。
     */
    const box = accountTab(
      account({ primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' } }),
      Date.now(),
      'play',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('读取中…');
    expect(box.textContent).not.toContain('未登录');
  });

  it('★ 非播放页 + 无昵称写「打开视频页后可见」', () => {
    const box = accountTab(
      account({ primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' } }),
      Date.now(),
      'other',
      { login: () => undefined, logout: async () => ({ ok: true }) },
    );
    expect(box.textContent).toContain('打开视频页后可见');
  });
});

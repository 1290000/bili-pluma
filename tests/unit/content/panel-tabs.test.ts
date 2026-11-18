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
import type { StreamingIdentity } from '../../../src/shared/constants/streaming-identity';
import {
  DEFAULT_CLEAN_OPTIONS,
  type CleanPreferences,
} from '../../../src/content/site-clean/clean-options';
import { OBSERVED_CATEGORIES } from '../../../src/content/site-clean/home-selectors';
/**
 * ⚠️ 这条 import 让「文案与实现一致」成为**可断言**的事：
 * hint 说"全部"，前提是隐藏逻辑真的会隐藏首屏批。
 */
import { shouldHideFeedCards } from '../../../src/core/feed-identity/feed-hide';

/** 一个「已接管 + 已解锁」的画质视图 */
function quality(overrides: Partial<QualityView> = {}): QualityView {
  return {
    pill: '已接管',
    tone: 'good',
    line: null,
    unlock: {
      title: '已解锁',
      badges: ['4K', '60fps'],
      anchor: '主账号最高 1080P',
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
  /**
   * `qualityTab()` 在 task-10 加了两个**必填**参数（`proxyUsable` /
   * `proxyDisabledReason`），它们决定总开关能不能点。
   *
   * 本文件测的是**画质卡渲染**，不关心 task-10 的禁用判据，所以默认给
   * "可点"（`proxyUsable: true`）。禁用判据的测试在
   * `tests/unit/content/panel/proxy-usable.test.ts`。
   */
  const QUALITY_ACTS_EXTRA = {
    proxyUsable: true,
    proxyDisabledReason: null,
  } as const;

  it('★ 非播放页不渲染解锁卡，也不补一句"当前页不是播放页"', () => {
    /**
     * `02-ui-spec.md` §3 状态 5 定稿：非视频页**两处都不渲染**。
     * 反例：把 `if (q.unlock)` 改成无条件渲染 → 本条必红。
     */
    const box = qualityTab(quality({ unlock: null, pageKind: 'other', pill: '未生效' }), {
      toggleProxy: () => undefined,
      ...QUALITY_ACTS_EXTRA,
    });
    expect(box.querySelector('.unlock-card')).toBeNull();
    // 不许出现任何解释"你在哪个页面"的话
    expect(box.textContent).not.toContain('当前页');
    expect(box.textContent).not.toContain('视频页');
  });

  it('播放页渲染解锁卡：标题 / 锚点 / 徽章都在', () => {
    const box = qualityTab(quality(), { toggleProxy: () => undefined, ...QUALITY_ACTS_EXTRA });
    expect(box.querySelector('.unlock-card')).not.toBeNull();
    expect(box.querySelector('.unlock-title')?.textContent).toBe('已解锁');
    expect(box.querySelector('.unlock-anchor')?.textContent).toBe('主账号最高 1080P');
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
      ...QUALITY_ACTS_EXTRA,
    });
    const cb = checkboxFor(box, '自动接管取流');
    expect(cb).not.toBeNull();
    expect(cb?.disabled).toBe(true);
    // 明确说读取失败，而不是静默显示一个关着的开关
    expect(box.textContent).toContain('状态读取失败');
  });

  it('proxyEnabled 为 true 时开关可用且勾上', () => {
    const box = qualityTab(quality({ proxyEnabled: true }), {
      toggleProxy: () => undefined,
      ...QUALITY_ACTS_EXTRA,
    });
    const cb = checkboxFor(box, '自动接管取流');
    expect(cb?.checked).toBe(true);
    expect(cb?.disabled).toBe(false);
  });

  it('点总开关会回调（且阻断冒泡）', () => {
    const spy = vi.fn();
    const box = qualityTab(quality({ proxyEnabled: true }), {
      toggleProxy: spy,
      ...QUALITY_ACTS_EXTRA,
    });
    const cb = checkboxFor(box, '自动接管取流');
    if (!cb) throw new Error('没找到总开关');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('有 line 时才渲染那一行（已接管不写解释）', () => {
    const withLine = qualityTab(quality({ line: '需要重新扫码', tone: 'bad' }), {
      toggleProxy: () => undefined,
      ...QUALITY_ACTS_EXTRA,
    });
    expect(withLine.querySelector('.pane-line')?.textContent).toBe('需要重新扫码');

    const noLine = qualityTab(quality({ line: null }), {
      toggleProxy: () => undefined,
      ...QUALITY_ACTS_EXTRA,
    });
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
    return displayTab(badge, { ...DISPLAY_ACTS });
  }

  it('★★ 角标开关在「显示」Tab 里', () => {
    expect(checkboxFor(display(), '页内角标')).not.toBeNull();
  });

  /**
   * ## 屏蔽 PCDN 开关（ADR 0038 授权 → ADR 0039 换 authority）
   *
   * **在**、**读不到时不画成关**、**hint 一句话说清收益与代价**。
   *
   * 文案在 2026-11-18 按用户要求精简过：原来那句 60 多字塞了「候选条数不变」
   * 「经官方代理」「资源标记为 mcdn」三处开发视角的解释，普通用户看不完。
   * 现在只留两件事：能干什么（P2P → 官方线路）、代价（部分起播变慢）。
   *
   * 代价这句**不能删**：实测代理分支 TTFB 中位 949ms vs 直连 128ms（7.4 倍），
   * UGC 4K 上 18/25 轨命中。原先写「略慢」是低估，改成「部分起播会变慢」——
   * 用用户能懂的「起播」，不写毫秒数（ADR 0038 禁止承诺收益数字）。
   */
  it('★ 屏蔽 PCDN 开关在「显示」Tab 里，hint 一句话说清收益与代价', () => {
    const box = display();
    const cb = checkboxFor(box, '屏蔽 PCDN 线路');
    expect(cb, '开关必须在').not.toBeNull();
    expect(cb?.disabled, '已读到设置 → 可点').toBe(false);
    // 从开关往上找它自己那一行的 hint（不能用 querySelector 取第一个，那是"页内角标"的）
    const ownRow = cb?.closest('.row');
    const hint = ownRow?.querySelector('.row-hint')?.textContent ?? '';
    expect(hint, '必须说清能干什么：换成官方线路').toContain('官方线路');
    expect(hint, '必须保留真实代价：部分起播变慢（不是"略慢"）').toContain('部分起播会变慢');
    expect(hint, '旧代价（弱网更容易卡）已作废，不许再出现').not.toContain('更容易卡');
    /**
     * ## 精简纪律：不许再把开发视角的解释塞回去
     *
     * 这三句是上一轮被用户点名"太长"的内容。它们各自都有技术依据
     * （候选条数不变见 ADR 0039；mcdn 标记见 ADR 0042；代理见 4K 实测），
     * 但都属于诊断面板/文档该说的事，不是开关描述该说的事。
     */
    for (const devJargon of ['候选条数不变', '资源标记为 mcdn', '首块']) {
      expect(hint, `开关描述不许再出现开发视角的「${devJargon}」`).not.toContain(devJargon);
    }
    expect(hint.length, '开关描述必须精简（60 字 → 20 字量级）').toBeLessThan(40);
  });

  it('★ 还没读到设置 → 开关禁用（不猜成"用户关了"）', () => {
    const box = displayTab(null, { ...DISPLAY_ACTS, pcdnFilterEnabled: null });
    const cb = checkboxFor(box, '屏蔽 PCDN 线路');
    expect(cb?.disabled, '读不到设置时不可点').toBe(true);
    // ⚠️ 不断言 checked === false：禁用态的 checkbox 天然是 false，
    // 断它等于断言"禁用"本身，看不出"有没有被当成用户关的"。
    // "读不到"与"用户关了"的区分由 `pcdnFilterReadFailed` 那条提示负责 —— 见下一条用例。
  });

  it('★ 读不到设置 → 说明原因（不许只留一个灰开关）', () => {
    const box = displayTab(true, {
      ...DISPLAY_ACTS,
      pcdnFilterEnabled: null,
      pcdnFilterReadFailed: true,
    });
    expect(box.textContent).toContain('读不到这个开关的当前设置');
  });

  /**
   * ## 「开关打开了却没有角标」（2026-11-16，用户报）
   *
   * 这不是 bug：`buildBadge()` 第一条判据就是「没在代理 → 不显示」，
   * 角标的语义是"我现在被接管了"。但**开关照样能点**就是 UI 的错 ——
   * 用户只能观察到"开了没用"，面板一个字都不解释。
   *
   * 修法与「自动接管取流」一致：本质不可用时灰掉 + 说明原因，
   * 同时**保留用户设的值**（登录后自动生效）。
   */
  it('★ 没接管 → 角标开关灰掉并说明原因，但**保留用户设的值**', () => {
    const box = displayTab(true, {
      ...DISPLAY_ACTS,
      badgeUsable: false,
      badgeDisabledReason: '还没有可用的取流账号 —— 到「账号」Tab 扫码登录后，角标才会出现',
    });
    const cb = checkboxFor(box, '页内角标');
    expect(cb?.disabled, '没接管时开关必须不可点').toBe(true);
    // 值照旧是 true —— 不许为了"看起来一致"去改用户的设置
    expect(cb?.checked).toBe(true);
    expect(box.textContent).toContain('扫码登录');
  });

  it('★ 读失败优先于"没接管"（更基础的问题先说）', () => {
    const box = displayTab(null, {
      ...DISPLAY_ACTS,
      badgeUsable: false,
      badgeDisabledReason: '还没有可用的取流账号',
      badgeReadFailed: true,
    });
    expect(box.textContent).toContain('读不到角标开关');
    expect(box.textContent).not.toContain('还没有可用的取流账号');
  });

  it('可用时不渲染任何解释文字（不留噪音）', () => {
    const box = displayTab(true, { ...DISPLAY_ACTS, badgeUsable: true });
    expect(checkboxFor(box, '页内角标')?.disabled).toBe(false);
    expect(box.textContent).not.toContain('扫码登录');
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
    const box = displayTab(true, { ...DISPLAY_ACTS, toggleBadge: spy });
    const cb = checkboxFor(box, '页内角标');
    if (!cb) throw new Error('没找到角标开关');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('点诊断入口会回调 openDiag', () => {
    const spy = vi.fn();
    const box = displayTab(true, { ...DISPLAY_ACTS, openDiag: spy });
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

/**
 * 账号卡动作的公共默认值。
 *
 * ## 为什么抽成常量（2026-11-11）
 *
 * `AccountActions` 的 `streamingIdentity` / `toggleStreamingIdentity` 已改成**必填**
 * （理由见 `tabs.ts` 的 `AccountActions` 注释：可选会掩盖"胶囊永不渲染"的死代码缺口）。
 *
 * 21 处调用点若各写一份，既啰嗦，又会让"这里到底该传什么"变得不明显。
 * 抽成一个带注释的常量后：
 *   - **默认没有身份**（`null`）→ 胶囊不渲染，因为大多数用例只关心账号卡本身
 *   - 关心胶囊的用例用 `render()` 显式覆盖 —— 那个辅助函数把"传了什么"写在校验点旁边
 */
const ACTS = {
  login: () => undefined,
  logout: async () => ({ ok: true }),
  streamingIdentity: null,
  toggleStreamingIdentity: () => undefined,
  /**
   * 退出结果的出口（2026-11-12 加）。
   *
   * 账号 Tab 不再把结果写进 `box`（那会被 `render()` 的 `replaceChildren` 冲掉），
   * 改成回调交给编排层 —— 所以这里必须给一个，否则类型不过。
   * 断言"结果是否被送到界面上"的用例见 `panel/account-logout-notice.test.ts`。
   */
  notifyResult: () => undefined,
} as const;

/**
 * 「显示」Tab 的动作公共默认值（2026-11-11，推荐流开关迁入后新增）。
 *
 * ## 为什么它和 `ACTS` 分开
 *
 * `displayTab()` 现在**同时管两件互不相干的事**：
 *   - 页内角标（原来的职责）
 *   - 首页推荐流（2026-11-11 从「账号」Tab 迁来）
 *
 * 而它的 `actions` 里**刻意没有 `StreamingIdentity`** ——
 * 推荐流开关的可点性只认 `hasCredential`，与取流身份无关。
 * **这个类型约束就是"两个功能独立"的防线**（见 `tabs.ts` 的 `displayTab` 注释）。
 *
 * 默认 `feedAccountEnabled: false` + `hasCredential: false`
 * → 开关**灰着**（这是"没配置扩展账号"的真实形态），大多数用例不关心它。
 */
const DISPLAY_ACTS = {
  toggleBadge: () => undefined,
  openDiag: () => undefined,
  /** 默认按「已接管」的典型态：角标此刻可能出现（不可用态另有专门的用例） */
  badgeUsable: true,
  badgeDisabledReason: null,
  feedAccountEnabled: false,
  toggleFeedAccount: () => undefined,
  hasCredential: false,
  /** 默认不是"读失败"态（大多数用例不关心角标读取结局） */
  badgeReadFailed: false,
  /**
   * 屏蔽 PCDN 开关：默认给"已读到、关着"—— 让不关心它的用例拿到可点控件。
   * 「还没读到」与「读失败」两个态各有专门用例。
   */
  pcdnFilterEnabled: false,
  pcdnFilterReadFailed: false,
  togglePcdnFilter: () => undefined,
} as const;

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
      proxyEnabled: true,
      ...overrides,
    };
  }

  it('双卡都在，A 灰 / B 信息色（class 区分）', () => {
    const box = accountTab(account(), Date.now(), 'play', {
      ...ACTS,
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
      ACTS,
    );
    const tags = [...box.querySelectorAll('.acct-tag')].map((n) => n.textContent);
    expect(tags[0]).toBe('只读');
    // 不许出现 LV + 数字
    expect(box.textContent).not.toMatch(/LV\d/);
  });

  it('播放账号显示"仅取流"与会员类型', () => {
    const box = accountTab(account(), Date.now(), 'play', {
      ...ACTS,
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
      ACTS,
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
      ...ACTS,
    });

    const btns = [...box.querySelectorAll('.acct-btn')].map((b) => b.textContent);
    expect(btns).toContain('重新登录');
    expect(btns).toContain('退出取流账号');
  });

  it('★ 未配置时给登录入口，且**不**给退出按钮', () => {
    const box = accountTab(
      account({ playback: null, hasCredential: false, needsLogin: true }),
      Date.now(),
      'play',
      ACTS,
    );
    const btns = [...box.querySelectorAll('.acct-btn')].map((b) => b.textContent);
    expect(btns).toContain('扫码登录取流账号');
    // 没配置时给「退出」会让人莫名其妙
    expect(btns).not.toContain('退出取流账号');
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
      ACTS,
    );
    expect(box.querySelectorAll('.acct-btn').length).toBe(0);
  });

  // ────────────── 三种"看起来都像没配置"的状态必须分开说（2026-11-10）──────────────

  it('★★ 真没配置 → 「还没有配置取流账号」', () => {
    const box = accountTab(
      account({ playback: null, hasCredential: false, unknown: false }),
      Date.now(),
      'play',
      ACTS,
    );
    expect(box.textContent).toContain('还没有配置取流账号');
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
      ACTS,
    );
    expect(box.textContent).toContain('已配置，但暂时读不出账号资料');
    // ★ 不能说成"没配置"
    expect(box.textContent).not.toContain('还没有配置取流账号');
  });

  it('★★ 完全读不到（unknown）→ 「读取失败」，既不说没配置也不说已配置', () => {
    const box = accountTab(
      account({ playback: null, hasCredential: false, unknown: true }),
      Date.now(),
      'play',
      ACTS,
    );
    expect(box.textContent).toContain('账号信息读取失败');
    expect(box.textContent).not.toContain('还没有配置取流账号');
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
      ACTS,
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
      ACTS,
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
      ACTS,
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

  /** 找到「退出取流账号」按钮 */
  function removeBtn(box: HTMLElement): HTMLElement | undefined {
    return [...box.querySelectorAll<HTMLElement>('.acct-btn')].find(
      (b) => b.textContent === '退出取流账号',
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
      ...ACTS,
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
      ...ACTS,
      logout: logoutSpy,
    });

    removeBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    confirmBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it('★★ 点「取消」回到非确认态，**不执行**', () => {
    const logoutSpy = vi.fn(async () => ({ ok: true }));
    const box = accountTab(account(), Date.now(), 'play', {
      ...ACTS,
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
      ...ACTS,
    });
    removeBtn(box)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmBtn(box)?.classList.contains('danger')).toBe(true);
  });

  it('★ 未配置时点登录按钮会回调（文案是「扫码登录取流账号」）', () => {
    const spy = vi.fn();
    const box = accountTab(
      account({ playback: null, hasCredential: false, needsLogin: true }),
      Date.now(),
      'play',
      { ...ACTS, login: spy },
    );
    const btn = [...box.querySelectorAll('.acct-btn')].find(
      (b) => b.textContent === '扫码登录取流账号',
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
      ACTS,
    );
    expect(box.textContent).toContain('读取中…');
    expect(box.textContent).not.toContain('未登录');
  });

  it('★ 非播放页 + 无昵称写「打开视频页后可见」', () => {
    const box = accountTab(
      account({ primary: { uname: null, level: null, loggedIn: 'unknown', source: 'none' } }),
      Date.now(),
      'other',
      ACTS,
    );
    expect(box.textContent).toContain('打开视频页后可见');
  });
});

describe('取流身份胶囊（步骤 4，2026-11-11）', () => {
  const BASE = {
    primary: { uname: '主', level: 6, loggedIn: 'yes' as const, source: 'live' as const },
    playback: {
      uname: '播',
      mid: 2,
      vipLabel: 'annual' as const,
      expireAt: null,
      healthy: true,
      checkedAt: 0,
      reason: null,
    },
    unknown: false,
    hasCredential: true,
    needsLogin: false,
    /** 2026-11-16：身份入口只在「开关开着 + 有账号」时渲染 */
    proxyEnabled: true,
  };

  function render(
    streamingIdentity: 'extension' | 'page' | null,
    toggleStreamingIdentity: (next: 'extension' | 'page') => void = () => undefined,
  ) {
    /**
     * 显式传值，**不用可选展开**：
     * 两个字段现在是必填，"不传"= 忘传，是一个缺口。
     * 想让胶囊不渲染就传 `null` 并断言 —— 那是一个判据。
     */
    return accountTab(BASE, Date.now(), 'play', {
      ...ACTS,
      streamingIdentity,
      toggleStreamingIdentity,
    });
  }

  it('extension → 图标按钮的 aria-label 写明当前用扩展账号取流', () => {
    const btn = render('extension').querySelector('.acct-identity-btn');
    expect(btn?.getAttribute('aria-label')).toContain('取流：扩展账号');
  });
  it('page → 图标按钮的 aria-label 写明当前用浏览器账号取流', () => {
    const btn = render('page').querySelector('.acct-identity-btn');
    expect(btn?.getAttribute('aria-label')).toContain('取流：浏览器账号');
  });

  it('★★ identity 为 null（还没读出来）→ **胶囊仍然渲染**，显示「取流身份：未知」', () => {
    /**
     * ## 这条用例 2026-11-11 被**反转**了，不是被"改成让它过"
     *
     * 上一版断言的是 `not.toContain('取流：')`（整块不渲染），理由是
     * "渲染任何默认值都是编数据"。**那个理由只对了一半**：
     *
     * | 规则 | 正确理解 |
     * | --- | --- |
     * | 「不渲染任何默认值」 | 是**内容**规则 —— 不许假装用户选了 extension / page |
     * | 但它**不是**删掉入口的许可 | **控件消失不是安全默认值，而是隐形 bug** |
     *
     * 真机事故：`streaming/status` 读失败 → `null` → 整块消失 →
     * **用户永远看不到"切换取流身份"的唯一入口**，以为功能没做。
     *
     * 正确做法：**内容仍是"未知"（不编数据），但入口要留着**。
     */
    const box = render(null);
    const btn = box.querySelector('.acct-identity-btn');
    /**
     * 2026-11-16：文字胶囊换成 24px 图标后，"内容"落在 `aria-label` 上
     * （视觉上没有字了）。判据本身没变：入口要在、且不许冒充真实身份。
     */
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toContain('还没读到取流身份设置');
    // 未知态**不许**冒充任何一个真实身份
    expect(btn?.getAttribute('aria-label')).not.toContain('扩展账号');
    expect(btn?.getAttribute('aria-label')).not.toContain('浏览器账号');
  });

  it('★ 未知态**不可点**（目标不确定，点了可能违反预期）', () => {
    /**
     * 未知时若允许点击，`identity === 'extension' ? 'page' : 'extension'` 会取到
     * 分支的错误一侧 —— 用户点一下可能反而切到他不想要的身份。
     *
     * **宁可少一个动作，不可让动作的结果违反预期。**
     *
     * 反向验证：把未知态也设成 `role="button"` → 本用例红。
     */
    const btn = render(null).querySelector<HTMLButtonElement>('.acct-identity-btn');
    expect(btn?.disabled).toBe(true);
  });

  it('有回调 → 可点，点击时传「目标值」而不是"取反"', () => {
    const spy = vi.fn();
    const box = render('extension', spy);
    const pillEl = box.querySelector('.acct-identity-btn');
    expect(pillEl).not.toBeNull();
    pillEl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith('page');
  });

  it('page 状态下点击 → 目标值是 extension', () => {
    const spy = vi.fn();
    const box = render('page', spy);
    box
      .querySelector('.acct-identity-btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith('extension');
  });

  it('★ 胶囊只加一个可点元素，不重复渲染', () => {
    /**
     * 原来这里测的是"没有回调时不渲染成可点元素"。
     *
     * **2026-11-11 改成必填后那个场景不再存在**（`toggleStreamingIdentity` 一定给），
     * 所以换一条更有意义的：胶囊**只出现一次**。
     *
     * 防的是"B 卡渲染两次"或"胶囊在 `pb` 有值/无值两个分支各加一次"这类回归。
     */
    const box = render('extension');
    expect(box.querySelectorAll('.acct-identity-btn').length).toBe(1);
  });

  it('★ 任何状态下都不出现「停用」「关闭」字样', () => {
    for (const id of ['extension', 'page'] as const) {
      const text = render(id).textContent ?? '';
      expect(text).not.toContain('停用');
      expect(text).not.toContain('关闭');
    }
  });

  /**
   * ## 入口该不该出现（2026-11-16 裁决 A）
   *
   * 用户看到的现场：「已停用」+ 开关关 + 一行「取流：扩展账号」——
   * 那行说的是**设置值**，不是**生效值**，所以读起来自相矛盾。
   *
   * 规则：只在「开关开着 + 有账号」时渲染。其余状态下"用哪个号取流"
   * 本来就不生效，显示它只会与开关读起来重复。
   *
   * ⚠️ 这与"控件消失是隐形 bug"不冲突：那条讲的是**读不到值**时也不能消失，
   * 这里讲的是**这个功能此刻不该出现**。两者判据不同，别混。
   */
  it('★ 开关关着 → 入口不渲染（但 B 卡还在）', () => {
    const box = accountTab({ ...BASE, proxyEnabled: false }, Date.now(), 'play', { ...ACTS });
    expect(box.querySelector('.acct-identity-btn')).toBeNull();
    // 减法只针对"不生效的设置值"，账号本身照常显示
    expect(box.querySelector('.acct-row.playback')).not.toBeNull();
  });

  it('★ 没有账号 → 入口不渲染（此时只能浏览器取流，切身份没有区别）', () => {
    const box = accountTab({ ...BASE, hasCredential: false, playback: null }, Date.now(), 'play', {
      ...ACTS,
    });
    expect(box.querySelector('.acct-identity-btn')).toBeNull();
  });

  it('开关开着 + 有账号 → 入口在（这是唯一有意义的状态）', () => {
    const box = accountTab({ ...BASE, proxyEnabled: true }, Date.now(), 'play', { ...ACTS });
    expect(box.querySelector('.acct-identity-btn')).not.toBeNull();
  });
  /**
   * ## task-10 剩余：`page` 身份下「没凭据」不是「没配置」（2026-11-11）
   *
   * 与 popup 里 `!configured` 那条**是同一个 bug 的面板侧镜像**：
   * 取流身份 = `'page'` 时 `hasCredential` 恒为 `false`，
   * 而旧判据 `!pb && !hasCredential` 会把这种**完全可用**的配置
   * 报成「还没有配置取流账号」。
   */
  describe('账号 Tab：page 身份下不误报「未配置」', () => {
    /** `page` 身份 + 无凭据 + 读不到资料 = 单账号模式的典型形态 */
    function noCredentialView(): AccountView {
      return {
        ...BASE,
        playback: null,
        hasCredential: false,
        unknown: false,
      };
    }

    function renderWith(
      identity: StreamingIdentity | null,
      view: AccountView = noCredentialView(),
    ) {
      return accountTab(view, Date.now(), 'play', {
        ...ACTS,
        streamingIdentity: identity,
        toggleStreamingIdentity: () => undefined,
      });
    }

    it('★★ page + 无凭据 → **不**显示「还没有配置取流账号」', () => {
      const box = renderWith('page');
      /**
       * 反向验证：把 `tabs.ts` 的判据改回 `if (!pb && !a.hasCredential)` →
       * 这里会再次显示「还没有配置取流账号」→ 本用例红。
       */
      expect(box.textContent).not.toContain('还没有配置取流账号');
    });

    it('★★ extension + 无凭据 → **仍然**显示「还没有配置取流账号」（对照组）', () => {
      /**
       * 对照组：证明上面那条不是"恒不显示"。
       * 唯一差别是 `streamingIdentity` 的取值。
       */
      const box = renderWith('extension');
      expect(box.textContent).toContain('还没有配置取流账号');
    });

    it('⚠️ identity 为 null（还读不出来）→ 走旧的保守判据，仍然报未配置', () => {
      /**
       * 纪律与 popup 一致：**缺参数不改口**。不知道用户选了谁，
       * 就不能替他认定"这个配置是好的"。
       *
       * 反向验证：把 `streamingIdentity === null` 当成 `'page'` → 本用例红。
       */
      const box = renderWith(null);
      expect(box.textContent).toContain('还没有配置取流账号');
    });

    it('page + 有凭据（配过但选择不用）→ 也不误报', () => {
      const box = renderWith('page', { ...BASE, hasCredential: true });
      expect(box.textContent).not.toContain('还没有配置取流账号');
    });
  });
});

/**
 * ## 首页推荐流开关（2026-11-11）—— 与取流身份**完全独立**
 *
 * 用户原话：
 * > **首页推荐流的变化与取流身份是完全独立的两个功能**
 *
 * 所以本组测试最重要的一条是：**改 `streamingIdentity` 不影响本开关的可点性与勾选态**。
 */
describe('显示 Tab：首页推荐流开关（2026-11-11 从账号 Tab 迁来）', () => {
  /**
   * ## 为什么整组迁到这里
   *
   * 用户裁决：「**移到显示 tab，但不改 tab 名**」。
   *
   * 迁移只改**渲染位置**，不改任何判据 —— 所以下面这些断言
   * （可点性 = `hasCredential`、与 `streamingIdentity` 无关、勾选态来自 `feedAccountEnabled`）
   * **一条都没删，只是换了个宿主 Tab**。
   *
   * ⚠️ 如果哪天有人把开关挪回账号 Tab 或别处，**这一组会红** ——
   * 那正是它该做的事：它钉的是"这个开关存在于哪个 Tab"。
   */
  const VIEW_WITH_CRED: AccountView = {
    primary: { uname: '主', level: 6, loggedIn: 'yes', source: 'live' },
    playback: {
      uname: 'bili_x',
      mid: 1,
      vipLabel: 'annual',
      expireAt: null,
      healthy: true,
      checkedAt: 0,
      reason: null,
    },
    unknown: false,
    hasCredential: true,
    needsLogin: false,
    /** 2026-11-16：身份入口只在「开关开着 + 有账号」时渲染 */
    proxyEnabled: true,
  };

  function renderDisplay(
    over: {
      feedAccountEnabled?: boolean;
      hasCredential?: boolean;
    } = {},
  ) {
    return displayTab(true, {
      ...DISPLAY_ACTS,
      feedAccountEnabled: over.feedAccountEnabled ?? false,
      hasCredential: over.hasCredential ?? true,
    });
  }

  /** 找到推荐流开关的 checkbox（按 label 文案） */
  function feedSwitch(box: HTMLElement): HTMLInputElement | undefined {
    return [...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((el) =>
      (el.closest('label')?.textContent ?? '').includes('首页推荐流使用取流账号'),
    );
  }

  it('★ 开关在「显示」Tab 里（迁位置的直接断言）', () => {
    expect(renderDisplay().textContent).toContain('首页推荐流使用取流账号');
  });

  it('★ 开关**不在**账号 Tab 里了（迁走之后账号 Tab 不该再有它）', () => {
    /**
     * ## 这条防的是"迁了一半"
     *
     * 只断言"显示 Tab 有"是不够的 —— 若旧位置没删干净，
     * 用户会看到**两个**同名开关，而且它们共用同一个 storage key，
     * 拨一个另一个不同步（面板只在切 Tab 时重画）。
     *
     * 反向验证：把账号 Tab 里那段加回去 → 本用例红。
     */
    const accountBox = accountTab(VIEW_WITH_CRED, Date.now(), 'play', {
      ...ACTS,
      streamingIdentity: 'extension',
      toggleStreamingIdentity: () => undefined,
    });
    expect(accountBox.textContent).not.toContain('首页推荐流使用取流账号');
  });

  it('★★ 有凭据 → 开关**可点**', () => {
    expect(feedSwitch(renderDisplay({ hasCredential: true }))?.disabled).toBe(false);
  });

  it('★★ **没有凭据 → 开关灰掉点不动**', () => {
    /**
     * 用户原话：「如果用户没有扫码登录扩展账号的话这个开关就灰掉无法点击」。
     *
     * 🔁 反向验证：把 \`disabled: !actions.hasCredential\` 改成 \`disabled: false\` → 本用例红。
     */
    const el = feedSwitch(renderDisplay({ hasCredential: false }));
    expect(el).toBeDefined();
    expect(el?.disabled).toBe(true);
  });

  it('★★ 没有凭据时**不再**给出引导语（2026-11-12 task-11 按用户要求删除）', () => {
    /**
     * ## 这条测试的口径**反过来了**，请勿"修回去"
     *
     * 旧版断言：「没有凭据时给出下一步动作」→ `toContain('先扫码登录取流账号')`。
     *
     * 用户原话（task-11）：
     * > 「"先扫码登录取流账号，才能用它来换首页推荐流"…… 这些字都可以删掉」
     *
     * 所以现在断言的是**它不在了**。
     *
     * ⚠️ 已知副作用（用户已确认接受）：无凭据时开关灰着且无解释。
     * **不要**自己再造一句替代文案 —— 用户要求的是删除。
     *
     * 🔁 反向验证：把那句 `pane-note` 加回 `displayTab()` → 本用例红。
     */
    expect(renderDisplay({ hasCredential: false }).textContent).not.toContain('先扫码登录取流账号');
  });

  it('勾选态来自 feedAccountEnabled', () => {
    expect(feedSwitch(renderDisplay({ feedAccountEnabled: true }))?.checked).toBe(true);
    expect(feedSwitch(renderDisplay({ feedAccountEnabled: false }))?.checked).toBe(false);
  });

  it('★★ 可点性**与取流身份无关** —— 类型里根本没有 StreamingIdentity', () => {
    /**
     * ## 为什么这条从"传不同 identity 看结果"改成了"看类型"
     *
     * 迁到 \`displayTab\` 之后，**它的 \`actions\` 里没有 \`streamingIdentity\` 这个字段** ——
     * 想"让开关跟着身份变"必须先改类型签名，那会让调用点报错。
     *
     * **比原来在账号 Tab 里"传两个不同的 identity 试一下"更强**：
     * 原来那个是**行为**断言（试出来的一样），现在是**结构**断言（根本传不进去）。
     *
     * 见 \`tabs.ts\` 的 \`displayTab\` 注释：「迁 Tab 只改渲染位置，不改这条判据」。
     */
    const actsKeys = Object.keys(DISPLAY_ACTS);
    expect(
      actsKeys,
      'displayTab 的 actions 里出现了身份相关字段 —— 两个功能被耦合了',
    ).not.toContain('streamingIdentity');
    expect(actsKeys).toContain('hasCredential');
  });

  it('★★ 推荐流开关**没有 hint**（2026-11-12 task-11 按用户要求删除）', () => {
    /**
     * ## 用户原话（task-11）
     *
     * > 「把首页推荐流使用取流账号这个开关的"打开后首页推荐完成取流账号的"
     * > 这些详细描述删掉，**标题已经能够完美解释这个开关的含义了**」
     *
     * ## 这条测试的口径**反转了**，请勿"修回去"
     *
     * 旧版断言：「hint 只有 14 字，且不提机制词」→ `toContain('打开后，首页推荐换成取流账号的')`。
     * 现在断言的是**它完全不在了**。
     *
     * ⚠️ **不要自己再造一句更短的说明代替它** —— 用户要求的是删除。
     *
     * 🔁 反向验证：给 `switchRow` 加回 `hint: '打开后，首页推荐换成取流账号的'` → 本用例红。
     */
    const box = renderDisplay();
    const text = box.textContent ?? '';

    expect(text, 'hint 还在 —— 用户要求删掉全部说明文字').not.toContain(
      '打开后，首页推荐换成取流账号的',
    );

    // 机制词当然也不许出现（本来就在 hint 里，hint 没了它自然也没了）
    for (const banned of ['首屏', '滚动加载', '隐藏']) {
      expect(text, `出现了机制词「${banned}」`).not.toContain(banned);
    }
  });

  it('★ 实现事实没变：打开开关仍隐藏首屏批（只是不再写进文案）', () => {
    /**
     * ## 文案精简 ≠ 功能改变
     *
     * 用户说"不用写清首屏也会换" —— 那是**文案**要求。
     * **实现该隐藏还是要隐藏**，否则"首页推荐换成取流账号的"就变成假话。
     *
     * 反向验证：把 \`shouldHideFeedCards\` 改成恒 \`false\` → 本用例红。
     */
    expect(
      shouldHideFeedCards({ feedAccountEnabled: true, hasCredential: true }),
      '打开开关应隐藏首屏批（否则文案"换成取流账号的"是假话）',
    ).toBe(true);
  });
});

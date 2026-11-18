// @vitest-environment jsdom

/**
 * 广告清理的**失效可见化**（ADR 0031 的必需项，2026-11-19 落地）。
 *
 * ## 这个文件守什么
 *
 * ADR 0031 :163-164 把「诊断页显示匹配状态」列为**必需项**，理由是
 * B 站改版会让选择器失效、而扩展没有任何远程修复手段；:185 点名失败形态：
 * 「选择器失效是**静默的**：命中 0 不报错」。
 *
 * 在此之前，界面上「这页本来没广告」与「判据全挂了」**完全一样**。
 * 这里守的是这两者能被分开 —— 也守住**不许**把它们混回一起。
 *
 * ## 为什么用 jsdom 而且是真判据
 *
 * `markAdElements()` 读的是 `getComputedStyle(el).getPropertyValue('--pluma-ad-card')`。
 * jsdom 真的会算内联与样式表里的自定义属性（本文件实测：`<style>.ad{--pluma-ad-card:1}`
 * 下 `getComputedStyle` 返回 `"1"`），所以这里**不桩判据** —— 桩了就等于把
 * "选择器失效能不能被发现"这件事本身变成假设。
 *
 * ## ADR 0031 记的测试债
 *
 * 它写着「DOM 样式功能跑不了完整单测……这是本 ADR 主动接受的测试债务」。
 * 那句话对**视觉结果**（元素真的被 `display:none` 了）仍然成立；
 * 但「判据命中了几个、失效了没有」是**可测的观测**，不需要看渲染结果。
 * 本文件测的正是后者，把那条债务里可还的一部分还掉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AD_DEAD_ATTR, AD_MARK_ATTR } from '../../../src/content/site-clean/ads-css';
import {
  countMarkedAds,
  inspectAdClean,
  installAdObserver,
  markAdElements,
} from '../../../src/content/site-clean/ads';
import { adCleanVerdictText } from '../../../src/content/panel/diagnostics';

/** 一份真的会命中的判据样式（模拟扩展注入的 `buildJudgementCss()` 产出） */
function installJudgementCss(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  // ⚠️ 也必须清 documentElement 的属性：上一条用例写的 data-pluma-ad-dead 会活到下一条，
  // 表现是"单独跑必过、跑全文件必挂"（与 resetBridge() 记的那个坑同型）。
  document.documentElement.removeAttribute(AD_DEAD_ATTR);
});

describe('inspectAdClean：三种结论必须分开', () => {
  it('★★ 标记数 > 0 → working（正常）', () => {
    installJudgementCss('.ad-report{--pluma-ad-card:1}');
    document.body.innerHTML = '<div class="ad-report" id="ad1"></div>';
    // 先按真判据打标记（这是 `applyAdClean()` 里那一步）
    const changed = markAdElements(document, window);
    expect(changed).toBe(1);

    const ad = inspectAdClean(document);
    expect(ad).toMatchObject({ candidates: 1, marked: 1, containerMissing: false, verdict: 'working' });
  });

  it('★★ 有候选、但一处都没命中判据 → suspect（不是失效）', () => {
    /**
     * 预筛（33 个选择器）宽于判据是**设计**：候选在而判据不命中，完全可能是
     * "这些候选本来就不是广告"。所以这一档**不许**说成失效。
     */
    installJudgementCss('.ad-report{--pluma-ad-card:1}');
    // `.feed-card` 在预筛里，但没有判据命中它
    document.body.innerHTML = '<div class="feed-card" id="c1"></div>';

    const ad = inspectAdClean(document);
    expect(ad.candidates).toBe(1);
    expect(ad.marked).toBe(0);
    expect(ad.verdict).toBe('suspect');
  });

  it('★★ 连候选都没有 → dead（这才是"判据可能已失效"）', () => {
    // 33 个预筛选择器一个都不命中 —— 真实 B 站页面上成片出现的那类容器一个都没有
    document.body.innerHTML = '<div class="something-else"></div>';

    const ad = inspectAdClean(document);
    expect(ad).toMatchObject({ candidates: 0, marked: 0, containerMissing: false, verdict: 'dead' });
  });

  it('⛔ 「没有广告」与「判据失效」不许落进同一个结论', () => {
    /**
     * 这是本文件存在的理由。两种 0 在旧界面上完全一样，而它们的处置相反：
     * `suspect` 是"多半正常"，`dead` 是"去看是不是 B 站改版了"。
     */
    installJudgementCss('.ad-report{--pluma-ad-card:1}');
    document.body.innerHTML = '<div class="feed-card"></div>';
    const noAd = inspectAdClean(document);

    document.body.innerHTML = '<div class="unrelated"></div>';
    const dead = inspectAdClean(document);

    expect(noAd.marked).toBe(0);
    expect(dead.marked).toBe(0);
    expect(noAd.verdict).not.toBe(dead.verdict);
  });
});

describe('countMarkedAds：只数"被标记的"，不数"候选"', () => {
  it('★ 候选多、标记少 → 只报标记数', () => {
    installJudgementCss('.ad-report{--pluma-ad-card:1}');
    document.body.innerHTML =
      '<div class="ad-report" id="a"></div>' + '<div class="feed-card" id="b"></div>';
    markAdElements(document, window);

    // 预筛 2 个候选，判据只命中 1 个
    expect(document.querySelectorAll('[data-pluma-ad="1"]').length).toBe(1);
    expect(countMarkedAds(document)).toBe(1);
  });

  it('★ 标记属性名是 `data-pluma-ad`（换了名字会让计数静默归零）', () => {
    // 硬编码断言：`AD_MARK_ATTR` 变了而 CSS 或计数没跟，就是"数永远是 0"
    expect(AD_MARK_ATTR).toBe('data-pluma-ad');
  });

  it('⛔ 标记被撤销后计数跟着降（不是只增不减）', () => {
    /**
     * `markAdElements()` 早年被抓到"只加不减"，导致关掉开关元素仍被隐藏。
     * 这里顺带守计数口径：撤销之后 `countMarkedAds` 必须跟着变，
     * 否则诊断页会一直报一个更高的历史值。
     */
    installJudgementCss('.ad-report{--pluma-ad-card:1}');
    document.body.innerHTML = '<div class="ad-report" id="a"></div>';
    markAdElements(document, window);
    expect(countMarkedAds(document)).toBe(1);

    // 判据不再命中（模拟用户拨动开关 / 元素换类）→ 标记应被撤销
    installJudgementCss('.ad-report{--pluma-ad-card:0}');
    markAdElements(document, window);
    expect(countMarkedAds(document)).toBe(0);
  });
});

describe('adCleanVerdictText：文案不许把"没命中"说成"坏了"', () => {
  it('★ working → 说出隐藏了几处', () => {
    expect(adCleanVerdictText({ candidates: 3, marked: 3, containerMissing: false, verdict: 'working' })).toContain(
      '已隐藏 3 处',
    );
  });

  it('★ suspect → 说清"通常是这一页本来就没有广告"', () => {
    const text = adCleanVerdictText({ candidates: 2, marked: 0, containerMissing: false, verdict: 'suspect' });
    expect(text).toContain('2 个候选位置');
    expect(text).toContain('本来就没有广告');
    // ⛔ 不许说成失效
    expect(text).not.toContain('失效');
  });

  it('★ dead → 说"可能已失效"，**不许**说成"已失效"（我们没观测到因果）', () => {
    const text = adCleanVerdictText({ candidates: 0, marked: 0, containerMissing: false, verdict: 'dead' });
    expect(text).toContain('找不到任何广告位结构');
    // 观测到的是"整页没有广告位结构"，不是"B 站改版了"
    expect(text).toContain('可能已因');
    expect(text).not.toContain('已失效');
  });

  it('⛔ 三档文案互不相同（合成一句就分不出"没广告"和"坏了"）', () => {
    const a = adCleanVerdictText({ candidates: 1, marked: 1, containerMissing: false, verdict: 'working' });
    const b = adCleanVerdictText({ candidates: 1, marked: 0, containerMissing: false, verdict: 'suspect' });
    const c = adCleanVerdictText({ candidates: 0, marked: 0, containerMissing: false, verdict: 'dead' });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('★★ 容器超时信号优先于其它一切（哪怕此刻已经有标记）', () => {
    /**
     * `containerMissing` 是**时间维度**的证据：15 秒内 4 个已知容器一个都没出现。
     * 它比"此刻数不到"强得多 —— 所以排在 `working` 前面：
     * 就算这一刻页面已经正常标记上了，"曾经 15 秒没容器"仍说明结构变了。
     */
    const text = adCleanVerdictText({
      candidates: 5,
      marked: 5,
      containerMissing: true,
      verdict: 'working',
    });
    expect(text).toContain('15 秒内没找到');
    expect(text).toContain('可能已因 B 站改版失效');
    // ⛔ 不许被 working 那句盖掉（否则窗口过去后就再也看不到这条信号）
    expect(text).not.toContain('已隐藏 5 处');
  });

  it('★ 超时信号不只是文案：它作为字段独立下发', () => {
    /**
     * 这个标记由**另一个 bundle**（`content-home`）写，面板只是读。
     * 所以它必须能从 `inspectAdClean()` 拿到，而不是靠命中数反推 ——
     * 命中数正常时它同样可能是 `true`（15 秒后才加载出容器）。
     */
    document.documentElement.setAttribute(AD_DEAD_ATTR, '1');
    installJudgementCss('.ad-report{--pluma-ad-card:1}');
    document.body.innerHTML = '<div class="ad-report" id="a"></div>';
    markAdElements(document, window);

    const ad = inspectAdClean(document);
    expect(ad.marked).toBe(1);
    expect(ad.verdict).toBe('working');
    // 命中正常，但超时信号仍在 —— 两个信号互不覆盖
    expect(ad.containerMissing).toBe(true);
  });

  it('★ 没有那个属性时 containerMissing 为 false（不猜）', () => {
    document.body.innerHTML = '<div class="ad-report"></div>';
    expect(inspectAdClean(document).containerMissing).toBe(false);
  });
});

describe('容器超时标记：常量与写入点', () => {
  it('★ 属性名是 `data-pluma-ad-dead`（跨 bundle 契约，改名会让诊断页永远读 false）', () => {
    // 一边写（content-home）、一边读（panel），没有类型把两边绑住 —— 只能钉住字面量
    expect(AD_DEAD_ATTR).toBe('data-pluma-ad-dead');
  });

  it('★ 与广告标记属性**不同**（同名会让"已标记"与"结构失效"互相污染）', () => {
    expect(AD_DEAD_ATTR).not.toBe(AD_MARK_ATTR);
  });
});

/**
 * 写入点：15 秒兜底触发时必须把标记落到 DOM 上。
 *
 * ## 为什么这条不能省
 *
 * `installAdObserver()` 的 `onGiveUp` 在 `content-home.content.ts` 里只 `console.warn`，
 * 用户永远看不到 —— 这正是 ADR 0031 :185 说的「失效是静默的」。
 * 上面的用例只证明"读得到 ⇒ 讲得对"，但如果不写，读的那一侧永远读 false，
 * 整条链路在界面上等价于**从未实现**。所以必须有一条用例真的驱动那个 setTimeout。
 */
describe('容器超时标记的写入点：15 秒兜底真的落标记', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('★★ 一个已知容器都没有 → 15 秒后写 data-pluma-ad-dead="1"', () => {
    // body 里没有任何 CONTAINERS 选择器命中的节点
    document.body.innerHTML = '<div class="something-else"></div>';

    const onGiveUp = vi.fn();
    const observer = installAdObserver(document, onGiveUp);

    // ⚠️ 15 秒之前不许写：慢加载页面此时可能只是还没渲染
    vi.advanceTimersByTime(14999);
    expect(document.documentElement.getAttribute(AD_DEAD_ATTR)).toBeNull();
    expect(onGiveUp).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(document.documentElement.getAttribute(AD_DEAD_ATTR)).toBe('1');
    expect(onGiveUp).toHaveBeenCalledTimes(1);

    // 落完标记之后，诊断页那一侧立刻读得到（跨 bundle 的唯一接口是 DOM）
    expect(inspectAdClean(document).containerMissing).toBe(true);

    observer.stop();
  });

  it('★★ 15 秒内容器迟到了 → 不写标记（不许诬告慢加载页面）', () => {
    /**
     * 这一条是上一条的**反面**：没有它，"无条件写标记"也能让上一条通过。
     * 时序判据的价值全在"等满 15 秒之后仍在不在"，而不是"等过就报"。
     */
    document.body.innerHTML = '<div class="something-else"></div>';

    const onGiveUp = vi.fn();
    const observer = installAdObserver(document, onGiveUp);

    // 第 10 秒容器渲染出来（闭包里的 CONTAINERS 在回调时才查，所以这样是有效的）
    vi.advanceTimersByTime(10000);
    document.body.insertAdjacentHTML('beforeend', '<div class="right-container"></div>');

    vi.advanceTimersByTime(5000);
    expect(document.documentElement.getAttribute(AD_DEAD_ATTR)).toBeNull();
    expect(onGiveUp).not.toHaveBeenCalled();

    observer.stop();
  });

  it('★ stop() 之后超时回调不再落标记（卸载后不许留痕）', () => {
    document.body.innerHTML = '<div class="something-else"></div>';

    const onGiveUp = vi.fn();
    const observer = installAdObserver(document, onGiveUp);
    observer.stop();

    vi.advanceTimersByTime(20000);
    expect(document.documentElement.getAttribute(AD_DEAD_ATTR)).toBeNull();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});
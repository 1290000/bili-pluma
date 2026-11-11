// @vitest-environment jsdom

/**
 * 首屏推荐流隐藏 —— 判据 + DOM 行为。
 *
 * ## 最重要的一组断言：**与取流身份无关**
 *
 * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
 *
 * 所以本文件**故意不出现 `streamingIdentity` 这个词** ——
 * 若哪天有人把它加进判据，这组测试仍会全绿，**但那是错的**。
 * 防法是：`shouldHideFeedCards` 的入参类型里根本没有这个字段（类型级防线）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FEED_CARD_SELECTOR,
  HIDE_STYLE_ID,
  SWIPE_SELECTOR,
  evaluateHidePlan,
  shouldHideFeedCards,
} from '@/src/core/feed-identity/feed-hide';
import {
  applyHideStyle,
  collectTargets,
  isHideStyleApplied,
  removeHideStyle,
  updateHide,
} from '@/src/content/feed-order/feed-hide-dom';

function resetDoc(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
}

/** 造首页结构：轮播（内含 .feed-card）+ 10 个 .feed-card + 18 个 bili-feed-card */
function buildHome(): void {
  const swipe = document.createElement('div');
  swipe.className = 'recommended-swipe';
  const swipeInner = document.createElement('div');
  swipeInner.className = 'feed-card';
  swipe.appendChild(swipeInner);
  document.body.appendChild(swipe);

  for (let i = 0; i < 10; i++) {
    const fc = document.createElement('div');
    fc.className = 'feed-card';
    document.body.appendChild(fc);
  }

  for (let i = 0; i < 18; i++) {
    const bfc = document.createElement('div');
    bfc.className = 'bili-feed-card';
    document.body.appendChild(bfc);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDoc();
});

describe('shouldHideFeedCards —— 只看开关 + 凭据', () => {
  it('开关开 + 有凭据 → true', () => {
    expect(shouldHideFeedCards({ feedAccountEnabled: true, hasCredential: true })).toBe(true);
  });

  it('★★ 开关关 → false（用户没开这个功能）', () => {
    expect(shouldHideFeedCards({ feedAccountEnabled: false, hasCredential: true })).toBe(false);
  });

  it('★★ 开关开但**没有凭据** → false（藏了会看到空白）', () => {
    /**
     * 这是安全底线：没有扫码登录扩展账号时，rcmd 批也是页面账号的。
     * 藏掉 A 会让用户看到"推荐流少了 10 张"，甚至空白。
     *
     * 反向验证：把 `&& input.hasCredential` 删掉 → 本用例红。
     */
    expect(shouldHideFeedCards({ feedAccountEnabled: true, hasCredential: false })).toBe(false);
  });

  it('两个都 false → false', () => {
    expect(shouldHideFeedCards({ feedAccountEnabled: false, hasCredential: false })).toBe(false);
  });

  it('全矩阵：只有 (开, 有凭据) 一种为真', () => {
    const rows = [true, false].flatMap((e) =>
      [true, false].map(
        (c) =>
          `${e ? 'on' : 'off'}/${c ? 'cred' : 'noCred'} → ${String(shouldHideFeedCards({ feedAccountEnabled: e, hasCredential: c }))}`,
      ),
    );
    expect(rows).toEqual([
      'on/cred → true',
      'on/noCred → false',
      'off/cred → false',
      'off/noCred → false',
    ]);
  });
});

describe('evaluateHidePlan —— 失败必须可观测', () => {
  it('不该隐藏时 → 不告警（匹配 0 张正常）', () => {
    const p = evaluateHidePlan({ feedAccountEnabled: false, hasCredential: true }, 0);
    expect(p.apply).toBe(false);
    expect(p.warn).toBe(false);
  });

  it('⚠️ 该隐藏却匹配 0 张 → **告警**（选择器可能失效）', () => {
    /**
     * 反向验证：删掉 `if (matchedCount === 0)` 分支 → 本用例红。
     */
    const p = evaluateHidePlan({ feedAccountEnabled: true, hasCredential: true }, 0);
    expect(p.apply).toBe(true);
    expect(p.warn).toBe(true);
    expect(p.warnReason).toContain('匹配到 0 个');
  });

  it('正常 10 张 → 不告警', () => {
    expect(evaluateHidePlan({ feedAccountEnabled: true, hasCredential: true }, 10).warn).toBe(
      false,
    );
  });

  it('B 站小幅改批大小（8 / 12）→ 仍不告警', () => {
    expect(evaluateHidePlan({ feedAccountEnabled: true, hasCredential: true }, 8).warn).toBe(false);
    expect(evaluateHidePlan({ feedAccountEnabled: true, hasCredential: true }, 12).warn).toBe(
      false,
    );
  });

  it('⚠️ 匹配数远超预期 → 告警（结构可能已变）', () => {
    const p = evaluateHidePlan({ feedAccountEnabled: true, hasCredential: true }, 25);
    expect(p.warn).toBe(true);
    expect(p.warnReason).toContain('结构可能已变');
  });
});

describe('collectTargets —— 只命中 .feed-card，排除轮播内部', () => {
  it('首页结构：命中 10 个（轮播里那个被排除）', () => {
    buildHome();
    expect(collectTargets(document)).toHaveLength(10);
  });

  it('⚠️ 轮播内部零命中（`recommended-swipe` 里的 .feed-card 必须排除）', () => {
    /**
     * 反向验证：删掉 `swipes.some(...)` 过滤 → 本用例得到 11 个 → 红。
     * 那会让顶部轮播整个消失 —— 用户会以为扩展把页面搞坏了。
     */
    buildHome();
    const targets = collectTargets(document);
    const swipe = document.querySelector(SWIPE_SELECTOR);
    expect(targets.filter((el) => swipe?.contains(el))).toHaveLength(0);
  });

  it('不碰 .bili-feed-card（rcmd 批）', () => {
    buildHome();
    expect(collectTargets(document).every((el) => !el.classList.contains('bili-feed-card'))).toBe(
      true,
    );
  });
});

describe('updateHide —— 隐藏与撤销', () => {
  it('开关开 + 有凭据 → 注入样式', () => {
    buildHome();
    const r = updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    expect(r.applied).toBe(true);
    expect(isHideStyleApplied(document)).toBe(true);
  });

  it('★★ 开关关 → **不加任何样式**', () => {
    buildHome();
    const r = updateHide(document, { feedAccountEnabled: false, hasCredential: true });
    expect(r.applied).toBe(false);
    expect(isHideStyleApplied(document)).toBe(false);
  });

  it('★★ 关掉开关 → **样式被撤销**（可逆）', () => {
    buildHome();
    updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    expect(isHideStyleApplied(document)).toBe(true);

    updateHide(document, { feedAccountEnabled: false, hasCredential: true });
    expect(isHideStyleApplied(document)).toBe(false);
  });

  it('★★ 凭据被清掉 → 样式也被撤销', () => {
    buildHome();
    updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    updateHide(document, { feedAccountEnabled: true, hasCredential: false });
    expect(isHideStyleApplied(document)).toBe(false);
  });

  it('重复调用幂等：不会堆出多个 style', () => {
    buildHome();
    updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    expect(document.querySelectorAll(`#${HIDE_STYLE_ID}`)).toHaveLength(1);
  });

  it('CSS 必须是 display:none（不是 visibility / height:0）', () => {
    /**
     * 实测：`visibility: hidden` 元素仍占位，**B 不会上移**；
     * `height: 0` 需要额外处理 margin/padding。
     * `display: none` 才是"移出布局流、B 自然上移"。
     */
    buildHome();
    updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    const css = document.getElementById(HIDE_STYLE_ID)?.textContent ?? '';
    expect(css).toContain('display: none');
    expect(css).not.toContain('visibility');
  });

  it('选择器是 .feed-card，不是 .bili-video-card', () => {
    expect(FEED_CARD_SELECTOR).toBe('.feed-card');
    expect(FEED_CARD_SELECTOR).not.toContain('bili-video-card');
  });

  it('该隐藏但页面没有 .feed-card → 仍注入（后续 DOM 变更时生效），且告警', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = updateHide(document, { feedAccountEnabled: true, hasCredential: true });
    expect(r.applied).toBe(true);
    expect(r.plan.warn).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('applyHideStyle / removeHideStyle 幂等性', () => {
  it('apply 两次只有 1 个节点', () => {
    applyHideStyle(document);
    applyHideStyle(document);
    expect(document.querySelectorAll(`#${HIDE_STYLE_ID}`)).toHaveLength(1);
  });

  it('remove 不存在的节点不抛错', () => {
    expect(() => removeHideStyle(document)).not.toThrow();
  });
});

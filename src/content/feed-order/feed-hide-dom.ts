/**
 * 首屏推荐流**隐藏** —— DOM 层。
 *
 * 判据全在 `@core/feed-identity/feed-hide`（纯函数，有单测）。本文件只管"怎么落进页面"。
 *
 * ## 为什么不走 `content-home.content.ts`（ADR 0031）
 *
 * `content-home` 的前提是**「不碰账号」** —— 三条硬约束写死了
 * `不读 cookie、不发请求、不改响应`。
 *
 * 而本功能**必须**读两样账号相关的东西：
 *   - `pluma:feed-account-enabled`（用户开关，`storage.local`）
 *   - `proxy/status` 的 `hasCredential`（有没有扫码登录扩展账号）
 *
 * 硬塞进去 = 在 ADR 0031 里开例外，而 0031 的整篇论证建立在"不碰账号"上。
 * **所以放在独立入口**（`entrypoints/content-feed-order.content.ts`），
 * ADR 0031 一个字不改。
 *
 * ## 三条已知限制（**不许当成已验证**）
 *
 * 1. **B 站曝光上报可能按 DOM 顺序** —— 隐藏后上报可能仍记在 A 批上。
 *    **未测。** 若属实，"已看过"的记录与用户实际看到的不一致。
 * 2. **依赖 `.feed-card` 类名** —— B 站改版会失效（由 `evaluateHidePlan` 告警）。
 * 3. **匹配数异常时告警，不静默**。
 */

import type { FeedHideInput } from '@core/feed-identity/feed-hide';
import {
  FEED_CARD_SELECTOR,
  HIDE_CSS,
  HIDE_STYLE_ID,
  SWIPE_SELECTOR,
  evaluateHidePlan,
  shouldHideFeedCards,
} from '@core/feed-identity/feed-hide';

/** 防抖间隔（ms）。B 站首页 DOM 变更频繁，不防抖会拖慢页面 */
const DEBOUNCE_MS = 100;

/** 预期首屏 SSR 批大小（实测 `[10,10,10,10,10]`，标准差 0） */
const EXPECTED_FEED_CARDS = 10;

/** 注入 `<style>`（幂等：已有同 id 节点时不重复加） */
export function applyHideStyle(doc: Document = document): void {
  if (doc.getElementById(HIDE_STYLE_ID)) return;

  const style = doc.createElement('style');
  style.id = HIDE_STYLE_ID;
  style.textContent = HIDE_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** 撤销样式（关开关 / 失去凭据时调用） */
export function removeHideStyle(doc: Document = document): void {
  doc.getElementById(HIDE_STYLE_ID)?.remove();
}

/** 样式是否已注入 */
export function isHideStyleApplied(doc: Document = document): boolean {
  return doc.getElementById(HIDE_STYLE_ID) !== null;
}

/**
 * 数页面上有多少个 `.feed-card`，并**剔除轮播内部的**。
 *
 * ## 为什么要剔除轮播
 *
 * 实测：`recommended-swipe`（顶部轮播）内部**也可能套 `.feed-card`** 结构。
 * 藏掉它会让顶部轮播整个消失 —— 那是明显的视觉错误，
 * 而且用户会以为扩展把页面搞坏了。
 *
 * @returns 命中的元素（**已排除轮播内部的**）
 */
export function collectTargets(doc: Document = document): HTMLElement[] {
  const all = [...doc.querySelectorAll<HTMLElement>(FEED_CARD_SELECTOR)];
  const swipes = [...doc.querySelectorAll<HTMLElement>(SWIPE_SELECTOR)];

  return all.filter((el) => {
    // 排除「自己就是轮播」或「在轮播内部」
    return !swipes.some((s) => s === el || s.contains(el));
  });
}

/**
 * 校正一次 —— **可重复调用，结果一致**（幂等）。
 *
 * @returns 本次是否加了样式，以及评估结果
 */
export function updateHide(
  doc: Document,
  input: FeedHideInput,
): { applied: boolean; plan: ReturnType<typeof evaluateHidePlan> } {
  const targets = collectTargets(doc);
  const plan = evaluateHidePlan(input, targets.length, EXPECTED_FEED_CARDS);

  if (!shouldHideFeedCards(input)) {
    /**
     * 不该隐藏 → **必须撤销已有的**。
     *
     * 这是"可逆"的实现：用户关掉开关、或凭据被清掉时，
     * 之前注入的样式要被清掉，否则页面看起来还是"A 不见了"。
     */
    removeHideStyle(doc);
    return { applied: false, plan };
  }

  applyHideStyle(doc);

  if (plan.warn) {
    /**
     * ⚠️ **不静默失败**：选择器失效时必须说出来。
     *
     * 用 `console.warn` 而不是抛错：抛错会让整个 content script 挂掉，
     * 而"隐藏没生效"本身不该影响其他功能。
     */
    console.warn(`[pluma] 首页推荐隐藏：${plan.warnReason ?? ''}`);
  }

  return { applied: true, plan };
}

/**
 * 装一个防抖的 MutationObserver，持续校正。
 *
 * @param getInput 每次变更时**现读**当前开关与凭据（不缓存 —— 用户可能中途操作）
 * @returns `{ stop, refresh }`
 */
export function installHideObserver(
  doc: Document,
  getInput: () => Promise<FeedHideInput>,
): { stop: () => void; refresh: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (stopped) return;
    const input = await getInput().catch(() => ({
      feedAccountEnabled: false,
      hasCredential: false,
    }));
    if (stopped) return;
    updateHide(doc, input);
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, DEBOUNCE_MS);
  };

  /**
   * 观察整棵树：B 站可能**替换整个列表容器**（首屏 SSR → rcmd 接管时）。
   * 只观察容器的话，容器被换掉后观察器就失效了，而它不会报错。
   */
  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  void run();

  return {
    refresh: schedule,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      observer.disconnect();
      /** 销毁时**撤销样式** —— 否则扩展失效后页面还留着我们的 display:none */
      removeHideStyle(doc);
    },
  };
}

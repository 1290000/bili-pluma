/**
 * 首屏推荐流**隐藏** —— 纯判据，零 DOM、零 chrome API。
 *
 * ## 这个功能做什么（用户最终需求，2026-11-11）
 *
 * 用户在面板里打开「首页推荐流使用取流账号」后：
 * - **首屏那 10 张 `.feed-card`（页面账号的 SSR 推荐）彻底隐藏**
 * - 取流账号的推荐（`.bili-feed-card`，直接挂 grid 的 18 个）**自动上移填满**
 *
 * ## 为什么是"隐藏"而不是"推到后面"
 *
 * 用户原话：
 * > **用户打开这个开关之后，就是希望首页的视频推荐流全部都换成另一个账号的，
 * > 你还让浏览器账号的卡片保留有什么好的**
 *
 * `order: 9999` 只是视觉重排，A 的卡仍在页面上、滚动到底还会看到。
 * **隐藏才是"全部换成另一个账号"的字面实现。**
 *
 * ## 真机实测（2026-11-11，三次采样）
 *
 * | | 隐藏前 | 隐藏后 |
 * | --- | --- | --- |
 * | 首屏可见卡 | 22 张（A=12 / B=10） | 22 张（**A=0 / B=22**） |
 * | 首张可见卡 `top` | **255** | **255**（零空洞） |
 *
 * 滚动 3 轮回顶后 `top` 精确恢复 255，B 每轮稳定 +14 补位，A 数量恒定不动。
 *
 * ## 与取流身份**完全独立**
 *
 * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
 *
 * 所以本功能的判据**只看独立开关 + 有没有凭据**，
 * **不看 `streamingIdentity`**，也不看 `proxyIdentity`。
 *
 * ## 三条已知限制（**不许当成已验证**）
 *
 * 1. **B 站曝光上报可能按 DOM 顺序** —— 隐藏后上报可能仍记在 A 批上。**未测。**
 * 2. **依赖 `.feed-card` 类名** —— B 站改版会失效（由 `evaluateHidePlan` 告警）。
 * 3. **匹配数异常时告警，不静默** —— 见 `evaluateHidePlan()`。
 */

/** 首屏 SSR 批的包裹元素类名（**只动它**） */
export const FEED_CARD_SELECTOR = '.feed-card';

/**
 * 顶部轮播容器 —— **绝对不能碰**。
 *
 * 实测：`recommended-swipe` 内部的卡**不带 `is-rcmd`**，
 * 首屏 13 张里前 2 个 `other` 就是它。藏掉它会让轮播消失。
 *
 * ⚠️ 更关键：**轮播内部也可能套 `.feed-card` 结构**，
 * 所以 `collectTargets()` 必须显式排除轮播内部。
 */
export const SWIPE_SELECTOR = '.recommended-swipe';

/**
 * 隐藏样式。
 *
 * ## 为什么用 `display: none` 而不是 `visibility: hidden` / `height: 0`
 *
 * 实测三种方式都能让 B 上移，但：
 * - `visibility: hidden` → 元素仍占位，**B 不会上移**（实测 `visible: 33 → 33` 不变）
 * - `height: 0` → 需要额外处理 margin/padding，容易留下空隙
 * - **`display: none`** → 直接移出布局流，B 自然上移，**实测 `top` 回到 255、零空洞**
 */
export const HIDE_CSS = `${FEED_CARD_SELECTOR} { display: none !important; }`;

/** 注入的 `<style>` 元素 id（固定 id 保证幂等） */
export const HIDE_STYLE_ID = 'pluma-feed-hide';

/** 隐藏判据的输入 —— 只有两个字段，与取流身份无关 */
export interface FeedHideInput {
  /** 独立开关：首页推荐流是否使用扩展账号 */
  feedAccountEnabled: boolean;
  /** vault 里有没有凭据（`proxy/status.hasCredential`） */
  hasCredential: boolean;
}

/**
 * 判断是否该隐藏。
 *
 * ## 判据：**独立开关开 + 有凭据**
 *
 * | 开关 | `hasCredential` | 隐藏吗 | 为什么 |
 * | --- | --- | --- | --- |
 * | `false` | 任意 | ❌ | 用户没开这个功能 |
 * | `true` | **`false`** | ❌ | **没有凭据 → rcmd 批也是页面账号的** → 藏了 A 会看到空白 |
 * | `true` | `true` | ✅ | rcmd 批确实是扩展账号的 |
 *
 * ⚠️ **与 `streamingIdentity` 无关**（用户原话：两个功能独立）。
 * 即使取流身份是「浏览器账号」，只要推荐流开关开着 + 有凭据，
 * 推荐流仍应换成扩展账号的。
 */
export function shouldHideFeedCards(input: FeedHideInput): boolean {
  return input.feedAccountEnabled && input.hasCredential;
}

/** 一次隐藏评估的结果 —— **失败要可观测，不能静默** */
export interface HidePlan {
  /** 该不该加样式 */
  apply: boolean;
  /** 匹配到的 `.feed-card` 数量（已排除轮播，0 = 页面还没渲染好 / 选择器失效） */
  matched: number;
  /** 是否需要告警 */
  warn: boolean;
  /** 告警时给开发者看的一句话 */
  warnReason: string | null;
}

/**
 * 评估一次"要不要隐藏、藏得对不对"。
 *
 * **抽成纯函数**是为了能用单测钉住"失败可观测" —— 写在 DOM 操作里只能靠肉眼看。
 *
 * @param input         开关 + 凭据
 * @param matchedCount  页面上匹配到的 `.feed-card` 数量（已排除轮播）
 * @param expectedCount 预期数量（实测首屏 SSR 批固定 10 张）
 */
export function evaluateHidePlan(
  input: { feedAccountEnabled: boolean; hasCredential: boolean },
  matchedCount: number,
  expectedCount = 10,
): HidePlan {
  const apply = shouldHideFeedCards(input);

  if (!apply) {
    // 不该隐藏时不告警：匹配 0 张是完全正常的
    return { apply: false, matched: matchedCount, warn: false, warnReason: null };
  }

  // 该藏却没匹配到 → 选择器可能失效（B 站改版）
  if (matchedCount === 0) {
    return {
      apply: true,
      matched: 0,
      warn: true,
      warnReason: `开关已打开，但 ${FEED_CARD_SELECTOR} 匹配到 0 个 —— 选择器可能已失效（B 站改版？）`,
    };
  }

  /**
   * 数量明显多于预期 → 结构可能已变。
   * 用 `expectedCount * 2` 作阈值：允许 B 站小幅调整批大小（8/12），
   * 但**多到一倍以上**说明 `.feed-card` 的含义变了。
   */
  if (matchedCount > expectedCount * 2) {
    return {
      apply: true,
      matched: matchedCount,
      warn: true,
      warnReason: `匹配到 ${String(matchedCount)} 个 ${FEED_CARD_SELECTOR}（预期约 ${String(expectedCount)} 个）—— 结构可能已变`,
    };
  }

  return { apply: true, matched: matchedCount, warn: false, warnReason: null };
}

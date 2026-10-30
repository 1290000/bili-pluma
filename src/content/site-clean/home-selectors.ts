/**
 * 首页净化的**分类清单与判据** —— 单一真相源。
 *
 * ## 清单从哪来（必须有来源，2026-10-31 教训）
 *
 * 首轮 M4 用了上游 Bilibili-Evolved `clear-home` 的 **37 个分类名**，
 * 但那是从源码抄来的，**在当前 B站 首页没有实测依据**。
 * 独立验证者指出：那份清单里混着"广告"这种非分类项，
 * 且在真实页面上只有 9 项出现 —— **"37 个里有 4 个有落点"这句话的分母本身就是假的**。
 *
 * 现在的清单来源是**实测**：
 *   - 滚动 80 步（文档高度 3,670px → 98,832px）、收集 448 张 `.floor-single-card`
 *   - 两个独立 session 各得一遍，结果一致
 *   - 证据：`.tmp/verifier/out-sweep-report.json`、`out-floor-cards.json`
 *
 * **加分类的前提是实测该分类真实存在**，不要凭上游或猜测往这里加。
 *
 * ## 为什么分类名而不是 DOM id
 *
 * B站 的 `.floor-single-card` 本身不带分类标识，唯一可靠判据是它内部
 * `.badge` 的**文本**（如「番剧」「国创」）。所以判据是文本匹配。
 */

/** 实测存在的首页分类（2026-10-31，两个 session 一致） */
export const OBSERVED_CATEGORIES = [
  '直播',
  '番剧',
  '国创',
  '综艺',
  '课堂',
  '电影',
  '电视剧',
  '纪录片',
  '漫画',
] as const;

export type ObservedCategory = (typeof OBSERVED_CATEGORIES)[number];

/** 判断一个 badge 文本是不是我们认识的分类 */
export function isObservedCategory(text: string | null | undefined): text is ObservedCategory {
  if (!text) return false;
  return (OBSERVED_CATEGORIES as readonly string[]).includes(text);
}

/**
 * 首页推荐流容器 —— MutationObserver 的落点。
 *
 * ⚠️ 这是**实测的当前结构**。B站 改版后它会失效，
 * 届时 `installCleanObserver` 会打警告（不许静默）。
 */
export const FEED_CONTAINER_SELECTOR =
  'main > .feed2 > .recommended-container_floor-aside > .container';

/** 专题推荐位卡片 —— 分类判据作用的元素 */
export const FLOOR_CARD_SELECTOR = '.floor-single-card';

/** 顶部大图推荐位 —— 单独的"可隐藏"项 */
export const SWIPE_SELECTOR = '.recommended-swipe';

/** JS 写入的分类标记属性，CSS 用它来命中 */
export const CATEGORY_MARK_ATTR = 'data-pluma-cat';

/** 样式节点 id */
export const HOME_CLEAN_STYLE_ID = 'pluma-home-clean';

/**
 * 删除广告 —— 编排层（第 2/3 层的接线）。
 *
 * ## 分工
 *
 * | 层 | 文件 | 职责 |
 * | --- | --- | --- |
 * | 1+4 | `ads-css.ts` | 选择器 + 布局补偿 |
 * | 2 | `clean-options.ts` | 选项表与默认值 |
 * | 3 | `body-classes.ts` | 选项 → body 类名 |
 * | — | **本文件** | 扫描命中元素、打标记、装配以上三层 |
 *
 * ## 为什么 JS 要打标记（而不是纯 CSS 就够）
 *
 * 上游的纯 CSS 做法有一个表达力缺口：**CSS 无法"撤销另一条 CSS"来恢复显示**。
 * 而我们要支持 `debug` 模式（把已隐藏的元素**恢复显示**并加红框），
 * 纯 CSS 做这件事依赖规则顺序，脆弱且难排查。
 *
 * 所以：**CSS 负责判据（`--pluma-ad-card`）与全部外观**，
 * **JS 只负责把命中元素打上 `data-pluma-ad="1"`**，再由 CSS 按 body 类名决定怎么显示。
 *
 * 好处：调试时在控制台 `$$('[data-pluma-ad]')` 立刻能看到命中了哪些元素。
 */

import { AD_CLEAN_CSS, AD_MARK_ATTR } from './ads-css';
import { prescreenSelector } from './ad-selectors';
import { applyBodyClasses, BODY_CLASS } from './body-classes';
import type { CleanOptions } from './clean-options';

const STYLE_ID = 'pluma-ad-clean';

/**
 * 预筛选择器 —— **由判据数据生成，不手写**。
 *
 * 见 `markAdElements()` 的注释：手写第二份清单是本轮反复出错的原因。
 */
const PRESCREEN = prescreenSelector();

/** 插一次样式；已存在则跳过（幂等） */
export function ensureAdStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = AD_CLEAN_CSS;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

/**
 * 扫描并给命中元素打标记。
 *
 * ## 判据来源：CSS 设的 `--pluma-ad-card` 变量
 *
 * 元素命中任一条判据规则就会带上这个自定义属性。JS 用 `getComputedStyle` 读它。
 *
 * ## 预筛与 CSS 判据**构造上同源**（2026-10-31 第四次修正）
 *
 * 本轮在这个问题上栽了三次，全部是"两张表手工同步"导致的静默漏标：
 *
 * | 版本 | 做法 | 后果 |
 * | --- | --- | --- |
 * | v1 | JS 另写一张候选类名清单 | 漏了约 20 个选择器 → 那些广告永不隐藏、**不报错** |
 * | v2 | 改成全文档扫 | 正确但慢 |
 * | v3 | 预筛 + 正则从 CSS 源码抽类名校验 | 正则拆错 import/注释，**校验结论不可信** |
 * | **v4** | **预筛由 `prescreenSelector(ALL_AD_RULES)` 生成** | 构造保证不漂移 |
 *
 * 现在这里**没有任何手写选择器**，加判据只需改 `ad-selectors.ts`。
 *
 * @returns 本次发生变化的元素数（新增标记 + 撤销标记）
 */
export function markAdElements(doc: Document = document, win: Window = window): number {
  /**
   * 预筛：只看可能命中判据的元素。
   *
   * 由 `prescreenSelector()` 从判据数据生成，**不要在这里手写类名**。
   */
  const candidates = doc.querySelectorAll<HTMLElement>(`body ${PRESCREEN}`);

  /**
   * ## ⚠️ 标记必须能**撤销**（2026-10-31 verifier 实测抓出的真 bug）
   *
   * 首版是：
   *
   * ```ts
   * if (el.getAttribute(AD_MARK_ATTR) === '1') continue;  // 已有标记直接跳过
   * ```
   *
   * **只加不减**。后果：元素一旦被打过标记，之后即使开关让判据不再命中
   * （例如用户打开「保留活动横幅」，`.ad-report.ad-floor-exp` 不再匹配），
   * `data-pluma-ad="1"` 仍留在元素上 → 继续被 `body.pluma-clean-mode-hide`
   * 隐藏 → **用户必须刷新页面才恢复**。
   *
   * 这正是用户报的「视频页关掉活动横幅不生效」的真根因 ——
   * 我当时以为改 CSS 判据（`:not(.ad-floor-exp)`）就够了，
   * 但 verifier 实测该元素 `matches` 已返回 false，是**旧标记没撤销**。
   *
   * 现在两个方向都处理：
   *   - 命中 → 打标记
   *   - 不再命中 → **摘掉标记**
   */
  let changed = 0;
  for (const el of candidates) {
    const probe = win.getComputedStyle(el).getPropertyValue('--pluma-ad-card').trim();
    const shouldMark = probe === '1';
    const isMarked = el.getAttribute(AD_MARK_ATTR) === '1';

    if (shouldMark && !isMarked) {
      el.setAttribute(AD_MARK_ATTR, '1');
      changed += 1;
    } else if (!shouldMark && isMarked) {
      el.removeAttribute(AD_MARK_ATTR);
      changed += 1;
    }
  }
  return changed;
}

/**
 * 把选项应用到当前页面（body 类名 + 重新标记）。
 *
 * ## ⚠️ `document_start` 时 `document.body` 可能是 null
 *
 * 2026-10-31 实测踩到：入口是 `runAt: 'document_start'`，那时
 * `<body>` 往往**还没被解析出来**，`applyBodyClasses()` 拿到 `null` 直接返回 0，
 * 结果**一个 body 类名都没加上**，CSS 的 `body:not(.xxx)` 全部失配。
 *
 * 表现极具误导性：样式表注入了、元素也打了 `data-pluma-ad="1"`，
 * 但元素 `display` 仍是 `block` —— 看起来像"选择器写错了"，
 * 实际是 body 类名根本没生效。
 *
 * 所以这里用 `applyWhenBodyReady()`：body 就绪后立即补应用一次。
 *
 * @returns 是否**立即**应用成功（false 表示 body 未就绪，已排入等待队列）
 */
export function applyAdClean(options: CleanOptions, doc: Document = document): boolean {
  ensureAdStyle(doc);
  markAdElements(doc, doc.defaultView ?? window);

  if (doc.body) {
    applyBodyClasses(options, doc.body);
    return true;
  }

  // body 未就绪：等它出现（一次性）
  const obs = new MutationObserver(() => {
    if (!doc.body) return;
    obs.disconnect();
    applyBodyClasses(options, doc.body);
    // body 出现后元素才可能齐全，补扫一次
    markAdElements(doc, doc.defaultView ?? window);
  });
  const root = doc.documentElement;
  if (root) obs.observe(root, { childList: true, subtree: true });
  return false;
}

/**
 * 安装动态监听 —— 推荐流是无限滚动的，广告卡片会持续插入。
 *
 * ⚠️ 容器可能还没渲染（`document_start` 时必然没有），所以两段式：
 * 先尝试直接挂到已知容器，无论成功与否都再挂一个 body 级兜底。
 *
 * @param onGiveUp 15 秒仍找不到任何已知容器时回调（ADR 0031：失效不许静默）
 */
export function installAdObserver(
  getOptions: () => CleanOptions,
  doc: Document = document,
  onGiveUp?: () => void,
): { stop: () => void } {
  const win = doc.defaultView ?? window;

  /** 只在需要时重扫，避免每次 DOM 变动都全量跑 */
  let pending = false;
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (getOptions().adDebug) return; // 调试态不需要标记变化
      markAdElements(doc, win);
    });
  };

  // 首页推荐流容器 / 视频页右栏，两处都可能承载广告
  const CONTAINERS = [
    'main > .feed2 > .recommended-container_floor-aside > .container',
    '#reco_list',
    '.video-page-container',
    '.right-container',
  ];

  const observers: MutationObserver[] = [];

  const attachTo = (root: Element): void => {
    const ob = new MutationObserver(schedule);
    ob.observe(root, { childList: true, subtree: true });
    observers.push(ob);
  };

  let attached = 0;
  for (const sel of CONTAINERS) {
    const el = doc.querySelector(sel);
    if (el) {
      attachTo(el);
      attached += 1;
    }
  }

  // 无论如何都挂一个 body 级兜底（容器尚未渲染的情况）
  const body = doc.body ?? doc.documentElement;
  if (body) attachTo(body);

  // 初扫
  markAdElements(doc, win);

  /**
   * 超时兜底：body 级 observer 已能覆盖慢加载，
   * 这里只在**一个已知容器都没找到**时告警（说明页面结构可能变了）。
   */
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (attached === 0) {
    timer = setTimeout(() => {
      const still = CONTAINERS.some((s) => doc.querySelector(s));
      if (!still) onGiveUp?.();
    }, 15000);
  }

  return {
    stop: () => {
      for (const ob of observers) ob.disconnect();
      if (timer) clearTimeout(timer);
    },
  };
}

/** 供调试：当前命中数 */
export function countMarkedAds(doc: Document = document): number {
  return doc.querySelectorAll(`[${AD_MARK_ATTR}="1"]`).length;
}

export { BODY_CLASS };

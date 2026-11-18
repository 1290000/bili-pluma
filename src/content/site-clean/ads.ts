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

import { AD_CLEAN_CSS, AD_DEAD_ATTR, AD_MARK_ATTR } from './ads-css';
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
 * ## 为什么不再接 `getOptions` 参数（2026-10-31）
 *
 * 它原来只被一处用到：`if (getOptions().adDebug) return;` —— 而那一行是**错误的**
 * （见 `schedule()` 里的长注释：调试模式恰恰最需要标记）。
 * 删掉那行后参数就没人用了，留着只会误导后来人以为"重扫还要看选项"。
 *
 * @param onGiveUp 15 秒仍找不到任何已知容器时回调（ADR 0031：失效不许静默）
 */
export function installAdObserver(
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
      /**
       * ## ⚠️ 这里**绝不能**因为 `adDebug` 而跳过（2026-10-31 verifier 抓出的严重 bug）
       *
       * 曾有一行：
       *
       * ```ts
       * if (getOptions().adDebug) return; // "调试态不需要标记变化"
       * ```
       *
       * **完全错了。** 调试模式的整个用途是"把命中的元素用红框标出来"，
       * 而红框的选择器就是 `body.mode-debug [data-pluma-ad="1"]` ——
       * **没有标记就没有红框**。
       *
       * 更糟的是：`applyAdClean()` 的首扫发生在 `document_start`，
       * 那时广告元素还没渲染，标记数为 0；
       * 之后每次 DOM 变化的重扫都被这行跳过 → **标记永远是 0**。
       *
       * 后果：用户一开调试模式，**广告清理和调试模式同时失效** ——
       * 表现为"开了删除广告但广告还在"（用户报的正是这个）。
       *
       * 性能考虑若确实需要，只能跳过**撤销分支**，不能跳过整个函数。
       */
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
   *
   * ## 2026-11-19：回调之外**再落一个 DOM 标记**
   *
   * `onGiveUp` 的调用方（`content-home.content.ts`）只 `console.warn` ——
   * 用户永远看不到。ADR 0031 :185 把「选择器失效是静默的」列为本条最需要
   * 警惕的失败模式，所以这里额外在 `document.documentElement` 上写
   * `data-pluma-ad-dead="1"`，让诊断页（另一个 bundle）读得到。
   *
   * 写在 `documentElement` 而不是 `body`：`document_start` 时 body 可能还不存在，
   * 而这个标记要落在一个**此刻一定存在**的节点上。
   *
   * ⚠️ 只写不清：15 秒的判据一旦成立就是既成事实（那段时间确实没有容器）。
   * 后续容器出现时页面已经能正常工作，而"曾经 15 秒没有容器"仍是真事实 ——
   * 清掉它等于抹掉一次真实的观测。诊断页文案说的是"页面结构与预期不符"，
   * 不是"现在坏了"，所以不会误导。
   */
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (attached === 0) {
    timer = setTimeout(() => {
      const still = CONTAINERS.some((s) => doc.querySelector(s));
      if (!still) {
        try {
          doc.documentElement.setAttribute(AD_DEAD_ATTR, '1');
        } catch {
          // 极端情况下（文档已卸载）写不进去，绝不能因此中断回调
        }
        onGiveUp?.();
      }
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

/**
 * 广告清理的**自检结论**（ADR 0031 要求的「失效可见化」，2026-11-19 落地）。
 *
 * ## 为什么需要它
 *
 * ADR 0031 :163-164 把「诊断页显示匹配状态」列为**必需项**，理由是
 * 「B 站改版会让选择器失效，而我们没有任何远程手段修复它，用户必须等下一个版本」；
 * :185 又点名了失败形态：「选择器失效是静默的：命中 0 不报错」。
 *
 * 现状曾经是：命中 0 与「这一页本来就没广告」在界面上**完全一样**，
 * `installAdObserver()` 的 `onGiveUp` 只 `console.warn` 一句（用户看不见）。
 *
 * ## 两种 0 必须分开
 *
 * | 观测 | 含义 | 结论 |
 * | --- | --- | --- |
 * | 预筛命中 0 | 页面上连一个**候选元素**都没有 ⇒ 33 个选择器集体失效 | `dead` |
 * | 预筛 > 0、标记 0 | 候选在，但判据（CSS 变量）一个都没命中 | `suspect` |
 * | 标记 > 0 | 正常 | `working` |
 *
 * 判据为什么用**预筛**而不是"标记数 > 0"：`prescreenSelector()` 由 36 条判据
 * 规则**生成**（33 个选择器，覆盖 `.feed-card` / `.ad-report` / `.gg-pic` 这类
 * B 站到处都有的类名），不是手抄清单。它命中 0 是相当强的信号 —— 那意味着整页
 * 没有任何一处结构长得像广告位，而真实页面上这类容器成片出现。
 *
 * ⚠️ `suspect` 只能叫"判据没命中"，**不许**说成"功能失效"：候选在而判据不命中
 * 完全可能是"这些候选本来就不是广告"（预筛宽于判据，这是设计）。所以文案要
 * 说清观测到的事实，不下失效结论。
 *
 * ## 判据的边界（说清才不会误用）
 *
 * 这是**当前 DOM 的快照**，不回答"历史上有没有生效过"。`adEnabled` 关着时
 * 元素不会被标记，此时 `marked: 0` 不代表失效 —— 调用方必须自己判开关，
 * 所以本函数**不产出** any 结论文案，只产观测值。
 *
 * @param doc 目标文档
 * @returns 预筛命中数、实际标记数、容器超时信号、以及由它们推出的粗结论
 */
export function inspectAdClean(doc: Document = document): {
  candidates: number;
  marked: number;
  /** `installAdObserver()` 报过"15 秒内一个已知容器都没出现"（跨 bundle 的 DOM 标记） */
  containerMissing: boolean;
  verdict: 'working' | 'suspect' | 'dead';
} {
  const candidates = doc.querySelectorAll(`body ${PRESCREEN}`).length;
  const marked = countMarkedAds(doc);
  /**
   * 独立于命中数的第二个信号（2026-11-19）：由 `content-home` 那个 bundle 在
   * 15 秒超时时写下的标记。它回答的是**时间维度**的问题 ——
   * "容器有没有在合理时间内出现"，而命中数回答的是"此刻页面上有没有"。
   *
   * 两者都要：命中数 0 可能是这页没广告；但容器 15 秒都没出现，就不是"没广告"
   * 能解释的了，那指向页面结构变了。
   */
  const containerMissing = doc.documentElement.getAttribute(AD_DEAD_ATTR) === '1';

  if (marked > 0) return { candidates, marked, containerMissing, verdict: 'working' };
  if (candidates > 0) return { candidates, marked, containerMissing, verdict: 'suspect' };
  return { candidates, marked, containerMissing, verdict: 'dead' };
}

export { BODY_CLASS };

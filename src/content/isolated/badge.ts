/**
 * 页内角标 —— 原生 DOM + Shadow DOM，**不用 Preact**。
 *
 * ## 为什么不用框架
 *
 * 角标只有二十来行 DOM。上框架的收益为零，代价是多一个渲染器和 B站页面
 * 抢同一个 DOM 的可能性。规范（docs/02-ui-spec.md §5）明确要求：
 * 播放器右下角一个 12px 半透明小标记，**不改变原有布局**。
 *
 * ## 为什么必须 Shadow DOM
 *
 * B站的全局样式很激进（`*` 选择器、`!important`、`body` 规则）。
 * 不做隔离的话：我们的样式会漏到页面上，页面的样式也会把角标冲烂。
 *
 * `mode: 'closed'` 是刻意的——页面脚本拿不到 `host.shadowRoot`，
 * 无法篡改我们的角标。代价是我们自己也要持有引用（见 `shadowRef`）。
 *
 * ## CSS 变量不穿透 shadow 边界
 *
 * `tokens.css` 必须**把文本塞进 shadow root 的 `<style>`**，不能靠外部链接。
 * 这也是为什么 `tokens.css` 的根选择器写的是 `:host, :root` 两个。
 */

import { buildBadge, type BadgeContent, type BadgeInput } from './badge-content';

/** 角标宿主元素的 id，用于幂等注入与查找 */
const HOST_ID = 'pluma-badge-host';
/**
 * 把当前内容画进 DOM。
 *
 * ## 为什么放在模块级
 *
 * 事件监听器只绑定一次，若 `paint` 是 `renderBadge` 内的闭包，
 * 它捕获的 `content` 会永远停在第一次渲染时的值 —— 用户点开详情
 * 看到的就是"已接管 / 等待加载"这种开场快照。
 *
 * 放在模块级 + 读 `currentContent`，每次点击都拿最新数据。
 *
 * 用 `textContent` 而不是 `innerHTML`，杜绝注入面。
 */
function paintBadgeDom(rootEl: HTMLElement): void {
  // 内容还没准备好就什么都不画，避免读到 null
  if (!currentContent) return;

  const content = currentContent;

  rootEl.textContent = '';
  rootEl.classList.toggle('expanded', expanded);

  const dot = document.createElement('span');
  dot.className = 'dot';
  rootEl.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = content.label;
  rootEl.appendChild(label);

  for (const chip of content.chips) {
    const chipEl = document.createElement('span');
    chipEl.className = 'chip';
    chipEl.textContent = chip;
    rootEl.appendChild(chipEl);
  }

  if (expanded) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = content.detail;
    rootEl.appendChild(detail);
  }
}

/**
 * 当前要显示的内容。
 *
 * ## 为什么必须是模块级状态
 *
 * 踩过的严重 bug：点是角标后，详情里总是显示「已接管 / 等待播放器加载」，
 * 而视频其实早就在播了。
 *
 * 原因：事件监听器**只在第一次创建 host 时绑定一次**，
 * 里面调用的 `paint()` 是那次 `renderBadge` 调用产生的闭包，
 * 捕获的是**当时的 `content`**。之后每次 `renderBadge` 都换了新内容，
 * 但点击时执行的还是最早的闭包 → 画出来的永远是页面刚打开时的快照。
 *
 * 修法：`content` 提到模块级，`paint()` 每次读最新值。
 * 这样闭包引用的是变量本身，不是某一时刻的值。
 */
let currentContent: BadgeContent | null = null;

/** 我们自己持有的 shadow 引用（closed 模式下外部拿不到） */
let shadowRef: ShadowRoot | null = null;

/** 是否展开详情（hover / 点击） */
let expanded = false;

/**
 * ## Hi-Res 徽章为什么**不做迟滞**
 *
 * 这里曾经有一段 `stabilize()` 迟滞：同一个值连续出现 2 次才翻转。
 * 现在**整段删掉**了，理由有两条，缺一不可。
 *
 * ### 一、数据源已经是稳定判据，不需要界面层再兜底
 *
 * 迟滞原本是给主世界那个**坏判据**擦屁股的：
 * 旧实现用「3 秒内有没有写入」推断哪条音轨在播，
 * 而缓冲填满后停止写入是**正常状态**（实测停顿 4 秒、9 秒），
 * 于是 `audioFamily` 在 `FLAC` 和 `unknown` 之间反复横跳。
 *
 * 现在主世界改成按 **SourceBuffer 创建顺序**判断（`pickActive`）：
 * 编码在创建时就固定，与「多久没写入」无关，输出不再抖动。
 * 在稳定的数据源上再加一层迟滞，只是让 UI 比事实更慢。
 *
 * ### 二、上报是**事件驱动**的，按次数计数的迟滞会变成按秒计数
 *
 * 主世界只在 **6s / 15s / 30s 和分辨率变化**时上报（见 `reportHdrAfter`）。
 * 所以「连续 2 次确认」不是「连续两次刷新」，而是：
 *
 *   - 第 6 秒收到 FLAC → streak = 1，不亮
 *   - 第 15 秒收到 FLAC → streak = 2，才亮
 *
 * **用户要等 9 秒才看到 Hi-Res**。而 30 秒后没有定时上报，
 * 中途一旦丢一次，就得等下一次切画质才可能恢复——
 * 正好复现用户报的「直接不再出现」。
 *
 * ### 结论
 *
 * 该修的地方是**判据**，不是阈值。数据层改对之后，
 * 徽章直接跟随数据即可：有 FLAC 就显示，没有就不显示。
 */

/**
 * 上一次成功观测到的播放高度。
 *
 * ## 为什么要记
 *
 * 切画质 / 切换分辨率时 `<video>.videoHeight` 会**短暂变成 0**。
 * 如果这次读到 0 就把角标重置成「已接管」，用户会看到角标"闪一下变空"，
 * 过几秒才恢复——这是用户实际报过的 bug。
 *
 * 所以宁可显示"上次的值"，也不要闪回空状态。
 * 只有当**从未**拿到过高度（0）时才说「已接管」。
 */
let lastPaintedHeight = 0;

/**
 * 把缓存同步到 `sessionStorage`，跨 content script 重载存活。
 *
 * ## 为什么必须持久化
 *
 * 踩了**三轮**才找到的根因：
 *
 * B站是 SPA，切 P / 点推荐视频时**不整页刷新**，但评论区、播放器、路由会重建，
 * 主世界的 content script 在某些情况下会**重新执行**。
 * 一旦重载，模块级变量 `lastPaintedHeight` 和 `hasEverActivated` 全部归零。
 *
 * 而重载瞬间 `hdr` 消息可能先于 `video.metadata` 到达（`h` 还是 0），
 * 于是 `playingHeight=0 && lastPaintedHeight=0` → **闪回「已接管」**。
 *
 * 用户看到的"角标在已接管和正常画质之间乱跳"，就是在每次 SPA 导航时发生的。
 *
 * 用 sessionStorage（随标签页生命周期，不跨标签页）保存高度与接管标记，
 * 重载后立刻恢复，不再闪。
 */
const SS_KEY = 'pluma.badge.height';

function loadCachedHeight(): number {
  try {
    const v = Number(sessionStorage.getItem(SS_KEY) ?? '0');
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function saveCachedHeight(h: number): void {
  try {
    sessionStorage.setItem(SS_KEY, String(h));
  } catch {
    // sessionStorage 不可用（极少数沙箱场景）时静默降级，不影响功能
  }
}

// 模块加载时立刻恢复上次的高度
lastPaintedHeight = loadCachedHeight();

/**
 * 注入或更新角标。
 *
 * 幂等：重复调用只更新内容，不会插入第二个角标。
 * content script 在 `document_start` 和 `DOMContentLoaded` 都会调，
 * 不幂等就会出现两个角标叠在一起。
 *
 * @param tokensCss `tokens.css` 的原始文本。**必须传入**——
 *   shadow root 内部拿不到外部样式表，CSS 变量不会穿透。
 * @param input 当前观测到的真实状态
 */
export function renderBadge(tokensCss: string, input: BadgeInput): void {
  /**
   * 直接把观测值交给纯函数渲染，**不做迟滞**。
   *
   * 原因见文件上方「Hi-Res 徽章为什么不做迟滞」：
   * 抖动来自主世界那个坏判据，现在已在数据层修掉（按创建顺序选轨）。
   * 在这一层再压一遍，只会让徽章比事实更慢——而上报是事件驱动的，
   * 「连续 2 次」实际等于「等 9 秒」。
   */
  const content = buildBadge({
    ...input,
    lastKnownHeight: lastPaintedHeight,
  });

  // 只有读到有效高度时才更新缓存，读到 0 时保留上一次的值
  if (input.playingHeight > 0 && input.playingHeight !== lastPaintedHeight) {
    lastPaintedHeight = input.playingHeight;
    saveCachedHeight(lastPaintedHeight);
  }

  // 更新模块级内容：点击时 paintBadgeDom 读的就是这里的最新值
  currentContent = content;

  let host = document.getElementById(HOST_ID);

  // 不显示时移除已有角标（比如用户关掉了总开关）
  if (!content.visible) {
    host?.remove();
    shadowRef = null;
    return;
  }

  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    // 宿主本身不参与布局影响：fixed 定位，不占文档流
    host.style.cssText =
      'position:fixed;right:16px;bottom:96px;z-index:2147483000;pointer-events:auto;';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'closed' });
    shadowRef = shadow;

    // ⚠️ tokens 必须在最前面：后面的角标样式依赖它定义的变量
    const tokenStyle = document.createElement('style');
    tokenStyle.textContent = tokensCss;
    shadow.appendChild(tokenStyle);

    const badgeStyle = document.createElement('style');
    badgeStyle.textContent = BADGE_CSS;
    shadow.appendChild(badgeStyle);

    const root = document.createElement('div');
    root.className = 'badge';
    shadow.appendChild(root);

    /**
     * 事件只绑定一次，所以这里**不能**捕获任何一次性的局部变量。
     * 读模块级的 `currentContent` 和实时的 DOM 引用。
     */
    const el = root;
    el.addEventListener('click', (ev) => {
      // 阻止冒泡：否则点击会穿透到 B站页面，触发播放器自己的点击处理
      ev.stopPropagation();
      expanded = !expanded;
      paintBadgeDom(el);
    });
    el.addEventListener('mouseleave', () => {
      expanded = false;
      paintBadgeDom(el);
    });
  }

  if (!shadowRef) return;

  const rootEl = shadowRef.querySelector<HTMLElement>('.badge');
  if (!rootEl) return;

  // 每次 renderBadge 都重绘：内容已更新到 currentContent
  paintBadgeDom(rootEl);
}

/** 移除角标（离开视频页 / 用户关闭时） */
export function removeBadge(): void {
  document.getElementById(HOST_ID)?.remove();
  shadowRef = null;
  expanded = false;
  /**
   * ⚠️ 这里**不清 `lastPaintedHeight`**。
   *
   * 踩过的 bug：`page/activate` 在 SPA 路由变化（切 P、点推荐视频）时会重复触发，
   * 任何一次都走 `removeBadge()`。如果这里把缓存归零，下一次绘制时高度恰好是 0，
   * 角标就闪回「已接管」——用户看到的是"角标在乱跳"。
   *
   * 缓存只在**真正离开视频页**（路由变成非视频页）时清，
   * 由 `content.ts` 显式调用 `resetBadgeCache()`。
   */
}

/**
 * 彻底重置角标缓存。
 *
 * 只在**确认离开视频页**时调用（比如路由从 `/video/` 变成首页）。
 * 日常的"暂时不显示"不要调 —— 那会让角标闪回「已接管」。
 */
export function resetBadgeCache(): void {
  lastPaintedHeight = 0;
  expanded = false;
  currentContent = null;
  try {
    sessionStorage.removeItem(SS_KEY);
  } catch {
    // ignore
  }
}

/**
 * 角标样式。
 *
 * 全部用 `tokens.css` 的变量——**不许硬编码颜色**。
 * 字号固定 12px（规范要求），不用 `--pluma-font-caption` 是因为
 * 角标需要比 popup 的辅助文字稍微大一点点才看得清，但不能再大，
 * 大了就开始碍事。
 */
const BADGE_CSS = `
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pluma-surface) 82%, transparent);
  border: 0.5px solid var(--pluma-border);
  color: var(--pluma-text);
  font-family: var(--pluma-font-sans);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  user-select: none;
  backdrop-filter: blur(6px);
  transition: background-color 0.15s;
}

.badge:hover {
  background: color-mix(in srgb, var(--pluma-surface) 95%, transparent);
}

.badge.expanded {
  border-radius: var(--pluma-radius-control, 8px);
  flex-wrap: wrap;
  max-width: 260px;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pluma-accent);
  flex: 0 0 auto;
}

.label {
  font-weight: 500;
  white-space: nowrap;
}

.chip {
  color: var(--pluma-accent);
  white-space: nowrap;
}

.detail {
  flex-basis: 100%;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 0.5px solid var(--pluma-border);
  color: var(--pluma-text-muted);
  font-size: 11px;
  line-height: 1.4;
  white-space: normal;
}
`;

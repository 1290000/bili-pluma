/**
 * 面板的三个 Tab 视图 —— **纯 DOM 构建函数**，每个接收模型、返回一个元素。
 *
 * ## 职责边界
 *
 * 这里只负责"把模型画成 DOM"与"把用户操作回调出去"，**不取数、不写存储**。
 * 取数在 `panel-data.ts`，写存储与主动应用在 `panel.ts`（编排层）。
 *
 * 这样每个 Tab 都能在 jsdom 里单独测：喂一个模型，断言画出来的文本与控件状态。
 *
 * ## 不许谎报（`02-ui-spec.md` §3 / §5）
 *
 * - 非播放页**不渲染**任何画质卡，也不补一句"当前页不是播放页"——
 *   用户已经知道自己在哪个页面。
 * - 拿不到数据时显示「未知」，**不落回某个看起来正常的默认值**。
 */

import type { CleanOptionKey, CleanPreferences } from '@/src/content/site-clean/clean-options';
import { CLEAN_OPTION_META } from '@/src/content/site-clean/clean-options';
import { OBSERVED_CATEGORIES } from '@/src/content/site-clean/home-selectors';
import { describeAdDebugCaveat, type AccountView, type QualityView } from './panel-data';
import { el, pill, switchRow } from './dom';
import { describeExpiry, describeHealth } from '@core/ui/popup-state';
import { describeStreamingIdentity } from '@core/ui/streaming-pill';
import { isStreamingReady, type StreamingIdentity } from '@shared/constants/streaming-identity';
import type { UpdateStatusView } from '@shared/types/update';
import { CONTRIBUTORS } from '@/src/generated/contributors';
import { primaryPlaceholder } from '@shared/utils/primary-card';

/** 会员类型短标签 */
const VIP_TAG: Record<'none' | 'monthly' | 'annual', string> = {
  none: '非会员',
  monthly: '大会员',
  annual: '年度大会员',
};

// ─────────────────────────── 画质 Tab ───────────────────────────

/**
 * 画质 Tab：状态胶囊 + 解锁画质卡 + 总开关。
 *
 * ## 结构（自上而下）
 *
 * ```text
 * [已接管]                          ← 胶囊
 * ┌─────────────────────────────┐
 * │ 已解锁        主账号仅可用 1080P │  ← 解锁卡（非播放页/开关关着时不渲染）
 * │ [4K] [60fps] [Hi-Res]        │
 * └─────────────────────────────┘
 * 自动接管取流              [开关]
 * ```
 */
export function qualityTab(
  q: QualityView,
  actions: {
    toggleProxy: (next: boolean) => void;
    /**
     * ── 总开关能不能点（2026-11-12，task-10）──
     *
     * ## 用户裁决（原话）
     *
     * > 「可以保留这个开关原本的状态，但是因为退出了扩展账号所以这个开关
     * > 即便是开着也是没有用了，所以整个开关应变为灰色不可点击」
     *
     * 即：**开关值照旧保留**（不许为了"看起来一致"去改 `ENABLED_KEY`），
     * 但**没有可用账号时它必须灰掉**，因为开着也没用。
     *
     * ## ⚠️ 判据**不许在本函数里写**
     *
     * 三种情况必须区分，而只有一处实现（`streaming-identity.ts`）：
     *
     * | 取流身份 | 有凭据 | 能用吗 | 开关 |
     * | --- | --- | --- | --- |
     * | `page` | 无 | **能**（本就不需要扩展参与） | **可点** |
     * | `extension` | 有 | 能 | 可点 |
     * | `extension` | 无 | 不能（真的没配） | **灰** |
     *
     * ⚠️ **`page` 身份下 `hasCredential` 恒为 `false`** —— 只看 `hasCredential`
     * 会把一个**完全可用**的配置误禁（这正是 `isStreamingReady()` 被抽出来的原因）。
     *
     * 所以本函数只接收**算好的结论**（`proxyUsable`）与**算好的原因**，
     * 判据在 `panel.ts` 里走 `isStreamingReady()`。
     */
    proxyUsable: boolean;
    /**
     * 开关灰掉时要给用户看的那句话。`null` = 不需要解释（可点）。
     *
     * ⚠️ **必须给文字**（不许只灰不说）：handoff §2.3 记过"开关永久禁用
     * 且不说明原因"这一类，用户会以为控件坏了。
     */
    proxyDisabledReason: string | null;
  },
): HTMLElement {
  const box = el('div', 'tab-pane');

  const head = el('div', 'pane-head');
  head.appendChild(pill(q.pill, q.tone));
  box.appendChild(head);

  if (q.line) box.appendChild(el('p', 'pane-line', q.line));

  /**
   * 解锁卡。`null` 时**整块不渲染** —— 包括"等待取流"这类占位也不行：
   * 非播放页根本没有取流这回事，摆一张卡等于让用户等一个不会来的东西。
   */
  if (q.unlock) {
    const card = el('div', 'unlock-card');

    const row = el('div', 'unlock-head');
    row.appendChild(
      el('span', `unlock-title ${q.unlock.improved ? 'good' : 'muted'}`, q.unlock.title),
    );
    row.appendChild(el('span', 'unlock-anchor', q.unlock.anchor));
    card.appendChild(row);

    if (q.unlock.badges.length > 0) {
      const badges = el('div', 'badges');
      for (const b of q.unlock.badges) badges.appendChild(el('span', 'badge-chip', b));
      card.appendChild(badges);
    }

    box.appendChild(card);
  }

  /**
   * 总开关。
   *
   * ⚠️ `proxyEnabled === null`（读不到 `proxy/status`）时**禁用**，而不是画成"关"。
   * 把"未知"画成"关"，用户会以为功能自己关掉了 —— 与角标开关同一个纪律。
   *
   * ## 两种"禁用"要分开（2026-11-12，task-10）
   *
   * | 情况 | 禁用？ | 解释 |
   * | --- | --- | --- |
   * | 状态读不到（`proxyEnabled === null`） | ✅ | 「状态读取失败，暂时无法切换」 |
   * | **没有可用账号**（`!proxyUsable`） | ✅ | 由 `proxyDisabledReason` 给（task-10） |
   *
   * 两者可以同时成立（读不到状态 + 没账号），那时优先说"读不到状态"——
   * 那是更基础的问题，说"先去扫码"会让用户白折腾一次。
   */
  const proxyDisabled = q.proxyEnabled === null || !actions.proxyUsable;
  box.appendChild(
    switchRow({
      label: '自动接管取流',
      hint: '只替换取流接口的身份，收藏 / 点赞 / 历史不受影响',
      /**
       * ⚠️ 灰掉时**仍然渲染开关本身**（不是不渲染）。
       *
       * handoff §2.3 第 9 条：控件消失是隐形 bug —— 用户看不见就以为功能没做。
       * `checked` 照旧反映用户设的值（task-10 的要求：**保留原本的状态**）。
       */
      checked: q.proxyEnabled === true,
      disabled: proxyDisabled,
      onToggle: actions.toggleProxy,
    }),
  );

  if (q.proxyEnabled === null) {
    box.appendChild(el('p', 'pane-note', '状态读取失败，暂时无法切换'));
  } else if (!actions.proxyUsable && actions.proxyDisabledReason) {
    /**
     * 没有可用账号 → 说清原因（**不许只灰不说**）。
     *
     * 文案由 `panel.ts` 给，与「账号」Tab 的引导语同一套说法（"扫码登录取流账号"），
     * 不制造第二套术语。
     */
    box.appendChild(el('p', 'pane-note', actions.proxyDisabledReason));
  }

  return box;
}

// ─────────────────────────── 净化 Tab ───────────────────────────

/**
 * 净化 Tab：四个布尔开关 + 二级浮层入口。
 *
 * ## 四个开关的来源
 *
 * `CLEAN_OPTION_META` 是**唯一真相源**（`clean-options.ts`），文案不在 UI 里另写一份。
 * 顺序也用它的顺序 —— 设置页与面板必须一致，否则用户换个地方看就找不到同一项。
 *
 * ## 二级浮层入口
 *
 * 「首页净化 ▸」不是开关，是**进入二级页的入口**：9 个分类 + 隐藏顶部大图
 * 放在那里。不进二级的话，面板里要平铺 9 个分类开关，把三个 Tab 挤成一坨。
 *
 * @param openSub 点击"首页净化 ▸"时调用（由编排层压栈）
 */
/**
 * 一级「净化」Tab **只放广告相关的三项**。
 *
 * ## 为什么 `homeHideSwipe` 不在这里
 *
 * `CLEAN_OPTION_META` 里它有，但它属于**首页净化**那一组，
 * 与 9 个分类一起放在二级浮层（`homeCleanPane`）。
 *
 * 否则它会同时出现在一级 Tab 和二级页里 —— 两个位置同一个开关，
 * 用户在二级页里改了、回到一级看到状态没变（或反之）会以为其中一个是坏的。
 *
 * 这条过滤是**按归组**而不是"少写一项"：`homeHideSwipe` 在二级页里有明确的家，
 * 见 `homeCleanPane`。
 */
const AD_OPTION_KEYS = new Set<CleanOptionKey>(['adEnabled', 'adPreserveEventBanner', 'adDebug']);

export function cleanTab(
  prefs: CleanPreferences | null,
  actions: {
    toggleOption: (key: CleanOptionKey, next: boolean) => void;
    openSub: () => void;
    /**
     * ## ❌ 这里曾有 `toggleFeedBoundary` / `feedBoundaryEnabled`（2026-11-11 删除）
     *
     * 它们服务于「显示推荐来源分界线」那个开关。**分界线功能整体取消**：
     *
     * 1. 用户裁决：设完取流账号后直接隐藏 `.feed-card`，首屏就是取流账号的，线没有意义
     * 2. 而隐藏方案也因**选择器与身份两层都未验证**（父子嵌套 / M1）而冻结
     *
     * 所以净化 Tab 里那个开关、它的 action、它的参数全部删除。
     *
     * ⚠️ **不要为了"以后可能要用"把它加回来** —— 一个"看起来在做"
     * 但永远不生效的开关，比没有更糟（用户会拨它，然后什么都没发生）。
     */
  },
): HTMLElement {
  const box = el('div', 'tab-pane');

  // 还没读出来：整块禁用，**不把 null 当成全关**
  const unknown = prefs === null;
  const options = prefs?.options ?? null;

  for (const meta of CLEAN_OPTION_META) {
    if (!AD_OPTION_KEYS.has(meta.key)) continue;
    /**
     * `adDebug` / `adPreserveEventBanner` 是广告的子项：总开关关着时置灰。
     * 判据与设置页 `clean.tsx` 的 `isSubAdOption` 一致 —— 两处必须同语义，
     * 否则用户在面板里能点、在设置页里点不了（或反之），会以为其中一个坏了。
     */
    const isSub = meta.key !== 'adEnabled';
    const dim = isSub && options?.adEnabled !== true;

    box.appendChild(
      switchRow({
        label: meta.label,
        hint: meta.hint || undefined,
        checked: options?.[meta.key] === true,
        disabled: unknown || dim,
        dim,
        onToggle: (next) => actions.toggleOption(meta.key, next),
      }),
    );
  }

  if (options && describeAdDebugCaveat(options)) {
    box.appendChild(el('p', 'pane-note warn', describeAdDebugCaveat(options) ?? ''));
  }

  // ── 二级浮层入口 ──
  const sub = el('button', 'sub-entry');
  sub.type = 'button';
  const count = prefs?.hideCategories.length ?? 0;
  sub.appendChild(el('span', undefined, '首页净化'));
  sub.appendChild(
    el('span', 'sub-entry-hint', count > 0 ? `已隐藏 ${String(count)} 类` : '9 个分类'),
  );
  sub.appendChild(el('span', 'sub-entry-chevron', '▸'));
  sub.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.openSub();
  });
  box.appendChild(sub);

  /**
   * ## ⚠️ 角标开关与诊断入口**已从这里移走**（2026-11-10 真机反馈）
   *
   * 它们搬去了新的「显示」Tab（见 `displayTab`）。原因：
   * 角标是**界面偏好**、诊断是**排查工具**，都不是"净化页面内容"。
   *
   * `docs/02-ui-spec.md` §4.3 当初在 options 里就论证过这条，
   * 面板里却重犯了 —— 用户指出后单开「显示」Tab。
   */

  return box;
}

// ─────────────────────────── 显示 Tab ───────────────────────────

/**
 * 「显示」Tab —— 回答"**页面上显示什么**"（2026-11-10 新增，真机反馈）。
 *
 * ## 为什么单开这个 Tab
 *
 * 原来角标开关和诊断入口都塞在**净化** Tab 底部。用户指出位置不对：
 *
 * | 项 | 是什么 | 为什么不属于「净化」 |
 * | --- | --- | --- |
 * | 页内角标 | **界面偏好** | 「净化」回答"我让网站变成什么样"，而角标是"我要不要看到自己的状态" |
 * | 诊断 | **排查工具** | 塞在净化里会让人以为它是净化的一部分 |
 *
 * `docs/02-ui-spec.md` §4.3 当初在 options 里就专门论证过这条：
 * > 塞「诊断」页 → 用户会以为它是排查工具，而它是常驻的显示偏好
 *
 * 面板里重犯了同一个错，所以单开。
 *
 * ## 为什么两项能放一个 Tab
 *
 * options 时期它们分属「显示」与「诊断」两个分区，那是因为全屏页面有空间。
 * 面板只有 280px，而这两项都是"低频率、看一眼就走"的界面配置 ——
 * 合成一个 Tab 既省空间，又符合"显示什么"这个共同语义。
 *
 * ⚠️ 角标开关写完**不需要**面板做什么：`entrypoints/content.ts` 监听
 * `BADGE_ENABLED_KEY` 的 `storage.onChanged` 并立刻重画角标。
 *
 * @param badgeEnabled 角标开关。`null` = 还没读出来 → 禁用，**不画成"关"**
 * @param badgeReadFailed 角标开关**读失败**（`true` 时禁用态要说明原因）。
 *   默认 `false`：区分"正在读"与"读不到" —— 见 `panel.ts` 的 `badgeReadFailed`。
 */
export function displayTab(
  badgeEnabled: boolean | null,
  actions: {
    toggleBadge: (next: boolean) => void;
    openDiag: () => void;
    /**
     * ── 首页推荐流开关（2026-11-11 从「账号」Tab 迁来）──
     *
     * ## 为什么归「显示」而不是「账号」
     *
     * 用户原话：「**移到显示 tab，但不改 tab 名**」。
     *
     * 语义上也确实更合：这个 Tab 的现有内容（页内角标）都是
     * **"页面怎么表现"的偏好**，而"首页用谁的推荐"正是同一类。
     * 它**不是**"我有哪几个号"——那才是「账号」Tab 的回答。
     *
     * ## 可点性判据不变
     *
     * 仍然是 `hasCredential`（没有托管账号就没有"另一个账号"可用），
     * **不是** `streamingIdentity` —— 见 `accountTab` 里那段原注释。
     * 迁 Tab 只改渲染位置，**不改判据**。
     */
    feedAccountEnabled: boolean;
    toggleFeedAccount: (next: boolean) => void;
    /** 有没有扫码登录过扩展账号 —— 决定推荐流开关能否点 */
    hasCredential: boolean;
    /**
     * 角标开关**读失败**（`true` 时禁用态必须说明原因）。
     *
     * ## 为什么必须是显式字段而不是从 `badgeEnabled === null` 推
     *
     * `badgeEnabled === null` 同时表示「正在读」与「读不到」：
     *   - 正在读 → 灰几毫秒是正常的，不该弹一句"失败"
     *   - 读不到 → **必须解释**，否则用户面对一个永远点不动的开关
     *
     * 两者混在一起，就写不出"只在真的失败时才说话"的断言
     * （那正是 task-5 卡里提醒的"很容易写成永远为真的断言"）。
     */
    badgeReadFailed: boolean;
  },
): HTMLElement {
  const box = el('div', 'tab-pane');

  box.appendChild(el('p', 'diag-section', '页内显示'));
  box.appendChild(
    switchRow({
      label: '页内角标',
      hint: '播放器右下角显示当前实际分辨率、帧率、音频编码',
      checked: badgeEnabled === true,
      disabled: badgeEnabled === null,
      onToggle: actions.toggleBadge,
    }),
  );
  /**
   * ## 读不到时**说出原因**（2026-11-12，task-5 静默点 2）
   *
   * 旧实现：读失败 → 开关永久灰着 → **面板上一个字都没有**。
   * 用户不知道是加载中、坏了、还是自己关掉了。
   *
   * ⚠️ 只在 `badgeReadFailed === true` 时渲染 —— 别在"正在读"那一瞬
   * 就弹一句失败（那会让每次进 Tab 都闪一下红字）。
   */
  if (actions.badgeReadFailed) {
    box.appendChild(el('p', 'pane-note', '读不到角标开关的当前设置 —— 收起重开面板可重试'));
  }

  /**
   * ## 首页推荐流（2026-11-11 从「账号」Tab 迁来）
   *
   * ⚠️ **开关下面没有任何说明文字**（2026-11-12，task-11）。
   *
   * 用户原话：
   * > 「把首页推荐流使用取流账号这个开关的"打开后首页推荐完成取流账号的"
   * > 这些详细描述删掉，**标题已经能够完美解释这个开关的含义了**」
   *
   * 所以 `hint` 被**整个去掉**（不是传空串），下方那句「先扫码登录取流账号，
   * 才能用它来换首页推荐流」也一并删除。
   *
   * ⚠️ **不要自己再造一句更短的说明代替它。** 用户要求的是删除，
   * "换个说法"违背需求；删完这里就是空的。
   *
   * ### 已知副作用（用户已明确接受）
   *
   * 无凭据时这个开关是**灰的且没有原因说明**。用户看过这条取舍并要求删除。
   *
   * 机制细节（首屏藏 / 滚动换 Cookie）在 [ADR 0035] 里给维护者，**不在界面上**。
   */
  box.appendChild(el('p', 'diag-section', '首页推荐流'));
  box.appendChild(
    switchRow({
      label: '首页推荐流使用取流账号',
      /**
       * ## ⚠️ 渲染的必须是**生效状态**，不是"用户选的开关值"（2026-11-12，task-5）
       *
       * 旧写法是 `checked: actions.feedAccountEnabled` —— 于是「用户开过这个开关、
       * 后来退出了取流账号」时，控件渲染成**「开 + 灰」**，而功能其实没在生效。
       *
       * 真机证据（`poc/probe/logout-login/REPORT.md` E-3）：
       * `@e267 checkbox [disabled] [checked]="on"` —— **陈述了一件没发生的事**。
       *
       * 判据在 `rule-plan.ts` 的 `buildRulePlan()`：
       * ```
       * if (!state.hasCredential) return { feedStreaming: false, feedAccount: false };
       * ```
       * 没有凭据时 `feedAccount` **恒为 `false`**。
       *
       * ### 所以 `checked` 与 `disabled` 用**同一个与逻辑**
       *
       * ⚠️ **判据一行没改**（裁决文件「定稿 C」）：`disabled` 仍然只判
       * `hasCredential`，`rule-plan.ts` 里那个"只看 `feedAccountEnabled`"的
       * 独立防线也一个字没动。这里改的只是**这一个控件渲染什么值**。
       *
       * ⚠️ 也**没有**去改通用的 `switchRow()`（`dom.ts`）。
       */
      checked: actions.hasCredential && actions.feedAccountEnabled,
      /**
       * 没有托管账号 → 灰掉。
       *
       * ⚠️ **只判 `hasCredential`**，不判任何身份相关的值 ——
       * 那是"两个功能独立"在代码上的落地（原判据，迁 Tab 时原样保留）。
       */
      disabled: !actions.hasCredential,
      onToggle: actions.toggleFeedAccount,
    }),
  );

  /**
   * 诊断入口。
   *
   * ⚠️ **不能丢**：诊断分区是排查 InPrivate 权限的**唯一入口**
   * （`wxt.config.ts` 的注释原话）。阶段 4 删掉 options 后，这里是用户唯一能看到它。
   */
  box.appendChild(el('p', 'diag-section', '排查'));
  const diag = el('button', 'sub-entry');
  diag.type = 'button';
  diag.appendChild(el('span', undefined, '诊断'));
  diag.appendChild(el('span', 'sub-entry-hint', '自检信息 · 日志 · 导出'));
  diag.appendChild(el('span', 'sub-entry-chevron', '▸'));
  diag.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.openDiag();
  });
  box.appendChild(diag);

  /**
   * ⚠️ 这里**曾经有一句**：「诊断里有 InPrivate 权限、DNR 规则与诊断日志 ——
   * 出问题时先看那里。」（2026-11-12，task-11 按用户要求删除）
   *
   * 用户原话：
   * > 「"诊断里有 InPrivate权限、DNR规则与诊断日志 -- 出问题 时先看那里。"
   * > 这些字都可以删掉」
   *
   * ⚠️ **删的是那句解释，不是入口**。上面那个 `diag` 按钮必须保留 ——
   * 它是排查 InPrivate 权限的**唯一入口**（`wxt.config.ts` 的注释原话）。
   */

  return box;
}

// ─────────────────────────── 二级浮层：首页净化 ───────────────────────────

/**
 * 二级浮层「首页净化」：隐藏顶部大图 + 9 个分类。
 *
 * ## 为什么是"返回"而不是"跳转"
 *
 * 用返回栈（见 `panel.ts` 的 `viewStack`），不是新窗口也不是新标签页。
 * 用户在首页看得好好的，点一下设置不该丢掉上下文 —— 这条与
 * popup「播放账号」就地展开是同一个理由（`02-ui-spec.md` §2.6）。
 *
 * @param back 点返回时调用（编排层弹栈）
 */
export function homeCleanPane(
  prefs: CleanPreferences | null,
  actions: {
    toggleOption: (key: CleanOptionKey, next: boolean) => void;
    toggleCategory: (cat: string, next: boolean) => void;
    back: () => void;
  },
): HTMLElement {
  const box = el('div', 'tab-pane');

  const bar = el('div', 'sub-bar');
  const backBtn = el('button', 'sub-back');
  backBtn.type = 'button';
  backBtn.textContent = '‹ 返回';
  backBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.back();
  });
  bar.appendChild(backBtn);
  bar.appendChild(el('span', 'sub-title', '首页净化'));
  box.appendChild(bar);

  const unknown = prefs === null;
  const options = prefs?.options ?? null;

  // 隐藏顶部大图（布尔项，不是分类）
  const swipeMeta = CLEAN_OPTION_META.find((m) => m.key === 'homeHideSwipe');
  box.appendChild(
    switchRow({
      label: swipeMeta?.label ?? '隐藏顶部大图推荐',
      checked: options?.homeHideSwipe === true,
      disabled: unknown,
      onToggle: (next) => actions.toggleOption('homeHideSwipe', next),
    }),
  );

  box.appendChild(el('p', 'pane-note', '按分类隐藏首页的专题推荐位。默认全不隐藏。'));

  const cats = prefs?.hideCategories ?? [];
  for (const cat of OBSERVED_CATEGORIES) {
    box.appendChild(
      switchRow({
        label: cat,
        checked: cats.includes(cat),
        disabled: unknown,
        onToggle: (next) => actions.toggleCategory(cat, next),
      }),
    );
  }

  return box;
}

// ─────────────────────────── 账号 Tab ───────────────────────────

/**
 * 账号 Tab：A/B 双卡 + 登录入口。
 *
 * ## 视觉层级刻意拉开（`02-ui-spec.md` §2.4）
 *
 * 用户的潜在恐惧是"我的号会不会被切走"。所以要让人一眼看出：
 * A 是**主账号**（只读、灰、列出收藏/点赞/评论/历史四项社交行为），
 * B 是**受控工具**（信息色、副标题写「仅取流」）。
 *
 * ## 不许编数据
 *
 * 昵称读不到就写占位（`primaryPlaceholder()`，复用而不是另写一份文案），
 * 等级读不到就写「只读」，**不编一个 LV 数字**。
 */
/**
 * 账号 Tab 的动作。
 *
 * ## 为什么 2026-11-10 从「只有 login」变成了三个（真机功能缺失）
 *
 * 迁移时漏了 `logout` —— 原 `options/sections/account.tsx` 有「重新登录」和
 * 「退出播放账号」两个按钮，随 options 一起删了，但面板没接上。
 *
 * 结果：**配置成功之后账号 Tab 一个按钮都没有**，用户既不能重新登录，也不能退出。
 * 这是功能缺失，不是设计。
 *
 * ⚠️ `logout` 返回 `Promise<{ok, detail?}>` 而不是 `void`：
 * 失败必须能让 UI 说清原因（"点了没反应"是最糟的反馈）。
 */
export interface AccountActions {
  /** 打开扫码窗口（`login/open`） */
  login: () => void;
  /** 退出播放账号（`account/remove`）。**调用前 UI 必须已经过两步确认** */
  logout: () => Promise<{ ok: boolean; detail?: string }>;
  /**
   * ── 退出结果的**出口**（2026-11-12，task-3 修路径②）──
   *
   * ## 为什么不能继续写在 `box` 里
   *
   * 旧实现把结果写进 `box` 的 `.acct-result`（本文件末尾那段）。而
   * `panel.ts` 的 `render()` 每次切 Tab / `setModel` 都会
   * `replaceChildren(content, [accountTab(...)])` —— **整个 `box` 被丢弃**，
   * 刚写的结果文案随之消失。
   *
   * 更糟的是**退出成功本身会触发重画**：`logout` 的实现会重新取数并
   * `setModel()`，那次重画必然把 `.acct-result` 冲掉。于是用户点了
   * 「确认退出」，面板看起来**什么都没发生**（取证 A 节路径②）。
   *
   * 而竞态（重画先到还是文案先写）决定了文案能不能被看到**一瞬** ——
   * 这正是用户说的「**有些时候**点击退出……没有任何变化」。
   *
   * ## 怎么修 / 修成什么样
   *
   * 由**编排层**（`panel.ts`）把结果交给 `PanelController.showNotice()`：
   * 它挂在 `root` 上（**跨 `replaceChildren` 存活**，见那条的注释），
   * 与登录结果同一条通道，不另造第二套提示机制。
   *
   * ⚠️ 本模块**不认识** `PanelController`（`tabs.ts` 是纯 DOM 层，
   * 不 import 编排层）—— 所以这里只声明一个回调，实现由调用方注入。
   * 这与 `toggleStreamingIdentity` 同一个手法。
   *
   * @param text 给用户看的一句话
   * @param ok   `true` 中性/成功色，`false` 危险色
   */
  notifyResult: (text: string, ok: boolean) => void;
  /**
   * ── 取流身份（2026-11-11，步骤 4）──
   *
   * ## 为什么是**必填**（原本做成可选，2026-11-11 改）
   *
   * 第一版做成可选，理由是"不破坏既有 8 处测试"。**那个理由掩盖了一个真缺口**：
   * `panel.ts` 调 `accountTab()` 时根本没传这两个字段，于是
   * **胶囊永远不渲染 → 这个功能在生产里是死代码**，而所有测试都是绿的。
   *
   * 做成必填后，每个调用点都必须**明确表态**：
   *   - 有身份 → 传 `'extension' | 'page'`
   *   - 确实没有（例如测试里只想看账号卡）→ 传 `null` 并断言"胶囊不渲染"
   *
   * **"明确表达这里没有" ≠ "忘了传"。** 前者是一个判据，后者是一个缺口。
   */
  /** 当前取流身份；`null` = 还没读出来（胶囊不渲染，**不猜**） */
  streamingIdentity: StreamingIdentity | null;
  /** 点胶囊切换。`next` 是要切到的目标，不是"取反"（让调用方可复用同一回调） */
  toggleStreamingIdentity: (next: StreamingIdentity) => void;

  /**
   * ── 首页推荐流开关**已迁到「显示」Tab**（2026-11-11）──
   *
   * 这两个字段（`feedAccountEnabled` / `toggleFeedAccount`）**已移到
   * `displayTab()` 的 `actions` 里**，不再属于 `AccountActions`。
   *
   * 用户裁决：「**移到显示 tab，但不改 tab 名**」。
   *
   * ## ⚠️ 迁位置 ≠ 迁判据
   *
   * 原有一段类型级防线（不能删，只是搬走了）：
   *
   * > 本字段的**类型里根本没有 `StreamingIdentity`** ——
   * > 谁想在推荐流开关的判据里用取流身份，必须先改这个签名，
   * > 而改签名会让调用点报错 → **不可能静默发生**。
   *
   * 那条防线**现在由 `displayTab()` 的 `actions` 类型承担**：
   * 它同样只有 `hasCredential: boolean`，**没有** `StreamingIdentity`。
   *
   * **迁 Tab 只改渲染位置，没改这条判据。**
   */
}

/**
 * 账号 Tab —— 回答"两个身份分别是谁"，并提供重新登录 / 退出。
 *
 * ## 两个按钮为什么现在**总是**出现（2026-11-10）
 *
 * 旧实现只在"未配置"时给按钮，配置成功后一个按钮都没有 —— 用户无法重新登录或退出。
 *
 * 现在的规则：
 * - **重新登录**：**只要读过 `account/summary`（`!unknown`）就显示** ——
 *   已配置时它是"换一个号"，未配置时它就是登录入口
 * - **退出播放账号**：只在**确实有凭据**（`pb || hasCredential`）时显示 ——
 *   没配置时给一个"退出"按钮会让人莫名其妙
 *
 * ## 退出是两步（`docs/02-ui-spec.md` §7 禁止 `confirm()`）
 *
 * ```
 * 点「退出播放账号」→ 变成「确认退出」+「取消」
 * 点「确认退出」→ 才执行
 * ```
 *
 * 理由（`02` §7 原话）：`alert` / `confirm` 会阻塞 SW，且在扩展页面里表现异常。
 *
 * @param a     账号视图
 * @param now   当前时刻（算到期日）
 * @param pageKind 页面类型（决定主账号占位文案）
 * @param actions 见 `AccountActions`
 */
export function accountTab(
  a: AccountView,
  now: number,
  pageKind: 'play' | 'other',
  actions: AccountActions,
): HTMLElement {
  const box = el('div', 'tab-pane');

  // ── A：主账号（只读）──
  const primaryRow = el('div', 'acct-row primary');
  primaryRow.appendChild(el('span', 'acct-avatar', '主'));
  const pMain = el('span', 'acct-main');
  /**
   * ⚠️ 占位文案必须走 `primaryPlaceholder(pageKind, loggedIn)`，**不能自己写一份**。
   *
   * 那条纯函数里钉着两条纪律（`primary-card.ts` 的注释有完整出处）：
   *   - 播放页 + `unknown` → 「读取中…」，**绝不能写"未登录"**（刚进页面的常见路径）
   *   - 非播放页 → 「打开视频页后可见」
   *
   * 面板自己拼一句，就会在"刚进视频页"那 1.5 秒里显示一个错的结论。
   */
  pMain.appendChild(
    el('span', 'acct-name', a.primary.uname ?? primaryPlaceholder(pageKind, a.primary.loggedIn)),
  );
  pMain.appendChild(el('span', 'acct-sub', '收藏 · 点赞 · 评论 · 历史'));
  primaryRow.appendChild(pMain);
  // 等级拿不到就写「只读」—— 不编一个 LV 数字
  primaryRow.appendChild(
    el('span', 'acct-tag', a.primary.level !== null ? `LV${String(a.primary.level)}` : '只读'),
  );
  box.appendChild(primaryRow);

  // ── B：播放账号 ──
  const pb = a.playback;
  if (pb || a.hasCredential) {
    const playbackRow = el('div', 'acct-row playback');
    /**
     * 头像字用「**取**」不是「播」。
     *
     * 踩过：这里原本是 `'播'`（"播放账号"的缩写），而全线已改叫**取流账号**
     * （术语纠错，`task-1`）。留下 `播` 会让用户在账号卡上看到一个
     * 在别处已经不存在了的叫法 —— 术语漂移的典型形态。
     *
     * ⚠️ A 卡是 `'主'`。两个字都只有 1 字符，`.acct-avatar` 是 24×24 定宽，
     * 换成「取」不会改变任何布局。
     */
    playbackRow.appendChild(el('span', 'acct-avatar accent', '取'));
    const bMain = el('span', 'acct-main');
    /**
     * ## ⚠️ `pb === null && hasCredential` 时**只能有一个结论**（2026-11-12，task-3 修 B-4）
     *
     * 这个组合是真实存在的：`hasCredential` 来自 `proxy/status`（vault 里有没有密文），
     * 而 `pb` 来自 `account/summary`（账号资料读没读出来）。两者**各有各的失败方式**，
     * 于是会出现「密文还在，但资料读不出」。
     *
     * ### 旧实现在这张卡上放了**三句互相矛盾**的话
     *
     * | 位置 | 旧文案 | 读起来 |
     * | --- | --- | --- |
     * | 昵称（`:580`） | 「取流账号已配置」 | 已配置 |
     * | 标签（`:626`） | 「已配置」 | 已配置 |
     * | 副标题（`:608`） | 「读不出账号资料 · 点下方重新登录」 | **没配置** |
     *
     * 同一张卡同时说"配好了"和"读不出来"，用户不知道该信哪句 ——
     * 这正是「界面自相矛盾」类缺陷（与 `pb`/`hasCredential` 那轮同类）。
     *
     * ### 现在的规则：卡上**统一说"已配置，但资料暂时读不出"**
     *
     * 事实是：密文在（功能可用），只是这次没读到昵称/到期日。
     * 所以三处都按「已配置」这一侧说话，**不出现"未配置"的暗示**；
     * 唯一的例外是把"为什么没有昵称"讲清楚（那才是用户会疑惑的点）。
     *
     * ⚠️ **不改判据结构**（裁决文件「定稿 B」）：`if (pb || hasCredential)`
     * 这个入口条件一行不动，`AccountView` 的形状也不动。
     * 本轮只要求"文案不自相矛盾"，不是重做数据模型。
     */
    bMain.appendChild(
      el(
        'span',
        'acct-name',
        pb?.uname ??
          /**
           * ⚠️ 只有 `hasCredential` 为真才会走到这里（外层 `if (pb || a.hasCredential)`）。
           * 此时**不能**写「取流账号已配置」当昵称 —— 那是个**占位符冒充昵称**，
           * 而下方标签已经说了「已配置」。昵称位说"资料没读出来"才是准确的信息。
           */
          '取流账号（昵称暂未读出）',
      ),
    );
    const exp = pb ? describeExpiry(pb.expireAt, now) : '';
    /**
     * ## ⚠️ 副标题**保持原样**，不要在这里缩短（2026-11-11 回退）
     *
     * 曾经试过把 `仅取流 · 6 个月后到期`（13 字）缩成 `仅取流 · 6 个月`（9 字），
     * 想靠少三个字解决截断。**已回退。**
     *
     * ### 为什么回退
     *
     * 真机实测证明**光把胶囊挪出卡片就够了**：`.acct-main` 从 **154.3 → 229**，
     * 229 放得下 13 字的副标题。
     *
     * 更重要的理由是方法论：**一次只改一个变量**。
     * 若同时挪胶囊 + 缩文案，复测"变好了"就**无法归因**是哪个改动的功劳；
     * 万一还是截断，也不知道该再动哪个。
     *
     * ### 如果将来真需要缩短
     *
     * 判据是**真机复测显示 229 仍不够**，而不是"看起来挤"。
     * 那时优先缩短文案，**但不要改 `describeExpiry()`** ——
     * 它是 `popup-state.ts` 的共用纯函数，输出 `N 个月后到期` 在别的语境下是完整句子；
     * 而且它承载单位换算的正确性（曾因子单位算错显示过"698197 个月后到期"）。
     */
    bMain.appendChild(
      el(
        'span',
        'acct-sub',
        pb
          ? exp
            ? `仅取流 · ${exp}`
            : '仅取流 · 无到期日'
          : /**
             * `pb === null` 但密文在（见上面 `acct-name` 的注释）。
             *
             * ⚠️ 旧文案「读不出账号资料 · 点下方重新登录」与同卡的
             * 「已配置」并列 → 自相矛盾（B-4）。而且"重新登录"这个建议
             * 也不成立：密文在、功能可用，用户没有必须重扫的理由。
             *
             * 现在说的是**事实**：账号已配置，只是这次没读到资料；
             * 并给出一个**用户真能做的**动作（重开面板会重取一次，
             * 与 `loadOnce` 的超时重试同一路径）。
             */
            '已配置 · 账号资料暂时读不出，收起重开面板可重试',
      ),
    );
    /**
     * 凭据健康状态（2026-11-10，原 options 有、迁移时漏了）。
     *
     * ⚠️ **只显示相对时间**，不加"可能已过期"这类猜测 ——
     * `02-ui-spec.md` §2.4：「过期是内部卫生，不该变成 UI 上的疑虑」。
     *
     * | 情况 | 渲染 |
     * | --- | --- |
     * | `health` 为 `null`（读不到） | **整行不渲染** |
     * | `healthy: true` | 「刚刚校验」/「N 分钟前校验」 |
     * | `healthy: false` | 「凭据异常：<reason>」—— 这个**必须**说，因为它影响可用性 |
     */
    const healthText = describeHealth(pb, now);
    if (healthText) bMain.appendChild(el('span', 'acct-sub acct-health', healthText));
    playbackRow.appendChild(bMain);
    playbackRow.appendChild(el('span', 'acct-tag accent', pb ? VIP_TAG[pb.vipLabel] : '已配置'));

    /**
     * 胶囊的**独立行容器**（2026-11-11，S4 新增）。
     *
     * 它不在 `playbackRow` 里 —— 见下面"为什么挪出来"的实测数据。
     * 单独建一个容器而不是直接 append 到 `box`，是为了让 CSS 能把它
     * 与卡片**视觉绑定**（缩进对齐），同时又不参与卡片内部的 flex 竞争。
     */
    const pillRow = el('div', 'acct-pill-row');

    /**
     * ── 取流身份胶囊（2026-11-11，步骤 4）──
     *
     * ## 为什么放在 B 卡上而不是 A 卡
     *
     * A 卡是**浏览器登录态**（`tabs.ts` 文件头那段：A 只读、灰、列出四项社交行为）。
     * 让它变成可点击的，会让用户怀疑扩展在管主账号 —— 与 [ADR 0004] 的
     * 设计意图（消除"我的号会不会被切走"的恐惧）直接冲突。
     *
     * 胶囊挂在 B 卡，语义是"**扩展这一侧提供哪种取流**"：
     *   - 「取流：扩展账号」→ 用 vault 里那个号
     *   - 「取流：浏览器账号」→ 扩展不介入，页面自己取流
     *
     * 两个状态都是**正常配置**，没有一个是"停用"。
     *
     * ## ⚠️ `identity === null` 时**仍然渲染**（2026-11-11 修正）
     *
     * ### 上一版是错的
     *
     * 上一版写的是 `if (streamingIdentity !== null) { … }` —— **`null` 时整块消失**。
     * 当时的理由是"渲染任何默认值都是编数据"。**那个理由只对了一半**：
     *
     * | 规则 | 正确理解 |
     * | --- | --- |
     * | 「不渲染任何默认值」 | 是**内容**规则 —— 不许假装用户选了 `extension` 或 `page` |
     * | 但它**不是**删掉入口的许可 | **控件消失不是安全默认值，而是隐形 bug** |
     *
     * `null` 有两种成因，上一版**把它们都吞成了"不存在"**：
     *   - 消息还没回来（读得晚）
     *   - 消息**永远失败**（background 没应答 / 实例不对）
     *
     * 第二种下用户**永远看不到这个控件的任何痕迹** —— 而它是"切换取流身份"的
     * **唯一入口**。用户看不见 = 功能没做。
     *
     * ### 现在的规则
     *
     * | 值 | 胶囊 | 可点 |
     * | --- | --- | --- |
     * | `'extension'` | 「取流：扩展账号」 | ✅ |
     * | `'page'` | 「取流：浏览器账号」 | ✅ |
     * | **`null`** | 「**取流身份：未知**」 | ❌（点了也不知道切成什么） |
     *
     * 未知态**不可点**：在没有读到当前值时，"切到另一个"这个动作的目标是不确定的
     * —— 若当前其实已经是 `page`，用户点一下反而切到了 `extension`。
     * **宁可少一个动作，不可让动作的结果违反预期。**
     */
    {
      const identity = actions.streamingIdentity;
      const known = identity !== null;
      const pill = known
        ? describeStreamingIdentity(identity)
        : {
            label: '取流身份：未知',
            accent: false,
            /**
             * 未知态**不强调**：`accent` 是"这是当前生效的身份"的视觉信号，
             * 而未知时我们连它是什么都不知道。
             */
            stale: true,
          };
      const pillEl = el('span', pill.accent ? 'acct-tag accent' : 'acct-tag', pill.label);

      if (known) {
        /**
         * 可点：`toggleStreamingIdentity` 现在是**必填**（见 `AccountActions` 的注释），
         * 所以这里不再需要"有没有回调"的分支 —— 那就跳过了一个"渲染了点不动的按钮"的坑。
         */
        pillEl.setAttribute('role', 'button');
        pillEl.setAttribute('tabindex', '0');
        pillEl.style.cursor = 'pointer';
        pillEl.title = pill.accent
          ? '点击改为用浏览器当前登录的账号取流'
          : '点击改为改用扩展账号取流';

        const toggle = actions.toggleStreamingIdentity;
        const fire = (ev: Event): void => {
          ev.stopPropagation();
          ev.preventDefault();
          // 传**目标值**而不是"取反"：调用方不需要自己算 next，也就不可能算错
          toggle(identity === 'extension' ? 'page' : 'extension');
        };
        pillEl.addEventListener('click', fire);
        pillEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') fire(ev);
        });
      } else {
        /**
         * 未知态：**留痕但不给动作**。
         *
         * `title` 说明"为什么不能点"，而不是让用户点一下没反应（那更糟）。
         */
        pillEl.title = '还没读到取流身份设置。收起重开面板会重新读取。';
      }

      /**
       * ## ⚠️ 胶囊**不再 append 进 `playbackRow`**（2026-11-11，S4）
       *
       * ### 为什么挪出来：实测它把昵称挤断了
       *
       * 真机像素实测（面板真实宽 **311 CSS**）：
       *
       * | 元素 | 宽 | 说明 |
       * | --- | --- | --- |
       * | 卡片内容区 | 295 | 311 − padding 16 |
       * | 头像 + 间距 | 48 | `flex: 0 0 auto` |
       * | VIP 标签 | 25.7 | `flex: 0 0 auto` |
       * | **胶囊** | **67.0** | `flex: 0 0 auto` |
       * | **`.acct-main` 剩余** | **154.3** | ← **不够** |
       *
       * 后果（截图实证）：
       *   - `.acct-name`：`{{取流账号昵称}}`（16 字）→ 屏显 `{{取流账号昵称}}...`（**少 4 字**）
       *   - `.acct-sub`：`仅取流 · 6 个月后到期` → 屏显 `仅取流 · 6 个月...`
       *
       * 胶囊移出后 `.acct-main` 从 **154.3 → 229**（+67 胶囊 +8 间距），
       * 229 足够放 16 字昵称（≈110–120）与 9 字副标题（≈70–80）。
       *
       * ### 为什么语义上也该分开
       *
       * | 元素 | 表达什么 |
       * | --- | --- |
       * | 昵称 / VIP / 健康 | **账号属性**（这个号是什么、多强、还好吗） |
       * | **胶囊** | **当前设置**（现在用谁取流） |
       *
       * 两者不是一类 —— 前者随账号变，后者随用户选择变。
       * 挤在同一行还会让用户以为胶囊是"这个账号的属性之一"。
       *
       * ### ⚠️ 不要动 `.acct-main` 的 `flex: 1 1 auto`
       *
       * 它**本来就该占剩余空间**。问题在胶囊不收缩（`flex: 0 0 auto`），不在 main。
       * 把 main 改成 `flex: 1 1 0` 之类只会让它更窄。
       */
      pillRow.appendChild(pillEl);
    }

    box.appendChild(playbackRow);
    /**
     * 胶囊单独一行，挂在**卡片下方**（不是卡片内部）。
     *
     * 左对齐 —— 与卡片左边缘对齐，读起来是"这张卡的当前设置"。
     */
    if (pillRow.childElementCount > 0) box.appendChild(pillRow);

    /**
     * ## 「有凭据但读不出资料」的解释（2026-11-10，原 options 有、迁移时漏了）
     *
     * 上面卡片副标题只写了「读不出账号资料 · 点下方重新登录」——
     * 那是**现象**，缺**归因**。`02-ui-spec.md` 反复强调
     * 「归因 + 后果 + 动作」三者缺一不可。
     *
     * 措辞来自原 `options/sections/account.tsx`。
     *
     * ⚠️ 与「真的没配置」必须分开：混成一句会让用户以为账号没了，
     * 跑去重新扫码 —— 而他其实**只是这次没读到资料**。
     */
    if (!pb) {
      box.appendChild(
        el(
          'p',
          'pane-note',
          '已配置，但暂时读不出账号资料（可能是网络或风控）。点下方「重新登录」可以重新扫码。',
        ),
      );
    }
  }

  /**
   * ## 三种"看起来都像没配置"的状态必须分开说（2026-11-10）
   *
   * | 状态 | 判据 | 文案 |
   * | --- | --- | --- |
   * | 真的没配置 | `!pb && !hasCredential && !unknown` | 「还没有配置取流账号」 |
   * | **有凭据但读不出资料** | `hasCredential && !pb` | 见上面 playback 分支里的专门文案 |
   * | 完全不知道 | `unknown` | 「账号信息读取失败，稍后重试」 |
   *
   * ⚠️ 读不到 `account/summary` 时**不能显示"未配置"** ——
   * 那会引导用户去扫一个可能已经存在的号（`messages.ts` 里记过这条）。
   *
   * ## ⚠️ 第四种：`page` 身份下「没凭据」是**正常配置**（2026-11-11 任务 10 剩余）
   *
   * 取流身份 = `'page'`（用浏览器当前登录态）时，`hasCredential` **恒为 `false`** ——
   * 这种配置**本来就不需要** vault 里的凭据。
   *
   * 旧判据只看 `!pb && !hasCredential`，于是会把一个**完全可用**的配置
   * 报成「还没有配置取流账号」—— 和 popup 里 `!configured` 那条是同一个 bug，
   * 只是这里在面板侧又写了一份。
   *
   * 判据统一走 `isStreamingReady()`（同一处实现），**不在这里另写 `a || b`**。
   */
  const streamingIdentity = actions.streamingIdentity ?? null;
  /**
   * ⚠️ `streamingIdentity === null`（还没读出来）时**走旧的保守判据** ——
   * 与 popup 的"缺参数不改口"同一纪律：不知道就别替他下结论。
   */
  const streamingReady =
    streamingIdentity === null
      ? pb !== null || a.hasCredential
      : isStreamingReady(streamingIdentity, a.hasCredential);

  if (!streamingReady) {
    box.appendChild(
      el('p', 'pane-note', a.unknown ? '账号信息读取失败，稍后重试' : '还没有配置取流账号'),
    );
  }

  // ── 操作区：重新登录 / 退出播放账号 ──

  /**
   * ⚠️ 读不到 `account/summary`（`unknown`）时**一个按钮都不给** ——
   * 那时不知道有没有配置，给「重新登录」可能让用户白扫一次，
   * 给「退出」更可能删掉一个其实存在的账号。
   */
  if (a.unknown) {
    return box;
  }

  const actionsRow = el('div', 'acct-actions');

  /**
   * **重新登录**。
   *
   * 已配置时是"换一个号"，未配置时它就是登录入口 —— 两种情况同一个动作。
   * 所以文案按状态变，行为不变。
   */
  const loginBtn = el('button', 'acct-btn ghost', pb ? '重新登录' : '扫码登录取流账号');
  loginBtn.type = 'button';
  loginBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.login();
  });
  actionsRow.appendChild(loginBtn);

  /**
   * **退出播放账号** —— 只在确实有凭据时给。
   *
   * ## 两步确认（`docs/02-ui-spec.md` §7 禁止 `confirm()`）
   *
   * 第一次点击**不执行任何东西**，只把按钮换成「确认退出」+「取消」。
   * 第二次点「确认退出」才真的发 `account/remove`。
   *
   * ⚠️ 这是**有意不做成一步**：退出之后取流会回退到主账号身份，
   * 番剧页会立刻掉回 1080P，用户如果只是误触会很难受。
   */
  if (pb || a.hasCredential) {
    let confirming = false;

    /** 「取消」按钮 —— 只在确认态存在 */
    const cancelBtn = el('button', 'acct-btn ghost', '取消');
    cancelBtn.type = 'button';
    cancelBtn.style.display = 'none';

    const removeBtn = el('button', 'acct-btn ghost', '退出取流账号');
    removeBtn.type = 'button';

    /** 回到非确认态 */
    const reset = (): void => {
      confirming = false;
      removeBtn.textContent = '退出取流账号';
      removeBtn.classList.remove('danger');
      cancelBtn.style.display = 'none';
    };

    cancelBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      reset();
    });

    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();

      if (!confirming) {
        // 第一步：只切文案，不发任何请求
        confirming = true;
        removeBtn.textContent = '确认退出';
        removeBtn.classList.add('danger');
        cancelBtn.style.display = '';
        return;
      }

      /**
       * 第二步：真正执行。
       *
       * 先复位文案再发请求 —— 失败时按钮不会卡在「确认退出」上，
       * 用户可以再点一次。
       */
      reset();
      removeBtn.disabled = true;
      cancelBtn.disabled = true;

      void actions.logout().then((r) => {
        removeBtn.disabled = false;
        cancelBtn.disabled = false;

        /**
         * ## 结果交给 `root` 级的提示条，**不再写进 `box`**（2026-11-12，路径②）
         *
         * 旧实现写 `.acct-result`，而它随 `box` 一起被 `replaceChildren` 丢弃 ——
         * 而退出成功**必然**触发一次重画（`logout` 实现会重取并 `setModel`），
         * 所以文案几乎总是被自己触发的那次重画冲掉。
         * 用户看到的就是「点了没反应」，与「有些时候」吻合（竞态）。
         *
         * `notifyResult` 由 `panel.ts` 注入，实现在 `showNotice()` ——
         * 挂在 `root`，**跨 `replaceChildren` 存活**。
         *
         * ⚠️ 文案是裁决文件钉死的那两句，一字不改（权威顺序：
         * 裁决文件 > 任务卡 > 聊天消息）：
         *   - 成功 → 「已退出取流账号，取流回退到浏览器当前账号」
         *   - 失败 → 「退出失败：<detail>」
         *
         * ⚠️ 说法必须是「浏览器当前账号」不是「主账号」——
         * 用户能读懂前者，后者是内部术语（裁决 1 第 2 条）。
         */
        /**
         * ⚠️ 这两句与 `panel.ts` 的 `NOTICE_LOGOUT_OK` 必须**逐字一致**。
         *
         * 为什么不是 import 那个常量：`panel.ts` import 本文件（`accountTab` 等），
         * 反向 import 会形成循环依赖（ESLint 的 import 规则也会红）。
         *
         * 契约靠测试守：`tests/unit/content/panel/logout-notice-contract.test.ts`
         * 断言界面上的文字 === `NOTICE_LOGOUT_OK` —— 两边任何一处漂移都会红。
         */
        actions.notifyResult(
          r.ok ? '已退出取流账号，取流回退到浏览器当前账号' : `退出失败：${r.detail ?? '未知原因'}`,
          r.ok,
        );
        /**
         * 成功后**不用**这里手动刷新：`logout` 的实现（`content-panel.content.ts`）
         * 会重新取数并重画面板。这里只负责把"刚才发生了什么"说清楚。
         *
         * ⚠️ 重取**失败**时的那句「已退出，但界面刷新失败」由实现方负责
         * （它才知道 `loadOnce()` 的结局，见 `content-panel.content.ts`）——
         * 本模块拿不到那个信息，不要在这里编。
         */
      });
    });

    actionsRow.appendChild(removeBtn);
    actionsRow.appendChild(cancelBtn);
  }

  box.appendChild(actionsRow);

  if (!pb) {
    box.appendChild(el('p', 'pane-note', '主账号无需配置，自动沿用浏览器当前登录状态'));
  }

  /**
   * ## 首页推荐流开关**已迁到「显示」Tab**（2026-11-11）
   *
   * 用户裁决：「**移到显示 tab，但不改 tab 名**」。
   *
   * 这里原本是：
   * ```
   * box.appendChild(el('div', 'acct-divider'));
   * box.appendChild(switchRow({ label: '首页推荐流使用取流账号', hint: '打开后，首页推荐流（含首屏）…（62 字）', … }));
   * if (!a.hasCredential) box.appendChild(el('p','pane-note','先扫码登录取流账号…'));
   * ```
   *
   * ### 为什么连 `acct-divider` 一起删
   *
   * 它只有一个用途 —— 把推荐流开关与账号卡**隔开**，传达"这是另一件事"。
   * 开关迁走后，**它失去了唯一的功能**。
   *
   * ⚠️ 而且它**从来没有样式**：`sidebar.ts` 里搜不到 `.acct-divider`
   * （2026-11-11 盘点确认，`task-28` PLAN.md §1.4）。也就是说它一直是
   * 一个**零高度、无边框的空 div** —— 那个"用分隔线告诉用户这是两件事"
   * 的设计意图，**从未真正实现过**。
   *
   * 所以删它不是"清理顺手"，而是**删掉一个从未生效的东西**。
   */
  return box;
}

// ─────────────────────────── 关于 Tab ───────────────────────────

/**
 * 「上次检查」的相对说法。**不要显示绝对时间戳**：
 * 用户问的是"刚才查了没有"，不是"哪年哪月哪秒"。
 */
function describeLastCheck(lastCheckAt: number | null, now: number): string {
  if (lastCheckAt === null) return '从未检查';
  const diff = now - lastCheckAt;
  // 时钟回拨时 diff 为负，说"刚刚"就好，别显示"-3 分钟前"那种东西
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.floor(hours / 24))} 天前`;
}

/** 体积文案。真实包约 283 KB，没必要显示精确到字节。 */
function describeSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${String(Math.round(bytes / 1024))} KB`;
}

/**
 * 关于 Tab：版本 / 更新 / 仓库入口。
 *
 * ## 为什么「检查更新」与「立即更新」是两个东西
 *
 * 前者只问一句"有没有新的"，后者才动文件。用户可能只想确认一下，
 * 也可能只想点「去 Releases 自己下」——三条路径**互不替代**。
 * 所以这里不给"去更新"这种含糊按钮。
 *
 * ## 读不到状态时不落默认值
 *
 * `view === null` 表示面板与后台没对上（SW 未醒 / 消息失败）。
 * 此时**不显示"已是最新"**——那是谎报。只说明读不到，并让用户重开面板。
 *
 * ## `phase` 只决定"提不提示"，不决定"有没有更新"
 *
 * `'dismissed'` = 用户已经打开过这个 Tab，这一版不再打扰。
 * 它**不是**"没有新版"：版本行照常显示「最新 vY」，「立即更新」照常可点。
 * 官方规格见 `docs/02-ui-spec.md` §5.3「通知通道」那一节。
 */
export function aboutTab(
  view: UpdateStatusView | null,
  actions: {
    check: () => void;
    openUpdate: () => void;
    openReleases: () => void;
    toggleAuto: (next: boolean) => void;
    /** 正在检查（按钮置灰 + 文案改成"检查中…"） */
    busy: boolean;
  },
): HTMLElement {
  const box = el('div', 'tab-pane');
  box.appendChild(el('p', 'diag-section', '更新'));

  if (!view) {
    box.appendChild(
      el('p', 'pane-note', '读不到更新状态 —— 关掉面板再打开试试（后台可能还没醒来）'),
    );
    return box;
  }

  const latest = view.latestVersion;
  const size = describeSize(view.latestSizeBytes);
  const versionLine =
    latest && latest !== view.currentVersion
      ? `当前 v${view.currentVersion} · 最新 v${latest}${size ? `（${size}）` : ''}`
      : `当前 v${view.currentVersion} · 已是最新`;

  const version = el('p', 'pane-note', versionLine);
  version.setAttribute('data-testid', 'update-version');
  box.appendChild(version);

  /**
   * 「上次更新没生效」—— 这条不能省。
   *
   * 用户为更新点过一次目录授权；如果写进去的文件没被加载（多半选错了目录），
   * 不说清楚的话他会看到"更新完成"而版本没变，然后完全无从下手。
   * 类名用 `.pane-note.warn`（琥珀色），不是 `.warning` —— 后者不存在。
   */
  if (view.lastFailedVersion) {
    const failed = el(
      'p',
      'pane-note warn',
      `上次更新到 v${view.lastFailedVersion} 没有生效 —— 可能选错目录了。重新选一次目录，或在扩展详情页点「重新加载」。`,
    );
    failed.setAttribute('data-testid', 'update-failed');
    box.appendChild(failed);
  }

  const checked = el(
    'p',
    'pane-note',
    `上次检查 ${describeLastCheck(view.lastCheckAt, Date.now())}`,
  );
  checked.setAttribute('data-testid', 'update-last-check');
  box.appendChild(checked);

  const checkBtn = el('button', 'acct-btn ghost', actions.busy ? '检查中…' : '检查更新');
  checkBtn.type = 'button';
  checkBtn.disabled = actions.busy;
  checkBtn.setAttribute('data-testid', 'update-check');
  checkBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.check();
  });
  box.appendChild(checkBtn);

  /**
   * 自动检查开关。
   *
   * ⚠️ 文案**不能**写成"启用更新检查"——那会让用户以为关掉后手动也失效。
   * 它只停"自动发起"，见方案 §6.3。
   */
  box.appendChild(
    switchRow({
      label: '自动检查更新',
      hint: `每 ${String(view.intervalDays)} 天首次打开时查一次（关掉后仍可手动检查）`,
      checked: view.autoCheckEnabled,
      onToggle: actions.toggleAuto,
    }),
  );

  /**
   * 「立即更新」与「GitHub Releases」并排，但**是两件不同的事**：
   * 前者下载并覆盖文件，后者只是跳去下载页。合成就等于替用户选了。
   *
   * 没有新版时禁用 —— 点了也只会拿到「没有可更新的版本」。
   *
   * ⚠️ **`dismissed` 必须也视为可执行**（2026-11-17）。
   * 它只表示"这一版不再提示"，**不代表没有更新** —— `latestVersion` 仍然比当前新。
   * 只认 `'available'` 的话，用户点进「关于」Tab（自动 dismiss）之后
   * 按钮会被永久禁用，**从此无法更新** —— 比"红点消不掉"严重得多的功能倒退。
   */
  const updateBtn = el('button', 'acct-btn', '立即更新');
  updateBtn.type = 'button';
  updateBtn.disabled = view.phase !== 'available' && view.phase !== 'dismissed';
  updateBtn.setAttribute('data-testid', 'update-now');
  updateBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.openUpdate();
  });
  box.appendChild(updateBtn);

  const releases = el('button', 'acct-btn ghost', 'GitHub Releases');
  releases.type = 'button';
  releases.setAttribute('data-testid', 'update-releases');
  releases.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.openReleases();
  });
  box.appendChild(releases);

  /**
   * 贡献者。
   *
   * ⚠️ 头像走 `avatars.githubusercontent.com`。B站页面的 CSP 有可能拦掉第三方图片，
   * 所以 `img` 出错时**只隐藏图片保留名字** —— 名字才是必须显示的，头像是修饰。
   */
  if (CONTRIBUTORS.length > 0) {
    box.appendChild(el('p', 'diag-section', '贡献者'));
    const list = el('div', 'contributors');
    for (const person of CONTRIBUTORS) {
      const item = el('button', 'contributor');
      item.type = 'button';
      item.title = `${person.login} · ${String(person.contributions)} commits`;

      const avatar = document.createElement('img');
      avatar.className = 'contributor-avatar';
      avatar.alt = '';
      avatar.loading = 'lazy';
      avatar.src = person.avatarUrl;
      avatar.addEventListener('error', () => {
        avatar.hidden = true;
      });
      item.appendChild(avatar);
      item.appendChild(el('span', 'contributor-name', person.login));

      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        window.open(person.htmlUrl, '_blank', 'noopener,noreferrer');
      });
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  return box;
}

/**
 * popup §2.3「当前页解锁画质」的视图模型 —— 纯函数，零 UI。
 *
 * ## 为什么抽到 core
 *
 * 这一块是"整个 popup 唯一不能省的部分"（`docs/02-ui-spec.md` §2.3），
 * 而它的文案判定比看上去复杂：**"已解锁"是能力声明，"没有提升"是事实陈述**，
 * 两者的分界线一旦画错，这个插件就变成了自我欺骗的装饰。
 *
 * 埋在 TSX 里只能靠肉眼看；抽出来就能用 Vitest 钉死。
 *
 * ## 三条不许
 *
 * 1. 拿不到播放账号侧数据时**不许**猜画质（只说"等待取流"）
 * 2. 拿不到主账号基线时**不许**编一个对比（锚点写"未知"）
 * 3. 两侧相同时**不许**写"已解锁"（那说明这个视频本来就这样，或者代理没生效）
 */

import type { Capability, PageTracksView } from '@shared/types/playinfo';
import { heightLabel, qualityLabels } from '@shared/utils/quality';

/** 徽章上限。规范 §2.3：最多 6 个，超出收成 `+N`，不横向滚动 */
export const MAX_BADGES = 6;

/**
 * 这个 pageKey 是不是普通视频页。
 *
 * 判据是「以 `BV` 开头」，而不是去问 `parsePlayPage()` ——
 * `core/` 不许依赖 URL 解析那类的运行环境细节，而 pageKey 的形状契约
 * 是 `shared/types/playinfo.ts` 写死的：普通视频是 bvid（`BV…`），
 * PGC 是 `ep:` / `ss:` 前缀。
 *
 * ⚠️ 用 `startsWith('BV')` 而不是「不含冒号」之类的反向判据：
 * 反向判据会把将来任何新前缀都算成视频页，而正向前缀错了会立刻被单测抓到。
 */
export function isVideoPage(pageKey: string): boolean {
  return pageKey.startsWith('BV');
}

/**
 * PGC 页（番剧 / 国创 / 电影）的锚点。
 *
 * ## 为什么 PGC 页不做对比（ADR 0024）
 *
 * §2.3 的对比靠「主账号侧基线 vs 播放账号侧」。PGC 页上主账号侧那块数据
 * **拿不到也不该去拿**：
 *
 *   - SSR 的 `__playinfo__` 会被主世界换成播放账号的完整流（ADR 0019），不是基线
 *   - PGC 页面**根本不调** `/pgc/player/web/playurl`，没有可观测的响应
 *   - 想拿到只能以主账号身份主动请求一次，那是越界，不做
 *     （理由见 ADR 0024「为什么不用主账号再取一次」）
 *
 * 所以这里如实说"不提供"，而不是含糊地写「无法对比」——
 * 后者只说明"数据缺"，读起来像加载中，而这其实是**设计上就不做**。
 */
/**
 * PGC 页（番剧 / 国创 / 电影）的锚点：**只写来源，不加解释**。
 *
 * ## ⚠️ 不许补「此处不做主账号对比」（2026-10-29 用户要求删掉）
 *
 * 曾经写「播放账号提供 · 此处不做主账号对比」。那半句是**给开发者看的**：
 * 解释"为什么没有对比"。但用户点开 popup 不是来读设计说明的 ——
 * 他只需要知道"这些画质是谁给的"。多出来的解释占了他 2 秒里的一格注意力，
 * 而回答的是他根本没问过的问题。
 *
 * **"不做对比"这件事本身仍然成立**（ADR 0024），只是不需要在界面上声明：
 * 没有那行「主账号仅可用 X」时，用户自然不会以为自己在看对比。
 */
export const PGC_ANCHOR = '播放账号提供';

/**
 * PGC 页**不显示**的画质徽章。
 *
 * ## 判据不是"低画质"，而是"试看本来就能看"
 *
 * 番剧的试看限制的是**时长**（几分钟就断），**不是分辨率** ——
 * 未登录/无大会员的用户试看时照样能选 1080P。
 *
 * 所以这些档在番剧页标出来**没有任何信息量**：
 *
 * | 徽章 | 试看能不能看 | 结论 |
 * | --- | --- | --- |
 * | `1080P`(80) | 能 | 不标 |
 * | `720P`(64) / `480P`(32) / `360P`(16) | 能 | 不标 |
 * | `1080P+`(112) | —— | 标（高码率是额外价值） |
 * | `1080P60`(116) | —— | 标 |
 * | `HDR`(125) / `4K`(120) / `8K` | 不能 | 标 |
 *
 * ## ⚠️ `'1080P'` 这一项现在是**冗余防御**，但故意留着（2026-10-29）
 *
 * 同一天用户要求从 `BADGE_QUALITY_NAMES` 删掉 `80`(1080P) 与 `116`(1080P60)，
 * 于是 `unlockedBadges()` **再也不会产出 `'1080P'`** —— 这一项过滤的是
 * 一个不会出现的值，字面上已经是死条目。
 *
 * **仍然留着**，理由两条：
 *
 * 1. **它是文档**：这张表回答的是"PGC 页哪些档不该标"，
 *    而 1080P **在 PGC 页确实不该标**（试看就能看）。删掉它会让"为什么
 *    PGC 页没有 1080P"这个问题的答案散落到另一个文件里。
 * 2. **回归保险**：万一 `80` 被加回 `BADGE_QUALITY_NAMES`（比如产品改主意），
 *    删了这里就会让 1080P 徽章在番剧页直接冒出来 —— **而不会有任何测试变红**
 *    （因为它是"过滤一个不存在的值"，删掉它测试照样绿）。
 *
 * 也就是说：**这一项的成本是 0，收益是"将来某个改动不会静默走错"**。
 * 上面那条交叉校验断言（必须能在 `QUALITY_NAMES` 找到）对它仍然成立 ——
 * `QUALITY_NAMES` 里 `80` 还在（它描述的是"这个 id 叫什么"，与"要不要标"无关）。
 *
 * ## 为什么用字符串集合而不是 qid 集合
 *
 * 过滤发生在 `unlockedBadges()` **之后** —— 那一层的输出已经是标签文本，
 * 而 PGC 分支拿不到"哪个标签来自哪个 id"的对应关系。
 * 用标签名过滤的代价是：`QUALITY_NAMES` 改名时这里要一起改。
 *
 * **所以下面加了一条单测交叉校验**：`PGC_HIDDEN_BADGES` 里的每一项
 * 都必须能在 `QUALITY_NAMES` 的值里找到，否则说明改名漂移了。
 */
export const PGC_HIDDEN_BADGES: ReadonlySet<string> = new Set(['1080P', '720P', '480P', '360P']);

/**
 * PGC 页的标题。**是事实陈述，不是能力声明。**
 *
 * 没有基线就没有"提升"可言，所以绝不能说「已解锁」——
 * 那意味着"因为这些画质才有的"，而没有对比就没有这个证据。
 * 说「已取得 4K」只陈述"播放账号这次确实拿到了 4K"。
 *
 * @param label 最高画质的短标签（`4K` / `1080P` …）；空串表示拿不到高度
 */
export function pgcTitle(label: string): string {
  return label ? `已取得 ${label}` : '已取得播放账号的画质';
}

/**
 * 播放账号能力 → 徽章。
 *
 * ## 画质徽章改用 `quality id`（2026-10-29 真机修正）
 *
 * 原来只有 `heightLabel(cap.maxHeight)`，于是**同一高度下的多个档全被折叠成一个**。
 * 真机实测（ss34412）：播放账号拿到了 `112`(1080P 高码率) 和 `125`(HDR 真彩)，
 * 而 popup 只显示一个 `1080P` —— 用户当场指出「我测的这个番剧有 1080P 高码率还有 HDR 真彩」。
 *
 * 现在用 `topQualityIds`（直接从 `dash.video[].id` 取的真实 id）出徽章，
 * 顺序即 B 站画质菜单里的顺序（id 降序）。**取不到 id 才退回高度标签。**
 *
 * ## ⚠️ HDR 这条要分开说
 *
 * 旧注释写"不产出 HDR 徽章，四个可用信号全被证伪"（ADR 0014）。那句针对的是
 * **运行时信号**（`(video-dynamic-range: high)` 之类）—— 它们判断不了。
 * 但 `dash.video[].id === 125` 是**服务端在真实轨道上返回的档位 id**，
 * 与那些信号不是一回事：它只说明"这条轨是 HDR 档"，不声称"你正在看 HDR"。
 *
 * 所以现在只在 `QUALITY_NAMES` 有这个 id 且**该 id 真的出现在 dash 里**时才出徽章。
 * 这是 ADR 0014 的**修订**，理由与边界见 ADR 0026。
 *
 * ⚠️ 帧率用 `maxFrameRateAtTopHeight` 而不是 `maxFrameRate`：
 * "4K 能不能 60fps"和"这个视频最高有没有 120fps"是两个问题。
 */
export function unlockedBadges(cap: Capability | null): string[] {
  if (!cap) return [];

  const out: string[] = [];

  // 画质档：优先用真实 qid（能区分 1080P+ / HDR / 1080P），取不到才退回高度
  out.push(...qualityLabels(cap.topQualityIds, cap.maxHeight));

  // 30fps 是多数视频的默认值，标出来只是噪音（与角标同一判据）
  if (cap.maxFrameRateAtTopHeight >= 50) out.push(`${String(cap.maxFrameRateAtTopHeight)}fps`);
  if (cap.hasHiRes) out.push('Hi-Res');
  if (cap.hasDolbyAudio) out.push('杜比全景声');
  // 语义是"本视频提供杜比视界版本"，不是"当前在播"（ADR 0014）
  if (cap.providesDolbyVision) out.push('杜比视界');

  return out.slice(0, MAX_BADGES);
}

export interface UnlockSummary {
  /** 主文案：`已解锁` / `没有提升` / `无法对比` / `等待取流…` */
  title: string;
  /** 徽章（可能为空） */
  badges: string[];
  /** 锚点小字：`主账号仅可用 1080P` / `主账号基线未知` */
  anchor: string;
  /** 是否真的比主账号强。`false` 时标题不会是"已解锁" */
  improved: boolean;
}

/** 锚点小字 —— 价值锚点，没有它用户感受不到插件做了什么 */
function anchorText(view: PageTracksView): string {
  if (!isVideoPage(view.pageKey)) return PGC_ANCHOR;

  /**
   * ⚠️ **未登录主账号时，锚点不能说"仅可用 480P"。**
   *
   * 那句话读起来像"你这个号只有 480P"，而真实原因是"没有号"。
   * 而且游客态两侧都是 480P，`diff` 会判成"两侧相同"，
   * 于是标题落到「无提升（源限制）」—— 双重误导。
   */
  if (view.primary.loggedIn === 'no') return '主账号未登录，无对比基线';

  const cap = view.primary.capability;
  if (view.primary.usable && cap) {
    const label = heightLabel(cap.maxHeight);
    return label ? `主账号仅可用 ${label}` : `主账号仅可用 ${String(cap.maxHeight)}p`;
  }

  // 基线不可用时如实说"未知"，并区分原因 —— 否则用户和开发者都无从判断
  switch (view.primary.reason) {
    case 'client-written':
      return '主账号基线不可用（数据来源是播放账号）';
    case 'absent':
      return '主账号基线未知（本页没有 SSR 数据）';
    case 'unparsable':
      return '主账号基线未知（数据解析失败）';
    case 'ssr':
      return '主账号基线未知';
  }
}

/**
 * 生成 §2.3 的视图。
 *
 * @param view content 报来的当前页数据；`null` 表示不是视频页 / 还没报到
 * @param proxyEnabled 总开关是否开着。**`false` 时返回 `null`，整块画质区不渲染**
 *   （2026-10-29 用户要求，见下面那段注释）
 * @returns `null` 时 popup 不渲染画质卡
 */
export function describeUnlock(
  view: PageTracksView | null,
  proxyEnabled = true,
): UnlockSummary | null {
  if (!view) return null;

  /**
   * ## 关掉总开关后，这条整块不显示（2026-10-29 用户要求）
   *
   * 原来的问题是：开关关了以后 popup 仍然显示
   * 「主账号基线未知（本页没有 SSR 数据）· 1080P」——
   * 而那时**根本没有在代理**，这行字描述的是一个不存在的东西。
   * 它既不是画质对比，也不是错误，纯粹是噪音。
   *
   * 用户的原话是要求"直接去掉，不要显示画质对比区"。
   *
   * ## ⚠️ 为什么返回 `null` 而不是调一个新的"空视图"
   *
   * `null` 在本函数里原来只表示"不是播放页"。现在多一个含义"开关关着"。
   * **两者在 UI 上的处理相同**（都不渲染画质卡），所以不需要区分 ——
   * popup 只需要知道"画这张卡吗"。
   *
   * 但**它们不该共用一句话**。原来非播放页会显示「打开任意视频页查看效果」，
   * 那是给"你在首页"用的提示。开关关着时**什么都不能显示**：
   * 用户刚亲手关的开关，再弹一句"去视频页看看"是在装傻。
   * 所以调用方（`popup/main.tsx`）**不再根据 `null` 反推文案**，
   * 而是：非播放页根本进不到这里（它先判 `page.kind`）→ 什么都不渲染。
   *
   * 判据传参而不是在这里读存储：`core/` 不许碰 `chrome.*`（AGENTS §5.2）。
   */
  if (!proxyEnabled) return null;

  const playback = view.playback?.capability ?? null;
  const anchor = anchorText(view);

  // 播放账号侧还没数据：**绝不猜画质**
  if (!playback) {
    return { title: '等待取流…', badges: [], anchor, improved: false };
  }

  const badges = unlockedBadges(playback);

  /**
   * ## PGC 页走这条（ADR 0024）—— 排在所有对比判断之前
   *
   * PGC 页没有主账号基线，`diff` 恒为 `null`。若不在这里拦住，会落到下面的
   * 「无法对比」—— 那句话读起来像"还没加载完"，而真相是**设计上就不做对比**。
   *
   * 但也不能说「已解锁」：那是能力声明，没有对比就没有证据。
   * 所以陈述事实：「已取得 4K」+ 锚点只写来源。
   *
   * ## ⚠️ PGC 页的徽章要过滤掉 1080P 及以下（2026-10-29 用户要求）
   *
   * **番剧的试看本来就能看 1080P**（用户确认；B 站的试看限制是**时长**，不是分辨率）。
   * 所以在番剧页标一个 `1080P`，等于告诉用户"你能看 1080P"——
   * 那是他没有插件也能做到的事，**是废话，不是价值证明**。
   *
   * PGC 页的徽章只有一种用途：说明播放账号这次**额外**拿到了哪些档。
   * 见 `PGC_HIDDEN_BADGES`。
   */
  if (!isVideoPage(view.pageKey)) {
    const meaningful = badges.filter((b) => !PGC_HIDDEN_BADGES.has(b));

    /**
     * 标题也只报**过滤后剩下的最高档**。
     *
     * ⚠️ 不能直接取 `qualityLabels(...)[0]` —— 那一项可能正是被过滤掉的 `1080P`，
     * 于是出现"徽章全空、标题却写已取得 1080P"的矛盾。
     *
     * 全都被过滤光时（播放账号也只拿到 1080P 及以下）：
     * 标题退回 `pgcTitle('')`，即「已取得播放账号的画质」——
     * **不编一个具体档位出来**。
     */
    const topLabel = qualityLabels(playback.topQualityIds, playback.maxHeight).find(
      (l) => !PGC_HIDDEN_BADGES.has(l),
    );

    return {
      title: pgcTitle(topLabel ?? ''),
      badges: meaningful,
      anchor,
      improved: false,
    };
  }

  // 「已解锁」是事实陈述：两侧能比、且播放账号更强，就先说这个（与登录状态无关）
  if (view.diff?.improved) {
    return { title: '已解锁', badges, anchor, improved: true };
  }

  /**
   * 未登录主账号 → 排在「无法对比」之前。
   *
   * 有实测依据：**游客页根本没有 `__playinfo__`**（2026-10-26 InPrivate 实测，
   * 见 `poc/verify/RESULT.md` §六），所以游客态的 `diff` 恒为 null。
   * 若按"先判 diff"的顺序会显示「无法对比」—— 那句话只说明"数据缺"，
   * 不告诉用户"该去登录"，而登录是他唯一能做的动作。
   */
  if (view.primary.loggedIn === 'no') {
    return { title: '未登录主账号', badges, anchor, improved: false };
  }

  // 没有对比就没有"已解锁" —— 只能陈述事实
  if (!view.diff) {
    return { title: '无法对比', badges, anchor, improved: false };
  }

  /**
   * 没有提升有两种可能，**必须分开说**：
   *   - 主账号本来就能拿到同样的画质 → 视频源限制
   *   - 代理没生效（两个身份拿到的一样）→ 用户该去查开关
   * 判据是两侧能力是否完全相同；相同就说"源限制"，不同（播放账号更弱）就是异常。
   *
   * （"未登录主账号"已在函数前段拦掉，不会走到这里。）
   */
  const primaryCap = view.primary.capability;
  const same =
    primaryCap !== null &&
    primaryCap.maxHeight === playback.maxHeight &&
    primaryCap.hasHiRes === playback.hasHiRes;

  return {
    title: same ? '无提升（源限制）' : '没有提升',
    badges,
    anchor,
    improved: false,
  };
}

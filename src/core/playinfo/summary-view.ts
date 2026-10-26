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
import { heightLabel } from '@shared/utils/quality';

/** 徽章上限。规范 §2.3：最多 6 个，超出收成 `+N`，不横向滚动 */
export const MAX_BADGES = 6;

/**
 * 播放账号能力 → 徽章。
 *
 * ⚠️ **不产出 HDR 徽章。** 四个可用信号全被实测证伪
 * （见 `src/content/isolated/badge-content.ts` 的"HDR 徽章已移除"注释与 ADR 0014）。
 *
 * ⚠️ 帧率用 `maxFrameRateAtTopHeight` 而不是 `maxFrameRate`：
 * "4K 能不能 60fps"和"这个视频最高有没有 120fps"是两个问题。
 */
export function unlockedBadges(cap: Capability | null): string[] {
  if (!cap) return [];

  const out: string[] = [];

  const height = heightLabel(cap.maxHeight);
  if (height) out.push(height);

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
 * @returns `null` 时 popup 该显示"打开任意视频页查看效果"
 */
export function describeUnlock(view: PageTracksView | null): UnlockSummary | null {
  if (!view) return null;

  const playback = view.playback?.capability ?? null;
  const anchor = anchorText(view);

  // 播放账号侧还没数据：**绝不猜画质**
  if (!playback) {
    return { title: '等待取流…', badges: [], anchor, improved: false };
  }

  const badges = unlockedBadges(playback);

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

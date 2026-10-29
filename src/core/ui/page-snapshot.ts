/**
 * 把 `pageState` 的原始数据算成 popup 快照 —— **纯函数，无 DOM / 无 chrome API**。
 *
 * ## 为什么单独一个文件
 *
 * `page/snapshot:get` 的应答要跨三层（content 取数 → core 算 → shared 组装）。
 * 如果这三步都挤在 `entrypoints/content.ts` 里，**一行都测不到** ——
 * 而快照本身就是给自动化断言用的，它自己不可测就没有意义。
 *
 * 所以分层：
 *   - **本文件**：输入全由参数给，输出是可断言的对象
 *   - `content.ts`：只负责取数（`sendToBackground`）与调这里
 *
 * ## ⚠️ 判据必须与 popup 完全同源
 *
 * 这里**调的是 popup 用的同一个函数**：`describePopup` / `describeUnlock` /
 * `resolvePrimaryCard`。绝不自己写一份 `if`。
 *
 * 唯一刻意的差异：**缓存兜底传 `null`**（见 `buildPageSnapshot` 的注释）。
 */

import { describeUnlock } from '@core/playinfo/summary-view';
import { describePopup, type PopupAccount, type PopupSnapshot } from '@core/ui/popup-state';
import type { PageTracksView } from '@shared/types/playinfo';
import { resolvePrimaryCard, type PrimaryCard } from '@shared/utils/primary-card';
import type { PopupSnapshotReply } from '@shared/types/messages';
import { buildPopupSnapshot } from '@shared/utils/popup-snapshot';

/** 账号摘要（`AccountSummary` 的安全子集 —— **不含任何凭据**） */
export interface SnapshotAccount {
  uname: string;
  mid: number;
  vipLabel: 'none' | 'monthly' | 'annual';
  expireAt: number | null;
  healthy: boolean;
}

export interface BuildPageSnapshotInput {
  /** `pageState.view()` 的结果；`null` = 不是播放页 / 还没报到 */
  pageView: PageTracksView | null;
  /** `proxy/status` 的字段 */
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number };
  /** `account/summary` 的账号；`null` = 未配置 / 读不出来 */
  account: SnapshotAccount | null;
  /**
   * 缓存里的主账号显示档案；**默认 `null`**。
   *
   * content script 读得到 `storage.local`（它有扩展 API），但**刻意不读**：
   * 快照要回答的是"这个页面此刻的实时状态"，而缓存兜底是 popup 在
   * "实时还没到"时的补位。把两者混进一个字段会让"主账号显示对不对"这件事
   * 无法归因（到底是实时拿到的，还是缓存的？）。
   * 需要看缓存态时看 `primary.source` 与 popup 截图对照。
   */
  cached: { uname: string; level: number | null } | null;
}

/**
 * 把页面数据算成 popup 快照。
 *
 * @param input 全部输入
 * @returns 可直接 `JSON.stringify` 的快照（**不含凭据**）
 */
export function buildPageSnapshot(input: BuildPageSnapshotInput): PopupSnapshotReply {
  const { pageView, proxy, account, cached } = input;

  /**
   * `PopupSnapshot` 的形状与 popup 的 `snap` 一致。
   * `buckets` 传空数组 —— 成功率条形图不在快照的验收范围里，
   * 而多取一次 `stats/recent` 会让快照慢一截。
   */
  const popupSnap: PopupSnapshot = {
    proxy,
    configured: account !== null || proxy.hasCredential,
    account: account ? toPopupAccount(account) : null,
    buckets: [],
    page: pageView ? { kind: 'play' } : { kind: 'other' },
  };

  const popupView = describePopup(popupSnap);

  const cardPage = pageView
    ? {
        kind: 'play' as const,
        primary: {
          uname: pageView.primary.user?.uname ?? null,
          level: pageView.primary.user?.level ?? null,
          loggedIn: pageView.primary.loggedIn,
        },
      }
    : ({ kind: 'other' } as const);

  const primary: PrimaryCard = resolvePrimaryCard(cardPage, cached);

  /**
   * 画质区：**判据与 popup 同一处**（`describeUnlock` 自己处理"开关关着 → null"）。
   */
  const unlock = describeUnlock(pageView, proxy.enabled);

  return buildPopupSnapshot({
    view: {
      state: popupView.state,
      pill: popupView.pill,
      tone: popupView.tone,
      ...(popupView.line ? { line: popupView.line } : {}),
      needsLogin: popupView.needsLogin,
    },
    primary,
    playbackAccount: account,
    unlock: unlock
      ? {
          title: unlock.title,
          badges: [...unlock.badges],
          anchor: unlock.anchor,
          improved: unlock.improved,
        }
      : null,
    page: {
      kind: pageView ? 'play' : 'other',
      pageKey: pageView?.pageKey ?? null,
      p: pageView?.p ?? null,
    },
    proxy,
  });
}

/**
 * `SnapshotAccount` → `PopupAccount`（`core/ui/popup-state.ts` 的形状）。
 *
 * 两边的字段名不同（`healthy` vs `health.healthy`），这一层负责转换。
 * 之所以不直接把 `PopupAccount` 用作快照类型：快照是**对外契约**，
 * 不应随 `core` 的内部结构调整而变。
 *
 * @param a 账号摘要
 */
function toPopupAccount(a: SnapshotAccount): PopupAccount {
  return {
    uname: a.uname,
    mid: a.mid,
    vipLabel: a.vipLabel,
    expireAt: a.expireAt,
    healthy: a.healthy,
    // `checkedAt` / `reason` 只驱动「多久前检查过」这类文案，
    // 快照不关心；给固定值以免被误读成"刚刚检查过"。
    checkedAt: 0,
    reason: null,
  };
}

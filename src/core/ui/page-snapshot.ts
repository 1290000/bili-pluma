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
import type { PopupSnapshotReply, ProxyActivateReason } from '@shared/types/messages';
import type { StreamingIdentity } from '@shared/constants/streaming-identity';
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
  /**
   * 最近一次 `page/activate` 的 reason。
   *
   * ## 为什么这个字段必须存在（否则步骤 2/3 全是死代码）
   *
   * 链路是四环：
   *
   * ```
   * page/activate 回包 reason
   *   → entrypoints/content.ts      pageState.setProxyIdentity(reason)   ✅
   *   → page-state.ts               view() 产出                          ✅
   *   → page-snapshot.ts            ← 这里。缺这一环则下面永远拿不到
   *   → popup-state.describePopup   selfIdentity() / 基线文案
   * ```
   *
   * 少了它，`lastActivateReason` 恒为 `undefined` → popup 永远走兼容分支显示
   * 「已接管」，而真机上"取流号就是这个号"这件事**一个字都不会被说出来**。
   * 类型能过、单测能过（测试直接注入该字段），真机上是死代码 ——
   * 与本文件注释里"判据必须与 popup 完全同源"的纪律同一类问题。
   *
   * ## 缺省 `undefined` 的含义
   *
   * = "调用方没给 / 这次还不知道"。此时**不带**该字段进快照，
   * popup 走既有判据。
   *
   * ⚠️ **不许在这里默认成 `'ok'`**：那是拿未知冒充结论。
   * 也不知道就等于不知道，与 `'unknown'` 同义（见下面的收敛说明）。
   *
   * ## ⚠️ 取值域**派生自** `ProxyActivateReason`（2026-11-11 改）
   *
   * 这里曾手抄一份字面量联合，加 `'page-identity'` 时漏改，
   * 而 `tsc` **没报错** —— 因为该字段当时还没有生产调用方，
   * "两边一起错"互相抵消了。一接上就会把新 reason 静默吞成「已接管」→ 谎报扩展在工作。
   * 现在一律用 `import type`，新增 reason 自动跟上。
   */
  lastActivateReason?: ProxyActivateReason | 'unknown' | null | undefined;
  /**
   * 用户选的取流身份（2026-11-11，步骤 6 段 1）。
   *
   * ⚠️ **本文件只负责透传，不在这里算判据** —— 判据在
   * `isStreamingReady()`，消费方是 `popup-state.describePopup()`。
   *
   * 为什么必须有这一环：`page-snapshot` 是 `content.ts` → `popup` 的唯一数据通道，
   * 缺它则 `popup-state.ts` 里 `page` 身份的短路分支永远拿不到输入 → **死代码**。
   * 与本文件 `lastActivateReason` 注释里记的"四环链路"是同一类风险。
   */
  streamingIdentity?: StreamingIdentity | null;
}

/**
 * 把页面数据算成 popup 快照。
 *
 * @param input 全部输入
 * @returns 可直接 `JSON.stringify` 的快照（**不含凭据**）
 */
export function buildPageSnapshot(input: BuildPageSnapshotInput): PopupSnapshotReply {
  const { pageView, proxy, account, cached, lastActivateReason, streamingIdentity } = input;

  /**
   * ## 在**边界处**把 `'unknown'` / `'same-account'` 收敛掉，不让它们漏进纯函数
   *
   * ### 为什么收敛 `'unknown'`
   *
   * `PopupSnapshot.lastActivateReason` 的取值域**不含** `'unknown'`，而且不需要含：
   * 在 popup 里，`'unknown'` 的行为与"没给"**完全一致**（都不改变判据）。
   * 多一个值只会让 `describePopup` 多一条永远等不到的分支。
   *
   * **"未表态"不该被塞进纯函数** —— 那会让下一个读 `describePopup` 的人
   * 以为 `snap.lastActivateReason` 可能是 `'unknown'`，进而写出多余的分支。
   *
   * ### 为什么收敛 `'same-account'`（旧名）
   *
   * ## ✅ 2026-11-11 清理：`'same-account'` 兼容分支已删除
   *
   * 步骤 2 已把该值改名为 `'self'` 且全量通过，`messages.ts` 的
   * `ProxyActivateReason` 里不再有旧名 —— 所以这里也不需要收敛了。
   *
   * 现在只剩一件事：把 `'unknown'`（"回包没来"）收敛成 `undefined`，
   * 因为 `'unknown'` 在 popup 里的行为与"没给"完全一致（都不改变判据），
   * 多传一个值只会让 `describePopup` 多一条永远等不到的分支。
   * **在边界处收敛"未表态"，别把它漏进纯函数。**
   */
  const reasonForPopup = lastActivateReason === 'unknown' ? undefined : lastActivateReason;

  /**
   * `PopupSnapshot` 的形状与 popup 的 `snap` 一致。
   * `buckets` 传空数组 —— 成功率条形图不在快照的验收范围里，
   * 而多取一次 `stats/recent` 会让快照慢一截。
   */
  const popupSnap: PopupSnapshot = {
    proxy,
    /**
     * ⚠️ **只透传，不在这里写判据**（2026-11-11，步骤 6 段 1）。
     *
     * `configured` 与 `streamingIdentity` 的判据只有一处：
     * `isStreamingReady()`（`@shared/constants/streaming-identity`），
     * 由 `popup-state.ts` 消费。本文件是**数据组装层**，
     * 在这里再算一遍就是第二处判据 —— 必然在某次改动后与 popup 分裂。
     *
     * `configured` 仍按"任一来源为真"透传，理由与 `panel-data.ts` 同：
     * `account.configured` 来自 background 的权威回答（那边也已改用同一判据）。
     */
    configured: account !== null || proxy.hasCredential,
    account: account ? toPopupAccount(account) : null,
    buckets: [],
    page: pageView ? { kind: 'play' } : { kind: 'other' },
    ...(streamingIdentity != null ? { streamingIdentity } : {}),
    ...(reasonForPopup !== undefined ? { lastActivateReason: reasonForPopup } : {}),
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

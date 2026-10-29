/**
 * popup 快照的**组装逻辑** —— 纯函数，无 DOM / 无 chrome API。
 *
 * ## 为什么要有这个文件（2026-10-29）
 *
 * `chrome-extension://` 页面被 bsk 的 Agent Window sandbox 拒绝 `evaluate`，
 * 所以 popup 渲染成什么样**只能靠用户手点截图**。每个 UI bug 都要用户配合一轮。
 *
 * `page/snapshot:get` 把"popup 会渲染成什么"变成可读 JSON。但**组装逻辑必须可测**——
 * 否则快照本身就是新的 bug 来源（它会和真实渲染悄悄漂移）。
 *
 * 所以：**"怎么组装"在这里（纯函数 + 单测），"去哪取数"在 `entrypoints/content.ts`**。
 *
 * ## ⚠️ 与真实渲染的漂移是本文件唯一的风险
 *
 * 快照是 popup 渲染的**参考实现**，不是它的依赖（popup 不调这里）。
 * 两者的输入相同：`PopupSnapshot`（`describePopup` 的原料）+ `PageView` +
 * `PrimaryCard` + `UnlockSummary`。
 *
 * 漂移的典型形态：popup 改了文案规则，这里没改 → 快照说"A"、界面显示"B"，
 * 于是自动化报了一个不存在的 bug。防法是**文案规则本身尽量放在纯函数里**
 * （`primaryPlaceholder` / `describeUnlock` / `describePopup` 都是），
 * 这里只做"拼装"，不自己发明任何判据。
 */

import type { PopupSnapshotReply } from '@shared/types/messages';
import type { PrimaryCard } from '@shared/utils/primary-card';
import { primaryPlaceholder } from '@shared/utils/primary-card';

/** `describePopup()` 的产出（`core/ui/popup-state.ts`） */
export interface SnapshotView {
  state: string;
  pill: string;
  tone: string;
  line?: string;
  needsLogin: boolean;
}

/** `describeUnlock()` 的产出（`core/playinfo/summary-view.ts`） */
export interface SnapshotUnlock {
  title: string;
  badges: string[];
  anchor: string;
  improved: boolean;
}

/** popup 渲染所需的全部输入，原样传进来 */
export interface SnapshotInput {
  /** `null` = 拿不到 `proxy/status` */
  view: SnapshotView | null;
  primary: PrimaryCard;
  /** 播放账号摘要（**不含凭据**） */
  playbackAccount: {
    uname: string;
    mid: number;
    vipLabel: 'none' | 'monthly' | 'annual';
    expireAt: number | null;
    healthy: boolean;
  } | null;
  /** `describeUnlock()` 的结果。已包含"开关关着 → null"的判据 */
  unlock: SnapshotUnlock | null;
  page: { kind: 'play' | 'other'; pageKey: string | null; p: number | null };
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number };
}

/**
 * 把渲染输入拼成快照。
 *
 * **不做任何新的判断** —— 每个字段都直接取自调用方算好的结果
 * （`describePopup` / `describeUnlock` / `resolvePrimaryCard`）。
 * 这里唯一的"逻辑"是把 `texts` 那几行拼出来方便断言，
 * 而拼法必须与 `popup/main.tsx` 的 JSX 一致。
 *
 * @param input 渲染输入
 * @returns 可直接 `JSON.stringify` 的快照
 */
export function buildPopupSnapshot(input: SnapshotInput): PopupSnapshotReply {
  const { view, primary, playbackAccount, unlock, page, proxy } = input;

  /**
   * 主账号栏那一行 —— 与 `popup/main.tsx` 的
   * `{primaryUname || primaryPlaceholder(page.kind, primaryLoggedIn)}` 完全一致。
   */
  const primaryLine = primary.uname ?? primaryPlaceholder(page.kind, primary.loggedIn);

  /**
   * 画质卡那一行。**`null` 表示不渲染整块**（不是播放页 / 还没数据 / 开关关着）。
   *
   * 拼法对齐 JSX：标题在左、锚点在右，中间一个空格。
   * 徽章不拼进来 —— 它们在 `unlock.badges` 里，机器可读，不必塞进一句话。
   */
  const unlockLine = unlock ? `${unlock.title} · ${unlock.anchor}` : null;

  return {
    view: view ? { ...view } : null,
    primary: {
      uname: primary.uname,
      level: primary.level,
      loggedIn: primary.loggedIn,
      source: primary.source,
      /**
       * ⚠️ **这是"没有昵称时会显示什么"，不是"现在显示什么"**（2026-10-29 澄清）。
       *
       * 真机实测踩到的误读：番剧页 `uname` 有值（缓存兜底成功）而
       * `placeholder: "读取中…"` —— 两者并存看着矛盾，其实各答一件事：
       *   - `primaryLine`：**当前实际渲染的那一行**
       *   - `placeholder`：`uname` 为 null 时才用它
       *
       * 所以要判断"主账号栏现在显示什么"，**看 `texts.primaryLine`**，
       * 不要看 `placeholder`。保留这个字段是为了能单独验
       * "没有昵称时的兜底文案对不对"（那是 `primaryPlaceholder` 的职责）。
       */
      placeholder: primaryPlaceholder(page.kind, primary.loggedIn),
    },
    playbackAccount,
    unlock: unlock ? { ...unlock, badges: [...unlock.badges] } : null,
    page,
    proxy,
    texts: { primaryLine, unlockLine },
  };
}

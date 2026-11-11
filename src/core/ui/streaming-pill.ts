/**
 * 取流身份胶囊 —— **纯函数，零 DOM、零 chrome API**（2026-11-11，步骤 4）。
 *
 * 面板账号卡上那个二态胶囊的文案判定。抽成纯函数是因为：
 *   - `tabs.ts` 是 DOM 代码，Vitest 覆盖不到；而"胶囊该说什么"是**判据**，
 *     判错的后果是让用户以为配置没生效
 *   - 接线可以晚做，判据必须先钉住
 *
 * ## 两个状态都是"正常"，没有一个需要报警
 *
 * | 选择 | 胶囊 | 用户看到的意思 |
 * | --- | --- | --- |
 * | `extension` | 「取流：**扩展**账号」 | 扩展用托管那个号取流 |
 * | `page` | 「取流：**浏览器**账号」 | 扩展不介入，页面自己取流 |
 *
 * ## 为什么是「扩展账号」而不是「取流账号」（2026-11-11 定稿）
 *
 * 三个词的关系必须说清，否则会读成同义反复：
 *
 * | 词 | 是什么 | 用在哪 |
 * | --- | --- | --- |
 * | **取流账号** | **身份名词**：当前被指定为"负责取流"的那个账号 | 术语纠错后的通用说法（取代"播放账号"） |
 * | **扩展账号** | **来源限定**：凭据存在扩展 vault 里的账号 | 与"浏览器账号"对偶 |
 * | **浏览器账号** | **来源限定**：浏览器自己登录的那个号 | 与"扩展账号"对偶 |
 *
 * 「取流账号」回答"**谁负责取流**"；「扩展账号 / 浏览器账号」回答"**它从哪来**"。
 * 所以胶囊写「取流：扩展账号」——前面是职责，后面是来源，**不是同义反复**。
 * 若写成「取流：取流账号」，职责说了两遍，来源反而没说。
 *
 * ⚠️ 所以 `docs/02-ui-spec.md` 里"取流账号"这个术语**不需要改**：
 * 它仍是身份名词，只是胶囊特意用了更具体的来源限定词。
 *
 * ⚠️ **不能说「已停用」**。`page` 是用户选的**合法身份**，不是停用功能；
 * 总开关在 `page` 模式下仍然算"开"（见 `dnr.switchStreamingIdentity`）。
 * 说成"停用"会让用户以为要重新开启，而他从没关过任何东西。
 *
 * ## 与 popup 胶囊的关系（**两个界面必须说同一件事**）
 *
 * | 界面 | 位置 | 文案来源 |
 * | --- | --- | --- |
 * | 面板账号卡 | 取流账号卡上的二态胶囊 | 本文件的 `describeStreamingIdentity()` |
 * | popup 状态胶囊 | 顶部状态 | `core/ui/popup-state.ts` 的 `selfIdentity()` / `pageIdentity()` |
 *
 * 两者**不是同一句话**（面板说"怎么配的"，popup 说"现在生效了吗"），
 * 但它们必须**不矛盾**：面板说「取流：浏览器账号」时，popup 就不许说「已接管」。
 * 哪天出现矛盾，就说明有一处改漏了 —— 这正是拆成两个界面的价值。
 */

import type { ProxyActivateReason } from '@shared/types/messages';

import type { StreamingIdentity } from '@shared/constants/streaming-identity';

/** 胶囊的渲染原料 */
export interface StreamingIdentityPill {
  /** 胶囊文字。短，不解释 */
  label: string;
  /** 是否有强调色。`extension` = 扩展在干活（信息色），`page` = 中性 */
  accent: boolean;
  /**
   * 是否需要立即提醒用户「改了要刷新页面才生效」。
   *
   * 只有在**当前页实际行为与选择不一致**时才为 true —— 见 `needsReloadHint()`。
   */
  stale: boolean;
}

/** 选择 → 胶囊文案。**不解释、不判断对错**，只陈述配置 */
export function describeStreamingIdentity(identity: StreamingIdentity): StreamingIdentityPill {
  if (identity === 'page') {
    return {
      label: '取流：浏览器账号',
      // 中性色：这是一个合法选择，不该用"扩展在工作"的信息色去暗示它更好
      accent: false,
      stale: false,
    };
  }
  return { label: '取流：扩展账号', accent: true, stale: false };
}

/**
 * 当前页的实际行为是否与用户的选择不一致 —— 需要提示"刷新后生效"。
 *
 * ## 为什么必须提示，而不是假装立即生效
 *
 * `playurl` **只在页面加载和切 P 时调一次**（`docs/03` Q3 实测）。
 * 用户切了取流身份之后，已打开的视频页**不会**自动改变画质 ——
 * 它的流早就取回来了。不提示的话，用户会以为切换没生效，反复去点。
 *
 * 这与 `proxy/affected-tabs` 那条提示是同一个道理，只是触发源不同。
 *
 * @param identity 用户的选择
 * @param lastActivateReason 本页最近一次 `page/activate` 的 reason；`undefined` = 还不知道
 * @returns 该不该提示刷新
 */
export function needsReloadHint(
  identity: StreamingIdentity,
  lastActivateReason: ProxyActivateReason | 'unknown' | undefined,
): boolean {
  /**
   * ⚠️ **不知道就不提示**。
   *
   * 拿不到 `page/activate` 回包（SW 休眠 / context invalidated / 超时）时，
   * "本页现在用哪个身份"是未知的。此时提示"刷新后生效"是在**编造一个结论** ——
   * 用户刷新了却发现本来就对，会认为这个提示是噪音。
   *
   * 这与 `page-state.ts` 把 `'unknown'` 当一等值、且"什么都不改变"是同一条纪律。
   */
  if (lastActivateReason === undefined || lastActivateReason === 'unknown') return false;

  const currentlyProxying = lastActivateReason === 'ok';

  /**
   * `extension` 模式下，能证明"代理确实装着"的只有 `'ok'`。
   * 其余 reason（`self` / `page-identity` / `disabled` / `error` / `not-configured`）
   * 都意味着**当前页没有换身份** → 与选择不一致 → 提示刷新。
   */
  if (identity === 'extension') return !currentlyProxying;

  /**
   * `page` 模式：只有 `'ok'` 表示"当前页还在换身份"（改之前打开的老页面）
   * → 需要刷新才能回到浏览器身份。
   */
  return currentlyProxying;
}

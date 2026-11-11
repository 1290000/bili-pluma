/**
 * **规则装配的计划层** —— 从"完整状态"推导"应该装哪些规则"。
 *
 * ## 为什么需要这一层（2026-11-11 的结构性修复）
 *
 * 修之前，规则装载是**由动作驱动**的：
 * ```
 * enableProxy()            → 装全部白名单路径
 * switchStreamingIdentity() → 清空 → 按新身份重建（但**不知道**推荐流开关的存在）
 * ```
 *
 * 于是"开关开着 → 切取流身份"会把推荐流那条规则**悄悄清掉** ——
 * 开关看着是开的、实际没生效。**这正是本项目反复出现的
 * 「界面说在工作、实际没工作」。**
 *
 * **如果只是"在 switch 里补一句重建推荐流规则"，将来加第三个独立开关时又会漏一次。**
 *
 * ## 正确做法：状态推导
 *
 * 本模块的 `buildRulePlan(state)` 是**纯函数**：输入完整状态，输出完整计划。
 * 任何"状态变了"的入口（切身份 / 拨推荐流开关 / 登录 / 登出）
 * **都调同一个函数**，不再各写一份"补一句"。
 *
 * ```
 * state = { streamingIdentity, feedAccountEnabled, hasCredential }
 *          ↓ buildRulePlan()
 * plan  = { feedStreaming: boolean, feedAccount: boolean }
 *          ↓ applyRulePlan()
 * 实际装/删哪些规则
 * ```
 *
 * ## 两个"身份槽"
 *
 * | 槽 | 管什么 | 由谁决定 |
 * | --- | --- | --- |
 * | `feedStreaming` | 取流路径（playurl 族）用谁的凭据 | `streamingIdentity` |
 * | `feedAccount` | **首页推荐流**（`feed/rcmd`）用谁的凭据 | **推荐流开关**（与上者独立） |
 *
 * ⚠️ **两者完全独立**是产品需求（用户原话）：
 * 「首页推荐流的变化与取流身份是完全独立的两个功能」。
 */

import type { StreamingIdentity } from '@shared/constants/streaming-identity';

/** 首页推荐流路径 —— 单独占一个规则槽，不进主白名单的 ID 段 */
export const FEED_RCMD_PATH = '/x/web-interface/wbi/index/top/feed/rcmd';

/** 规则装配的**完整输入状态** */
export interface RuleState {
  /** 取流身份（决定 playurl 族用谁的凭据） */
  streamingIdentity: StreamingIdentity;
  /** 首页推荐流是否使用扩展账号（**独立开关**，与 `streamingIdentity` 无关） */
  feedAccountEnabled: boolean;
  /** vault 里有没有凭据 —— 没有的话两个槽都装不了 */
  hasCredential: boolean;
}

/** 规则装配的**计划**（要装哪些槽） */
export interface RulePlan {
  /** 取流路径是否用扩展账号凭据 */
  feedStreaming: boolean;
  /** 首页推荐流是否用扩展账号凭据 */
  feedAccount: boolean;
}

/**
 * **从完整状态推导计划** —— 纯函数，零 IO。
 *
 * ## 判据表
 *
 * | `hasCredential` | `streamingIdentity` | `feedAccountEnabled` | `feedStreaming` | `feedAccount` |
 * | --- | --- | --- | --- | --- |
 * | `false` | 任意 | 任意 | ❌ | ❌ |
 * | `true` | `'page'` | `false` | ❌ | ❌ |
 * | `true` | `'page'` | **`true`** | ❌ | **✅** |
 * | `true` | `'extension'` | `false` | **✅** | ❌ |
 * | `true` | `'extension'` | **`true`** | **✅** | **✅** |
 *
 * ## 三条关键判据
 *
 * 1. **`hasCredential === false` 时两个槽都不装** —— 没有凭据就没有"扩展账号"
 *    可言。"推荐流开关可点"的前提就是 `hasCredential`（开关 UI 用它做可点性），
 *    所以正常路径下不会出现"开关开着但没凭据"，但**这里是最后一道闸**：
 *    凭据可能在开关打开后被清掉（退出账号）。
 *
 * 2. **`feedAccount` 只看 `feedAccountEnabled`，完全不看 `streamingIdentity`** ——
 *    这是产品需求「两个功能独立」的直接实现。
 *    **不要"顺手"加上 `&& streamingIdentity === 'extension'`**。
 *
 * 3. **`feedStreaming` 只看 `streamingIdentity`** —— 推荐流开关不影响取流。
 *    若推荐流开关打开时顺便改取流身份，用户会看到"我只是想换推荐，怎么画质变了"。
 */
export function buildRulePlan(state: RuleState): RulePlan {
  // ① 没有凭据 → 两个槽都装不了
  if (!state.hasCredential) {
    return { feedStreaming: false, feedAccount: false };
  }

  return {
    // ② 取流槽：只看取流身份
    feedStreaming: state.streamingIdentity === 'extension',
    // ③ 推荐流槽：**只看推荐流开关**（与取流身份无关）
    feedAccount: state.feedAccountEnabled,
  };
}

/**
 * 把计划转成"要装哪些业务路径"。
 *
 * ## 为什么推荐流路径**不**在 `ENABLED_ROUTE_PATHS` 里重复出现
 *
 * `routes.ts` 的白名单里**有** `feed/rcmd`（ADR 0035 加的）。所以：
 *   - `feedStreaming === true` 时，白名单里的 `feed/rcmd` **会跟着被装**
 *   - `feedAccount === false` 时必须把它**排除**掉，否则取流身份为
 *     `extension`、推荐流开关关着时，推荐流仍会被换成扩展账号 —— **开关失效**
 *
 * **这正是 `excludePaths` 存在的理由**，也是本函数要返回"排除项"而不是
 * 只返回"要装的路径"的原因。
 */
export interface PathPlan {
  /** 要装进 `feedStreaming` 那一套的路径（已排除推荐流） */
  streamingPaths: readonly string[];
  /** 推荐流是否单独装一条（走独立 ID 段） */
  feedAccount: boolean;
}

/**
 * 组合"计划 + 全部白名单路径" → 具体的路径分配。
 *
 * @param plan         `buildRulePlan()` 的输出
 * @param allPaths     `ENABLED_ROUTE_PATHS`（含 `feed/rcmd`）
 */
export function planPaths(plan: RulePlan, allPaths: readonly string[]): PathPlan {
  /**
   * 取流那一套**永远排除推荐流** —— 推荐流是否被代理，由 `feedAccount` 单独决定。
   *
   * ⚠️ 若哪天 `feed/rcmd` 不在白名单里（被移除），本逻辑仍然成立：
   * `streamingPaths` 就是全部白名单路径（不含它），`feedAccount` 走独立规则。
   */
  const streamingPaths = plan.feedStreaming ? allPaths.filter((p) => p !== FEED_RCMD_PATH) : [];

  return {
    streamingPaths,
    /**
     * 推荐流要单独装，**但它也必须在可代理路径集合里** ——
     * `feedAccount === true` 却 `feed/rcmd` 不在白名单时，装了也白装
     * （`buildPathRule()` 会因 `isProxyPath()` 拒绝而返回 null）。
     *
     * 所以这里显式要求它在白名单里，而不是写个恒真的锁。
     */
    feedAccount: plan.feedAccount && allPaths.includes(FEED_RCMD_PATH),
  };
}

/**
 * **推荐流身份判定** —— 「取流账号是否真的 ≠ 页面账号」。
 *
 * > 从 `src/content/feed-boundary/feed-boundary.ts` 摘出来的（2026-11-11）。
 * > 原文件是"来源分界线"功能的判据；**分界线功能已取消**，但这套判据本身
 * > 与它无关 —— 任何"按身份做条件渲染"的功能都要用它。
 *
 * ## 为什么放在 `core/`
 *
 * 它是**纯函数 + 纯类型，零 IO、零 chrome API、零 DOM**：
 *   - 能在 Node 里用 Vitest 全覆盖
 *   - `content`（首页）与未来别处都能引用
 *   - 依赖方向 `content → core` 合法（`AGENTS.md` §5.1）
 *
 * ## 🔗 与 `page-state.ts` 的 `setProxyIdentity()` 是**同一件事的两种实现**
 *
 * | 位置 | 输入来源 | 场景 |
 * | --- | --- | --- |
 * | `page-state.ts` | `page/activate` 回包里的 `reason` | **播放页**（会发那条消息） |
 * | **本文件** | 自己比 mid | **首页**（`page/activate` 根本不发，拿不到 reason） |
 *
 * ⚠️ **改任何一处的 mid 比较逻辑，另一处必须同步检查。**
 * 唯一能让人发现这件事的方法就是这条互相引用 —— 所以不要删这几行。
 *
 * ## 为什么首页要自己算
 *
 * `page/activate` 只在播放页发起（`entrypoints/content.ts` 里由 `parsePlayPage()`
 * 闸门拦住才调）。首页 `www.bilibili.com/` **不发这条消息**，所以拿不到 `reason`。
 *
 * ## 算身份要两个输入，任一缺失都只能得到 unknown
 *
 * | 缺哪个 | 什么时候发生 |
 * | --- | --- |
 * | `account/summary` 拿不到 | 网络失败、扩展上下文失效、SW 未就绪 |
 * | `DedeUserID` 读不到 | **游客态**（没登录就没有这个 cookie） |
 *
 * ⚠️ **`unknown` 不是"预留分支"，是真实的失败态。**
 * 尤其游客态：游客没有"我的推荐"这个概念；而"技术上确实在代理"
 * （`page.handler.ts` 游客态继续代理）**不能**成为把它当 `ok` 的理由。
 *
 * **任何按身份做的条件渲染，一旦判成 `ok` 就是在陈述一个事实。
 * "可能"不能当断言用。**
 */

/** 取流账号与页面账号的关系 —— `null` 表示算不出来 */
export type FeedIdentity =
  | 'ok'
  | 'self'
  | 'disabled'
  | 'not-configured'
  /** 用户选了"用浏览器账号取流"，取流根本没走扩展账号 */
  | 'page-identity'
  | 'unknown';

/**
 * **这个身份下，可不可以按"取流账号"来处置页面内容？**
 *
 * | 输入 | 返回 | 为什么 |
 * | --- | --- | --- |
 * | `'ok'` | ✅ `true` | 真的在代理：取流账号存在、且 ≠ 页面账号 |
 * | `'self'` | ❌ | 两边是同一个账号，没有"另一个账号"可言 |
 * | `'disabled'` | ❌ | 用户主动关的，没在代理 |
 * | `'not-configured'` | ❌ | 没有取流账号 |
 * | `'page-identity'` | ❌ | 用户选了浏览器账号取流，扩展没参与 |
 * | `'unknown'` | ❌ | **算不出来 ≠ 在代理** |
 * | `null` | ❌ | 同 unknown |
 *
 * ⚠️ **六种输入里只有一种返回 `true`。** 这不是保守，是这类判据的性质：
 * 它决定的是"要不要把页面上的一部分内容按另一个身份处置"，
 * **猜错的代价是用户看到不属于他的东西（或看不到属于他的东西）**。
 */
export function shouldSwitchFeed(identity: FeedIdentity | null): boolean {
  return identity === 'ok';
}

/**
 * 首页侧的身份判据 —— 自己比 mid。
 *
 * ## 判据
 *
 * | 输入 | 输出 | 依据 |
 * | --- | --- | --- |
 * | 开关关 | `'disabled'` | 用户主动关的，优先于一切 |
 * | 无凭据 | `'not-configured'` | 没有取流账号 |
 * | 取流身份 = `page` | `'page-identity'` | 用户选了浏览器账号取流 |
 * | 摘要拿不到 | `'unknown'` | 算不出来 |
 * | 页面 mid 为 `null`（游客） | `'unknown'` | 见文件头 |
 * | 两 mid 相等 | `'self'` | 同号，代理无意义 |
 * | 两 mid 不等 | `'ok'` | **真的在代理** |
 *
 * @param streamingIdentity `readStreamingIdentity()` 的结果。**必填** ——
 *                          漏传它曾经是一个真实 bug（分界线在 page 身份下仍显示）
 * @param proxyEnabled      `proxy/status` 的 `enabled`
 * @param hasCredential     `proxy/status` 的 `hasCredential`
 * @param credentialMid     `account/summary` 的 `profile.mid`；拿不到为 `null`
 * @param pageMid           页面 `document.cookie` 的 `DedeUserID`；游客为 `null`
 */
export function resolveFeedIdentity(input: {
  streamingIdentity: 'extension' | 'page';
  proxyEnabled: boolean;
  hasCredential: boolean;
  credentialMid: number | null;
  pageMid: number | null;
}): FeedIdentity {
  const { streamingIdentity, proxyEnabled, hasCredential, credentialMid, pageMid } = input;

  // 顺序与 `popup-state.ts` / `page.handler.ts` 一致
  if (!proxyEnabled) return 'disabled';
  if (!hasCredential) return 'not-configured';

  /**
   * ⚠️ 这一行曾是一个真实 bug 的修复点：
   * 首版没有这个入参，于是用户选了「浏览器账号取流」、而扩展账号 mid 恰好 ≠ 页面 mid 时，
   * 会被判成 `'ok'` → 按取流账号处置内容 → **而取流根本没走扩展账号**。
   */
  if (streamingIdentity === 'page') return 'page-identity';

  // 任一缺失 → 算不出来（游客态也走这里）
  if (credentialMid === null || pageMid === null) return 'unknown';

  return credentialMid === pageMid ? 'self' : 'ok';
}

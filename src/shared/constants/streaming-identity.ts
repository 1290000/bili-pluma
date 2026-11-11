/**
 * 取流身份选择 —— **纯类型与纯判据，零 IO**。
 *
 * ## 职责：只有两个值（2026-11-11 定稿）
 *
 * 用户可以把"谁负责取流"设成下面之一：
 *
 * | 值 | 取流身份 | 需要 DNR 吗 |
 * | --- | --- | --- |
 * | `extension` | 扩展托管凭据（vault 里那个） | ✅ 换 Cookie |
 * | `page` | **浏览器当前登录态** | ❌ **不需要**，页面本来就是它 |
 *
 * ⚠️ **这不等于"任意账号可配"**。vault 是单 blob 模型
 * （`core/vault/vault.ts`、`docs/04-project-structure.md:310`「v1 只支持单个播放账号」），
 * 所以只有这两个合法值。多账号推迟到 v1.5，因为要改登录流程
 * （每加一个账号开一次无痕窗口扫码，而 `incognito:'split'` 下窗口一关 cookie 就销毁）
 * ——那是 [ADR 0012](../../../docs/decisions/0012-isolated-window-login.md) 级别的重新设计。
 *
 * ## ⚠️ 本文件为什么放在 `shared/` 而不是 `platform/`
 *
 * 因为它**只有类型和纯函数**：`needsProxy()` / `switchingRequiresRebuild()` 都能用
 * Vitest 全覆盖，`background` 与 `content` 两侧都要引用它们。
 *
 * **存储实现在 `@platform/storage/streaming-identity-store`** ——
 * `shared/` 里出现 `chrome.storage` 会被 `scripts/check-boundaries.ts` 判红
 * （`AGENTS.md` §5.1：依赖方向 `core → shared`，反向一律禁止）。
 * 这是**两道强制检查**之一，不许用 `(globalThis as any).chrome` 绕过。
 *
 * ## 为什么不塞进 `credential-store` / `ui-prefs-store`
 *
 * - `credential-store` 管的是**加密凭据**（`SESSDATA` 等），泄漏即帐号泄露；
 *   而这里只是一个 `'page' | 'extension'` 字符串。把两者的生命周期绑在一起，
 *   会让"退出取流账号"顺手清掉用户的选择，反之亦然。**权限最小化**。
 * - `ui-prefs-store` 管的是**视觉偏好**（净化选项、角标开关），
 *   改了只影响"页面长什么样"；这里改的是**取流行为**，会触发 DNR 规则重建。
 *   混在一起的后果是：改一个净化开关可能意外触发一次规则重建。
 *
 * 所以它是**第三类**：影响网络行为的、不含凭据的、纯字符串的配置位。
 */

/** 取流身份选择 */
export type StreamingIdentity = 'extension' | 'page';

/**
 * 默认值：`extension`。
 *
 * 理由：已配置过取流账号的用户，其意图就是"用扩展托管那个"。
 * 若默认 `page`，老用户升级后会**静默失去高画质**——那是不可接受的回归。
 */
export const DEFAULT_STREAMING_IDENTITY: StreamingIdentity = 'extension';

/**
 * 把任意存储值收敛成合法值。
 *
 * 非法值（被手改 / 旧版本写入 / 存储被清）一律回落到默认值 ——
 * **宁可少一个配置，不可让一个未知字符串流进规则逻辑**。
 *
 * 抽成纯函数是为了能用单测钉住"非法输入不会穿透"这件事，
 * 而不必为了测它去模拟 `chrome.storage`。
 */
export function normalizeStreamingIdentity(raw: unknown): StreamingIdentity {
  return raw === 'page' ? 'page' : DEFAULT_STREAMING_IDENTITY;
}

/** 是否需要 DNR 换 Cookie。`page` 模式不需要 —— 页面本来就是那个身份 */
export function needsProxy(identity: StreamingIdentity): boolean {
  return identity === 'extension';
}

/**
 * **这个功能现在能不能用** —— `configured` 的**唯一判据**。
 *
 * ## ⚠️ 它回答的是"配置是否完整"，**不是"凭据是否有效"**
 *
 * | 场景 | 本函数 | 说明 |
 * | --- | --- | --- |
 * | `extension` + 有密文 + **凭据已失效** | **`true`** | 配置是完整的，只是号的状态有问题 |
 *
 * 凭据有效性归 `AccountHealth`（`healthy` / `checkedAt`），**与本函数无关**。
 * 名字里的 "Ready" 只指"这一步配置做完了"，不指"现在一定取得到流"——
 * 两件事混在一起会让"凭据失效"这条状态失去归属。
 *
 * ## 为什么不能再用 `hasCredential`（2026-11-11）
 *
 * `hasCredential` 只回答"扩展里存没存过一个号"。它**曾经**能当"功能配好了没有"
 * 的代理指标，但那是因为旧模型里**只有一种配置方式**（扫码存凭据）。
 *
 * 现在有了第二种合法配置：**取流身份 = 浏览器当前登录态**。它不需要、
 * 也不应该存任何凭据 —— 这种配置下 `hasCredential` 恒为 `false`，
 * 若仍拿它当判据，界面就会把**一个完全可用的配置**报成「未配置」，
 * 并引导用户去扫一个他根本不需要的号。
 *
 * ## 判据（用户 2026-11-11 裁决）
 *
 * | 取流身份 | 有密文 | 能用吗 | 返回 |
 * | --- | --- | --- | --- |
 * | `page` | 无 | 能（只是不需要扩展参与） | **`true`** |
 * | `extension` | 有 | 能 | `true` |
 * | `extension` | 无 | 不能（真的没配） | `false` |
 *
 * ## ⚠️ 为什么不复用 `needsProxy()`
 *
 * 两者回答的是**两个问题**，合并会把"配置过"说成"没配置"：
 *
 * | 函数 | 回答 | `page` + 有密文 时 |
 * | --- | --- | --- |
 * | `needsProxy()` | "**要不要**换 Cookie" | `false` |
 * | `isStreamingReady()` | "这个功能**现在能不能用**" | **`true`** |
 *
 * `page` 模式下用户可能**以前配过**扩展账号、只是选择不用它 ——
 * 此时 `needsProxy === false` 但 `isStreamingReady === true`。
 * 若拿 `needsProxy` 当"是否配置"的判据，就会引导用户去扫一个**已经存在**的号
 * （`messages.ts` 的 `configured: true` + `account: null` 那条注释记过同一个坑）。
 *
 * ## ⚠️ 这是一条判据，只许有一处实现
 *
 * `page-snapshot.ts`、`panel-data.ts`、`account.handler.ts`、`popup-state.ts`
 * **全部调用本函数**，不许各自写 `a || b`。
 * 分开写必然在某次改动后分裂成"面板说能用、popup 说未配置"——
 * 这正是 verifier 反复指出的「交叉一致性缺口」。
 *
 * @param identity      用户选的取流身份
 * @param hasCredential 扩展里有没有存过密文（`proxy/status` 的 `hasCredential`）
 */
export function isStreamingReady(identity: StreamingIdentity, hasCredential: boolean): boolean {
  return identity === 'page' || hasCredential;
}

/**
 * 这个配置**需不需要用户去扫码**。
 *
 * ## 为什么必须与 `isStreamingReady` 分开
 *
 * "能用"和"需要登录"是**两件事**：
 *
 * | 状态 | `isStreamingReady` | `needsLogin` |
 * | --- | --- | --- |
 * | `page` 身份、无密文 | `true` | **`false`** ← 用户不需要扫码 |
 * | `extension`、有密文 | `true` | `false` |
 * | `extension`、无密文 | `false` | **`true`** ← 真的需要扫 |
 *
 * 曾经把两者合成"`!configured` → `needsLogin: true`"，
 * 于是 `page` 身份下界面会一边说"能用"一边催用户扫码 —— 自相矛盾。
 */
export function needsLoginForStreaming(
  identity: StreamingIdentity,
  hasCredential: boolean,
): boolean {
  return !isStreamingReady(identity, hasCredential);
}

/**
 * 切到 `next` 时要不要重建规则。
 *
 * 抽成纯函数是为了能用 Vitest 覆盖：`dnr.ts` 本身在 Node 里不存在
 * （DNR 是浏览器 API），但"要不要重建"这个判断是纯逻辑，
 * 不该跟着 DNR 一起变成不可测代码。
 */
export function switchingRequiresRebuild(
  current: StreamingIdentity,
  next: StreamingIdentity,
): boolean {
  return current !== next;
}

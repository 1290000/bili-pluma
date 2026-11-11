/**
 * 取流身份选择位的**存储实现**（`AGENTS.md` §5.1：`shared/` 只放类型与纯判据，
 * 碰 `chrome.storage` 的实现在 `platform/`）。
 *
 * 状态形状见 `@shared/constants/streaming-identity` 的文件头 ——
 * 那里解释了为什么它是**独立于凭据与 UI 偏好的第三类配置**。
 */

import {
  normalizeStreamingIdentity,
  type StreamingIdentity,
} from '@shared/constants/streaming-identity';

/**
 * `storage.local` 键名，**对外只读导出**。
 *
 * 为什么要导出：`entrypoints/content.ts` / 面板要监听它变化来同步界面。
 * 那边照注释再抄一份字面量就成了**第二个真相源**，改一处忘一处就是静默失效
 * （与 `dnr.ts` 的 `PROXY_ENABLED_KEY` 同一条理由）。
 *
 * ⚠️ **只读权限**：拿到这个字符串直接 `chrome.storage.local.set` 会绕过
 * 规则重建 —— 切身份必须在 `dnr.switchStreamingIdentity()` 里走完整流程
 * （先清规则、再按新身份重建）。**不要那么做。**
 */
const STREAMING_IDENTITY_KEY = 'pluma:streaming-identity';

export const STREAMING_IDENTITY_STORAGE_KEY = STREAMING_IDENTITY_KEY;

/** 读当前选择。未写 / 非法值都回落到默认值（收敛逻辑在 shared 的纯函数里） */
export async function readStreamingIdentity(): Promise<StreamingIdentity> {
  const bag = await chrome.storage.local.get(STREAMING_IDENTITY_KEY);
  return normalizeStreamingIdentity(bag[STREAMING_IDENTITY_KEY]);
}

/**
 * 写选择。**只写状态，不动 DNR 规则。**
 *
 * 规则维护的唯一入口是 `dnr.switchStreamingIdentity()` —— 它保证
 * "先清两类规则、再按新身份重建"这个顺序。单独调用本函数 =
 * 状态改了但规则没跟着改，会造出"界面说用浏览器账号，实际还在换 Cookie"
 * 这类最难排查的不一致。
 */
export async function writeStreamingIdentity(identity: StreamingIdentity): Promise<void> {
  await chrome.storage.local.set({ [STREAMING_IDENTITY_KEY]: identity });
}

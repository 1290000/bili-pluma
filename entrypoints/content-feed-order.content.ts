/**
 * 首页推荐流**隐藏**入口（2026-11-11）。
 *
 * ## 它做什么
 *
 * 用户打开面板开关「首页推荐流使用取流账号」后，首页首屏那 10 张
 * `.feed-card`（页面账号的 SSR 推荐）被隐藏，扩展账号的推荐
 * （`.bili-feed-card`，直接挂 grid）自动上移填满。
 *
 * 真机实测：`A=12/B=10` → **`A=0/B=22`**，首张卡 `top` 保持 **255**，**零空洞**。
 *
 * ## 为什么单独一个入口，不并进 `content-home`
 *
 * `content-home` 的三条硬约束（ADR 0031）写死了：**不读 cookie、不发请求、不改响应**。
 *
 * 而本入口**必须读账号相关状态**：
 *   - `pluma:feed-account-enabled`（用户开关）
 *   - `proxy/status.hasCredential`（有没有扫码登录扩展账号）
 *
 * 硬塞进去 = 在 ADR 0031 里开例外，而 0031 的整篇论证建立在"不碰账号"上。
 * **ADR 0031 一个字不改。**
 *
 * ## ⚠️ 与取流身份**完全独立**（用户原话）
 *
 * > 首页推荐流的变化与取流身份是完全独立的两个功能
 *
 * 所以本入口**不读 `streamingIdentity`**，也**不读 `proxyIdentity`**。
 * 它只看两样：**推荐流开关** + **有没有凭据**。
 *
 * `feed/rcmd` 走扩展账号凭据这件事由 `dnr.applyRulePlan()` 负责
 * （独立 ID 段 11000），与本入口的显示逻辑互不依赖。
 *
 * ## 三条已知限制（**不许当成已验证**）
 *
 * 1. **B 站曝光上报可能按 DOM 顺序** —— 隐藏后上报可能仍记在 A 批上。**未测。**
 * 2. **依赖 `.feed-card` 类名** —— B 站改版会失效（由 `evaluateHidePlan` 告警）。
 * 3. **匹配数异常时告警，不静默**。
 */

import type { FeedHideInput } from '@core/feed-identity/feed-hide';
import { installHideObserver } from '@/src/content/feed-order/feed-hide-dom';
import { FEED_ACCOUNT_ENABLED_KEY, readFeedAccountEnabled } from '@platform/storage/ui-prefs-store';

/**
 * 当前页是不是首页。
 *
 * ⚠️ **只认 `www.bilibili.com`，与 `matches` 严格一致**（两边不一致会导致
 * "主域用户永远拿不到"这类静默失效，且没有检查能发现）。
 */
function isHomePage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname !== 'www.bilibili.com') return false;
  return u.pathname === '/' || u.pathname === '/index.html' || u.pathname.startsWith('/v/');
}

/**
 * 读隐藏判据需要的两个输入。
 *
 * ## 为什么 `hasCredential` 要发消息问 background
 *
 * 它是 vault 里"有没有密文"的**权威回答**（`proxy/status` 的字段）。
 * content script 自己读不到 vault（那是 background 的事）。
 *
 * ⚠️ **消息失败时返回 `hasCredential: false`** —— 保守方向：
 * 宁可少隐藏（看到原来的推荐），也不要在"没凭据"时藏掉 A 导致空白页。
 */
async function probeHideInput(): Promise<FeedHideInput> {
  const [enabled, statusRes] = await Promise.all([
    readFeedAccountEnabled().catch(() => false),
    chrome.runtime.sendMessage({ type: 'proxy/status' }).catch(() => null),
  ]);

  const hasCredential =
    statusRes?.type === 'proxy/status:ok'
      ? (statusRes as { hasCredential?: boolean }).hasCredential === true
      : false;

  return { feedAccountEnabled: enabled, hasCredential };
}

export default defineContentScript({
  /**
   * ⚠️ 字面量。WXT 生成 manifest 时对入口做静态分析，取不到跨文件常量。
   * 全站注入由 `isHomePage()` 在运行时收窄。
   */
  matches: ['*://www.bilibili.com/*'],

  /**
   * `document_idle`：隐藏要在卡片渲染出来后才有意义。
   *
   * 用 `document_start` 会在还是空壳时跑一遍（那时匹配 0 张，
   * 会触发"选择器可能失效"的**假警报**）。
   */
  runAt: 'document_idle',

  async main(ctx): Promise<void> {
    if (!isHomePage(location.href)) return;

    /**
     * 开关与凭据都是**每次 probe 时现读**，不缓存 ——
     * 用户可能在面板里中途打开开关，也可能中途退出账号。
     */
    const { stop, refresh } = installHideObserver(document, probeHideInput);
    ctx.onInvalidated(stop);

    /**
     * 用户拨开关 → 立刻生效，不用刷新页面。
     *
     * ⚠️ 这里**只监听、不写**：开关由面板写，
     * 显示逻辑只消费它。
     *
     * 另外监听凭据变化不可行（vault 变化没有 `storage.onChanged` 事件
     * 能可靠对应），所以凭据被清掉时靠下一次 DOM 变更或重开页面生效 ——
     * 这是**已知的延迟**，可接受：用户退出账号后通常也会刷新页面。
     */
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes[FEED_ACCOUNT_ENABLED_KEY]) return;
      refresh();
    });
  },
});

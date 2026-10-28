/**
 * Background Service Worker 入口。
 *
 * 约定（docs/04-project-structure.md §2）：入口只做编排，业务逻辑放 `src/`。
 *
 * ⚠️ 统一用 `chrome.*`，**不要用 `wxt/browser` 导出的 `browser`**。
 * Edge 156 提供了一个自己的 `browser` 命名空间（带 onRestartRequired / onUserScriptMessage），
 * WXT 检测到 `globalThis.browser.runtime.id` 就优先用它，导致 `onMessage` 的
 * `sendResponse` + `return true` 完全失效——消息永远不返回，且没有任何报错。
 * 详见 docs/guides/debugging.md。
 */

import { diag } from '@platform/storage/diag-store';
import { forgetLoginWindow, openLoginWindow } from '@/src/background/login-window';
import { clearLoginReady, markLoginReady } from '@/src/background/login-handshake';
import { handleAccountSummary } from '@/src/background/handlers/account.handler';
import { handleAccountRemove } from '@/src/background/handlers/account-remove.handler';
import { handlePageActivate, handlePageDeactivate } from '@/src/background/handlers/page.handler';
import { handleProxySet, handleProxyStatus } from '@/src/background/handlers/proxy.handler';
import { handleQrGenerate, handleQrPoll } from '@/src/background/handlers/qr.handler';
import { handleAffectedTabs, handleTabsReload } from '@/src/background/handlers/tabs.handler';
import { handleStatsRecent } from '@/src/background/handlers/stats.handler';
import { reconcileTabRules, rebuildRulesIfEnabled } from '@/src/platform/http/dnr';
import { recordStat } from '@/src/platform/storage/stats-store';

/**
 * 是否是"需要保留标签页代理规则"的播放页。
 *
 * 两类：普通视频 `/video/*`、PGC `/bangumi/play/*`（ADR 0019）。
 * 离开这两类页面就把规则撤掉 —— 不撤的话，之后这个标签页里任何
 * 命中白名单的请求都会带播放账号的 Cookie 发出去。
 */
function isVideoPageUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?bilibili\.com\/(video|bangumi\/play)\//.test(url);
}

/**
 * 打开登录窗口 —— `login/open` 消息的处理体。
 *
 * ## 为什么这段逻辑从 `action.onClicked` 搬到这里
 *
 * P2 加了 `default_popup` 之后，**`chrome.action.onClicked` 不再触发**
 * （Chrome 的规则：有 popup 时点图标只开 popup）。原来挂在 onClicked 上的
 * 登录入口会直接失效——用户再也点不出二维码。所以搬成消息处理，
 * 由 popup 的「扫码登录播放账号」按钮触发。
 *
 * ## 核心事实（实测，别改）
 *
 * `windows.create({ incognito: true })` 可能**确实创建成功**，但返回 `undefined`，
 * 且当前实例的 `windows.getAll()` 看不到新窗口（用户确认窗口真出现了，
 * 标题 `登录播放账号-[InPrivate]`）。
 *
 * 所以**不能**用返回值判断成败，否则会误弹说明页。
 * 判定依据只有一条：`isAllowedIncognitoAccess()`。
 *   true  → 按已创建处理（乐观，reason='assumed'）
 *   false → 确定没权限，弹说明页
 */
async function handleLoginOpen(): Promise<{
  type: 'login/open:ok';
  opened: boolean;
  reason?: 'incognito-disabled' | 'already-open' | 'assumed' | 'unknown';
}> {
  const result = await openLoginWindow();
  await diag('login/open', JSON.stringify(result));

  if (result.ok || result.reason === 'already-open' || result.reason === 'assumed') {
    if (result.reason === 'assumed') {
      await diag('create 返回 undefined 但权限正常 → 按已创建处理');
    }
    await markLoginReady();
    return {
      type: 'login/open:ok',
      opened: true,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  // 只有确定没权限时才弹说明页
  if (result.reason === 'incognito-disabled') {
    await diag('权限未开启 → 弹说明页');
    await chrome.windows
      .create({
        url: chrome.runtime.getURL('/need-incognito.html'),
        type: 'popup',
        width: 460,
        height: 420,
      })
      .catch(() => {});
    return { type: 'login/open:ok', opened: false, reason: 'incognito-disabled' };
  }

  await diag('openLoginWindow 未知失败');
  return { type: 'login/open:ok', opened: false, reason: 'unknown' };
}

export default defineBackground(() => {
  // ── SW 启动自愈（ADR 0006 的三条硬性配套之一）──
  // `sessionRules` 在浏览器重启后清空。如果总开关是开的，
  // 必须**重建**规则，否则代码以为在代理、实际一条规则都没有。
  void rebuildRulesIfEnabled()
    .then((r) => {
      if (r.rebuilt > 0) console.warn(`[pluma] 重建了 ${r.rebuilt} 条代理规则`);
      if (r.cleared > 0) console.warn(`[pluma] 清理了 ${r.cleared} 条残留规则`);
    })
    .catch(() => {});

  // 校正标签页规则：标签页崩溃/被强关时 content script 来不及删
  void reconcileTabRules()
    .then((n) => {
      if (n > 0) console.warn(`[pluma] 清理了 ${n} 条失效的标签页规则`);
    })
    .catch(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = (message as { type?: string } | undefined)?.type;

    if (type === 'qr/generate') {
      handleQrGenerate()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'qr/generate:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'qr/poll') {
      const { qrcodeKey } = message as { qrcodeKey: string };
      handleQrPoll(qrcodeKey)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ type: 'qr/poll:err', detail: e instanceof Error ? e.name : 'unknown' }),
        );
      return true;
    }

    if (type === 'page/quality') {
      const { height, note } = message as { height: number; note?: string };
      // note 优先：它承载 HDR / 改写 / 请求观测这类更细的信息
      void diag('page/quality', note ?? `页面实际播放 ${height}p`);
      return false;
    }

    if (type === 'account/summary') {
      const { recheck } = message as { recheck?: boolean };
      handleAccountSummary(recheck === true)
        .then(sendResponse)
        .catch(() => sendResponse({ type: 'account/summary:err', code: 'UNKNOWN', detail: null }));
      return true;
    }

    if (type === 'account/remove') {
      handleAccountRemove()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'account/remove:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'stats/recent') {
      handleStatsRecent()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'stats/recent:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'page/activate') {
      const { kind, pageKey, p, deviceCookies, primaryMid } = message as {
        kind: 'video' | 'pgc';
        pageKey: string;
        p: number;
        deviceCookies: Record<string, string>;
        primaryMid: string | null;
      };
      const tabId = _sender.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ type: 'page/activate:ok', activated: false, reason: 'error' });
        return false;
      }

      handlePageActivate({ tabId, kind, pageKey, p, deviceCookies, primaryMid })
        .then((r) => {
          // 记一次取流结果 —— 这是**唯一**已知的真实成败信号，
          // 比 background 另发一个探测请求更贴近用户体感。
          //
          // ⚠️ 两类**不算失败**的情况必须排除，否则统计会谎报：
          //   - `not-configured`：还没扫码，是"还没开始用"
          //   - `disabled`：用户主动关了总开关（2026-10-27 新增）。
          //     不排除的话，关掉开关后每刷一个视频页都记一次 fail，
          //     条形图会变成一片红，指向一个不存在的问题。
          if (r.reason !== 'not-configured' && r.reason !== 'disabled') {
            void recordStat(r.activated);
          }
          sendResponse({ type: 'page/activate:ok', ...r });
        })
        .catch(() => sendResponse({ type: 'page/activate:ok', activated: false, reason: 'error' }));
      return true;
    }

    if (type === 'proxy/status') {
      handleProxyStatus()
        .then(sendResponse)
        .catch(() =>
          sendResponse({
            type: 'proxy/status:ok',
            enabled: false,
            hasCredential: false,
            ruleCount: 0,
          }),
        );
      return true;
    }

    if (type === 'proxy/set') {
      const { enabled } = message as { enabled: boolean };
      handleProxySet(enabled)
        .then((r) => {
          sendResponse(r);
          void diag('proxy/set', `${enabled ? '开启' : '关闭'}代理`);
        })
        .catch((e: unknown) =>
          sendResponse({ type: 'proxy/set:err', detail: e instanceof Error ? e.name : 'unknown' }),
        );
      return true;
    }

    if (type === 'proxy/affected-tabs') {
      handleAffectedTabs()
        .then(sendResponse)
        .catch(() => sendResponse({ type: 'proxy/affected-tabs:ok', count: 0, tabIds: [] }));
      return true;
    }

    if (type === 'tabs/reload') {
      const { tabIds } = message as { tabIds: number[] };
      handleTabsReload(Array.isArray(tabIds) ? tabIds : [])
        .then(sendResponse)
        .catch(() => sendResponse({ type: 'tabs/reload:ok', reloaded: 0 }));
      return true;
    }

    if (type === 'login/open') {
      handleLoginOpen()
        .then(sendResponse)
        .catch(() => sendResponse({ type: 'login/open:ok', opened: false, reason: 'unknown' }));
      return true;
    }

    return false;
  });

  // ── 标签页生命周期：清理规则 ──
  //
  // ⚠️ `onActivated`（用户切到这个标签页）**绝不能**删规则。
  // 曾经只在 onUpdated + onRemoved 上清理，看起来够，但漏了一种高频情况：
  // 标签页在后台被 Chrome「冻结 / 丢弃」后重新进入，页面走 restore 路径，
  // 既没有 url 变化的 onUpdated、也没有 content script 的重新报到，
  // 于是规则留着、页面状态却是旧的 —— 表现就是"挂后台久了回来白屏 / 播放器无响应"。
  // 现在改为：**任何一次生命周期事件都只做"确认该不该有规则"，不该有才删。**

  chrome.tabs.onRemoved.addListener((tabId) => {
    void handlePageDeactivate(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // ⚠️ 只在**地址真的变了**时判断，不要因为 loading / status 变化就删规则。
    // 播放器重建、B站前端路由切换都会触发 onUpdated，那些时候 URL 可能不变。
    if (!changeInfo.url) return;
    if (!isVideoPageUrl(changeInfo.url)) void handlePageDeactivate(tabId);
  });

  // 标签页被冻结/丢弃时把规则撤掉。恢复时页面会重新报到，规则自然重建；
  // 不撤的话，恢复过程中任何 playurl 都会带旧 Cookie 发出去。
  chrome.tabs.onReplaced.addListener((_added, removed) => {
    void handlePageDeactivate(removed);
  });

  // 登录窗口被用户手动关掉时清理状态
  chrome.windows.onRemoved.addListener(() => {
    forgetLoginWindow();
    void clearLoginReady();
  });
});

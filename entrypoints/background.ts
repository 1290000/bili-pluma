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

import { diag, forgetLoginWindow, openLoginWindow } from '@/src/background/login-window';
import { clearLoginReady, markLoginReady } from '@/src/background/login-handshake';
import { handlePageActivate, handlePageDeactivate } from '@/src/background/handlers/page.handler';
import { handleProxySet, handleProxyStatus } from '@/src/background/handlers/proxy.handler';
import { handleQrGenerate, handleQrPoll } from '@/src/background/handlers/qr.handler';
import { reconcileTabRules, rebuildRulesIfEnabled } from '@/src/platform/http/dnr';

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

    if (type === 'page/activate') {
      const { bvid, p, deviceCookies, primaryMid } = message as {
        bvid: string;
        p: number;
        deviceCookies: Record<string, string>;
        primaryMid: string | null;
      };
      const tabId = _sender.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ type: 'page/activate:ok', activated: false, reason: 'error' });
        return false;
      }

      handlePageActivate({ tabId, bvid, p, deviceCookies, primaryMid })
        .then((r) => sendResponse({ type: 'page/activate:ok', ...r }))
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

    if (type === 'login/open') {
      openLoginWindow()
        .then((r) =>
          sendResponse({
            type: 'login/open:ok',
            opened: r.ok,
            ...(r.reason ? { reason: r.reason } : {}),
          }),
        )
        .catch(() => sendResponse({ type: 'login/open:ok', opened: false, reason: 'unknown' }));
      return true;
    }

    return false;
  });

  // 标签页关闭时删掉它的规则，避免规则堆积
  chrome.tabs.onRemoved.addListener((tabId) => {
    void handlePageDeactivate(tabId);
  });

  // 标签页导航到非视频页时也删（content script 不会在新页面上报，规则会残留）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    const isVideo = /^https?:\/\/(www\.)?bilibili\.com\/video\//.test(changeInfo.url);
    if (!isVideo) void handlePageDeactivate(tabId);
  });

  // 登录窗口被用户手动关掉时清理状态
  chrome.windows.onRemoved.addListener(() => {
    forgetLoginWindow();
    void clearLoginReady();
  });

  // P1 阶段没有 popup，点图标直接开登录窗口（走 InPrivate，不污染主账号）。
  // P2 会换成 popup 的「未配置」按钮。
  chrome.action.onClicked.addListener(() => {
    void (async () => {
      // 先记录"谁收到了这次点击"——split 模式下可能是两个实例各收一次
      await diag('action.onClicked 收到点击');

      // ⚠️ 核心事实（实测）：`windows.create({ incognito: true })` 可能**确实创建成功**，
      // 但返回 `undefined`，且当前实例的 `windows.getAll()` 看不到新窗口
      // （用户确认窗口真的出现了，标题 `登录播放账号-[InPrivate]`）。
      //
      // 所以**不能**用返回值判断成败，否则会误弹说明页。
      // 判定依据只有一条：`isAllowedIncognitoAccess()`。
      //   true  → 按已创建处理（乐观）
      //   false → 确定没权限，弹说明页

      const result = await openLoginWindow();
      await diag('openLoginWindow result', JSON.stringify(result));

      if (result.ok || result.reason === 'already-open' || result.reason === 'assumed') {
        if (result.reason === 'assumed') {
          await diag('create 返回 undefined 但权限正常 → 按已创建处理');
        }
        await markLoginReady();
        return;
      }

      // 只有确定没权限时才弹说明页
      if (result.reason === 'incognito-disabled') {
        await diag('权限未开启 → 弹说明页');
        await chrome.windows.create({
          url: chrome.runtime.getURL('/need-incognito.html'),
          type: 'popup',
          width: 460,
          height: 420,
        });
        return;
      }

      await diag('openLoginWindow 未知失败，跳过');
    })();
  });
});

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
import { handleDiagFacts } from '@/src/background/handlers/diag.handler';
import {
  handleUpdateAuto,
  handleUpdateCheck,
  handleUpdateDismiss,
  handleUpdateOpen,
  handleUpdateStatus,
  checkPendingUpdate,
  runStartupUpdateCheck,
} from '@/src/background/handlers/update.handler';
import {
  applyRulePlan,
  reconcileTabRules,
  rebuildRulesIfEnabled,
  switchStreamingIdentity,
} from '@/src/platform/http/dnr';
import { readStreamingIdentity } from '@/src/platform/storage/streaming-identity-store';
import { writeFeedAccountEnabled } from '@/src/platform/storage/ui-prefs-store';
import { normalizeStreamingIdentity } from '@/src/shared/constants/streaming-identity';
import { recordStat } from '@/src/platform/storage/stats-store';
import { parsePlayPage } from '@/src/shared/utils/video-page';
import type { LoginOpenReason } from '@/src/shared/types/messages';

/**
 * 是否是"需要保留标签页代理规则"的播放页。
 *
 * 两类：普通视频 `/video/*`、PGC `/bangumi/play/*`（ADR 0019）。
 * 离开这两类页面就把规则撤掉 —— 不撤的话，之后这个标签页里任何
 * 命中白名单的请求都会带播放账号的 Cookie 发出去。
 *
 * ## 为什么走 `parsePlayPage()` 而不是手写正则（B-02 / B-03）
 *
 * 原来这里是 `/^https?:\/\/(www\.)?bilibili\.com\/(video|bangumi\/play)\//`。
 * AGENTS.md §4.3 写明「判据只许走 `parsePlayPage()`」——
 * 这个文件因为不在 `check-page-gate` 的 `MUST_USE_GATE` 里（2026-10-29 已补入），
 * 带着一份手写判据活了一整轮 PGC 开发。
 *
 * 两者**语义不等价**，新判据更严格：hostname 必须是 `www.bilibili.com` / `bilibili.com`，
 * `/video/` 后必须 `BV` 开头，`/bangumi/play/` 后必须有 ep/ss 数字。
 *
 * ## 严格化的方向性是**安全**的（别以为是漏了）
 *
 * 旧正则多接受的两种 —— `/video/非BV`、`/bangumi/play/`（空尾）—— 在 B站上都不是真实播放页。
 * 判成"不是播放页"的唯一后果是**撤掉这个标签页的规则**（见下方 `onUpdated`），
 * 也就是"少代理一点"。反过来（多判成播放页）才会留下一条无主规则，
 * 让该标签页里所有命中白名单的请求继续带播放账号 Cookie —— 那才是危险方向。
 * 所以这里宁可严，不可宽。
 *
 * `export` 是为了让 `tests/unit/platform/background-play-page.test.ts` 能测这个接线：
 * 判据本身已有 38 例单测（`video-page.test.ts`），但"这里到底调没调它"没有任何守卫。
 */
export function isVideoPageUrl(url: string): boolean {
  return parsePlayPage(url) !== null;
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
 * 所以**不能**用返回值判断成没成功。判定依据有两条，各管一段：
 *   `isAllowedIncognitoAccess()` 读 false → 确定没权限 ⇒ 弹说明页（**不再 create**）
 *   读 true → 建窗；建完仍拿不到证据 ⇒ `assumed`，**`opened: false`**
 *
 * ## ⚠️ `assumed` 在真机上是**常态**，不是兜底例外（2026-11-12，task-12 实测）
 *
 * 跨两天 4 次调用，**4 次全是 `assumed`**，`create()` 从未返回过 `id`，
 * `windowsAfter === windowsBefore` 每一次都成立，`loginTabs` 恒为 0。
 * 这不是时序问题 —— 普通实例按设计就看不见无痕分区的窗口和标签页
 * （`login-window.ts` 文件头那两条铁律）。
 *
 * **已知限制**：走到 `assumed` 时，我们**无法确认**窗口真的开出来了。
 *
 * > 📌 2026-11-15（task-46）口径反转：以前这里回 `opened: true`（「有依据的乐观
 * > 判断」）。那条判断的前提是权限一定开着，而当时权限读数只记日志不裁决 ——
 * > 权限关着时照样 create，于是 **废页 + 报成功**。现在权限闸真的拦住了，
 * > `assumed` 回 `opened: false`，由面板如实说「没能确认窗口打开」。
 * > 完整论证见 `login-window.ts` 里 `openLoginWindow()` 情况 3 的注释。
 */
async function handleLoginOpen(): Promise<{
  type: 'login/open:ok';
  opened: boolean;
  confirmed?: boolean;
  /** ⚠️ 别手抄取值域 —— 唯一权威定义在 `src/shared/types/messages.ts` 的 `LoginOpenReason` */
  reason?: LoginOpenReason;
}> {
  const result = await openLoginWindow();
  await diag('login/open', JSON.stringify(result));

  /**
   * ## `assumed` **不再冒充成功**（2026-11-15，task-46 —— 口径反转）
   *
   * ### 旧口径（现在已废）
   *
   * `result.ok || reason==='already-open' || reason==='assumed'` 全都
   * `markLoginReady()` + `opened: true`。理由见下面那段历史注释。
   *
   * ### 为什么废了
   *
   * 那条「乐观判断」的前提是**权限一定开着**（上面 `isAllowedIncognitoAccess`
   * 那道闸当时只是记日志、不拦）。task-43/46 的真机取证把这个前提拆了：
   * 权限关着时照样 `create` 无痕窗 ⇒ 窗口里加载 `chrome-extension://…/login-window.html`
   * 而**无痕分区里没有这个扩展** ⇒ `ERR_BLOCKED_BY_CLIENT` ⇒ 用户看到一张废页，
   * 代码却回 `opened: true`。
   *
   * 现在权限闸真的拦在 `create()` 之前（`login-window.ts`），`assumed` 剩下的
   * 唯一含义就是「权限在，`create()` 没抛错，但我们**确实没法确认窗口开出来了**」。
   */
  if (result.reason === 'assumed') {
    await diag('create 返回 undefined → 交握判定，opened=false（无法确认窗口已开）');
    /**
     * `markLoginReady()` **照旧写**，这是关键，别顺手删：
     * 它的作用是**抑制另一个实例误弹说明页**（`login-handshake.ts` 双向握手）。
     * 「我们没确认」和「确定没开」是两件事 —— 后者才该弹说明页。
     */
    await markLoginReady();
    return {
      type: 'login/open:ok',
      opened: false,
      confirmed: false,
      reason: 'assumed',
    };
  }

  if (result.ok || result.reason === 'already-open') {
    /**
     * ## `markLoginReady()` 为什么在这里仍然要写（2026-11-15 复核）
     *
     * 走到这里只有两种可能：拿到了窗口对象（`ok`），或探测到心跳还活着
     * （`already-open`）—— 两种都是**有证据的**「应该开出来了一个」。
     * 写 `login-ready` 的作用是**抑制另一个实例误弹说明页**
     * （`login-handshake.ts` 的双向握手）。
     *
     * ⚠️ 不要因为它"不够严谨"就改成不写 —— 不写会让说明页**必然**弹出，
     * 而那正是「开了权限还看到红字」那条老 bug 的样子。
     */
    await markLoginReady();
    return {
      type: 'login/open:ok',
      opened: true,
      reason: result.reason ?? ('opened' as const),
    };
  }

  // 只有确定没权限时才弹说明页
  if (result.reason === 'incognito-disabled') {
    await diag('权限未开启 → 弹说明页');
    /**
     * ## ⚠️ `create` 之后必须留痕（2026-11-12，task-22 缺陷 1）
     *
     * 旧代码是 `.catch(() => {})` —— **返回值和异常全被吞掉**，而 `diag` 写在
     * `create` **之前**（上一行），所以日志里永远只有「权限未开启 → 弹说明页」，
     * 窗口**建没建成、建在哪个坐标、有没有被浏览器拒绝，一个字都没有**。
     *
     * 这一行在整轮「点了没反应」的调查里反复误导判断：日志显示走到了弹说明页
     * 的分支，但用户屏幕上没有窗口，于是只能靠猜。
     *
     * ⇒ 现在不管成功失败都写一条，带：
     *   - `id`：拿到窗口对象 = 窗口真的建出来了
     *   - `url`：确认建的是**说明页**而不是别的东西
     *   - `error`：被拒绝时的原始原因（`Invalid value` / 策略拦截等）
     *
     * ⚠️ **不许再改成 `.catch(() => {})`**：那个空 catch 是这条调查链上
     * 最贵的一个黑洞。错误可以不影响用户流程，但**必须进日志**。
     */
    let created: chrome.windows.Window | undefined;
    let createError = '';
    try {
      created = await chrome.windows.create({
        url: chrome.runtime.getURL('/need-incognito.html'),
        type: 'popup',
        width: 460,
        height: 420,
      });
    } catch (e) {
      createError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    await diag(
      'need-incognito 窗口创建结果',
      `id=${String(created?.id)} url=${String(created?.tabs?.[0]?.url)}` +
        (createError ? ` error=${createError.slice(0, 200)}` : ''),
    );
    return { type: 'login/open:ok', opened: false, confirmed: false, reason: 'incognito-disabled' };
  }

  await diag('openLoginWindow 未知失败');
  return { type: 'login/open:ok', opened: false, confirmed: false, reason: 'unknown' };
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

    /**
     * ## 🔨 构建证明：证明「浏览器跑的是这份代码」（2026-11-11）
     *
     * ### 为什么必须有它 —— 今天最贵的一课
     *
     * 本轮排查面板胶囊不渲染，花了两小时走了三条错路，最终发现根因是：
     * **Edge 对解压加载的扩展（`location:4`）有 Service Worker 代码缓存，
     * `taskkill /F` + 重启浏览器清不掉它。**
     *
     * 只有当用户在 `edge://extensions/` 点一次「重新加载」，新代码才真正跑起来。
     *
     * 而我们当时**没有任何手段能区分"代码写错了"和"浏览器跑的是旧代码"**：
     *   - `tsc` / `verify` 全绿 → 只证明**源码**
     *   - `reload-extension.mjs` 的 `✓ 生效：true` → 只证明
     *     **主世界脚本在视频页跑起来了**（它检查 `window.__PLUMA_MAIN__`，
     *     而 `main-hook` 的 `matches` 只含播放页），**不等于 background 是新代码**
     *
     * ### 用法：**任何真机验证前先读这个键**
     *
     * content 侧桥读 `pluma:build-proof`：
     *   - **有值且 `buildAt` 接近刚才的构建时间** → 跑的是新代码 → 实验有意义
     *   - **没有 / `buildAt` 很旧** → **跑的是旧 bundle** →
     *     让用户去 `edge://extensions/` 点「重新加载」，**否则所有实验无效**
     *
     * ### 为什么每次 SW 启动都写
     *
     * SW 会在空闲时被浏览器挂起，下次有消息再唤醒 —— **每次唤醒都是一次
     * "这份代码真的被加载了"的证明**。写 `buildAt` 让调用方能判断新鲜度。
     *
     * ⚠️ 只写时间戳与版本号，**不含任何用户数据、不含凭据**。
     */
    void chrome.storage.local
      .set({
        'pluma:build-proof': {
          swStartedAt: Date.now(),
          probeVersion: 2,
        },
      })
      .catch(() => {
        /* 证明写入失败不影响主流程 */
      });

    /**
     * ## ⚠️ 这里**不再**调 `trace()` / `diag()`（2026-11-10 第九轮实验）
     *
     * 曾经在这里写 `trace('onMessage', type)` 来定位"消息到了没有"。
     * 但 `trace()` 与 `diag()` **共用同一个模块级 Promise 队列** `pending`
     * （`diag-store.ts:75`）—— 链上任何一次写入卡住，整条链就永久悬挂，
     * 之后所有 `diag()` / `trace()` 都返回那个卡住的 Promise。
     *
     * smoke 观察到的现象全部吻合：
     *   - `proxy/set` / `page/quality` 有日志 → **早期**写的，链还没卡
     *   - `trace()` 一次都没成功 → **后期**写的，链已卡住
     *   - `diag/facts` 应答 resolve 成 `undefined`
     *
     * 而且**每收一条消息就写一次**，等于让卡住的概率随消息量线性增长。
     * 删掉它是纯收益：这个监听器现在完全不碰那个队列。
     *
     * 真正的修复是让 `diag()` / `trace()` 不共享队列（或给队列加超时），
     * 那属于 `diag-store.ts` 的改动，不在本轮范围。
     */

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

    /**
     * 诊断环境事实（2026-11-09 加）。
     *
     * 面板是 content script，`chrome.windows` / `chrome.cookies` /
     * `chrome.declarativeNetRequest` / `chrome.extension.isAllowedIncognitoAccess`
     * 在那个环境里**整个是 `undefined`**（真机实测），所以由这里代查。
     */
    if (type === 'diag/facts') {
      /**
       * ## ⚠️ 这里**不要**调 `trace()`（2026-11-10 第九轮实验）
       *
       * `trace()` 与 `diag()` **共用同一个模块级 Promise 队列** `pending`
       * （`diag-store.ts:75`）。只要链上有**任何一次**写入卡住
       * （`chrome.storage.local.get` 在 SW 挂起时不 resolve），
       * 整条链就永久悬挂，之后所有 `diag()` / `trace()` 都返回那个卡住的 Promise。
       *
       * 这能解释 smoke 观察到的全部现象：
       *   - `proxy/set` / `page/quality` 有日志（**早期**写的，那时链还没卡）
       *   - `trace()` 一次都没成功（**后期**写的，链已卡住）
       *   - `diag/facts` 的应答 `resolve` 成 `undefined`
       *
       * 所以这里只保留 `handleDiagFacts()` 本身，**不碰那个队列**。
       * 真正的修复应当是让 `diag()` / `trace()` 各自**不共享**队列
       * （或给队列加超时），那属于 `diag-store.ts` 的改动，不在本轮范围。
       */
      handleDiagFacts()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'diag/facts:err',
            detail: e instanceof Error ? e.message.slice(0, 80) : 'unknown',
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
          // ⚠️ **不算失败**的情况必须排除，否则统计会谎报：
          //   - `not-configured`：还没扫码，是"还没开始用"
          //   - `disabled`：用户主动关了总开关（2026-10-27 新增）。
          //     不排除的话，关掉开关后每刷一个视频页都记一次 fail，
          //     条形图会变成一片红，指向一个不存在的问题。
          //   - `self`：取流账号与页面身份是同一个号（2026-11-11 新增，原 `same-account`）。
          //     **这是"不需要代理"，不是失败** —— 代理是空操作，取流完全正常。
          //     `page.handler.ts` 的 `same-account` 分支历史就漏在这里：
          //     单账号用户每打开一个视频页都记一次假失败，条形图一路变红。
          //   - `page-identity`：用户把取流身份选成了浏览器登录态（2026-11-11 新增）。
          //     同理不算失败 —— 这是**用户主动选择的模式**，取流走页面自身身份，完全正常。
          //
          // ⚠️ 这几种的共同点是"**没有发生取流失败这件事**"，不是"没装规则"。
          //    `error` **必须**留在统计里：那是真的出错了。
          //
          // 用集合而不是链式 `&&`：新增一个 reason 时**必须在这里表态**，
          // 链式写法漏一个只会让统计静默变红，而集合是显式名单。
          const NOT_A_FAILURE: ReadonlySet<string> = new Set([
            'not-configured',
            'disabled',
            'self',
            'page-identity',
          ]);
          if (!NOT_A_FAILURE.has(r.reason)) {
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

    /**
     * ## 取流身份（2026-11-11，步骤 4）
     *
     * 与 `proxy/set` 分开是一条**刻意的边界**：
     *   - `proxy/set(false)` = 用户停用这个功能（→ popup 说「已停用」）
     *   - `streaming/set('page')` = 用户换个合法身份（→ popup 说「无需代理」，
     *     总开关**保持 true**）
     *
     * 合成一条消息会让两个语义互相污染 —— 例如"切到浏览器账号"被实现成
     * "关掉代理"，用户切回来时还得再开一次开关，而他从没想关掉任何东西。
     */
    if (type === 'streaming/status') {
      readStreamingIdentity()
        .then((identity) => sendResponse({ type: 'streaming/status:ok', identity }))
        .catch(() => sendResponse({ type: 'streaming/status:ok', identity: 'extension' }));
      return true;
    }

    if (type === 'streaming/set') {
      const raw = (message as { identity?: unknown }).identity;
      // 收敛在入口：非法值不许穿透到规则逻辑（`normalizeStreamingIdentity` 是唯一真相源）
      const identity = normalizeStreamingIdentity(raw);
      switchStreamingIdentity(identity)
        .then((activated) => {
          sendResponse({ type: 'streaming/set:ok', identity, activated });
          void diag('streaming/set', `取流身份 → ${identity}（激活=${String(activated)}）`);
        })
        .catch((e: unknown) =>
          sendResponse({
            type: 'streaming/set:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'tabs/reload') {
      const { tabIds } = message as { tabIds: number[] };
      handleTabsReload(Array.isArray(tabIds) ? tabIds : [])
        .then(sendResponse)
        .catch(() => sendResponse({ type: 'tabs/reload:ok', reloaded: 0 }));
      return true;
    }

    /**
     * ## 首页推荐流开关（2026-11-11，**与取流身份完全独立**）
     *
     * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
     *
     * ## 为什么必须在 background 写存储
     *
     * 这个开关不只改一个布尔：**它决定 `feed/rcmd` 那条 DNR 规则装不装**。
     * 所以必须走 `applyRulePlan()` —— 它读完整状态、一次性重建所有规则。
     *
     * ⚠️ 面板**不能**直接写 `storage.local`：那样规则不会重建，
     * 开关看着是开的、实际没生效。
     */
    if (type === 'feed-account/set') {
      const raw = (message as { enabled?: unknown }).enabled;
      /**
       * 严格布尔：字符串 `"false"` / 数字 `1` 一律拒绝。
       * 与 `set-proxy` 桥同一纪律（`docs/guides/bsk-page-bridges.md` §3）。
       */
      if (typeof raw !== 'boolean') {
        sendResponse({ type: 'feed-account/set:err', detail: 'enabled 必须是布尔值' });
        return false;
      }
      writeFeedAccountEnabled(raw)
        .then(() => applyRulePlan())
        .then((applied) => {
          sendResponse({ type: 'feed-account/set:ok', enabled: raw, applied: applied.feedAccount });
          void diag(
            'feed-account/set',
            `首页推荐流 → ${raw ? '取流账号' : '浏览器账号'}（规则已装=${String(applied.feedAccount)}）`,
          );
        })
        .catch((e: unknown) =>
          sendResponse({
            type: 'feed-account/set:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'update/status') {
      handleUpdateStatus()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'update/status:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'update/check') {
      const { manual } = message as { manual?: boolean };
      // `manual` 语义见 messages.ts：true = 用户点的按钮，无视间隔闸门
      handleUpdateCheck(manual === true)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'update/check:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'update/auto') {
      const { enabled } = message as { enabled: boolean };
      handleUpdateAuto(enabled === true)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'update/auto:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    if (type === 'update/open') {
      handleUpdateOpen()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'update/open:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
      return true;
    }

    /**
     * 打开「关于」Tab 即视为已读（2026-11-17）。
     *
     * 面板侧负责"该不该发"（只在 `phase === 'available'` 且只发一次），
     * 这里负责落盘 + 消角标。两者分离的理由：**background 是唯一写者**，
     * 面板直接写 `storage.local` 会绕过 `applyUpdateBadge`，角标就消不掉。
     */
    if (type === 'update/dismiss') {
      handleUpdateDismiss()
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({
            type: 'update/dismiss:err',
            detail: e instanceof Error ? e.name : 'unknown',
          }),
        );
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

  // ── 自动检查更新（2026-11-16）──
  //
  // 放在最后、`void` 掉、内部自己 catch：它是后台行为，用户没在等它。
  // 闸门（开关 + 间隔 + 时钟回拨）在 core 的 `shouldCheck` 里，这里不做判断。
  // 先核对"上一次更新到底生效没有"，再做自动检查（顺序不能反：
  // 自检会清掉 pendingUpdate，检查会写 lastCheckAt，两者互不依赖但先答旧问题）
  void checkPendingUpdate().finally(() => {
    void runStartupUpdateCheck();
  });
});

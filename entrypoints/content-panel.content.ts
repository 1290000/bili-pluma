/**
 * 页内侧栏面板入口 —— **第 4 个 content 入口**（ADR 0033 决定二）。
 *
 * ## 为什么必须新开一个入口，不能复用现有的三个
 *
 * 三个现有入口的 `matches` 都被 `scripts/check-page-gate.mjs` 锁死了，
 * **没有一个同时覆盖 `www` 与 `live` 两域**：
 *
 *   - `content.ts` —— 规则 2 强制它只能 `video` + `bangumi/play`
 *   - `content-home.content.ts` —— 只 `www`，不含直播域
 *   - `content-live.content.ts` —— 规则 2c 反向断言**禁止**它含播放页模式
 *
 * 面板要在"任何 B站 页面"都能唤起（首页 / 视频 / 直播），所以只能新开。
 *
 * ## ⚠️ 文件名必须带 `.content.`
 *
 * WXT 靠文件名判定入口类型（`PATH_GLOB_TO_TYPE_MAP`：`*.content.[jt]s` →
 * `content-script`）。叫 `content-panel.ts` 时它会**正常构建出一个 js 文件，
 * 但不进 manifest 的 `content_scripts`** —— 面板永远不会注入，且**构建不报任何错**。
 * 2026-10-31 实测踩过（记录在 `check-page-gate.mjs` 的 `NON_PLAY_PAGE_ENTRIES` 注释里）。
 *
 * ## 边界：本入口只负责"画壳"，不做取流
 *
 * 它**不碰** `parsePlayPage()`、不发消息、不读 cookie、不碰播放器节点。
 * 取流由 `content.ts` 负责。两者互不调用、各自独立失效 ——
 * 与 `content-home.content.ts` 的边界划分同一个原则（ADR 0031）。
 *
 * ## 为什么是 `document_idle`
 *
 * 面板不抢任何时序：它不参与页面首屏布局，也不需要在解析期插入。
 * `document_start` 只会让解析期多一次 DOM 操作，还会把
 * `document.body === null` 那条兜底路径真的走上（见 `panel/host.ts` 的注释）。
 */

import { ensurePanelHost, removePanelHost } from '@/src/content/panel/host';
import { mountSidebar, PANEL_CSS } from '@/src/content/panel/sidebar';
import { mountPanelBody, type PanelController } from '@/src/content/panel/panel';
import { loadPanelModel } from '@/src/content/panel/panel-data';
import { createOpenCycler, type LoadResult } from '@/src/content/panel/open-cycler';
import { describeLoginOutcome, type LoginOpenReply } from '@/src/content/panel/login-outcome';
import {
  startLoginPolling,
  type AccountSnapshot,
  type LoginPoller,
} from '@/src/content/panel/login-poller';
import { resolvePrimaryCard } from '@shared/utils/primary-card';
import type { StreamingIdentity } from '@shared/constants/streaming-identity';
import { parsePlayPage } from '@shared/utils/video-page';
import { readPrimaryProfile } from '@platform/storage/primary-profile-store';
import {
  PANEL_ENTRY_ENABLED_KEY,
  readFeedAccountEnabled,
  readPanelEntryEnabled,
} from '@platform/storage/ui-prefs-store';
// tokens.css 的**原始文本**，注入 shadow root 用。
// ⚠️ 不能用 <link>：CSS 变量不穿透 shadow 边界，必须把规则塞进 shadow 内部
import tokensCss from '@/src/design/tokens.css?raw';

/**
 * 当前页是不是受支持的播放页。
 *
 * ⚠️ **必须走 `parsePlayPage()`**，不许在本文件写 `/video/` 正则 ——
 * 那正是 `check-page-gate.mjs` 规则 1/3 在防的事
 * （2026-10-28 番剧页就是被一份手写正则判成「未生效」的）。
 *
 * 这里**只调用**、不 import 常量，因此不违反"路径字面量不许越界"。
 */
function detectPageKind(): 'play' | 'other' {
  return parsePlayPage(location.href) ? 'play' : 'other';
}

/**
 * 读主账号卡片原料。
 *
 * 播放页的实时昵称来自 `page/summary:get`（`PageTracksView.primary.user`）；
 * 非播放页读缓存显示档案（ADR 0025）。
 *
 * ⚠️ 判据（该不该读缓存、`unknown` 怎么渲染）在 `resolvePrimaryCard()`
 * 那个纯函数里，**本文件只负责"真去读"** —— 与 `popup/main.tsx` 同一个切法。
 */
async function readPrimary(
  pageKind: 'play' | 'other',
): Promise<ReturnType<typeof resolvePrimaryCard>> {
  const cached = await readPrimaryProfile().catch(() => null);
  const cache = cached ? { uname: cached.uname, level: cached.level } : null;

  /**
   * 面板这一侧拿不到"实时主账号"：`PageTracksView.primary.user` 要等
   * `page/summary:get` 的应答，而那条消息已经由 `loadPanelModel()` 在内部发过一次。
   * 为避免重复发消息，这里**只用缓存**，播放页的实时覆盖在模型重取时由
   * `panel-data` 自己拼（见 `buildPanelModel` 的 primary 参数）。
   *
   * 所以 `livePrimary` 传 `null` —— `resolvePrimaryCard` 会在播放页退到缓存兜底
   * （`loggedIn` 记 `unknown` → 显示「读取中…」而不是编一个"未登录"）。
   */
  return resolvePrimaryCard({ kind: pageKind === 'play' ? 'play' : 'other', primary: null }, cache);
}

export default defineContentScript({
  /**
   * ⚠️ 字面量，不能引用共享常量：WXT 生成 manifest 时对入口文件做**静态分析**，
   * 取不到跨文件常量的值（换成常量会让 manifest 里 `matches` 变空 = 扩展不注入）。
   *
   * 两域都要，而且**一个播放页模式都不许出现**：
   * 一旦含 `video/*` 或 `bangumi/play/*`，`check-page-gate.mjs` 规则 2c 的反向断言
   * 会把它判成"又一个播放页入口"（那个入口的规矩是「改 `content.ts`」，
   * 不是新开一个）。所以这里只写两个具体域，让面板覆盖全站但不触碰播放页判据。
   */
  matches: ['*://www.bilibili.com/*', '*://live.bilibili.com/*'],

  /** 不抢跑时序，见文件头 */
  runAt: 'document_idle',

  async main(ctx): Promise<void> {
    /** 用户是否允许显示悬浮入口（popup 唯一的开关，ADR 0033 决定三） */
    let enabled = true;
    /** 已经挂上的侧栏句柄；`null` 表示当前没挂 */
    let sidebar: ReturnType<typeof mountSidebar> | null = null;
    /** 面板编排层句柄（Tab / 返回栈 / 写入） */
    let controller: PanelController | null = null;
    /**
     * 扫码后的**一次性轮询**句柄；`null` = 没在轮询。
     *
     * ⚠️ **必须在面板收起 / 销毁时 `stop()`** —— 否则用户关掉面板后
     * 还会每 3 秒发一次 `account/summary`，白白唤醒 background。
     */
    let poller: LoginPoller | null = null;

    const pageKind = detectPageKind();

    /** 停轮询（幂等）。面板收起 / 销毁 / 重新登录前都要调 */
    const stopPolling = (): void => {
      poller?.stop();
      poller = null;
    };

    /** 读一次当前播放账号的 mid（轮询用） */
    const readAccountMid = async (): Promise<AccountSnapshot> => {
      const res = (await chrome.runtime
        .sendMessage({ type: 'account/summary' })
        .catch(() => null)) as {
        type?: string;
        account?: { profile?: { mid?: number } } | null;
      } | null;
      const mid = res?.type === 'account/summary:ok' ? (res.account?.profile?.mid ?? null) : null;
      return { mid: typeof mid === 'number' ? mid : null };
    };

    /**
     * 打开 login 窗口 —— 走 background 的既有消息，不新增类型。
     *
     * ## ⚠️ 失败必须让用户知道（2026-11-10）
     *
     * 旧实现是 `void sendMessage(...).catch(() => null)` —— **失败完全静默**，
     * 用户点了「扫码登录」什么也没发生，不知道是网络问题还是没开 InPrivate 权限。
     *
     * `login/open` 有明确的失败原因（`reason`），必须转成人话告诉用户。
     *
     * ## 成功后启动一次性轮询（2026-11-10，原 options 有、迁移时漏了）
     *
     * 扫码窗口在**无痕分区**，两个 background 实例不能通信，登录窗口没法
     * "通知"面板登录好了。唯一共享的是 `storage.local`，只能轮询。
     *
     * ⚠️ **先停旧的再开新的** —— 连点两次「重新登录」不能叠加两个轮询。
     */
    const openLogin = async (): Promise<void> => {
      // 先停旧的：用户可能是因为上一次没反应才又点的一次
      stopPolling();

      /**
       * 记下点之前的 mid —— 轮询靠"mid 变了"判断成功。
       * ⚠️ 在发 `login/open` **之前**读：读得晚可能已经把新号读到了，
       * 那样 `before` 就是新的，轮询会误判成"没变化"。
       */
      const before = (await readAccountMid().catch(() => ({ mid: null }))).mid;

      const res = (await chrome.runtime
        .sendMessage({ type: 'login/open' })
        .catch(() => null)) as LoginOpenReply | null;
      const r = describeLoginOutcome(res);
      if (controller) controller.showNotice(r.text, r.ok);

      // 只有真的打开了窗口才轮询
      if (!r.ok) return;

      poller = startLoginPolling(
        {
          read: readAccountMid,
          onDone: (outcome) => {
            poller = null;
            if (!controller) return;
            if (outcome.kind === 'configured') {
              controller.showNotice('取流账号已配置，可以开始用了', true);
              /** 重新取数，账号卡变成已配置态 */
              void loadOnce();
            } else if (outcome.kind === 'timeout') {
              controller.showNotice(
                '等了 3 分钟还没检测到新账号 —— 扫码成功了吗？也可以点「重新登录」再试一次',
                false,
              );
            }
            // cancelled：面板收起时的正常停止，不打扰用户
          },
        },
        before,
      );
    };

    /**
     * 退出播放账号（`account/remove`）。
     *
     * ## 为什么返回结果而不是 `void`
     *
     * 调用方（账号 Tab）负责显示成败 —— 但**成功后的重新取数在这里做**，
     * 因为只有这里拿得到 `loadOnce()`。
     *
     * ⚠️ **两步确认由 UI 负责**（账号 Tab 里），这里不重复判 ——
     * 否则同一件事两处实现，迟早漂移。
     */
    const removeAccount = async (): Promise<{ ok: boolean; detail?: string }> => {
      const res = (await chrome.runtime
        .sendMessage({ type: 'account/remove' })
        .catch(() => null)) as { type?: string; detail?: string } | null;

      if (res?.type === 'account/remove:ok') {
        /**
         * 成功后重新取数：账号卡要变回"未配置"态。
         * ⚠️ 不 `await` 后再返回 —— 取数失败不该让"退出成功"变成"退出失败"。
         */
        void loadOnce();
        return { ok: true };
      }
      return { ok: false, detail: res?.detail ?? '消息没有返回成功的应答' };
    };

    /**
     * ## 取流身份（2026-11-11，步骤 4）
     *
     * ### 为什么走消息而不是直接读 `storage.local`
     *
     * 切身份 ≠ 只写一个配置位：它要**重建全部 DNR 规则**（先清两类、再按新身份建）。
     * 那个流程只在 background 里（`dnr.switchStreamingIdentity`）。
     *
     * 直接写 storage 会造成最坏的一类不一致：
     * **界面显示"取流：浏览器账号"，而规则还在换 Cookie** ——
     * inventory 里那句"界面说 A、实际做 B"的老问题，只是换了方向。
     *
     * ### 失败必须让用户知道
     *
     * 用 `showNotice` 说人话。静默失败会让用户以为点坏了，反复点。
     * 与 `openLogin` / `removeAccount` 的处理一致（"点了没反应"是最糟的反馈）。
     */
    const setStreamingIdentity = async (next: StreamingIdentity): Promise<void> => {
      const res = (await chrome.runtime
        .sendMessage({ type: 'streaming/set', identity: next })
        .catch(() => null)) as { type?: string; detail?: string } | null;

      if (res?.type === 'streaming/set:ok') {
        /**
         * 成功后**重新取数**：`page/activate` 会在下次页面加载时按新身份走，
         * 而账号卡上的胶囊已经由面板乐观更新过了。这里刷一次是为了让
         * 画质卡/账号卡其余部分与最新状态一致。
         *
         * ⚠️ 不 `await`：取数失败不该让"切换成功"变成"切换失败"。
         */
        void loadOnce();
        return;
      }

      /**
       * 失败：抛出去让 `panel.ts` 的乐观更新**回滚**。
       *
       * 为什么抛而不是只提示：面板已经先把胶囊切成新值了，
       * 不抛的话用户会看到一个"成功了"的胶囊 + 一句失败提示 —— 自相矛盾。
       */
      controller?.showNotice(`取流身份切换失败：${res?.detail ?? '后台没有应答'}`, false);
      throw new Error(res?.detail ?? 'streaming/set failed');
    };

    /**
     * 读当前取流身份（胶囊初值）。
     *
     * `null` = 读不到 → 胶囊**不渲染**（不猜默认值）。
     * 与 `readFeedBoundaryEnabled` 的"读不到就保持禁用、不画成关"同一纪律。
     */
    const readStreamingIdentity = async (): Promise<StreamingIdentity | null> => {
      const res = (await chrome.runtime
        .sendMessage({ type: 'streaming/status' })
        .catch(() => null)) as { type?: string; identity?: StreamingIdentity } | null;
      return res?.type === 'streaming/status:ok' && res.identity ? res.identity : null;
    };

    /**
     * 取流身份的**缓存值**。
     *
     * ## 为什么声明在这里（2026-11-11 Bug B 修复时上移）
     *
     * 它同时被两处消费：
     *   - `loadOnce()` —— 传给 `loadPanelModel()`，决定**画质 Tab** 说真话还是说假话
     *   - `mountPanelBody()` —— 传给账号卡胶囊作初值
     *
     * 原声明在 `loadOnce` 之后（`:375`），靠 `let` 的 TDZ 之外执行顺序侥幸能用，
     * 但**读代码的人会先看到 `loadOnce` 用了它、后看到它没有声明** ——
     * 这种"先用后声明"是最容易误判成 bug 的形状。上移到使用点之前。
     *
     * ## 三个值
     *
     * | 值 | 含义 | 表现 |
     * | --- | --- | --- |
     * | `undefined` | **还没读** | 胶囊渲染「未知」态；画质 Tab 走既有判据 |
     * | `null` | 读失败 | 同上（**但不再永久缓存**，见 `ensureStreamingIdentityRead`） |
     * | `'extension' \| 'page'` | 真实配置 | 正常渲染 |
     *
     * ⚠️ **未知态也渲染**（2026-11-11 修正）。上一版是"读不到就整块不渲染"，
     * 理由"不猜默认值"——但**控件消失不是安全默认值，而是隐形 bug**：
     * 用户看不见就以为功能没做。不猜**内容** ≠ 删掉**入口**。
     */
    let streamingIdentityCache: StreamingIdentity | null | undefined = undefined;

    /**
     * ── 首页推荐流开关的缓存（2026-11-11）──
     *
     * ## ⚠️ 它与 `streamingIdentityCache` 是**两件独立的事**
     *
     * 用户原话：「首页推荐流的变化与取流身份是完全独立的两个功能」。
     *
     * | 状态 | 数据源 | 谁写 |
     * | --- | --- | --- |
     * | `streamingIdentityCache` | `streaming/status` 消息 | `streaming/set` |
     * | **`feedAccountCache`** | **`storage.local` 的 `pluma:feed-account-enabled`** | **本开关自己** |
     *
     * 两者**互不派生、互不重置**。
     *
     * 默认 `false`（新功能默认关），不存在"还没读出来"的三态 ——
     * 读失败按 `false` 处理：**宁可显示成关，也不要因为读失败而画成开**
     * （那会让用户以为功能在生效）。
     */
    let feedAccountCache = false;

    /**
     * 取一次数据并塞进面板。
     *
     * ⚠️ 失败时**不抛**：面板已经画出来了，取数失败只是让各块显示"未知"，
     * 不该让整个面板（或页面控制台）报错。
     *
     * ## 编排（节流 / 并发 / 重试）不在这里
     *
     * 全部搬到了 `src/content/panel/open-cycler.ts` —— 那部分依赖只有
     * "取数 + 是否还活着 + 定时器"，抽出来就能**直接单测真实实现**，
     * 不必在测试里镜像一份逻辑（阶段 2 的折中，会漂移）。
     *
     * 本函数只负责"真去取"这一步。
     *
     * @returns 本次取数的结局（供 open-cycler 决定要不要排 `not-ready` 重试）。
     *   取数抛错时返回 `null`（open-cycler 会当作普通失败，不排重试）。
     */
    const loadOnce = async (): Promise<LoadResult | null> => {
      if (!controller) return null;
      try {
        const primary = await readPrimary(pageKind);
        /**
         * ⚠️ **必须传 `streamingIdentity`**（2026-11-11，Bug B 修复）。
         *
         * 不传的话 `describePopup()` 里 `if (snap.streamingIdentity === 'page')`
         * 那条短路永远不触发 → `page` 模式下画质 Tab 会显示「已接管」，
         * 而 `page` 模式下**什么都没换 Cookie** —— 那是假话。
         *
         * 这里用缓存值：`ensureStreamingIdentityRead()` 在挂载前已读过一次并缓存，
         * `toggleStreamingIdentity` 成功后也会更新它。
         */
        const model = await loadPanelModel({
          pageKind,
          primary,
          streamingIdentity: streamingIdentityCache ?? null,
        });
        /**
         * ⚠️ 这里**不再判"是不是最新的一次"** —— 那个判据在 `open-cycler` 里
         * （它持有序号）。这里只保证"取到就画"。
         *
         * 但 controller 可能在 await 期间被卸掉（用户关开关），所以仍要判一次。
         */
        if (!controller) return null;
        controller.setModel(model);
        return { pageStateKind: model.pageStateKind };
      } catch {
        // 取不到就保持上一次的画面（或"正在读取…"），不做任何编造
        return null;
      }
    };

    /**
     * 展开重取 / 节流 / 并发 / `not-ready` 重试的编排。
     *
     * 依赖只有三个，全部注入 → 本模块不碰 `chrome.*` 与 DOM，能在 Node 里直接测。
     */
    const cycler = createOpenCycler({
      load: loadOnce,
      isActive: () => enabled && controller !== null,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    });

    /**
     * 读取流身份并缓存。
     *
     * ## ⚠️ 只缓存**成功**的结果（2026-11-11 修正）
     *
     * 上一版 `streamingIdentityCache = await readStreamingIdentity().catch(() => null)`
     * 把失败也**永久缓存**成 `null`：
     *
     * ```
     * 第一次读 → 失败 → 缓存 null
     * 之后每次 ensureStreamingIdentityRead() → 命中缓存 → 直接 return
     * → 这一页生命周期内**永不重试**
     * ```
     *
     * 后果：**用户不刷新页面就永远看不到胶囊**，即使 background 后来恢复了。
     *
     * 现在的规则：
     *   - 成功（`'extension'` / `'page'`）→ 缓存，不再重复请求
     *   - 失败（`null`）→ **不缓存**，下次开面板会再试
     *
     * ## 为什么不会"无限重试"
     *
     * 这个函数只在**面板挂载前**调一次（`main()` 里那句 `await`），
     * 收起重开才会再走。**用户不开面板就没有请求** —— 不存在轮询放大的风险。
     */
    const ensureStreamingIdentityRead = async (): Promise<void> => {
      if (streamingIdentityCache !== undefined) return;
      const v = await readStreamingIdentity().catch(() => null);
      // 只在拿到真实值时写缓存；`null` 保持 undefined，下次重试
      if (v !== null) streamingIdentityCache = v;
    };

    /**
     * 读首页推荐流开关的初值（挂载前调一次）。
     *
     * ⚠️ **读失败按 `false` 处理**，不保持"未读"三态 ——
     * 理由与身份不同：身份读失败要显示「未知」（因为那是用户选的、有明确值），
     * 而本开关读失败时**画成"开"会让用户以为功能在生效**，
     * 画成"关"最多是"没生效"，方向更安全。
     */
    const ensureFeedAccountRead = async (): Promise<void> => {
      feedAccountCache = await readFeedAccountEnabled().catch(() => false);
    };

    /**
     * 拨开关 → 写 `storage.local`。
     *
     * ## 为什么不需要走 background 消息（与取流身份不同）
     *
     * | | 取流身份 | **推荐流开关** |
     * | --- | --- | --- |
     * | 写存储后要做什么 | **重建 DNR 规则**（`switchStreamingIdentity`） | **同样要重建**（`applyRulePlan`） |
     * | 所以必须走消息吗 | 是 | **是** |
     *
     * 所以这里也走一条消息（`feed-account/set`），由 background 写存储并调
     * `applyRulePlan()` —— **面板不直接写 storage**，否则规则不会重建。
     */
    const setFeedAccount = async (next: boolean): Promise<void> => {
      const res = (await chrome.runtime
        .sendMessage({ type: 'feed-account/set', enabled: next })
        .catch(() => null)) as { type?: string; detail?: string } | null;
      if (res?.type !== 'feed-account/set:ok') {
        throw new Error(res?.detail ?? 'feed-account/set failed');
      }
      feedAccountCache = next;
    };

    /** 按当前开关重画：开 → 挂（幂等），关 → 摘 */
    const paint = (): void => {
      if (!enabled) {
        cycler.dispose();
        controller = null;
        /**
         * ⚠️ **先 `dispose()` 再置 null** —— sidebar 在 `document` 上挂了
         * 一个点击监听（"点面板外退出钉住态"）。不摘的话它会指向已删除的 DOM，
         * 每点一次页面就跑一次无用回调，长期累积。
         */
        sidebar?.dispose();
        sidebar = null;
        // 面板整个没了，轮询没有意义（否则关闭开关后还在每 3 秒发一次消息）
        stopPolling();
        removePanelHost();
        return;
      }
      // 已挂就不重建：ensurePanelHost 幂等，但 build 只在新建时跑一次
      if (sidebar !== null) return;
      const shadow = ensurePanelHost(tokensCss, PANEL_CSS, (s) => {
        /**
         * 建主体 → 塞进 sheet。
         *
         * ⚠️ `mountPanelBody` 的 `root` 必须在 `mountSidebar` **之前**建出来，
         * 因为 `mountSidebar` 会把它 append 进 sheet。顺序反了就塞不进去。
         */
        const body = mountPanelBody({
          login: () => void openLogin(),
          logout: removeAccount,
          // `undefined` → 传 null（面板视"还没读"与"读不到"为同一表现：胶囊不渲染）
          streamingIdentity: streamingIdentityCache ?? null,
          toggleStreamingIdentity: (next) => {
            // 成功后同步缓存，下次重挂载时不会退回旧值
            void setStreamingIdentity(next)
              .then(() => {
                streamingIdentityCache = next;
              })
              .catch(() => {
                /* 失败已由 setStreamingIdentity 内部提示 + 面板回滚 */
              });
          },
          /**
           * ⚠️ 推荐流开关与上面的身份**独立**：各自的缓存、各自的回调。
           * 不要在这里把两者写成联动（例如 toggle 时顺带改身份）。
           */
          feedAccountEnabled: feedAccountCache,
          toggleFeedAccount: (next) => {
            void setFeedAccount(next)
              .then(() => {
                feedAccountCache = next;
              })
              .catch(() => {
                /* 失败由面板回滚 + setFeedAccount 抛错 */
              });
          },
        });
        controller = body;
        sidebar = mountSidebar(s, {
          body: body.root,
          /**
           * 每次「收起 → 展开」都重新取数（修 1，2026-11-10 真机根因 2）。
           *
           * 挂载时那次取数拿到的可能是 `pageState` 的**初始化态**
           * （`pageKey` 有值、`playback` 为 null），而它不会自己变新 ——
           * `paint()` 的 `if (sidebar !== null) return` 短路了所有后续取数。
           * 用户重新 hover 就刷新，是最自然、零成本的修复。
           */
          onOpen: () => cycler.open(),
          /**
           * 收起面板 → 停轮询（2026-11-10）。
           *
           * 面板都看不见了还在每 3 秒发一次 `account/summary` 毫无意义。
           * ⚠️ 不要在这里提示用户"已取消" —— 收起面板是正常操作，不是失败。
           */
          onClose: () => stopPolling(),
        });
      });
      if (shadow === null) {
        sidebar = null;
        controller = null;
        return;
      }
      // 首屏也取一次（挂载时可能已是展开态，或不展开也想预热数据）
      void loadOnce();
    };

    enabled = await readPanelEntryEnabled();
    /**
     * 先在挂载前把取流身份读好。
     *
     * 为什么必须 `await` 在这里而不是在 `ensurePanelHost` 的 build 回调里：
     * 那个回调是**同步**的（要立刻返回 shadow root），而这是异步消息。
     *
     * 代价：面板首次挂载前多一次消息往返（`storage.local` 级，通常 <5ms）。
     * 用"读失败也挂载"兜底：`readStreamingIdentity` 内部已 `catch` 成 `null`，
     * 所以即使 background 没应答，面板也照常出现，只是不渲染胶囊 ——
     * **不因为一个附属信息读不到就让整个面板不出现**。
     */
    await ensureStreamingIdentityRead();
    /**
     * 推荐流开关的初值也要在挂载前读好 —— 与身份那次 read **并列**，不是嵌套。
     *
     * ⚠️ 两次读可以并行（`Promise.all`），但这里保持顺序 await 是刻意的：
     * 两者独立、互不依赖，先写哪个都不影响正确性；
     * 分成两行是为了让"这是两件不同的事"在代码形状上也看得见。
     */
    await ensureFeedAccountRead();
    paint();

    /**
     * 开关变化 → 立即生效，不用刷新页面。
     *
     * 与角标开关同一模式（`entrypoints/content.ts` 的 `BADGE_ENABLED_KEY` 监听）。
     * 之所以必须监听而不是"开页时读一次"：popup 保存后页面已经加载完了，
     * 不监听就得让用户刷新 —— 而 popup 的文案不会说"刷新生效"。
     */
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local') return;
      const change = changes[PANEL_ENTRY_ENABLED_KEY];
      if (!change) return;
      enabled = change.newValue !== false;
      paint();
    };
    chrome.storage.onChanged.addListener(onChanged);

    /**
     * 扩展被重新加载时摘掉面板 —— 否则页面上会留一个点了没反应的死壳
     * （旧 content script 的 chrome API 已失效，但 DOM 还在）。
     */
    ctx.onInvalidated(() => {
      chrome.storage.onChanged.removeListener(onChanged);
      cycler.dispose();
      // 摘掉 sidebar 在 document 上挂的点击监听（见 `paint()` 里的同段注释）
      sidebar?.dispose();
      // 扩展失效（重载 / 卸载）→ 必须清轮询定时器，否则它挂在已失效的上下文里
      stopPolling();
      sidebar = null;
      controller = null;
      removePanelHost();
    });
  },
});

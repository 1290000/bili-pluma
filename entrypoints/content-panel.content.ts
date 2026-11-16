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
import {
  mountPanelBody,
  NOTICE_LOAD_FAILED,
  NOTICE_LOGOUT_REFRESH_FAILED,
  type PanelController,
} from '@/src/content/panel/panel';
import { loadPanelModel } from '@/src/content/panel/panel-data';
import { createOpenCycler, type LoadResult } from '@/src/content/panel/open-cycler';
import {
  ALREADY_ASKED_TEXT,
  describeLoginOutcome,
  REPEAT_GUARD_MS,
  type LoginOpenReply,
} from '@/src/content/panel/login-outcome';
import {
  startLoginPolling,
  type AccountSnapshot,
  type LoginPoller,
} from '@/src/content/panel/login-poller';
import { resolvePrimaryCard } from '@shared/utils/primary-card';
import type { StreamingIdentity } from '@shared/constants/streaming-identity';
import { parsePlayPage } from '@shared/utils/video-page';
import { readPrimaryProfile } from '@platform/storage/primary-profile-store';
import { UPDATE_STATE_KEY } from '@platform/update/state-store';
import { currentVersion } from '@platform/update/version';
/**
 * `storage.onChanged` 拿到的是**归一化之前**的原始值，要变成面板认识的
 * `UpdateStatusView` 必须走 `toStatusView` —— 那是唯一实现（`phase` 判据在
 * `resolvePhase` 里，重写一份必然漂移）。
 *
 * ⚠️ 这两个都在 **core**（`@core/update/state`），不在 background 的 handler 里：
 * 本文件是 **content script**，不许依赖 background 的代码（AGENTS.md §5.1 的
 * `entrypoints → background` 是给 SW 入口用的）。2026-11-17 之前这里 import 过
 * `@/src/background/handlers/update.handler`，属于那笔债，已清。
 */
import { normalizeUpdateState, toStatusView } from '@core/update/state';
import {
  PANEL_ENTRY_ENABLED_KEY,
  readFeedAccountEnabled,
  readPanelEntryEnabled,
} from '@platform/storage/ui-prefs-store';
/**
 * 孤儿态自愈提示（task-33）。
 *
 * ⚠️ 这条路径**必须不依赖 `controller`** —— 孤儿态下它最容易是 null，
 * 而旧代码写的是 `if (controller) controller.showNotice(...)`（等于静默）。
 * 详见 `src/content/panel/orphan-hint.ts` 文件头。
 */
import {
  isOrphanError,
  isOrphanHintShown,
  showOrphanHint,
  startOrphanWatch,
} from '@/src/content/panel/orphan-hint';
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

/**
 * 活跃探活的心跳间隔 —— **已于 task-35 删除**。
 *
 * 曾有 `const PANEL_ALIVE_PROBE_MS = 20_000` 配一个 `setInterval`。撤掉的理由：
 * 没有 `document.hidden` 判断 ⇒ 每个后台 B 站标签页永久每 20s 唤醒 SW；
 * 且清理它的 `ctx.onInvalidated` 从不触发 ⇒ 心跳没有回收点。
 * 现在改成**动作驱动**（启动一次 / 点击 / `visibilitychange`），见 `main()`。
 *
 * ⚠️ 不要因为"探活不频繁了"就把这个常量加回来 —— 加了就等于恢复常驻轮询。
 */

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

    /**
     * ## 面板侧「刚点过扫码登录」的记忆（2026-11-15，task-44 缺陷 2）
     *
     * 存**上一次 `ok:true / reason:'assumed'` 的时间戳**；`null` = 没点过或已过期。
     *
     * ### 为什么需要它
     *
     * 真机实测（task-44 卡）：两次点击 ⇒ `windows.create` 跑两次 ⇒
     * 屏幕上多出**两个** 420×600 的二维码窗叠在一起（`windowsAfter` 4 → 6）。
     * 用户付了代价，只得到一次"我更确认了"。
     *
     * background 侧本来有 `probeExistingLoginWindow()` 想拦住第二次，
     * 但它靠**跨分区心跳**，而 split 模式下实测 `probe/heartbeat` **永远是 `none`**
     * —— 那条路在本机不存在。所以第二次点击必然又开一个窗口。
     *
     * 面板这一侧**知道一件事**：用户在这个 tab 刚点过。这就够拦第二次了。
     * 不需要知道窗口在不在（知道的话就轮到 background 了）。
     *
     * ### 为什么放这里（而不是 storage / 模块级 / 面板 controller）
     *
     * - **`main(ctx)` 闭包变量** ⇒ 天然「按 tab」：每个标签页各有一份 content script 实例。
     * - **内存级** ⇒ 页面刷新 / 扩展重载自动归零。这正是想要的：
     *   刷新页面 = 用户明确表示"我要重来"，此时**不该**继续拦他。
     * - **不写 storage**（卡里的硬约束）⇒ 不引入新的持久化面、不需要清理、
     *   不会跨标签页串味、也不会在扩展更新后留下一条过期的"刚点过"。
     * - 放在 `main()` 里而不是模块顶层：模块顶层在**同一页面**内也是单例，
     *   但 `main()` 更明确地表达"跟随这个页面实例"，和外层 `poller` 同一生命周期。
     *
     * 没有 `ctx.onInvalidated` 清理：闭包随页面卸载一起消失，
     * 清理是**不需要**的（不是"忘了写"，见 `probeAlive()` 上方同样的声明）。
     */
    /**
     * ## ⚠️ 临时债（**将来要整段删掉**，不是既有约定）—— 2026-11-15，task-47
     *
     * 这个变量现在**任何地方都不会被赋值**（赋值那一行已被删除，原因见
     * `openLogin()` 里那句 `⚠️ 这里**曾经**给「面板侧重复点击记忆」计时`）。
     * 于是 `shouldSkipRepeatOpen()` 恒 `false`，"发消息之前靠时间拦下第二次点击"
     * 这套推断**彻底作废**：窗口是否还开着已交给 background 的存活探测（pong）裁决。
     *
     * ### 本轮为什么留着（而不是现在就删）
     *
     * 删它要连带删掉 `lastAssumedAt` / `shouldSkipRepeatOpen` /
     * `ALREADY_ASKED_TEXT` / `REPEAT_GUARD_MS` **四样**，以及
     * `tests/unit/content/panel/assumed-repeat-guard.test.ts` 里
     * 约 200 行探针（`shouldSkipBody()` 直接从源码切片，删函数就删测试）。
     * 而当前时点是"修复已过真机验证、即将终验交付"—— **终验前不动**，
     * 避免把一次纯清理变成一轮新回归。
     *
     * ### 将来怎么处理（清理边界，照做即可）
     *
     * **整段删除**这四样 + 对应的探针组：
     * `lastAssumedAt`、`shouldSkipRepeatOpen`（本文件）、
     * `ALREADY_ASKED_TEXT`、`REPEAT_GUARD_MS`（`login-outcome.ts`），
     * 以及本文件里 `if (shouldSkipRepeatOpen()) { … }` 整块与其 import。
     * 那时这条 `eslint-disable` 也随之消失。
     *
     * **绝不要**反过来"修复"它（把赋值加回去）：接活 = 用户关窗后 2 分钟内
     * 点不出窗口 = 那个「点了没反应」原样复发（而且这次是我们主动拦的）。
     * 行为守卫：`assumed-repeat-guard.test.ts` 的
     * 「连续两次点击必须都发到 background」—— 谁接活，那条必红。
     *
     * ⚠️ lint 说明：`prefer-const` 会要求改成 `const`，但改成 `const` 后
     * `lastAssumedAt !== null` 会被 TS 收窄、下一句 `Date.now() - lastAssumedAt`
     * 直接报类型错。所以**临时**保留 `let` 并关掉那一条规则。
     */
    // eslint-disable-next-line prefer-const -- 临时债，见上方两节（为什么留着 / 将来怎么删）
    let lastAssumedAt: number | null = null;

    /**
     * 判断这次点击是否该被拦下（task-44 缺陷 2）。
     *
     * 只在**未过期**时返回 true。判据是**纯时间**，不看 background 的应答
     * —— 这正是它与 `already-open` 的区别：那个要等消息回来且依赖心跳，
     * 这个在**发消息之前**就能下结论。
     */
    const shouldSkipRepeatOpen = (): boolean =>
      lastAssumedAt !== null && Date.now() - lastAssumedAt < REPEAT_GUARD_MS;

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
      /**
       * ## 同步孤儿守卫（task-39 / task-41-B，必须排在**一切**前面）
       *
       * 判据：`chrome` 本身没了，或者 `chrome.runtime` 没了 / `id` 读不到。
       *
       * ### 为什么必须写 `typeof chrome === 'undefined'`
       *
       * 运行时探针实测（verifier 报回的真机形态）：`chrome` **整体不存在**时
       * `chrome.runtime?.id` 会先抛 `TypeError: Cannot read properties of
       * undefined (reading 'runtime')` —— `?.` 只保护 `runtime` 那一侧，
       * 管不住 `chrome` 本身。守卫在自己那行同步抛，`showOrphanHint()`
       * 永远轮不到 ⇒ 用户看到的就是**"点了完全没反应"**，而这正是本报的缺陷。
       * 所以 `typeof` 判断必须在前，且**不能**写成 `chrome?.runtime?.id`。
       *
       * ### 为什么必须是同步的、而且必须在这里
       *
       * 下面 `controller?.clearNotice()`、`stopPolling()`、`await readAccountMid()`
       * 和 `await sendMessage(...)` 全都在之后。面板半失活（controller 还在、
       * 扩展上下文已换人）时 `sendMessage` 可能是**同步抛**的，`.catch()` 根本不跑。
       * 守卫挂晚了就轮不到它，所以放在**第一行** —— 连 `stopPolling()` 之前。
       *
       * ### 已知边界（不是缺陷，是取舍）
       *
       * 「`chrome` 与 `runtime` 都还在、但 handler 已经换人」这种形态本守卫**不覆盖**。
       * 那需要跨代可观测信号（例如 DOM 上的代次标记），而该机制**没有任何实测证据
       * 证明这个形态真实存在**，误报代价却是给正常用户弹「请刷新」。
       * 本轮裁决：不引入没证据的机制去守没证据的形态（详见 task-41 卡）。
       * 这一形态若真出现，落点在后面的 `.catch`（修 C）。
       */
      const orphan = typeof chrome === 'undefined' || chrome.runtime?.id == null;
      if (orphan) {
        showOrphanHint();
        return;
      }

      // 先停旧的：用户可能是因为上一次没反应才又点的一次
      stopPolling();

      /**
       * ## 点下去的第一时间**先清掉上一条提示**（2026-11-12，裁决 3）
       *
       * 取证 D.2：用户开完 InPrivate 权限回到网页再点这个按钮，底下还挂着
       * **上一次**的红字（「等了 3 分钟还没检测到新账号…」）。新提示确实会替换旧的，
       * 但两条红字长得一样 —— 用户分不清"这次的失败"还是"上次留下的"，
       * 于是以为"权限开了也没用"，只能刷新整页。
       *
       * 清掉之后，**屏幕上出现一条红字就只可能是这一次的失败**。
       *
       * ⚠️ 清的是**上一次**，不是给"这一次"的失败加超时 ——
       * 失败提示照旧常驻（`panel.ts` 的论证成立，裁决 3 明令不许改）。
       * ⚠️ 也**不许**用时间戳/序号区分新旧（那是把内部状态推给用户）。
       *
       * 顺序：先清、再读 mid、再发消息。清必须发生在**任何 await 之前**，
       * 否则用户看到的是"红字还留着，过了几百毫秒才消失"。
       */
      controller?.clearNotice();

      /**
       * ## 缺陷 2：第二次点击**不再发 `login/open`**（2026-11-15，task-44）
       *
       * ### 为什么拦在**这里**（发消息之前）
       *
       * 位置决定代价：拦在 `sendMessage` 之前 ⇒ **background 根本不知道有这次点击**
       * ⇒ 不会有第二次 `windows.create` ⇒ 屏幕上不会多出第二个二维码窗。
       * 拦在后面就等于"开了再关"，那既晚了也有新问题（关哪个？）。
       *
       * 顺序也很重要：**在 `clearNotice()` 之后**。用户看到的行为是
       * 「上一条提示先清空 → 立刻出现这一条」，而不是"旧的还挂着，新的叠上来"。
       *
       * ### 为什么不复用 `already-open`
       *
       * `already-open` 是 background 侧的结论，依赖 `probeExistingLoginWindow()`
       * 读跨分区心跳；真机实测**永远是 `none`**（task-44 卡），那条分支从未命中。
       * 本判据只看**面板自己记得的"我刚点过"**，在发消息之前就能下结论，
       * 不依赖任何跨分区通道 —— 这正是"面板侧能自己做的事"。
       *
       * ### 拦住之后**不**更新 `lastAssumedAt`
       *
       * 让窗口的起点固定在第一下点击。否则用户连点十次就把 2 分钟越推越远，
       * 变成"越点越开不出来"。现在最坏情况是：用户干等 2 分钟自动放行。
       */
      if (shouldSkipRepeatOpen()) {
        /**
         * `shouldPoll: false` 由这里直接表达（不经过 `describeLoginOutcome`）：
         * 我们要的是"好消息 + 不轮询"，但**没有**任何 `login/open` 应答可翻译。
         * 走 `describeLoginOutcome` 会需要一个假的 `already-open` 应答，
         * 那等于把"面板猜的"伪装成"background 说的"—— 两层混淆，不干。
         */
        if (!isOrphanHintShown()) controller?.showNotice(ALREADY_ASKED_TEXT, true);
        if (!isOrphanHintShown() && controller === null) showOrphanHint();
        return;
      }

      /**
       * 记下点之前的 mid —— 轮询靠"mid 变了"判断成功。
       * ⚠️ 在发 `login/open` **之前**读：读得晚可能已经把新号读到了，
       * 那样 `before` 就是新的，轮询会误判成"没变化"。
       *
       * ## 修 A（task-41）：同步抛也必须兜住
       *
       * 原来只写 `.catch(() => ({ mid: null }))` —— 那只管**异步** reject。
       * 上下文失效时 `chrome.runtime.sendMessage` 可能是**同步抛**的，
       * `.catch()` 根本来不及挂上，异常直接冲出 `openLogin`（一个未被捕获的
       * rejected promise ⇒ 用户看到"点了完全没反应"）。所以外面再包一层 try/catch，
       * 两层都归一到 `{ mid: null }` —— `mid` 读不到只影响"能不能判断轮询成功"，
       * 不该让整次点击中止。
       */
      /**
       * 记下点之前的 mid —— 轮询靠"mid 变了"判断成功。
       * ⚠️ 在发 `login/open` **之前**读：读得晚可能已经把新号读到了，
       * 那样 `before` 就是新的，轮询会误判成"没变化"。
       *
       * 不需要额外的 try/catch：`readAccountMid()` 内部自带 `.catch`，
       * 这里再挂一层 `.catch`。产物里它是**内联在 `let` 初始化式里**直接调用的
       * （investigator 拆产物确认），抛不出来（task-41 修 A 已作废）。
       */
      const beforeMid = (await readAccountMid().catch(() => ({ mid: null }))).mid;

      /**
       * ## 发 `login/open`：**任何失败都必须留痕**（task-41 修 C，本轮真正的洞）
       *
       * ### 为什么不能写 `.catch(...)`
       *
       * `chrome.runtime.sendMessage({...})` 是**普通函数调用**。孤儿态下它
       * **同步抛**，而同步抛发生在 `.catch(...)` 被挂上**之前** ——
       * `.catch` 里的 `showOrphanHint()` 一次都不会执行，异常冲出 `openLogin`
       * 变成一个没人处理的 rejected promise（`:590` 的 `void openLogin()` 直接丢掉）
       * ⇒ **零提示 + 零 diag + 零心跳**。
       *
       * 这正是 20:04 那次的指纹：`pluma:build-proof3` 320 次（扩展活着）、
       * `pluma:diag` 0 次、20:04:00 有心跳（+928ms），而 20:04 点击零记录。
       * 消息根本没发到 background，异常在上游就没了。
       *
       * ### 判据：走到 catch = 点了没反应 = 必须告诉用户
       *
       * **不许**再写 `if (isOrphanError(e)) { … } res = null;` 那种
       * "不是孤儿错就静默继续"的写法 —— 对用户来说两者没有区别，
       * 都是"点了一下，什么都没发生"。所以 catch 里**所有路径**都挂提示后返回，
       * 不再往下走 `describeLoginOutcome(null)`（那条路要依赖 `controller`，
       * 而孤儿态下它偏偏最可能是 null，等于又回到静默）。
       */
      let res: LoginOpenReply | null = null;
      try {
        res = (await chrome.runtime.sendMessage({ type: 'login/open' })) as LoginOpenReply | null;
      } catch (e) {
        /**
         * 走到这里 = 消息没发出去。同步抛与异步 reject 都在这里。
         *
         * `e` 只用来写注释级诊断，**不参与判据** —— 判据就是"catch 到了"。
         * `isOrphanError` 仍然引用一下，避免它成为只有别处用的死导入；
         * 同时把真实错误串留在异常上下文里，便于真机排查。
         */
        void isOrphanError(e);
        showOrphanHint();
        return;
      }
      const r = describeLoginOutcome(res);
      /**
       * ## ⚠️ 这里**曾经**给「面板侧重复点击记忆」计时 —— 现在**故意不计**（2026-11-15，task-47）
       *
       * 旧代码是 `if (r.ok && res?.reason === 'assumed') lastAssumedAt = Date.now();`
       *
       * ### 它之前为什么是死代码
       *
       * task-46 把 `assumed` 的口径改成 `opened: false`，而 `describeLoginOutcome()`
       * 对 `opened !== true` 一律返回 `ok: false` ⇒ `r.ok` 恒 false ⇒
       * `lastAssumedAt` **永远不被赋值** ⇒ 下面的 `shouldSkipRepeatOpen()` 恒 false。
       * 也就是说 task-44 的"防连点多开"**其实早已失效**。
       *
       * ### 现在它更不可能生效，而且是**故意的**
       *
       * task-47 把 `assumed` 改回 `ok: true`（正常路径不该报红，见
       * `src/content/panel/login-outcome.ts`）—— 这一改会让上面那个条件**成立**，
       * 于是这套计时器**活过来**。而它一旦活过来，后果是：
       *
       * > 用户关掉扫码窗后 2 分钟内再点「扫码登录」⇒ 面板**根本不发 `login/open`**，
       * > 只显示「刚已经开过一次，别重复点」⇒ **窗口开不出来、用户被拦住**。
       *
       * 那正是**验收标准 1** 要禁止的行为（关窗后 ≤5 秒再点必须能开出新窗口），
       * 也与 `assumed` 新文案里的「还是没有就再点一次」直接矛盾。
       *
       * ### 所以：判定权已经从"面板猜"交给 background 的**存活探测**
       *
       * 窗口是否还开着，现在由 `probeExistingLoginWindow()` 发 ping、页面当场回 pong
       * 来裁决（不受节流影响）；窗口真开着 ⇒ 返回 `already-open` ⇒ **不会多开**。
       * 于是"在发消息之前靠时间猜"这套推断**没有任何存在理由**了。
       *
       * ### ⚠️ 临时债（将来整段删除，见 `lastAssumedAt` 声明处的清理边界）
       *
       * `lastAssumedAt` / `shouldSkipRepeatOpen()` / `ALREADY_ASKED_TEXT` /
       * `REPEAT_GUARD_MS` 现在全部是**死代码**（永不被赋值 ⇒ 永不触发）。
       * **要修的正确方向是整段删掉这套时间推断，绝不是把它接活。**
       * 把它接活 = 让用户在关窗后 2 分钟内点不出窗口 = 用户报的那个
       * 「点了没反应」原样复发（而且这次是我们主动拦的）。
       *
       * 行为守卫：`tests/unit/content/panel/assumed-repeat-guard.test.ts` 的
       * 「连续两次点击必须都发到 background」—— 谁把这件事接活，那条必红。
       */
      /**
       * ⚠️ 孤儿态已经由 `showOrphanHint()` 给了明确提示，
       * 这里不要再叠一条长驻红字（两条提示会互相覆盖、反而更乱）。
       */
      if (!isOrphanHintShown()) controller?.showNotice(r.text, r.ok);
      /**
       * ⚠️ 还有一种形状：`controller` 为 null 且**不是**孤儿态
       * （例如面板刚被开关逻辑卸掉、或 `paint()` 还没建出 body）。
       * 那时 `showNotice` 整句被跳过 —— 用户点了还是没反应。
       * 所以补一条与 controller 无关的兜底：提示接不上就自己挂到 document 上。
       * 这不是孤儿也必须给反馈（任务卡三-B：**绝对不许静默失败**）。
       */
      if (!isOrphanHintShown() && controller === null) showOrphanHint();

      /**
       * ## 跳过轮询看 `shouldPoll`，**不看** `ok`（2026-11-12，task-25）
       *
       * 原来是 `if (!r.ok) return;` —— 拿"这条提示是不是坏消息"当
       * "要不要轮询"用。两件事被一个布尔量绑死，于是 `already-open`
       * 为了不轮询只能取 `ok: false`，结果红色常驻、用户以为出错了。
       *
       * 现在分开了：`ok` 只决定提示的颜色与是否自动消失，
       * `shouldPoll` 才决定这里要不要早退。
       *
       * 判据本意仍是「只有真的打开了窗口才轮询」：
       * 窗口已开着（`already-open`）时它自己就在跑轮询，再启一轮只是重复请求。
       */
      if (!r.shouldPoll) return;

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
        beforeMid,
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
         *
         * ## 但重取失败**必须告诉用户**（2026-11-12，task-3 裁决 1 第 4 条）
         *
         * 旧实现 `void loadOnce()` 完全不管结局。而退出后界面能不能变
         * **完全取决于这次重取**：失败 → 面板保持旧模型 → 取流卡片还在、
         * 按钮还是「重新登录」→ 用户看到的就是「点了确认退出，什么都没变」。
         *
         * `loadOnce()` 成功时会 `setModel()` 重画，而**成功提示由账号 Tab 自己发**
         * （`notifyResult`，见 `tabs.ts`）。所以这里只兜**失败**那一侧，
         * 且必须**覆盖**刚写的那句成功提示 —— 否则用户读到的"已退出"
         * 搭配的是一张还画着旧账号的卡，自相矛盾。
         *
         * ⚠️ 文案一字不改（裁决文件）：
         * 「已退出，但界面刷新失败 —— 收起重开面板可刷新」
         */
        void loadOnce().then((r) => {
          if (r === null) {
            controller?.showNotice(NOTICE_LOGOUT_REFRESH_FAILED, false);
          }
        });
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
        /**
         * ## 取数失败**不再静默**（2026-11-12，task-3 修路径①）
         *
         * 旧实现是裸 `catch { return null; }`：既不重画也不提示，
         * 面板**保持上一帧的模型**。退出路径上这表现为
         * 「点了确认退出，界面什么都没变」（取证 A 节路径①）——
         * 因为旧模型里 `hasCredential` 仍是 true、`pb` 仍非空。
         *
         * ## 为什么**不**改成 `throw`
         *
         * `open-cycler` 把返回值当判据：`null` = 普通失败、**不排 `not-ready` 重试**
         * （见 `:354-355` 那段注释与 `open-cycler.ts` 的 `scheduleRetry`）。
         * 改成抛会让异常穿过 `load()` 进入 `cycler.run()` 的 `catch`，
         * 虽然结果同样是 `null`，但**语义**从"这次取数失败"变成"抛了个异常"，
         * 而且以后任何调用方都会被迫处理异常 —— 修一个 bug 引入另一个。
         *
         * **要的是让失败可见，不是让失败变响。** 所以返回值形状**一个字不变**，
         * 只多一条用户能看见的提示。
         *
         * ## 提示文案为什么是这句
         *
         * 它同时覆盖三种原因（消息没应答 / 并发任一条失败 / 解析抛错），
         * 而**失败归因**不能编 —— 面板拿不到"是哪一步坏了"。
         * 但用户至少要知道"不是你没点到，是这次没取到"，
         * 并且有一个**真能做的动作**（收起重开 = 再取一次）。
         *
         * ⚠️ 走 `showNotice`（`root` 级、跨 `replaceChildren` 存活），
         * 不另造第二套提示机制。失败色 → **常驻**，用户不会错过。
         */
        controller?.showNotice(NOTICE_LOAD_FAILED, false);
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
        /**
         * ## 失败必须让用户知道（2026-11-12，task-5 静默点 6）
         *
         * 旧实现只 `throw`，而调用方是：
         * ```
         * void setFeedAccount(next).then(...).catch(() => { /* 失败由面板回滚 *\/ });
         * ```
         * **那个注释是错的**：`PanelActions.toggleFeedAccount` 的签名是
         * `(next: boolean) => void` —— 面板 `await` 到的是 `undefined`，
         * 它的 `try/catch` **永远不会进入**：
         *   - 不会回滚（开关停在用户拨的新值上）
         *   - 不会提示（一个字都没有）
         *
         * 而**规则根本没重建** —— 用户看到开关是"开"，实际没生效。
         * 这是本项目的典型形状：「界面说 A、实际做 B」。
         *
         * 修法对齐 `setStreamingIdentity`（那个失败时会 `showNotice`）：
         * 在这里说人话，然后**仍然抛出去**（保持调用链的失败语义不变）。
         */
        controller?.showNotice('首页推荐流开关没保存成功 —— 稍后再拨一次', false);
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
          /**
           * ⚠️ 每次 `refreshModel()` 都**重新读缓存**，不是把值拷进去。
           *
           * `mountPanelBody()` 只在面板**首次挂载**时跑一次，而
           * `streamingIdentityCache` 会被 `toggleStreamingIdentity` 在之后更新
           * （见上面那个 `.then`）。传值 → 重取永远用挂载那一刻的旧身份；
           * 传取值函数 → 重取用的就是**当前**身份。
           *
           * 这正是 `refreshModel()` 缺参数那条缺陷（取证 B-1/B-2/B-3）的修法：
           * 值来自唯一真相源，**不硬编码** `'extension'` / `'page'`。
           */
          currentStreamingIdentity: () => streamingIdentityCache,
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
        /**
         * 「有新版本」→ 贴边条变强调色（2026-11-17，用户选方案 A）。
         *
         * 为什么必须补这条通道：工具栏角标要求图标**固定在工具栏**（Edge 默认把
         * 新装的扩展收进「扩展」菜单，等于没有载体），「关于」Tab 的红点在面板内部
         * 且一进去就判已读 —— 两条都要求用户先做点什么。贴边条是唯一
         * "打开 B站 页面就在那儿"的载体。
         *
         * ⚠️ 必须在 `mountSidebar()` **之后**接：`mountPanelBody()` 先构造，
         * 那时还没有 sidebar 可接；`setUpdateSink()` 内部会回放当前状态，
         * 所以不存在"接晚了丢掉一次信号"的问题。
         */
        body.setUpdateSink((available) => sidebar?.setUpdateDot(available));
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
     *
     * 同一个监听也负责**同步自动更新状态**（2026-11-17 三轮），见下面那段。
     */
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local') return;

      /**
       * ## 更新状态同步：一个 Tab 里看过，「另一个 Tab」的红点也要消失
       *
       * `updateStatus` 是**面板实例自己的缓存**（`ensureUpdateRead` 读到一次就不再重读），
       * 所以两个 B站 页面各挂一个面板时：在 A 里点开「关于」（后台记成已读）之后，
       * **B 的红点仍然亮着** —— 界面与后台事实相反。
       *
       * 同理，若 SW 的启动自动检查在面板挂载**之后**才写出"有新版本"，
       * 那一屏的红点本来也永远不出现。
       *
       * 两件事都由这条监听解决：存储变了就把新状态推给面板。
       *
       * ⚠️ **不许在这里触发 dismiss**：状态是别的 Tab / 后台写进来的，
       * 不代表用户看过这一版。`applyUpdateStatus()` 内部已压制
       * （`suppressDismissOnce`），否则两个面板会互相踩。
       */
      const updateChange = changes[UPDATE_STATE_KEY];
      if (updateChange) {
        // 存储里的东西一律不可信（可能是老版本写的 / 被手改过）→ 先归一化
        const state = normalizeUpdateState(updateChange.newValue);
        controller?.applyUpdateStatus(toStatusView(state, currentVersion()));
      }

      const change = changes[PANEL_ENTRY_ENABLED_KEY];
      if (!change) return;
      enabled = change.newValue !== false;
      paint();
    };
    chrome.storage.onChanged.addListener(onChanged);

    /**
     * ## 主动探活：扩展有没有被重新加载过（2026-11-12，task-33）
     *
     * 为什么必须**主动**：`devtools`/`wxt` 的失效通知在这条路径上不触发 ——
     * 见任务卡 §二.4 引用的 `content-script-context.mjs:57-60`（`isInvalid`
     * 是被动 getter）与 `:183-190`（`listenForNewScripts` 要求页面刷新）。
     * 所以下面那个 `ctx.onInvalidated` **从来没被调用过**。
     *
     * 判据只有一条：**消息能否往返**。`chrome.runtime.sendMessage` 在孤儿上下文里
     * 会抛 `Extension context invalidated`，而 `chrome.runtime` 对象本身、
     * `chrome.storage` 的旧监听器都还在 —— 所以只查 `chrome.runtime.id`
     * 不足以判定（它在部分形态下仍非空）。
     *
     * 探的是 `proxy/status` —— 一条**纯只读**消息（`proxy.handler.ts:66-113`
     * 只读 storage + 数规则，不写任何东西），所以探活不改变系统状态，
     * 也不会像写消息那样留下"探测副作用"。失败时才渲染提示；成功路径零额外 UI。
     */
    /**
     * 触发时机：① 启动时一次；② `document` capture 阶段任意点击（用户动作
     * 永远以点击开始）；③ 页面**重新变可见**时一次（用户从
     * `edge://extensions` 切回来正好命中，这是他实际的操作路径）。
     *
     * ## 🔴 为什么**没有**常驻心跳（2026-11-12，task-35 撤掉）
     *
     * 上一版有个 `setInterval(probeAlive, 20_000)`。verifier 裁决 + Lead 批准撤掉：
     * - `proxy/status` 虽然只读，但**没有 `document.hidden` 判断** ⇒ 每个后台
     *   B 站标签页都会永久每 20 秒唤醒一次 SW；
     * - 更要命的：清理它的 `ctx.onInvalidated` **本身就从不触发**（见下），
     *   所以 `clearInterval` 是死代码，心跳**没有回收点**。
     *
     * ⇒ 换成"动作驱动"：只在用户**真有动作**（点击 / 切回前台）时探一次，
     * 零后台开销，且覆盖了用户实际能遇到孤儿的全部路径
     * （孤儿态下他必然要么点一下、要么切回来）。
     *
     * ## ⚠️ 如实声明：这两个监听**没有显式回收点**
     *
     * `onInvalidated` 不触发（task-17 已证明），所以它们在页面生命周期内
     * 一直挂着，**随页面卸载自然消失**。这是可接受的：两个都是轻量监听、
     * 不开定时器、不持有外部引用；而唯一的"回收点"（`onInvalidated`）本身是假的 ——
     * 假装有回收点比没有更糟。**不要为了"对称"再加一个假的清理块。**
     */
    const probeAlive = (): void => {
      /**
       * ⚠️ 必须 try/catch 包住**同步**抛。
       *
       * 上下文失效时 `chrome.runtime.sendMessage` 是**同步抛**
       * `Error: Extension context invalidated.` —— 那时 `.catch` 还没挂上，
       * 异常直接冲出函数，`showOrphanHint()` 一次都不会执行。
       * 表现就是用户报的"点了没反应、也没有提示"。
       * （`openLogin()` 里修过同一类问题，这里漏了。）
       */
      let sending: Promise<unknown>;
      try {
        sending = chrome.runtime.sendMessage({ type: 'proxy/status' });
      } catch (e: unknown) {
        if (isOrphanError(e)) showOrphanHint();
        return;
      }
      void sending;
      /**
       * `Receiver not found` / `undefined` 都**不算孤儿**：前者是老版本
       * background 没有这个 handler（升级中途的正常态），后者是 handler
       * 没写 return —— 真孤儿是**抛异常**那一种。
       */
      void sending.catch((e: unknown) => {
        if (isOrphanError(e)) showOrphanHint();
      });
    };

    /** 启动时先探一次（页面可能是在扩展重载之后才加载完的） */
    void probeAlive();

    /**
     * 点击兜底：任何一次点击前都探一次活。
     *
     * 事件监听挂在 `document` 上、**capture 阶段**：比面板自己的 click handler
     * 先跑，所以提示会先出现、再轮到那次注定失败的业务调用。
     *
     * ⚠️ 必须 capture：shadow DOM 里的 click 在冒泡阶段才到 document，
     * 那时业务 handler 已经跑完并静默失败了。
     */
    /**
     * 存活监听：**不等用户动作**。
     *
     * 用户停在页面上、扩展在别处被 reload（或 InPrivate 权限被开关）时，
     * 之前的两条路径（点击 / 切回前台）都不会触发，面板就一直是死壳。
     * 这里每秒读一次 `chrome.runtime.id`（不发消息、不唤醒 SW），
     * 一旦失效立刻出提示。
     */
    startOrphanWatch({ onOrphan: () => showOrphanHint() });

    const onAnyClick = (): void => probeAlive();
    document.addEventListener('click', onAnyClick, true);

    /**
     * 切回前台探一次 —— **一次性，不是轮询**。
     *
     * 这正是用户的真实路径：去 `edge://extensions` 开/关 InPrivate 权限
     * （浏览器此时重载扩展）→ 切回 B 站标签页 → `visibilitychange` 触发 →
     * 发现自己是孤儿 → 立刻出提示。**他连点都不用点就能看到变化。**
     */
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') probeAlive();
    };
    document.addEventListener('visibilitychange', onVisible);

    /**
     * 扩展被重新加载时摘掉面板 —— 否则页面上会留一个点了没反应的死壳
     * （旧 content script 的 chrome API 已失效，但 DOM 还在）。
     *
     * ⚠️ **实测这条回调不会触发**（task-17 已证明）。保留它是因为：① 将来 WXT
     * 若改成主动轮询它会自动生效，成本为零；② 它做的清理正是孤儿态该做的事，
     * 一旦触发就是对的。**真正的兜底是 `probeAlive()`，不是这里。**
     */
    ctx.onInvalidated(() => {
      document.removeEventListener('click', onAnyClick, true);
      document.removeEventListener('visibilitychange', onVisible);
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

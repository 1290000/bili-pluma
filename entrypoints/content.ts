/**
 * 内容脚本（ISOLATED world）—— 页面侧的编排层。
 *
 * 三件事：
 *   1. **报到**：告诉 background「这个标签页要代理取流」
 *   2. 观测：记录页面实际播放画质（诊断用）
 *   3. 把配置下发给主世界脚本
 *
 * ## 主世界脚本不在这个文件里注入（2026-10-27 改）
 *
 * 主世界部分是独立的 MAIN world 内容脚本 `entrypoints/main-hook.content.ts`。
 * 两种"手工注入"都试过，都不行：
 *
 *   - `<script src=chrome-extension://…/main-world.js>`：**异步加载**，
 *     `async = false` 只管动态脚本之间的执行顺序、不阻塞解析。PGC 页的
 *     `window.nano = …` / `createPlayer(…)` 全在内联脚本里，所以 hook 装不上。
 *     实测 `__PLUMA_MAIN__ === true` 但 `nano` 没被包住 → PGC 分支静默失效。
 *   - `script.text = …`（内联）：MV3 的 `extension_pages` CSP **拒绝**
 *     `script-src 'unsafe-inline'`，Edge 156 报「Insecure CSP value」且**装不上扩展**。
 *
 * 现在由浏览器在 `document_start` 直接把 MAIN world 入口注进去（`world: 'MAIN'`），
 * 时机正确，也不碰 CSP。
 *
 * ⚠️ 本文件在 ISOLATED world：有 chrome API，但看不到页面的 JS 变量。
 */

import { browser } from 'wxt/browser';

import { renderBadge, removeBadge } from '@/src/content/isolated/badge';
import {
  applyHdrInput,
  describeHdrInput,
  describeHdrPlayback,
  describeTracks,
} from '@/src/content/isolated/badge-input';
import { PageState } from '@/src/content/isolated/page-state';
import {
  canSkipPgcInjection,
  isBetterStream,
  isPreviewSsr,
  isStreamTruncated,
  isSyncCacheUsable,
  isVideoInfoTruncated,
  loadCachedVideoInfo,
  maxVideoHeight,
  readCidFromSsr,
  shouldWritePgcCache,
  writePgcSessionCache,
} from '@/src/content/isolated/pgc-cache-inject';
import { fetchPgcPlayurl } from '@/src/content/isolated/pgc-fetch';
import {
  clearPgcReloadGuards,
  clearPgcSessionCache,
  isProxyReenabled,
  writeProxyOffMark,
} from '@/src/content/isolated/pgc-proxy-off';
import {
  GUARD_KEY_PREFIX,
  buildPlayurlUrl,
  isAlreadyTried,
  makeGuard,
  parseGuard,
  shouldReload,
  shouldResetGuardForBadCache,
} from '@/src/content/isolated/pgc-reload-plan';
import { restoreResumeTime, saveResumeTime } from '@/src/content/isolated/pgc-resume';
import { mergeVideoInfo } from '@core/playinfo/pgc-merge';
import { PROXY_ENABLED_KEY } from '@platform/http/dnr';
import { writePgcCache } from '@platform/storage/pgc-cache-store';
import { readPrimaryProfile, savePrimaryProfile } from '@platform/storage/primary-profile-store';
import { BADGE_ENABLED_KEY, readBadgeEnabled } from '@platform/storage/ui-prefs-store';
import { buildPageSnapshot } from '@shared/utils/page-snapshot';
import {
  parsePlayPage,
  readDeviceCookies,
  readPrimaryMidFromCookie,
} from '@shared/utils/video-page';
// tokens.css 的**原始文本**，注入 shadow root 用。
// ⚠️ 不能用 <link>：CSS 变量不穿透 shadow 边界，必须把规则塞进 shadow 内部
import tokensCss from '@/src/design/tokens.css?raw';

/** 跨 world 通信的随机令牌。页面脚本能读到它，只用于防盲注 */
const CHANNEL_TOKEN = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const NS = '__PLUMA__';

/**
 * 给 background 发消息 —— **扩展上下文失效时静默返回，不抛错**。
 *
 * ## 为什么要收敛成一个函数（2026-10-27 修 `Extension context invalidated`）
 *
 * 扩展重新加载后，页面里旧 content script 的 `chrome.runtime` 已失效。
 * 这时 `browser.runtime.sendMessage` 会**同步抛出**，而各调用点写的是
 * `.catch(() => {})` —— **只接得住 Promise 拒绝，接不住同步抛出**。
 * 于是错误冒到控制台，扩展管理页显示「错误 1 个」，用户以为插件坏了。
 *
 * 本文件有 **10 处**发消息，逐个打补丁必然漏。所以全部走这里。
 *
 * 默认实现：**静默返回 null，不 reject**。
 *
 * ⚠️ 曾经这里是 `Promise.reject(new Error('sender 尚未安装'))`，那是个真 bug：
 * `reportQuality` 用 `void` 丢弃 Promise，而 `void` **不会消除未处理拒绝**。
 * 任何在 `main()` 之前触发的上报，都会在控制台留下
 * `Uncaught (in promise) Error: sender 尚未安装`。
 *
 * 现在与真实实现的契约一致：**失败就返回 null，永不 reject**。
 * 调用点可以放心 `void`。
 */
let sendToBackground: (msg: unknown) => Promise<unknown> = () => Promise.resolve(null);

/**
 * 由 `main()` 调用：装上真实发送器。
 *
 * ## 为什么不再用 `ctx.isInvalid` 做短路
 *
 * 那个 getter 是**带副作用**的（`runtime.id == null` 时会永久 abort ctx）。
 * 作为"每次发送前问一句"的判据太危险：SW 冷启动的瞬时读不到，
 * 就会把整个 content script 永久判死。
 *
 * 而 `try/catch` 本身已经能接住真正失效时的**同步抛出** ——
 * 那才是我们真正要解决的问题，不需要额外的预判。
 */
function installSender(): void {
  sendToBackground = async (msg) => {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch {
      // 上下文失效（同步抛出）/ background 未就绪 / 未配置 —— 都不冒到控制台
      return null;
    }
  };
}

/** 发一条「页面画质」上报。失败静默 */
function reportQuality(payload: { height: number; note?: string }): void {
  void sendToBackground({ type: 'page/quality', ...payload });
}

/**
 * 「为什么这次没刷新 / 为什么刷了」的现场记录（2026-10-29 加）。
 *
 * ## 为什么需要它（真机排查踩的坑）
 *
 * 方向 B（重开开关 → 刷新 → 应恢复完整流）卡在 180 秒试看。当时的证据只有
 * 诊断日志的 30 条环形缓冲 —— 而 PGC 那条链路的判定分散在
 * `orchestratePgc` → `shouldReload` → `reloadWithGuard` 三处，
 * 中间还夹着两个 `return`。日志滚掉之后就只剩"结果不对"，
 * **看不出是哪一步退出的**。
 *
 * `window.__PLUMA_PGC__` 只记主世界的注入状态（`patchedAt` / `ssHit`），
 * 完全看不到 ISOLATED 侧"到底走到哪条分支" —— 这正是当时卡住的地方：
 * 主世界说 `patchedAt: 583`（注入了），但 `duration` 还是 180（播放器没用）。
 *
 * 所以这里在**页面**上挂一个只读快照，记录每次判定的入参和结论。
 * 无凭据、无用户数据，只有分支名与布尔值。
 */
const pgcReloadTrace = {
  /** `orchestratePgc` 被调了几次 */
  orchestrateCalls: 0,
  /** 最后一次 `orchestratePgc` 从哪条分支返回的（见下方各 `return` 处的赋值） */
  orchestrateExit: '',
  /** 最后一次 cid */
  cid: '',
  /** `hadSync`：进 cache 分支时 `sessionStorage` 本来有没有这份缓存 */
  hadSync: null as boolean | null,
  /** 这次 SSR 里的流是不是主世界注入的结果 */
  ssrPatchedByUs: null as boolean | null,
  /** 这次 SSR 判出来是否截断（`null` = 没有 SSR 数据） */
  ssrTruncated: null as boolean | null,
  /** `shouldReload` 被调用了几次 */
  shouldReloadCalls: 0,
  /** 最后一次 `shouldReload` 的入参 */
  shouldReloadArgs: null as { alreadyTried: boolean; hasStream: boolean } | null,
  /** 最后一次 `shouldReload` 的结论 */
  shouldReloadVerdict: null as boolean | null,
  /** `reloadWithGuard` 被调用了几次 */
  reloadWithGuardCalls: 0,
  /** `reloadWithGuard` 真正执行 `location.reload()` 了几次 */
  reloadIssued: 0,
  /** 最后一次没刷 / 没取流的原因 */
  lastReason: '',
};

try {
  (window as unknown as Record<string, unknown>).__PLUMA_PGC_ISOLATED__ = pgcReloadTrace;
} catch {
  /* 挂不上就只是少了排查手段，不影响功能 */
}

/**
 * 当前页的取流数据（主账号基线 + 播放账号实际拿到的）。
 *
 * 纯逻辑在 `page-state.ts`（可单测）；这里只负责把消息喂给它、以及应答 UI 的查询。
 */
const pageState = new PageState();

/**
 * 角标需要的状态。
 *
 * ⚠️ 全部来自**主世界的实际观测**，不用 `accept_quality` 之类的接口字段——
 * 后者在未登录时就会返回含 8K 的完整数组，拿它展示等于骗用户。
 */
/**
 * 本页是否**曾经**成功接管过。
 *
 * 用于区分"从未接管"和"临时失败"：
 *   - 从未成功 → 失败时撤掉角标（诚实）
 *   - 曾成功过 → 失败时保留角标，不清缓存（避免闪回「已接管」）
 *
 * 见 `activate()` 的 `.catch` 注释。
 */
let hasEverActivated = false;

/**
 * 总开关的最近一次已知值（`true` / `false` / `null` = 还不知道）。
 *
 * ## 为什么不直接用 `badgeState.proxying`
 *
 * 那是两个不同的量：
 *
 * | 变量 | 回答的问题 |
 * | --- | --- |
 * | `badgeState.proxying` | 这个页面**装上规则了吗**（未配置 / 同账号 / 出错都会 false） |
 * | 这个 | 用户**想不想用**（总开关） |
 *
 * 同账号时开关是开着的，但 `proxying` 是 `false` —— 拿它当总开关会让
 * `cfg` 里报出一个错的值，而主世界的 `cfgEnabled` 就是靠这个值门控的。
 *
 * ## 为什么要单独记
 *
 * 2026-10-29 之前，`orchestratePgc` 里那条 `cfg` 写死了 `enabled: true`。
 * 后果不只是"门控失效"（第一层 `localStorage` 已经兜住了），
 * 更麻烦的是真机排查时 `lastCfgEnabled: true` 会让人以为"消息通道报的是开" ——
 * 掩盖了真实原因。实际值必须能被观测到。
 *
 * 初值 `null`：`page/activate` 回包之前确实不知道，不要假装知道。
 */
let proxyEnabledKnown: boolean | null = null;

const badgeState = {
  proxying: false,
  playingHeight: 0,
  videoFamily: '',
  audioFamily: '',
  /** 当前轨道的实际帧率（0 = 未知） */
  frameRate: 0,
  /**
   * 浏览器 `(video-dynamic-range: high)` 的结果。
   *
   * 用来消除"SDR 的 HEVC 被误标成 HDR"：B站会给普通 4K 转 HEVC 省码率，
   * 那种轨也是 HEVC 但属于 SDR，只有浏览器确认是 HDR 才标徽章。
   */
  videoDynamicRange: null as boolean | null,
  /**
   * `(dynamic-range: high)` 的结果 —— **显示设备**是否支持 HDR。
   *
   * 与 `videoDynamicRange`（视频通道是否以 HDR 呈现）是两个不同的量：
   *   - display: high → 屏幕/系统开了 HDR
   *   - video: high   → 这条视频真的在走 HDR 输出
   *
   * 实测发现 `video` 会误报 standard（尤其 AV1 编码的 HDR 轨），
   * 所以判断 HDR 时必须两个信号一起看。
   */
  displayDynamicRange: null as boolean | null,
  /** HEVC 的 profile 段（如 `2.4.L153.90`），用于详情里标 10bit */
  hevcProfile: '' as string,
  /**
   * 本视频是否**提供**杜比视界版本（来自服务端 `dash.dolby.vision`）。
   *
   * ⚠️ 是"视频能力"不是"当前播放状态"。只用在详情，
   * 不能当主文案 —— 否则就成了"视频有 DV 轨"说成"你在看 DV"。
   */
  dolbyVisionAvailable: false,
};

/**
 * 用户是否允许显示页内角标（设置页「显示」分区控制）。
 *
 * 默认 `true`；只有显式关过才不画。读到之前先按 `true` 处理 ——
 * 反正角标本来就要等 `page/activate` 回来才出现，这几毫秒看不出来。
 */
let badgeEnabled = true;

/**
 * PGC 完整流缓存是否已经尝试下发过（ADR 0020）。
 *
 * `ssr-playinfo` 会被多次上报（hello + 两次延迟），只处理第一次，
 * 否则会往主世界重复 postMessage 几十 KB。
 */
let pgcCacheTried = false;

/**
 * 上一次处理的 cid。
 *
 * ⚠️ **SPA 切集时要重置 `pgcCacheTried`**（2026-10-28 真机踩到）：
 * 在播放器里点选集，页面不重载、`content script` 不重启，
 * 而 `pgcCacheTried` 一直是 true —— 于是新集永远不会走取流流程。
 * 实测：点「第 8 集」后 URL 变了，但 `__playinfo__.result.arc.cid` 还是第 7 集的，
 * 播放器于是用 360 秒的流播新集，6 分 01 秒撞墙。
 */
let pgcHandledCid = '';

/** 重画角标。所有字段变化后统一调这一个入口 */
function paintBadge(): void {
  // 关掉时不只是"不画"，还要把已经画出来的摘掉
  if (!badgeEnabled) {
    removeBadge();
    return;
  }
  renderBadge(tokensCss, badgeState);
}

/**
 * 主世界脚本由 **MAIN world 内容脚本** entrypoints/main-hook.content.ts 注入。
 * 本文件不再手工注入 —— 两种手工方式都被平台否掉了（见文件头注释）。
 */

/**
 * 告知主世界脚本：代理是否已启用。
 *
 * @param enabled 扩展是否启用（主世界据此决定要不要藏 `__playinfo__` / 轮询会员状态）
 * @param pgcActive `page/activate` 的结果。`false` 时主世界**不接管 PGC 播放器**
 *   （没装规则就接管，取回来的还是主账号的试看，纯属浪费一次请求）
 */
function tellMainWorld(enabled: boolean, pgcActive?: boolean): void {
  window.postMessage({ __ns: NS, type: 'cfg', token: CHANNEL_TOKEN, enabled, pgcActive }, '*');
}

/**
 * 监听主世界的回执。
 *
 * ## ⚠️ 这里只校验 `__ns`，**不校验 token** —— 这是有意的，不是漏写
 *
 * token 只在**反方向**生效：MAIN 在第一个 `cfg` 里锁定 token，之后每条都校验。
 * 本侧不校验的理由是威胁模型很窄：
 *
 * 1. 主世界上报的内容只影响**画质显示**（徽章、主账号基线），不驱动任何实际行为
 * 2. 本侧**从不向 MAIN 发送凭据**；凭据只在 background，换 Cookie 由 DNR 在网络层完成
 *
 * 所以页面脚本伪造 `ssr-playinfo` 最多让 popup 显示一个错的画质数字 ——
 * 拿不到凭据、改不了取流、也影响不了别的标签页。
 *
 * 要加固就得让本侧也知道 token（等于把 MAIN 已锁定的东西再验一遍），
 * 收益是"防显示错误"，成本是改协议 + 两边同时改 + 重验跨 world 通道。v1 判断不值得。
 *
 * 详见 `docs/protocols/messages.md`「通道 A：防护做了什么、没做什么」。
 */

/**
 * 组装一份 popup 快照 —— **给自动化 / bsk 用，popup 本身不依赖它**。
 *
 * ## 为什么抽成函数（2026-10-29）
 *
 * 有两条通道要它：
 *   1. `chrome.runtime.onMessage` 的 `page/snapshot:get`（扩展页发起）
 *   2. `window.postMessage` 的 `__PLUMA__/snapshot` 桥（**页面侧发起**）
 *
 * 第二条是为了让 `bsk evaluate` 能直接拿到 JSON —— 否则 `chrome-extension://`
 * 被沙箱拒 `evaluate` 时，UI 状态只能靠人手点、肉眼描述。
 * 两条通道共用这一份实现，**绝不复制**（复制必然漂移）。
 *
 * ## 为什么异步
 *
 * 要账号摘要，而账号摘要只有 background 有。调用方必须 `await`。
 *
 * @returns `page/snapshot:ok` 应答。组装失败时返回一份空快照而非抛错 ——
 *   自动化脚本不该因为某个字段拿不到就崩掉
 */
async function takeSnapshot(): Promise<{
  type: 'page/snapshot:ok';
  snapshot: ReturnType<typeof buildPageSnapshot>;
  /**
   * ISOLATED world 的 PGC 重载诊断快照。
   *
   * 为什么放在这里：那个对象挂在 ISOLATED 的 `window` 上，而 `bsk evaluate`
   * 在 MAIN world，读不到。借这条已有的快照桥送出去。
   * **不进 popup 的渲染路径**，popup 也从不发 `snapshot`。
   */
  pgcReload: typeof pgcReloadTrace;
}> {
  try {
    /**
     * 两样数据并行取：proxy/status、account/summary。
     * 串行会让快照慢三倍，而自动化脚本是反复跑的。
     *
     * `sendToBackground` 的返回是 `unknown`（它要兜住"上下文失效返回 null"
     * 与各种应答形状），所以这里按消息类型收窄 —— 与 `activatePage()` 同样的做法。
     */
    const [proxyRes, acctRes] = (await Promise.all([
      sendToBackground({ type: 'proxy/status' }),
      sendToBackground({ type: 'account/summary' }),
    ])) as [
      {
        type?: string;
        enabled?: boolean;
        hasCredential?: boolean;
        ruleCount?: number;
      } | null,
      {
        type?: string;
        configured?: boolean;
        account?: {
          profile: { uname: string; mid: number };
          vipLabel: 'none' | 'monthly' | 'annual';
          expireAt: number | null;
          health: { healthy: boolean };
        } | null;
      } | null,
    ];

    const proxyOk = proxyRes?.type === 'proxy/status:ok';
    const acctOk = acctRes?.type === 'account/summary:ok';

    const proxy = {
      enabled: proxyOk ? proxyRes.enabled === true : false,
      hasCredential: proxyOk ? proxyRes.hasCredential === true : false,
      ruleCount: proxyOk ? (proxyRes.ruleCount ?? 0) : 0,
    };

    const account =
      acctOk && acctRes.account
        ? {
            uname: acctRes.account.profile.uname,
            mid: acctRes.account.profile.mid,
            vipLabel: acctRes.account.vipLabel,
            expireAt: acctRes.account.expireAt,
            healthy: acctRes.account.health.healthy,
          }
        : null;

    /**
     * 组装逻辑全在 `shared/utils/page-snapshot.ts`（纯函数 + 单测）。
     * 这里只取数。
     *
     * ## `cached` 必须真的读（2026-10-29 修）
     *
     * 原本这里传 `null`，注释理由是"快照报实时状态，缓存兜底是 popup 自己的事"。
     * **真机一测就发现那个理由站不住**：番剧页（没有 `__INITIAL_STATE__`）
     * 快照报 `primary: {uname: null, source: 'none'}`，而 popup 实际会用缓存显示昵称 ——
     * **快照与 popup 不一致，那这份快照就没法用来验 popup**。
     *
     * 尤其问题 2/3 的修复本身就是"播放页也用缓存兜底"，快照不读缓存
     * 等于把要验的东西从快照里删掉了。
     *
     * 判据与 `popup/main.tsx` 的 `needsCache` 一致：只有**真的可能用到**才读
     * （`chrome.storage.local.get` 是一次异步 IO，能省就省）。
     */
    const pageView = pageState.view();
    const needsCache = pageView === null || !pageView.primary.user?.uname;
    const cached = needsCache ? ((await readPrimaryProfile()) ?? null) : null;

    return {
      type: 'page/snapshot:ok',
      snapshot: buildPageSnapshot({
        pageView,
        proxy,
        account,
        cached: cached ? { uname: cached.uname, level: cached.level } : null,
      }),
      /**
       * PGC 重载链路的诊断快照（2026-10-29 加）。
       *
       * ## 为什么必须从这里带出来
       *
       * `pgcReloadTrace` 挂在 **ISOLATED world 的 `window`** 上，而 `bsk evaluate`
       * 跑在 **MAIN world** —— 两个 world 的 `window` 不是同一个对象，
       * 所以页面侧 `window.__PLUMA_PGC_ISOLATED__` **永远是 `undefined`**。
       *
       * 2026-10-29 真机验收时踩到这里：埋点写好了、值也在更新，但从页面读不到，
       * 等于白写。现在通过这条已有的快照桥把它送出来 —— 页面发一条
       * `postMessage({type:'snapshot'})` 就能拿到，不需要新通道。
       *
       * ⚠️ 它只在 `page/snapshot:ok` 里，**不进 popup 的渲染路径**。
       */
      pgcReload: pgcReloadTrace,
    };
  } catch (e) {
    reportQuality({
      height: 0,
      note: `快照组装失败：${e instanceof Error ? e.message.slice(0, 60) : '?'}`,
    });
    return {
      type: 'page/snapshot:ok',
      snapshot: buildPageSnapshot({
        pageView: null,
        proxy: { enabled: false, hasCredential: false, ruleCount: 0 },
        account: null,
        cached: null,
      }),
      // 失败时也带上诊断 —— 排查恰恰最需要它
      pgcReload: pgcReloadTrace,
    };
  }
}
function listenMainWorld(): void {
  window.addEventListener('message', (ev) => {
    const d = ev.data as
      | {
          __ns?: string;
          type?: string;
          url?: string;
          method?: string;
          path?: string;
          display?: string;
          video?: string;
          w?: number;
          h?: number;
          /** 主世界 `ssr-playinfo` 用 */
          firstSeen?: string;
          playurlBefore?: boolean;
          /**
           * `data` 里的流**是不是主世界自己注入进去的**（2026-10-29 加）。
           *
           * `ssrPlayinfo` 是 `__playinfo__` 的**同一个对象引用**，而注入会
           * `r.video_info = next` 原地替换 —— 所以上报的 `data` 里是注入后的完整流。
           * 上层必须靠这个标记区分「SSR 本来完整」与「被我们改成了完整」。
           */
          pgcPatched?: boolean;
          data?: unknown;
          user?: { uname?: string; face?: string | null; level?: number | null } | null;
          /** 主世界 `playurl-raw` 用 */
          json?: unknown;
          flags?: {
            define?: string;
            hadExisting?: boolean;
            playinfo?: string;
            hasInitialState?: boolean;
            readyState?: string;
          };
        }
      | undefined;
    if (!d || d.__ns !== NS) return;

    if (d.type === 'hello') {
      const f = d.flags;
      reportQuality({
        height: 0,
        note: `主世界就绪 readyState=${f?.readyState ?? '?'} define=${f?.define ?? '?'} hadExisting=${String(f?.hadExisting)} playinfo=${f?.playinfo ?? '?'}`,
      });
      /**
       * 主世界先发 `hello` 时，立刻把配置推过去。
       *
       * ## ⚠️ `enabled` 必须是**真实的开关状态**，不能写死 `true`（2026-10-29 修）
       *
       * 这里原来写的是 `tellMainWorld(true)` —— 无论总开关开还是关都告诉主世界"开"。
       * 后果：`main-world.js` 的 `cfgEnabled` 永远是 `true`，
       * 于是「关开关后刷新番剧页 → 注入缓存的 4K 流 → 画质不回落」这条
       * **靠 `cfgEnabled` 判断的门控永远不会生效**（真机实测：关开关后 `patched: 648`、
       * `dashH` 仍含 2160）。
       *
       * 为什么当初写死：那时的假设是"能收到 hello 就说明扩展在工作"。
       * 但 hello 只说明**主世界脚本跑起来了**，与用户有没有关总开关无关。
       * 这两件事必须分开。
       *
       * 这里不能 `await`（`window.postMessage` 监听器是同步的，等异步会让 hello 的
       * 回应时序错乱）。所以用 `void` 异步查完再补发一次 —— 主世界对 `enabled`
       * 的更新是幂等都安全的（它只是改一个布尔量）。
       */
      tellMainWorld(true);
      void sendToBackground({ type: 'proxy/status' }).then((r) => {
        const st = r as { type?: string; enabled?: boolean } | null;
        if (st?.type !== 'proxy/status:ok') return;
        /**
         * 只在**明确关闭**时补发 `false`。
         *
         * 不补发 `true`：上面已经发过一次 `true`（那是"hook 已就绪、可以工作"的意思），
         * 而 `cfg` 每发一条主世界都会走一遍 `syncHooks()` —— 没必要为"开着"再多触发一次。
         */
        if (st.enabled === false) tellMainWorld(false);
      });
      return;
    }

    if (d.type === 'ready') {
      /**
       * ⚠️ **不要在这里回 `cfg`。**
       *
       * 主世界收到 `cfg` 会回 `ready`，收到 `ready` 再回 `cfg` 就是无限回环。
       * 2026-10-26 因此出过 **Out of Memory**（视频页停留几十秒后页面崩溃，
       * 普通与 InPrivate 都会），根因是回环里每轮都夹带一份完整的 `__playinfo__`。
       *
       * 配置只下发一次（`hello` 那一次）。开关变化本来就靠刷新页面生效
       * （popup 上写着"刷新后生效"），不需要热切换通道。
       */
      return;
    }

    /**
     * 主账号基线（ADR 0014）。
     *
     * ⚠️ 这里**不判断"有没有数据"就收下**，而是把 `firstSeen` / `playurlBefore` 一起交给
     * `PageState` 判定 —— 因为页面在发过 playurl 之后自己写的那份 `__playinfo__`
     * 属于播放账号身份，拿它当基线会让对比永远显示"没有提升"。
     */
    if (d.type === 'ssr-playinfo') {
      const firstSeen =
        d.firstSeen === 'initial' || d.firstSeen === 'set' || d.firstSeen === 'none'
          ? d.firstSeen
          : 'none';
      const user =
        d.user && typeof d.user.uname === 'string'
          ? {
              uname: d.user.uname,
              face: typeof d.user.face === 'string' ? d.user.face : null,
              // 等级拿不到就是 null，UI 会退化成"只读"标签（不编数字）
              level: typeof d.user.level === 'number' ? d.user.level : null,
            }
          : null;

      pageState.applySsr({
        firstSeen,
        playurlBefore: d.playurlBefore === true,
        data: d.data ?? null,
        user,
      });

      /**
       * ## 主账号显示档案的回写（ADR 0025）—— **全项目唯一写入点**
       *
       * 目的：非播放页（首页 / 空间 / 收藏夹）点开 popup 时也能看到主账号昵称。
       * 那些页面没有 content script，昵称唯一的来源就是这份缓存。
       *
       * ## 为什么守卫放在 `savePrimaryProfile` 里而不是这里
       *
       * 这里能做的判断只有"`user` 非空"，而那条**不够**：
       * `ssr-playinfo` 走的是跨 world 通道，本侧**不校验 token**（见本文件
       * `listenMainWorld()` 的注释）—— 因为"主世界上报的内容只影响画质显示"。
       * 一旦它被持久化成"用户的账号"，页面脚本伪造一条消息就能把假昵称写进存储。
       *
       * 所以真正的闸门是「**同时读到真实的 `DedeUserID`**」，而 `mid` 只有这里
       * 能从 `document.cookie` 读到。`savePrimaryProfile()` 的签名**强制**调用方
       * 传 `mid`，拿不到的调用点根本写不出这段代码。
       *
       * ## `void` + 不 await
       *
       * 写缓存与画质显示完全无关，不该让它挡住后面 PGC 编排的同步路径。
       * 函数内部已经把所有异常吞掉了（返回 `false`），所以 `void` 是安全的。
       */
      if (user) {
        void savePrimaryProfile(user, readPrimaryMidFromCookie(document.cookie));
      }

      /**
       * PGC 的完整流编排（ADR 0020）—— **只做一次**。
       *
       * 两条分支：
       *   - 缓存命中 → 下发给主世界，让它同步注入；**不发请求、不刷新**
       *   - 缓存未命中 → 取流 → 写缓存 → 刷新一次（护栏在 `pgc-reload-plan.ts`）
       *
       * ## 为什么这里每一层判定都要落日志（2026-10-28 真机踩到）
       *
       * 真机现场：`cacheBytes=0`、`lastStage='boot'` —— 主世界从未收到 `cfg`，
       * 但**诊断页里一行 PGC 日志都没有**，于是无法判断是"消息没到 ISOLATED"
       * 还是"到了但判定没过"。三个 if 连着 return，静默得像什么都没发生。
       *
       * 现在每一层都报一句：`收到 SSR` / `不是 PGC 播放页` / `非试看` / `无 cid`。
       * **静默返回是这类 bug 的最大帮凶**（同一教训已踩过三次）。
       */
      const playInfo = parsePlayPage(location.href);
      reportQuality({
        height: 0,
        note:
          `[PGC] 收到 SSR playInfo=${String(!!d.data)} firstSeen=${firstSeen}` +
          ` page=${playInfo?.kind ?? 'none'}` +
          ` preview=${String(isPreviewSsr(d.data))}` +
          ` truncated=${String(isStreamTruncated(d.data))}` +
          ` cid=${readCidFromSsr(d.data) ?? 'none'}` +
          ` tried=${String(pgcCacheTried)}`,
      });

      if (!playInfo || playInfo.kind !== 'pgc') return;
      const cid = readCidFromSsr(d.data);
      if (!cid) {
        reportQuality({ height: 0, note: '[PGC] 读不出 cid，放弃' });
        return;
      }
      /**
       * cid 变了 = SPA 切集。重置"只做一次"的状态，让新集重新走完整流程。
       * （同页重复上报同一个 cid 时保持 `pgcCacheTried === true`，不重复取流）
       */
      if (cid !== pgcHandledCid) {
        pgcHandledCid = cid;
        pgcCacheTried = false;
      }
      if (pgcCacheTried) return;
      pgcCacheTried = true;

      /**
       * 编排逻辑抽到 `orchestratePgc` —— 只服务整页加载。
       * SPA 切集由主世界在响应层拦 `/ogv/player/playview`（ADR 0023），不走这里。
       *
       * ⚠️ 第 3 个参数 `pgcPatched` 是 2026-10-29 加的关键判据：
       * 主世界在 setter 里注入成功后，`ssr-playinfo` 上报的 `data`
       * **已经是注入后的完整流**（同一对象引用被原地改过）。
       * 不传这个标记的话，ISOLATED 会把"自己的注入结果"误判成
       * "SSR 本来就是完整流"，于是走早退分支、永不 reload ——
       * 那就是「重开开关后卡在试看」。详见 `orchestratePgc` 里的长注释。
       */
      void orchestratePgc(cid, d.data, d.pgcPatched === true);
      return;
    }

    /** 页面自己的 playurl 响应原文（播放账号身份）—— 用同一套解析器算能力 */
    if (d.type === 'playurl-raw') {
      pageState.applyPlayback(d.json ?? null);
      return;
    }

    /**
     * PGC 的 SPA 切集：主世界换完流后把新一集的能力送回来（ADR 0023 + 0024 的配套）。
     *
     * ## 为什么这条消息必须存在
     *
     * 切集时 `__playinfo__` **完全不重新赋值**，所以 `ssr-playinfo` 不会再来；
     * PGC 的请求也不走 `/x/player/…`，所以 `playurl-raw` 也不会来。
     * 没有这条消息，`pageState` 会永远停在这张标签页**首次加载**的那一集。
     *
     * ## 为什么先换 `pageKey`
     *
     * `applyPlayback()` 把能力记在"当前这一页"名下。切集后如果不先换 pageKey，
     * 新集的 4K 会被记到上一集头上 —— 之后切回去会显示一个错的画质，
     * 而且**不报错、不崩溃**，属于最难查的那类。
     *
     * 响应里只有 `cid`，而 `pageKey` 用的是 `ep:` / `ss:`。映射靠
     * `sessionStorage` 的 `pluma:pgc-ep:{ep_id} → cid`（由 `writePgcSessionCache` 写）。
     * 拿不到映射就退回用 `ep:{cid}`：数字对不上但不致命 ——
     * 下一次整页加载会用正确的 key 覆盖。
     */
    if (d.type === 'pgc-playview-stream') {
      const s = d as { cid?: string; result?: unknown };
      const cid = typeof s.cid === 'string' ? s.cid : '';
      if (cid && s.result) {
        pageState.setPageKey(pgcPageKeyForCid(cid), 1);
        pageState.applyPlayback({ code: 0, result: s.result });
        reportQuality({ height: 0, note: `[PGC] 切集换流已记录 cid=${cid}` });
      }
      return;
    }

    // 会员状态响应已被改写 —— 切换画质不再弹「开通大会员」的前提
    if (d.type === 'patch') {
      const p = d as { path?: string };
      reportQuality({
        height: 0,
        note: `已改写会员状态响应: ${p.path ?? '?'}`,
      });
      return;
    }

    // SourceBuffer 装载成功（有数据写入）
    if (d.type === 'sb-ok' || d.type === 'sb-error') {
      const s = d as { mime?: string; kind?: string; buffered?: number };
      const label = s.kind === 'video' ? '视频轨' : '音轨';
      reportQuality({
        height: 0,
        note:
          d.type === 'sb-ok'
            ? `${label}装载成功: ${s.mime ?? '?'} (缓冲 ${Math.round(s.buffered ?? 0)}s)`
            : `${label}装载失败: ${s.mime ?? '?'}`,
      });
      return;
    }

    // playurl 响应里的音频轨道清单 —— 确认 Hi-Res / 杜比轨有没有下发
    if (d.type === 'playurl-tracks') {
      const s = (
        d as {
          summary?: {
            audio?: { id: number; bw: number }[];
            video?: { id: number; h: number; codecid: number; bw: number }[];
            flac?: { id: number; bw: number; sampleRate: number } | null;
            dolby?: { id: number; bw: number; type: number }[] | null;
            /** 服务端标注：本视频提供杜比视界版本 */
            dolbyVision?: boolean;
          };
        }
      ).summary;
      if (!s) return;

      /**
       * 记录"本视频提供杜比视界"。
       *
       * ⚠️ 这是**视频能力**，不是"当前在播杜比视界"。
       * 所以只用在角标详情里，不进主文案。
       * 依据是 B站服务端的 `dash.dolby.vision` 布尔值，不是推断。
       */
      badgeState.dolbyVisionAvailable = s.dolbyVision === true;
      paintBadge();

      // 一行日志：这次下发到底有哪些轨（拼接逻辑抽到 badge-input.ts，可单测）
      reportQuality({ height: 0, note: describeTracks(s) });
      return;
    }

    // HDR 状态：显示链路 + 视频通道 + 实际编码（视频 + 音频）
    if (d.type === 'hdr') {
      const h = d as {
        display?: string;
        video?: string;
        w?: number;
        h?: number;
        family?: string;
        profile?: string;
        frameRate?: number;
        canDecode?: string;
        audio?: string;
        audioFamily?: string;
        canPlayAudio?: string;
        vsb?: { total: number; active: number };
        asb?: { total: number; active: number };
        vDetail?: string;
        aDetail?: string;
      };

      /**
       * 写状态 + 两行诊断日志都抽到 `badge-input.ts` 了。
       *
       * 那里锁着两条踩过的规则（`h` 为 0 不清零、`'?'` 映射成 null），
       * 而它们原先埋在下面这 80 行里、没有任何测试。见该文件头注释。
       */
      applyHdrInput(badgeState, h);
      paintBadge();

      reportQuality({ height: 0, note: describeHdrInput(h, badgeState.dolbyVisionAvailable) });
      reportQuality({ height: h.h ?? 0, note: describeHdrPlayback(h) });

      // 逐条明细单独打一行，切换音质时看这个
      if (h.vDetail || h.aDetail) {
        reportQuality({
          height: 0,
          note: `轨道明细 视频[${h.vDetail ?? ''}] 音频[${h.aDetail ?? ''}]`,
        });
      }
      return;
    }

    // 播放器实际创建的 SourceBuffer 编码
    if (d.type === 'codec') {
      const c = d as { mime?: string; from?: string; kind?: string };
      reportQuality({
        height: 0,
        note: `${c.kind === 'audio' ? '音频' : '视频'}编码(${c.from ?? '?'}): ${c.mime ?? '?'}`,
      });
      return;
    }

    // 页面真的发出了 playurl 请求 —— 这是 DNR 能不能生效的前提
    if (d.type === 'req') {
      reportQuality({
        height: 0,
        note: `playurl 请求出现: ${d.method ?? 'GET'} ${(d.url ?? '').split('?')[0]}`,
      });
      return;
    }

    /**
     * PGC 主世界分支的状态（ADR 0020）。
     *
     * 阶段：`cfg`（收到缓存）/ `patch`（已注入）/ `error`（放弃注入）。
     * **必须每条都落日志**——注入失效时用户看到的是"还是试看"，不说就完全无法排查。
     */
    if (d.type === 'pgc') {
      const p = d as unknown as { stage?: string; detail?: string };
      reportQuality({ height: 0, note: `[PGC] ${p.stage ?? '?'} ${p.detail ?? ''}`.trim() });
      return;
    }
  });
}

/**
 * SPA 切集后，由 `cid` 推出这一集的 `pageKey`。
 *
 * ## 为什么优先用 URL 而不是反查映射
 *
 * `sessionStorage` 里只有 `pluma:pgc-ep:{ep_id} → cid`（正向），反查要遍历所有键。
 * 而 **SPA 切集时 `location.pathname` 会立刻更新**（ADR 0023 实测：点「第 8 集」后
 * URL 变了、`arc.cid` 还是第 7 集的）。所以 URL 是最直接的来源。
 *
 * 只有 URL 解析不出 ep/ss 时，才退回用 `cid` 当 key ——
 * 数字虽然对不上 `ep:` 前缀，但至少能保证"切到新集后旧能力被清空"，
 * 下一次整页加载会用真正的 key 覆盖。
 */
function pgcPageKeyForCid(cid: string): string {
  const info = parsePlayPage(location.href);
  if (info?.kind === 'pgc') {
    if (info.epId) return `ep:${info.epId}`;
    if (info.seasonId) return `ss:${info.seasonId}`;
  }
  return `ep:${cid}`;
}

/**
 * 时长已经够，但画质可能没到顶 —— 再试一次取流，更好才替换。
 *
 * ## 它只处理"时长够了"的集数
 *
 * 调用点在 `orchestratePgc` 里 `isStreamTruncated(...) === false` 之后。
 * 会员老番（只给 361 秒试看）走的是**另一条路径**，永远到不了这里 ——
 * 所以这个函数**不可能**让老番掉回试看。
 *
 * ## 为什么"不更好"时不写缓存
 *
 * `PGC_CACHE_MAX` 只有 8 条 LRU。如果每集都取、都写，一堆"取回来一样"的
 * 条目会把真正有价值的 4K 缓存挤出去，于是下次进同一集又要再取 —— 恶性循环。
 *
 * **没升级成功就不写缓存**，这是这条新路径能常驻的前提。
 *
 * ## 为什么失败要静默
 *
 * 这条路径是"锦上添花"：失败了用户仍能看完整集，只是画质停在 SSR 给的那档。
 * 弹错误提示反而让人以为坏了。
 *
 * @param cid     章节 id
 * @param ssrInfo SSR 里的 `video_info`（已含当前下发的流）
 * @returns `true` 表示已发起刷新（调用方该立刻 return）；`false` 表示不动
 */
async function tryUpgradeForQuality(cid: string, ssrInfo: unknown): Promise<boolean> {
  const currentH = maxVideoHeight(ssrInfo);

  /**
   * SSR 里连一条带高度的视频轨都没有 → 判不了"当前拿到什么"，
   * 也就无从比较。这种集数（纯 durl / 结构异常）保持原样，不冒险。
   */
  if (currentH <= 0) return false;

  /**
   * 重刷护栏：本会话已为这一集刷过一次就不再取。
   *
   * 与 `prepareFullStream` 共用同一个 guard key —— 一个集数在本会话里
   * 最多因"填充"刷一次，不管是时长原因还是画质原因。否则两条路径各自
   * 刷一次，用户会看到两次闪屏。
   */
  const guardKey = GUARD_KEY_PREFIX + cid;
  let alreadyTried = false;
  try {
    alreadyTried = isAlreadyTried(parseGuard(sessionStorage.getItem(guardKey)), Date.now());
  } catch {
    /* 读不到就当没试过 */
  }
  if (alreadyTried) return false;

  const outcome = await fetchPgcPlayurl(cid, buildPlayurlUrl(cid));
  if (outcome.kind !== 'ok') {
    reportQuality({
      height: 0,
      note: `[PGC] 画质补取失败（${outcome.kind === 'denied' ? `code=${outcome.code}` : outcome.detail}），保持现有画质`,
    });
    return false;
  }

  if (!isBetterStream(currentH, outcome.result)) {
    reportQuality({
      height: 0,
      note: `[PGC] 补取到的画质不高于现有 ${String(currentH)}p —— 不替换`,
    });
    return false;
  }

  const fetchedH = maxVideoHeight(outcome.result);
  const merged = mergeVideoInfo(ssrInfo, outcome.result);
  if (!merged) {
    reportQuality({ height: 0, note: '[PGC] 补取有更高画质但合并不出可用字段，保持现有' });
    return false;
  }

  /**
   * 走到这里才写缓存 —— **只有真正要用的那份才进 LRU**。
   */
  await writePgcCache(cid, merged);
  const epFromUrl = parsePlayPage(location.href);
  writePgcSessionCache(cid, merged, epFromUrl?.kind === 'pgc' ? epFromUrl.epId : null);

  reportQuality({
    height: 0,
    note: `[PGC] 补取到更高画质 ${String(currentH)}p → ${String(fetchedH)}p，刷新生效`,
  });
  reloadWithGuard(cid, `画质可从 ${String(currentH)}p 提升到 ${String(fetchedH)}p`);
  return true;
}

/**
 * PGC 完整流编排：**一条 cid 走一遍**（**只服务整页加载**，见 ADR 0023）。
 *
 * ## ⚠️ SPA 切集不走这里
 *
 * 曾以为切集会走 `__playinfo__` 的 setter，于是加过 `epchange` 通知链路。
 * 真机验证推翻了它：**切集后 `__playinfo__` 完全不重新赋值**，setter 不被调用
 * （实测切到 `ep341210` 后 `arc.cid` 仍是上一集的 `248742156`）。
 *
 * 切集改由主世界在**响应层拦截 `/ogv/player/playview`**、当场换成完整集 durl
 * 处理（ADR 0023）—— 那条路用户完全无感，不需要 reload。
 *
 * 所以这个函数**只负责整页加载**：缓存命中就下发（主世界在 setter 里同步注入），
 * 未命中就取流 + 刷一次。
 *
 * ## 两条分支
 *
 *   - **缓存命中** → 写同步通道 + 异步下发（后者兜底，前者才是关键路径）
 *   - **缓存未命中** → 取流 → 写缓存 → **立刻刷**（护栏见 `pgc-reload-plan.ts`）
 *
 * @param cid     章节 id
 * @param ssrData 主世界报来的 SSR 数据（用于判断是否真的需要完整流）
 */
async function orchestratePgc(
  cid: string,
  ssrData?: unknown,
  ssrWasPatchedByUs: boolean = false,
): Promise<void> {
  const playInfo = parsePlayPage(location.href);
  const epId = playInfo?.kind === 'pgc' ? playInfo.epId : null;

  pgcReloadTrace.orchestrateCalls += 1;
  pgcReloadTrace.cid = cid;
  pgcReloadTrace.orchestrateExit = 'pending';

  /**
   * ## 只需浏览的集数不必取流，但**仍要记录它拿到的画质**
   *
   * 免费集 / 主账号本来就有权益的集数，SSR 流长度与 `timelength` 相符 ——
   * 注入完整流没有收益，反而可能把高清换成缓存里的旧 qn。
   *
   * ## ⚠️ 这里必须 `applyPlayback`（2026-10-29 真机发现）
   *
   * 原来此处直接 `return`，什么也不记。而 popup §2.3 的徽章只读
   * `pageState.playback`，它此前只在 `prepareFullStream` 里被填充 ——
   * 于是**免费集的 popup 永远显示「等待取流…」**，用户看到的和"插件没生效"一模一样。
   *
   * 真机现场（ep3854815）：`play_video_type=whole`、`timelength=1168405`、
   * `dash.duration=1169`、实际播放 3840×2160 —— 画质完全正常，
   * 但 popup 里一个徽章都不会有。**这是同一个用户反馈的另一种成因。**
   *
   * 这份 SSR 数据本身就是**页面在播放账号身份下拿到的响应**（DNR 已换 Cookie），
   * 所以它可以如实代表"播放账号这次拿到了什么"。
   */
  const ssrTruncated = ssrData !== undefined ? isStreamTruncated(ssrData) : true;
  pgcReloadTrace.ssrPatchedByUs = ssrWasPatchedByUs;
  pgcReloadTrace.ssrTruncated = ssrData !== undefined ? ssrTruncated : null;

  if (
    ssrData !== undefined &&
    canSkipPgcInjection({ pgcPatchedByUs: ssrWasPatchedByUs, truncated: ssrTruncated })
  ) {
    const ssrInfo = readSsrVideoInfo(ssrData);
    if (ssrInfo) pageState.applyPlayback({ code: 0, result: ssrInfo });

    /**
     * ## ⚠️ 「流够长」不等于「画质到顶」（2026-10-29 真机修的第二个 bug）
     *
     * 上面那条 `isStreamTruncated` 只回答**时长**问题。而真机实测证明了
     * 另一个独立的问题：**限免 / 免费集的流是完整的，但画质没到顶。**
     *
     * ```
     * ep733317（限免集）
     *   dash:          80@1080 64@720 32@480 16@360   ← 服务端只下发到 1080
     *   timelength     1075582ms vs dash.duration 1076s ← 相符，不算截断
     *   accept_quality [125,122,120,112,80,...]         ← 内容有 HDR/4K/1080P+
     *   播放账号取流    最高 2160，含 125/120/112        ← 本来能拿到
     * ```
     *
     * 于是用户看到的是「画质菜单里能选 4K/HDR，选了没反应」——
     * 因为**播放账号压根没去取**。
     *
     * ## 为什么在这里再取一次流，而不是用 `accept_quality` 预判
     *
     * `accept_quality` 只说明"内容提供哪些档"，不说明"实际能取到哪些"。
     * 拿它预判会引入「漏取」风险 —— 而漏取正是当前这个 bug 的形态。
     * **取一次、比结果，事实说话**：`isBetterStream()` 只在严格更高时才返回 `true`。
     *
     * ## 为什么这不会拖累会员老番
     *
     * 会员老番（只有 720P）走的是**上面那条截断路径**，根本到不了这里 ——
     * 这里只处理"时长已经够了"的集数。所以「老番掉回试看」不可能发生：
     * `isStreamTruncated` 那条路一个字节都没改。
     */
    if (ssrInfo && (await tryUpgradeForQuality(cid, ssrInfo))) {
      pgcReloadTrace.orchestrateExit = 'quality-upgrade-reload';
      return;
    }

    /**
     * ## ⚠️ 方向 B 卡住的第一现场就在这里（2026-10-29 定位）
     *
     * 「流够长」→ 直接 `return`，**根本不会往下走到 cache 分支**，
     * 于是 `shouldReload` 永远不被调用 → `pluma:pgc-reload` 从来没被写过
     * （真机证据：三个 pgc-* key 里唯独没有它）。
     *
     * ## 为什么「流够长」这个判据在第二趟必然成立
     *
     * `ssr-playinfo` 上报的是 `ssrPlayinfo`，而它是 setter 里
     * `ssrPlayinfo = v` 记下的**引用**（`main-world.js:363`）。
     * 紧接着同一个 setter 里 `pgcPatchPlayinfo(v)` 会执行
     * `r.video_info = next`（`main-world.js:959`）—— **原地替换**。
     *
     * 引用是同一个，所以 ISOLATED 侧收到的 `ssr-playinfo.data` 里
     * 已经是**注入后的完整流**，不是原始试看：
     *
     * ```
     * 第一趟（无缓存）  ssr-playinfo 里的 dash.duration = 180   → isStreamTruncated = true  → 走 cache 分支 ✅
     * 第二趟（有缓存）  ssr-playinfo 里的 dash.duration = 1166  → isStreamTruncated = false → 早退 ❌
     * ```
     *
     * **注入越成功，这条路径越进不去。** 这才是方向 B 的真因 ——
     * 不是"注入失败"，是"注入成功了，于是判据认为不需要再管它"。
     *
     * ## 为什么不能简单删掉这个 `return`
     *
     * 它对**首访免费集**是必需的：SSR 本身就是完整流（`play_video_type: whole`），
     * 再取一次流纯属浪费，且可能把已到顶的画质换成缓存里的旧 qn。
     * 所以判据要保留，但要**排除"这份 SSR 是我们自己注入出来的"**这种情况。
     */
    reportQuality({
      height: 0,
      note: '[PGC] 流长度与 timelength 相符 —— 无需注入',
    });
    pgcReloadTrace.orchestrateExit = 'not-truncated-early-return';
    pgcReloadTrace.lastReason =
      'SSR 流够长（可能是自己注入的结果），未进入 cache 分支，因此不会 reload';
    return;
  }

  const cached = await loadCachedVideoInfo(cid);

  /**
   * ## 读取侧校验：丢弃已被污染的旧缓存（2026-10-29 加，问题 5 的「治存量」）
   *
   * ### 为什么光修写入侧不够
   *
   * 写入侧的校验只对**以后**写进去的缓存生效。但用户机器上**已经**躺着
   * 旧版本写进去的坏数据（`storage.local` 的 LRU 是 8 条、TTL 100 分钟；
   * `sessionStorage` 同样 100 分钟）。不在这里拦，那些用户要等 TTL 过期才自愈。
   *
   * 这里把它当成"没有缓存"处理 —— 落到后面的取流分支，重新取一次。
   * 取回来的如果是完整流就正常写入；如果仍是试看流，写入侧的校验（见
   * `prepareFullStream`）会拒绝写，也不会刷新。
   *
   * ### 为什么判据用 `isVideoInfoTruncated` 而不是"有没有 dash"
   *
   * 完整集也可能是**纯 durl**（`fnval=0` 的老路，单段 durl 且长度 = timelength）。
   * 拿"有没有 dash"当判据会把那种合法缓存误杀，导致每次都重新取流。
   * 长度判据对两种形态都成立。
   */
  const cachedUsable = cached !== null && !isVideoInfoTruncated(cached);
  if (cached !== null && !cachedUsable) {
    reportQuality({
      height: 0,
      note: '[PGC] 缓存里的流短于 timelength（旧版本写入的试看流），**丢弃并重新取流**',
    });
    pgcReloadTrace.lastReason = '缓存是截断流，已丢弃';

    /**
     * ## 作废刷新护栏（2026-10-29 加，问题 5 的「坏缓存自愈」）
     *
     * ### 为什么要清
     *
     * 护栏（`pluma:pgc-reload:<cid>`，`MAX_RELOAD_ATTEMPTS = 1`）的语义是
     * 「同一集本会话刷过一次就够」，它**隐含假设"刷过一次就应该好了"**。
     *
     * 坏缓存打破了这个假设：
     *
     * ```
     * 第 1 轮  坏缓存 → hadSync=true → 不刷新（老 bug），但 guard 已被写
     * 第 2 轮  坏缓存被识别 → 想刷 → alreadyTried=true → **拒绝**
     *         → reloadIssued: 0、duration 停在 180，且没有任何提示
     * ```
     *
     * 真机证据：guard 的 `at` 比这次加载只早 2.4 分钟（TTL 是 10 分钟），
     * 也就是**上一轮**留下的、仍然有效，于是把这一轮的合法刷新挡掉了。
     *
     * ### 为什么这是一个安全的方向
     *
     * 护栏防的是「**同一个失效原因**反复刷新」。而"缓存内容坏"这个原因
     * **已经被这里处理掉了**（丢弃 + 重新取流），下次刷新是不同原因驱动的。
     *
     * ### 为什么不会变成无限刷新
     *
     * 因为 `prepareFullStream` 里的 `shouldWritePgcCache()` 闸在刷新**之前**：
     *
     * ```
     * 丢弃坏缓存 → 清护栏 → 取流
     *   ├─ 好流   → 写缓存 → reload → 第 2 趟 setter 有数据 → 注入成功（1 次，结束）
     *   └─ 仍试看 → shouldWritePgcCache=false → return，**不写也不刷** → 终止
     * ```
     *
     * 最坏是"用户每次手动刷新多一次取流请求"，**不会自动循环**。
     *
     * ⚠️ **只在这里清**：`hadSync === false` 另有"正常首访第二趟"这个成因，
     * 那种情况下护栏是对的，清掉会削弱它。详见 `shouldResetGuardForBadCache`。
     */
    if (shouldResetGuardForBadCache(true)) {
      const guardKey = GUARD_KEY_PREFIX + cid;
      try {
        sessionStorage.removeItem(guardKey);
        reportQuality({
          height: 0,
          note: '[PGC] 已作废本集的刷新护栏（坏缓存已丢弃，允许重新取流后刷新）',
        });
      } catch {
        /* sessionStorage 不可用：清不掉就算了，护栏仍会拦住刷新，只是不自愈 */
      }
    }
  }

  if (cachedUsable) {
    /**
     * ## 先看 `sessionStorage` 里**本来**有没有这份缓存
     *
     * 两个存储的生命周期不同：
     *   - `storage.local`：跨标签页、跨会话，有 LRU —— `loadCachedVideoInfo` 读它
     *   - `sessionStorage`：只活在这个标签页会话里，但**能被主世界同步读**
     *
     * 主世界注入必须在 `__playinfo__` 被赋值那一刻同步完成（`createPlayer` 紧跟其后
     * 0~2ms）。它只能读 `sessionStorage` —— 异步通道太慢。
     *
     * 真机实测（2026-10-28，ep3854815）：
     * ```
     * 第一趟（storage.local 命中、sessionStorage 空）
     *   ssAt 613 → patchedAt 1842     差 1229ms → 播放器已用 180 秒数据建好 → dur 180
     * 第二趟（sessionStorage 命中）
     *   ssAt 476 → patchedAt 478      差 2ms    → 同步注入成功 → dur 1169 / 3840×2160
     * ```
     *
     * **所以「`storage.local` 有、`sessionStorage` 没有」这个状态一定会失败**，
     * 必须写完同步缓存后**刷一次**进第二趟。这正是原来缺的那一步 ——
     * 旧代码在这里直接 `return`，用户就永远停在 180 秒试看，
     * 而试看状态下切 4K 找不到轨 → "切换失败"。
     */
    /**
     * 现在改成**内容校验**：键在但内容是截断流 → 等同没有 → 走"写完同步缓存再刷一次"。
     * 判据与 `cachedUsable` 用同一个（长度，不是"有没有 dash"）。
     *
     * 校验逻辑抽在 `isSyncCacheUsable()` 里（纯函数，有单测）——
     * 这个文件是 WXT 入口，**零单测覆盖**，写在这里等于没有守卫。
     */
    let hadSync = false;
    try {
      hadSync = isSyncCacheUsable(sessionStorage.getItem('pluma:pgc-vi:' + cid));
    } catch {
      /* sessionStorage 被禁用 → 当作没有 */
    }
    pgcReloadTrace.hadSync = hadSync;

    // 写同步通道 + 异步下发（后者兜底，前者才是关键路径）
    writePgcSessionCache(cid, cached, epId);
    /**
     * ## ⚠️ `enabled` 必须是**真实的开关值**，不能写死 `true`（2026-10-29 修 R1）
     *
     * 这里原来写死 `enabled: true`。当时的想法是"能走到 cache 分支说明有缓存，
     * 有缓存说明之前取流成功过，也就是开关开着" —— **这个推理不成立**：
     * 缓存是**上一次**开关开着时写下的，用户完全可能之后关掉开关再刷新。
     *
     * 后果有两条：
     *   1. 主世界 `cfgEnabled` 被推成 `true` → 第二道门控失效
     *      （第一道 `localStorage` 标记仍然拦得住，所以不致命）
     *   2. **更麻烦的**：真机排查时 `lastCfgEnabled: true` 会让人以为
     *      "消息通道报的是开"，从而去错误的方向找原因。
     */
    window.postMessage(
      {
        __ns: NS,
        type: 'cfg',
        token: CHANNEL_TOKEN,
        enabled: proxyEnabledKnown ?? true,
        pgcVideoInfo: cached,
      },
      '*',
    );
    reportQuality({
      height: 0,
      note: `[PGC] 命中缓存并下发（cid=${cid} 时长=${String(cached.timelength ?? 0)} 同步缓存原有=${String(hadSync)}）`,
    });

    /**
     * `sessionStorage` 本来就有 → 主世界在 setter 里已经同步注入成功，什么都不用做。
     * 本来没有 → 这一趟必然错过注入窗口，刷一次进第二趟。
     */
    if (!hadSync) {
      const guardKey = GUARD_KEY_PREFIX + cid;
      let alreadyTried = false;
      try {
        alreadyTried = isAlreadyTried(parseGuard(sessionStorage.getItem(guardKey)), Date.now());
      } catch {
        /* 读不到就当没试过 */
      }
      const verdict = shouldReload({ alreadyTried, hasStream: true });
      pgcReloadTrace.shouldReloadCalls += 1;
      pgcReloadTrace.shouldReloadArgs = { alreadyTried, hasStream: true };
      pgcReloadTrace.shouldReloadVerdict = verdict;
      if (verdict) {
        pgcReloadTrace.orchestrateExit = 'cache-nosync-reload';
        reloadWithGuard(cid, `同步缓存刚写好（cid=${cid}），刷新进第二趟`);
      } else {
        pgcReloadTrace.orchestrateExit = 'cache-nosync-no-reload';
        pgcReloadTrace.lastReason = '同步缓存刚写好但本会话已刷过一次';
        reportQuality({
          height: 0,
          note: '[PGC] 同步缓存刚写好但本会话已刷过一次，不再刷新',
        });
      }
    } else {
      /**
       * `hadSync === true` → 按 ADR 0020 的设计**不该刷新**：
       * 主世界在 setter 里已经同步注入成功，播放器读到的就是完整流。
       *
       * ⚠️ 但真机上出现过"注入了却还是 180 秒"，所以这里把 `hadSync` 记进快照，
       * 排查时一眼能看出是不是走了这条"设计上正确但实际没用"的路。
       */
      pgcReloadTrace.orchestrateExit = 'cache-hadsync-no-reload';
      pgcReloadTrace.lastReason =
        '同步缓存本来就有（hadSync=true），按 ADR 0020 设计不刷新；若播放器仍是试看，说明注入没被播放器采用';
    }
    return;
  }

  /**
   * 取流前的预判：**只看"这一集是不是已经试过了"**。
   *
   * 这里不能判 `active` / `hasStream` —— 两个值此刻都还不知道
   * （`hasStream` 要等取流回来；`active` 依赖异步的 `page/activate`）。
   * 真正的刷新判定在 `prepareFullStream` 内部，那里 `hasStream` 是真的。
   */
  const guardKey = GUARD_KEY_PREFIX + cid;
  let alreadyTried = false;
  try {
    alreadyTried = isAlreadyTried(parseGuard(sessionStorage.getItem(guardKey)), Date.now());
  } catch {
    /* 读不到就当没试过 */
  }
  if (alreadyTried) {
    reportQuality({
      height: 0,
      note: '[PGC] 这一集本会话已刷过一次，不再取流',
    });
    return;
  }

  await prepareFullStream(cid, ssrData ?? null);
}

/**
 * 记进度 → 写护栏 → reload。
 *
 * 抽出来是因为"取流后刷"永远要做同样三件事，
 * 而其中**写护栏**这一步失败就意味着刷新循环，不允许多处各写一遍。
 *
 * @param cid  章节 id
 * @param why  日志里说明为什么要刷
 */
function reloadWithGuard(cid: string, why: string): void {
  const guardKey = GUARD_KEY_PREFIX + cid;
  pgcReloadTrace.reloadWithGuardCalls += 1;
  const v = document.querySelector('video');
  if (v && Number.isFinite(v.currentTime)) saveResumeTime(cid, v.currentTime);
  try {
    sessionStorage.setItem(guardKey, JSON.stringify(makeGuard(Date.now())));
  } catch {
    // 写不进去就不刷 —— 没有标记会变成循环
    pgcReloadTrace.lastReason = 'reloadWithGuard: sessionStorage 写不进护栏，放弃刷新';
    reportQuality({ height: 0, note: '[PGC] 无法写刷新标记（sessionStorage 不可用），不刷新' });
    return;
  }
  pgcReloadTrace.reloadIssued += 1;
  reportQuality({ height: 0, note: `[PGC] ${why}，刷新一次` });
  location.reload();
}

/**
 * 取完整流 → 写缓存 → 刷新一次（P2 的第一趟）。
 *
 * ## 护栏全在 `pgc-reload-plan.ts`（纯函数，有单测）
 *
 * 这条链路最危险的失败模式是**刷新循环**：取流失败 → 还是没缓存 → 再取 → 再刷。
 * 所以"能不能刷"由 `shouldReload` / `isAlreadyTried` 统一判定，
 * 不在这个函数里临时加条件。
 *
 * ## 为什么刷新前要记播放位置
 *
 * 刷新会丢进度。用户从第 3 分钟开始，刷完回到第 0 分钟，体感很差。
 * 记进 `sessionStorage`，第二趟由 `restoreResumeTime` 拉回去。
 *
 * @param cid  章节 id
 * @param ssr  主世界报上来的 `ssr-playinfo` 的 `data`（用来取骨架 + 当前进度）
 */
async function prepareFullStream(cid: string, ssr: unknown): Promise<void> {
  const guardKey = GUARD_KEY_PREFIX + cid;
  let alreadyTried = false;
  try {
    alreadyTried = isAlreadyTried(parseGuard(sessionStorage.getItem(guardKey)), Date.now());
  } catch {
    /* 读不到就当没试过 */
  }

  const outcome = await fetchPgcPlayurl(cid, buildPlayurlUrl(cid));

  if (outcome.kind !== 'ok') {
    const why =
      outcome.kind === 'denied'
        ? `服务端拒绝（code=${outcome.code}）`
        : `取流失败（${outcome.detail}）`;
    reportQuality({ height: 0, note: `[PGC] ${why}，按试看播放，不刷新` });
    return;
  }

  // 合并到 SSR 骨架（字段白名单在 core/playinfo/pgc-merge.ts）
  const ssrVideoInfo = readSsrVideoInfo(ssr);
  const merged = mergeVideoInfo(ssrVideoInfo, outcome.result);
  if (!merged) {
    reportQuality({ height: 0, note: '[PGC] 接口有流但合并不出可用字段，按试看播放' });
    return;
  }

  /**
   * ## 把这次取流的结果交给 `pageState`（2026-10-29 加）
   *
   * ## 为什么 PGC 侧原来根本没有"播放账号拿到了什么"
   *
   * 普通视频的播放账号数据来自 `playurl-raw` 上报，而那个上报的闸门是
   * `isPlayurlPath()` —— 只认 `/x/player/wbi/playurl` 与 `/x/player/playurl`。
   * PGC 的 `/pgc/player/web/playurl` **不在 DNR 白名单里**（页面根本不调它），
   * 请求是本文件自己的 `fetchPgcPlayurl()` 发出的，响应只拿去合并、写缓存，
   * **从未回流到 `pageState`**。
   *
   * 于是即使 popup 的 §2.3 能显示（`pageKey` 修好之后），
   * `playback` 恒为 `null` → 徽章永远为空。
   *
   * ⚠️ 这里传的是**完整的接口响应**（`{code, result}`），不是 `outcome.result`。
   * 解析器 `parsePlayurl` 现在认识 `{code, result}` 形状（`pickData` 的 result 分支），
   * 传完整响应能让"接口形状"这一层判断只留在一个地方。
   */
  pageState.applyPlayback({ code: 0, result: outcome.result });

  /**
   * ## ⚠️ 写缓存前必须校验「够不够长」（2026-10-29 真机定位，问题 5）
   *
   * ### 踩到的现象
   *
   * 用户机器上的 `sessionStorage` 里躺着一份**自相矛盾**的缓存：
   *
   * ```
   * pluma:pgc-vi:42696771537
   *   hasDash        : false
   *   durl[0].length : 180160     ← 180 秒
   *   timelength     : 1166528    ← 19 分钟
   * ```
   *
   * 播放器拿到「1 段 180 秒的 durl」就只能播 180 秒 —— 这就是
   * 「重开开关后画质不恢复」的真正原因。**不是时序问题，是缓存里本身就是坏数据。**
   *
   * ### 坏数据是怎么来的
   *
   * ```
   * 播放账号这一刻没权益 → 接口返回 durl 1 段 180 秒 + timelength 19 分钟
   *   （接口自己就矛盾 —— ADR 0023 记过：timelength 是整集元数据，不代表流有多长）
   * → hasPlayableStream() 只看"有没有 durl" → true
   * → fetchPgcPlayurl() 返回 kind:'ok'        ← 漏点 1（本次**不修**，见下）
   * → mergeVideoInfo() 如实搬运（它没有校验职责）
   * → 这里直接写缓存                            ← 漏点 2（**本次修的就是它**）
   * ```
   *
   * ### ⚠️ 两个判据不要混用（写给下一个人）
   *
   * | 函数 | 回答的问题 |
   * | --- | --- |
   * | `hasPlayableStream()` | **有没有流**（只看 dash/durl/durls 存在与否，**不看长度**） |
   * | `isVideoInfoTruncated()` | **够不够长**（流时长 vs `timelength`） |
   *
   * `hasPlayableStream` 通过**不代表**是完整流 —— 试看流也有 durl。
   * 2026-10-29 之前这里两者都没用，所以坏数据一路写进了缓存，
   * 然后躺 100 分钟（`PGC_CACHE_TTL_MS`），期间每次刷新都注入它。
   *
   * ---
   *
   * ### ⚠️ 为什么这里是 `return`，而不是"只跳过写缓存"
   *
   * `prepareFullStream` 的后续是 **`shouldReload()` → `reloadWithGuard()`**。
   * 而 `reloadWithGuard` 的唯一作用就是**让第二趟去读这份缓存**。
   *
   * 既然这次取回来的是试看流、缓存也不写，那么：
   *   - 刷新之后仍然没有可用缓存 → 再取一次 → **又拿到试看** → 又刷 → **死循环**
   *   - 而 `shouldReload({ hasStream: true })` 会放行（它拿的是硬编码 `true`），
   *     真正拦住循环的只有 `pluma:pgc-reload` 护栏（10 分钟 TTL）
   *
   * 所以这里必须**整个函数退出**：不写缓存、也不刷新。
   * 让用户按试看播放（180 秒），与 `outcome.kind !== 'ok'` 那条分支的处置一致 ——
   * 那条分支同样只打日志、不刷新。
   *
   * **代价**：这一集在本次会话里不会再尝试取流（`pgcCacheTried` 已置 true）。
   * 用户刷新页面可以重试。这比"无限刷新"和"把坏数据存 100 分钟"都好。
   */
  if (!shouldWritePgcCache(merged)) {
    reportQuality({
      height: 0,
      note:
        `[PGC] 取回的是试看流而非完整流（dash/durl 短于 timelength ` +
        `${String(merged.timelength ?? 0)}ms），**不写缓存、不刷新**，按试看播放`,
    });
    pgcReloadTrace.orchestrateExit = 'prepare-truncated-no-write';
    pgcReloadTrace.lastReason = '合并结果是截断流，拒绝写入缓存（避免污染 100 分钟）';
    return;
  }

  await writePgcCache(cid, merged);

  /**
   * **同时写一份 `sessionStorage`** —— 这是第二趟能同步拿到的唯一途径。
   *
   * ## 为什么不能只靠 `storage.local`
   *
   * 真机 trace：`patchedAt: 2032` vs `createPlayer: 409ms`。
   * 走 `chrome.storage`（异步）→ `postMessage`（排队）→ 106 KB 结构化克隆，
   * 叠起来 1.6 秒，**必然错过播放器取数的那个窗口**。
   *
   * `sessionStorage` 是同步 API，主世界在 `__playinfo__` 的 setter 里直接
   * `getItem()`，微秒级完成。两份都要写：
   *   - `storage.local`：跨标签页、可清理、有 LRU
   *   - `sessionStorage`：**同步读**，专供注入
   */
  // epId 从 URL 再解析一次（prepareFullStream 的签名里没有它，
  // 但这里必须写映射，否则切集时找不到这份缓存）
  const epFromUrl = parsePlayPage(location.href);
  writePgcSessionCache(cid, merged, epFromUrl?.kind === 'pgc' ? epFromUrl.epId : null);

  /**
   * ## 走到这里，取流已经成功了
   *
   * **取流成功本身就是"DNR 已生效"的证明** —— 这个请求走
   * `credentials: 'include'` + DNR 换 Cookie，才可能拿到播放账号的 4K dash。
   * 所以这里**不再看 `badgeState.proxying`**：那是 `page/activate` 的异步回复，
   * 晚到或失败都会让明明能刷的情况被拦住，用户就停在 180 秒试看
   * （2026-10-28 真机定位，见 `shouldReload` 的注释）。
   */
  const prepareVerdict = shouldReload({ alreadyTried, hasStream: true });
  pgcReloadTrace.shouldReloadCalls += 1;
  pgcReloadTrace.shouldReloadArgs = { alreadyTried, hasStream: true };
  pgcReloadTrace.shouldReloadVerdict = prepareVerdict;
  if (!prepareVerdict) {
    pgcReloadTrace.orchestrateExit = 'prepare-no-reload';
    pgcReloadTrace.lastReason = '已缓存但本轮不刷新（本会话已刷过一次）';
    reportQuality({
      height: 0,
      note: '[PGC] 已缓存但本轮不刷新（本会话已刷过一次）',
    });
    return;
  }

  pgcReloadTrace.orchestrateExit = 'prepare-reload';
  reloadWithGuard(cid, `已取到完整流并缓存（cid=${cid}，时长=${String(merged.timelength ?? 0)}）`);
}

/** 从主世界报来的 `ssr-playinfo` 里取 `video_info`（骨架） */
function readSsrVideoInfo(ssr: unknown): unknown {
  if (!ssr || typeof ssr !== 'object') return null;
  const o = ssr as Record<string, unknown>;
  const result =
    (o.result as Record<string, unknown> | undefined) ??
    ((o.data as Record<string, unknown> | undefined)?.result as
      Record<string, unknown> | undefined);
  return result?.video_info ?? null;
}

function report(): void {
  const info = parsePlayPage(location.href);
  if (!info) return;

  /** 状态键：视频页用 bvid，PGC 页用 `ep:` / `ss:` */
  const pageKey =
    info.kind === 'video' ? info.bvid : info.epId ? `ep:${info.epId}` : `ss:${info.seasonId ?? ''}`;
  const p = info.kind === 'video' ? info.p : 1;

  /**
   * 登记当前页，供 popup §2.3 与 §2.4 的 A 卡片用。
   *
   * ## ⚠️ 这里**必须两类页面都登记**（2026-10-29 修）
   *
   * 原来写的是 `if (info.kind === 'video')`，理由是"§2.3 的对比依赖 SSR 基线，
   * 而 PGC 的 SSR 会被主世界改写成播放账号的流，基线不可信"。
   *
   * 那个理由只对**能力基线**成立。把整份登记一起跳过，代价是 PGC 页上
   * `PageState.view()` 恒为 `null` —— 于是**主账号的昵称/等级也一起没了**
   * （它跟取流身份毫无关系），popup 的 §2.3 永远停在「正在读取本页取流数据…」，
   * A 卡片永远写「打开视频页后可见」。一个"基线不可信"的局部判断，
   * 否决掉了整份数据。
   *
   * 现在改为：**两类页面都登记**，能不能出对比由 `capability` 是否为 null 决定
   * （PGC 侧解析出的 dash 见 `applyPlayback`）。主账号的显示信息与基线可用性解耦。
   */
  pageState.setPageKey(pageKey, p);

  /**
   * 主账号是否登录 —— 从页面 cookie 的 `DedeUserID` 判断（不读任何凭据）。
   *
   * ⚠️ `document_start` 时 `document.cookie` 往往是空的，读不到**不代表**游客，
   * 所以传 `settled: document.readyState !== 'loading'`：
   * 只有 DOM 就绪后的那次读取，才允许把"读不到"判成"未登录"。
   */
  pageState.setPrimaryMid(
    readPrimaryMidFromCookie(document.cookie),
    document.readyState !== 'loading',
  );

  /**
   * 上报「这个页面要用播放账号取流」，由 background 决定装不装规则。
   *
   * 走 `sendToBackground` 而不是直接 `browser.runtime.sendMessage`：
   * 后者在扩展重新加载后会**同步抛出**，`.catch()` 接不住。
   */
  void (async () => {
    const res = (await sendToBackground({
      type: 'page/activate',
      kind: info.kind,
      pageKey,
      p,
      deviceCookies: readDeviceCookies(document.cookie),
      // 主账号 mid 从**页面** cookie 读（普通分区），不从 background 发 nav 猜。
      primaryMid: readPrimaryMidFromCookie(document.cookie),
    })) as {
      type?: string;
      activated?: boolean;
      /** 与 `messages.ts` 的 `page/activate:ok` 同源。`'disabled'` = 用户关了总开关 */
      reason?: 'ok' | 'not-configured' | 'same-account' | 'disabled' | 'error';
    } | null;

    /**
     * 代理是否真的装上，**只以 background 的回报为准**。
     * 不能因为"配置了账号"就假定生效——同账号、无白名单路径等情况都会 false。
     */
    if (res?.type === 'page/activate:ok') {
      badgeState.proxying = res.activated === true;
      /**
       * 把 activate 的结果转给主世界：PGC 分支据此决定要不要接管播放器。
       *
       * ## ⚠️ 第一个参数是**总开关**，不是"扩展在工作"（2026-10-29 修）
       *
       * 原来这里是 `tellMainWorld(true, ...)` —— 无论总开关开还是关都写死 `true`。
       * 后果：`main-world.js` 的 `cfgEnabled` 永远是 `true`，
       * 于是「关开关后刷新番剧页 → 注入缓存的 4K 流 → 画质不回落」这条
       * **靠 `cfgEnabled` 判断的门控永远不生效**（真机实测：`cfgCount: 4`、
       * `lastCfgEnabled: true`，开关明明是关的）。
       *
       * `reason === 'disabled'` 是 background 明确说"用户关了总开关"
       * （`page.handler.ts` 的 `isProxyEnabled()` 分支），
       * 那是这里能拿到的**最权威**的开关信号 —— 比另外发一条 `proxy/status` 更好，
       * 因为它搭在这条**本来就要发的**消息上，不额外多一次往返、也不会晚到。
       */
      const proxyEnabled = !(res.activated === false && res.reason === 'disabled');
      proxyEnabledKnown = proxyEnabled;
      tellMainWorld(proxyEnabled, res.activated === true);

      /**
       * ## 总开关状态的本地落地（ADR 0028 第一层 + 第二层）
       *
       * ### 为什么必须在这里写（而不是等 popup 那条 `proxy/set`）
       *
       * 这条路径覆盖"**刷新页面时开关已经关着**"这个主场景：
       * `document_start` 就发出 `page/activate`，回包带着 `reason: 'disabled'`。
       * 而 popup 那条 `proxy/set` 只覆盖"用户此刻正在拨开关"，覆盖不到
       * "开关早就关了，用户现在刷新" —— 那正是用户报的场景。
       *
       * ### 为什么第一层（`localStorage` 标记）才是主修复
       *
       * 清 `sessionStorage`（第二层）**必然晚于**注入：真机
       * `patchedAt: 358ms` vs `page/activate` 回包 ~400ms。那只是把竞争从
       * "读缓存"挪到"删缓存"，同一个赛跑换个赛道，**不算修好**（ADR 0028 洞 1）。
       *
       * 标记则与时序无关：它由 `chrome.storage.onChanged` 在开关变化的那一刻
       * 同步写进所有已开标签页（见 `main()` 里的监听器），主世界在 setter 里
       * 读到的永远是"已落地"的状态。
       *
       * 这里也写一次，是为了兜住"扩展刚装上 / content 刚注入、onChanged 没收到
       * 那一次变化"的情况 —— 两条路互相兜底，任一条到就够。
       */
      writeProxyOffMark(!proxyEnabled);

      /**
       * 第二层：清掉注入缓存（**只做数据卫生 + 双保险**，不承担门控职责）。
       *
       * 只在 background **明确**说"总开关关着"时才清：
       * `reason === 'not-configured'` / `'same-account'` / `'error'` 都不清 ——
       * 那几种情况下开关其实是开着的，清了会让用户配好账号后白白多取一次流。
       */
      if (res.reason === 'disabled') {
        const purged = clearPgcSessionCache();
        reportQuality({
          height: 0,
          note: `[PGC] 总开关已关闭，已清 ${String(purged)} 条同步缓存（不影响本页已完成的注入）`,
        });
      }

      if (badgeState.proxying) hasEverActivated = true;
      paintBadge();
      return;
    }

    /**
     * 失败分支（含 `res === null`：background 未就绪 / 未配置 / 上下文已失效）
     *
     * ## 不能一失败就把角标撤掉（这是"乱跳"的根因之一）
     *
     * `page/activate` 在 SPA 路由变化、切 P、播放器重建时会被**重复调用**。
     * 只要有一次失败就 `removeBadge()`，而 `removeBadge` 会把
     * `lastPaintedHeight` 清零 —— 下一次 `paintBadge()` 时若高度恰好是 0，
     * 角标就闪回「已接管」。
     *
     * 用户看到的"角标在已接管和正常画质之间乱跳"就是这么来的。
     *
     * 现在的策略：
     *   - 从未成功过 → 撤掉角标（诚实：确实没接管上）
     *   - 曾经成功过 → 保留角标，只把状态降级，不清缓存
     *     （临时失败很可能是 SW 休眠唤醒中，不代表真失效）
     */
    badgeState.proxying = false;

    if (!hasEverActivated) {
      removeBadge();
      return;
    }
    paintBadge();
  })();
}

/**
 * 观测页面实际播放画质，上报给 background 写进诊断日志。
 *
 * @param send 由 `main()` 注入的 `reportQuality`。**不要在这里直接调
 *   `browser.runtime.sendMessage`** —— 扩展重新加载后会同步抛出
 *   `Extension context invalidated`，而调用点只接得住 Promise 拒绝。
 */
function watchPlaybackQuality(send: (payload: { height: number; note?: string }) => void): void {
  let lastReported = -1;

  const sample = (): void => {
    const v = document.querySelector('video');
    if (!v) return;
    const h = v.videoHeight;
    if (!h || h === lastReported) return;
    lastReported = h;

    send({ height: h });
  };

  for (const delay of [2000, 5000, 10000, 20000]) {
    window.setTimeout(sample, delay);
  }
}

export default defineContentScript({
  /**
   * 两类页面：
   *   - `/video/*` 普通视频（投稿）
   *   - `/bangumi/play/*` 番剧 / 国创 / 电影（PGC，ADR 0019）
   *
   * 主世界那一半是 `entrypoints/main-hook.content.ts`（`world: 'MAIN'`），
   * 匹配串必须与本文件保持一致 —— 只改一边会让某个页面"有 hook 没报到"或反之。
   */
  matches: ['*://*.bilibili.com/video/*', '*://*.bilibili.com/bangumi/play/*'],
  // document_start：必须早于播放器初始化。
  // - __playinfo__ 要在播放器读它之前藏好
  // - playurl 只在页面加载时调一次，晚了就没机会
  runAt: 'document_start',
  /**
   * ## 为什么接 `ctx`（2026-10-27 修 `Extension context invalidated`）
   *
   * 扩展被重新加载后，页面里**旧的 content script 还活着**，但它的
   * `chrome.runtime` 已经失效。此后任何扩展 API 调用都会抛
   * `Uncaught Error: Extension context invalidated`，扩展管理页会显示
   * 「错误 1 个」，用户以为插件坏了。
   *
   * 实测：单个 `.catch()` 兜不住 —— WXT 的 `browser.runtime.sendMessage`
   * 在上下文失效时**同步抛出**，不进入 Promise 链。
   *
   * WXT 的 `ctx` 提供了正规解法：它监听自身被替换 / 扩展卸载，
   * 触发时把 `ctx.signal` abort 掉。所以我们只要**用 signal 驱动所有
   * 异步任务和 addEventListener**，失效时它们会一起停，不再有调用发出。
   *
   * 这比在每个调用点套 try/catch 干净得多，也不会漏。
   */
  main(ctx) {
    /**
     * ⚠️ `ctx` 现在只用来接住 WXT 的生命周期，**不主动读 `ctx.isInvalid`**。
     *
     * 那个 getter 带副作用：`runtime.id == null` 时会调 `notifyInvalidated()`
     * 永久 abort 整个 ctx。作为高频判据太危险（2026-10-27 踩过，
     * 表现为设置页读不到主账号）。
     *
     * 真正的防护放在发送点：`sendToBackground` 用 try/catch 接同步抛出，
     * 这正是 `Extension context invalidated` 的产生方式。
     */
    void ctx;

    installSender();

    /**
     * popup / 诊断页**直连**查询当前页数据（不经 SW）。
     *
     * 用原生 `chrome.runtime.onMessage` 而不是 `browser.*`：
     * Edge 自带的 `browser` 命名空间会让 `sendResponse` + `return true` 静默失效
     * （见 `entrypoints/background.ts` 顶部注释）。这里同步应答，不返回 true。
     */
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      /**
       * ⚠️ **这里不能加 `dead()` 判断**（2026-10-27 踩到）。
       *
       * `ctx.isInvalid` 的 getter 是**带副作用的**：
       *
       * ```js
       * get isInvalid() {
       *   if (browser.runtime?.id == null) this.notifyInvalidated();  // ← abort！
       *   return this.signal.aborted;
       * }
       * ```
       *
       * 只要访问那一刻 `runtime.id` 读不到（SW 冷启动的瞬间就可能），
       * 它就会 **永久 abort 掉 ctx** —— 之后所有消息都不再应答，
       * 表现为「设置页的账号卡片读不到主账号」。
       *
       * 而这条判断本来就不必要：上下文失效后浏览器会**自动停用**这个监听器，
       * 我们不需要自己再问一遍。加它只带来了误判风险。
       *
       * 发送方向（`sendToBackground`）用 `dead()` 是对的 —— 那里是**发出去**
       * 才可能抛错，且即便误判也只是少发一条日志，不会让功能失效。
       */
      if ((msg as { type?: string } | undefined)?.type !== 'page/summary:get') return false;

      const view = pageState.view();
      sendResponse(
        view
          ? { type: 'page/summary:ok', view }
          : { type: 'page/summary:none', reason: 'not-ready' },
      );
      return false;
    });

    /**
     * popup 快照（`page/snapshot:get`）—— 给自动化 / bsk 用，**popup 不依赖它**。
     *
     * ## 为什么必须异步（返回 `true`）
     *
     * 与上一条不同：快照要账号摘要，而账号摘要只有 background 有。
     * 所以这里要 `await sendToBackground({type:'account/summary'})`，
     * 必须 `return true` 让 `sendResponse` 在回调之后仍然有效
     * （同步 `return false` 会让通道立刻关闭，应答丢失）。
     *
     * ## 为什么不复用 `page/summary:get`
     *
     * 那条是**同步**的、只回 `pageState`，且被 popup 与 options 用着。
     * 改成异步会动到两个现有调用方；而快照是"给机器看"的另一件事，
     * 分开两条通道互不影响。
     *
     * 组装逻辑在 `shared/utils/popup-snapshot.ts`（纯函数，有单测）——
     * 这里只负责取数。
     */
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if ((msg as { type?: string } | undefined)?.type !== 'page/snapshot:get') return false;

      void takeSnapshot().then(sendResponse);
      return true;
    });

    /**
     * **页面侧触发快照** —— 让 `bsk evaluate` 能直接拿到 JSON。
     *
     * ## 为什么需要它（2026-10-29）
     *
     * popup / options 都是 `chrome-extension://` 页面，而 bsk 的 Agent Window
     * 沙箱**按 URL 白名单**拒绝它们：`evaluate` 直接报
     * `operation denied by the Agent Window sandbox`。
     * 于是每个 UI 问题（主账号栏空着、画质区显示错话）都只能靠人点一次、
     * 肉眼描述 → 一轮排查来回三次。
     *
     * 而用 `page/snapshot:get` 也不行：那是 `chrome.runtime.onMessage` 通道，
     * 页面主世界的 `chrome` **没有 `runtime`**（实测：
     * `Cannot read properties of undefined (reading 'sendMessage')`）。
     *
     * 所以加一条**页面 → content** 的 postMessage 桥。用法：
     *
     * ```js
     * // bsk evaluate 里
     * window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
     * window.addEventListener('message', e => {
     *   if (e.data?.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply')
     *     console.log(JSON.stringify(e.data.snapshot));
     * });
     * ```
     *
     * ## 安全边界（**改这里之前先读完**）
     *
     * - **只读**：快照来自 `takeSnapshot()`，它只读 `pageState` 与两个 background 查询，
     *   **不改任何状态**。页面脚本伪造这条消息最多让**自己**多看到一份数据。
     * - **不含凭据**：`buildPageSnapshot` 的输出已经过 `AGENTS.md §5.2` 的约束
     *   （只有 uname / mid / vipLabel / expireAt / healthy 五个字段），
     *   `tests/unit/shared/page-snapshot.test.ts` 有序列化后 grep 的断言。
     *   但**主账号昵称与 mid 仍属账号标识** —— 页面脚本本来就能从
     *   `__INITIAL_STATE__` / cookie 读到同等的值，所以这里没有增加暴露面。
     * - **不回环**：只应答、不主动重发，且 `snapshot-reply` 的 `type` 与
     *   `snapshot` 不同名，不会自己触发自己。
     */
    window.addEventListener('message', (ev) => {
      const d = ev.data as { __ns?: string; type?: string } | null;
      if (!d || d.__ns !== NS || d.type !== 'snapshot') return;

      void takeSnapshot().then((reply) => {
        window.postMessage(
          {
            __ns: NS,
            type: 'snapshot-reply',
            snapshot: reply.snapshot,
            // ISOLATED world 的 PGC 重载诊断（MAIN world 读不到那个对象，见 `takeSnapshot`）
            pgcReload: 'pgcReload' in reply ? reply.pgcReload : null,
          },
          '*',
        );
      });
    });

    /**
     * **页面侧切换总开关** —— 让自动化能验「关开关 → 刷新 → 画质回落」。
     *
     * ## 为什么必须有它
     *
     * 验收第 5 条（关总开关 → 刷新 → 画质回落）与用户报的问题 5/6 都要求
     * **真的去拨那个开关**。而 popup / options 是 `chrome-extension://`，
     * bsk 沙箱拒绝 `evaluate`；页面主世界又没有 `chrome.storage`
     * （实测 `typeof chrome.storage === 'undefined'`）。
     * 所以只能由 content 转一手。
     *
     * ## ⚠️ 为什么**不用 token 做防护**（重要，别加回来）
     *
     * 第一反应是"带个随机 token 只让知道的人用"。**但 token 对页面是公开的**：
     * `tellMainWorld()` 把 `CHANNEL_TOKEN` 直接 `postMessage` 到 `'*'`，
     * 页面脚本加个监听器就能拿到。拿一个页面能读到的值当权限凭证是自欺。
     *
     * ## 真正的边界：**只允许写一个键，且只允许布尔值**
     *
     * 这条通道能做的事被硬限制在：
     *   - **只有一个目标**：总开关（`pluma:proxy-enabled`）。不开放任意 key。
     *   - **只接受 `true` / `false`**（`=== true` / `=== false` 严格判断，
     *     字符串 `"false"`、`1`、`null` 一律拒绝）。
     *   - 走的是与 popup **完全相同**的那条消息（`proxy/set`），
     *     所以"关开关 → 删两类 DNR 规则"的既有语义不受影响。
     *
     * 即使页面脚本伪造，它能达到的最坏效果是**帮用户点了一下总开关** ——
     * 而用户本来就能点，且 popup 会立刻显示状态变化。
     * **不能借此读到凭据、不能改白名单、不能改账号。**
     *
     * ## 与快照桥分开写（不合并）
     *
     * 一条只读、一条会改状态。合并成一个 handler 会让"能不能写"取决于
     * 中间某个分支，读代码的人无法一眼确认。**分开 = 边界可见。**
     */
    window.addEventListener('message', (ev) => {
      const d = ev.data as { __ns?: string; type?: string; enabled?: unknown } | null;
      if (!d || d.__ns !== NS || d.type !== 'set-proxy') return;

      /** 严格布尔：`"false"` / `1` / `null` 全部拒绝（见上面「真正的边界」） */
      const enabled = d.enabled === true ? true : d.enabled === false ? false : null;
      if (enabled === null) {
        window.postMessage(
          { __ns: NS, type: 'set-proxy-reply', ok: false, error: 'enabled 必须是布尔值' },
          '*',
        );
        return;
      }

      void sendToBackground({ type: 'proxy/set', enabled })
        .then((res) => {
          const r = res as { type?: string; enabled?: boolean; detail?: string } | null;
          const ok = r?.type === 'proxy/set:ok';
          window.postMessage(
            {
              __ns: NS,
              type: 'set-proxy-reply',
              ok,
              enabled: ok ? r?.enabled === true : enabled,
              ...(ok ? {} : { error: r?.detail ?? '切换失败' }),
            },
            '*',
          );
        })
        .catch((e: unknown) => {
          window.postMessage(
            {
              __ns: NS,
              type: 'set-proxy-reply',
              ok: false,
              error: e instanceof Error ? e.message.slice(0, 60) : 'unknown',
            },
            '*',
          );
        });
    });
    /**
     * 角标开关（设置页「显示」分区）。
     *
     * 读一次 + 监听变化：设置页保存后**不用刷新页面**角标就消失/出现，
     * 因为它只是不再渲染，不涉及 DNR 规则（那是总开关的事）。
     */
    void readBadgeEnabled().then((enabled) => {
      badgeEnabled = enabled;
      paintBadge();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      /**
       * ## 总开关变化 → 同步本地标记（ADR 0028 第一层，跨标签页机制）
       *
       * `chrome.storage.onChanged` **在所有已打开的 B站标签页里都会触发**
       * （不只当前那个），所以这一个监听器就补掉了 ADR 0028 的「洞 3」：
       * 用户开着 5 个番剧标签页时，关一次开关，5 个页面的 `localStorage` 标记
       * 同时更新 —— 逐个刷新时全部回落。
       *
       * ## 为什么用 storage 事件而不是 `page/activate` 回包
       *
       * `page/activate` 只在**页面加载时**发一次。开关变化发生在页面已经加载完之后，
       * 那时不会再有回包。所以"拨开关"这个动作必须靠 storage 事件传播，
       * 否则用户得先刷新才生效 —— 而 popup 的提示语是"刷新生效"，
       * 意思是"刷新之后就生效"，不是"得先刷两次"。
       *
       * 标记写的是 `{at: <now>}`，主世界侧有 30 分钟 TTL（`PROXY_OFF_TTL_MS`）。
       */
      const proxyChange = changes[PROXY_ENABLED_KEY];
      if (proxyChange) {
        const off = proxyChange.newValue === false;
        writeProxyOffMark(off);
        /**
         * 同步更新"已知开关值"，让后续 `cfg` 报出真实状态。
         *
         * `newValue` 可能是 `undefined`（键被删）—— 那种情况不更新，
         * 保持上一次的已知值比"猜一个"更安全。
         */
        if (typeof proxyChange.newValue === 'boolean') {
          proxyEnabledKnown = proxyChange.newValue;
        }

        /**
         * ## 第三层：**重开**开关时清掉刷新护栏（ADR 0028 的「洞 2」）
         *
         * 只在 `oldValue === false && newValue === true` 这一个瞬间清 ——
         * **不能无条件清**。每次 storage 变化都清会废掉 `alreadyTried` 的
         * 防刷新循环本意（`pgc-reload-plan.ts` 的三条硬护栏之一）。
         *
         * 为什么要清：用户
         * ```
         * 关开关 → 缓存被清（第二层）、guard 保留
         * 重开开关 → 刷新 → 无缓存，该取流了
         *          → isAlreadyTried(guard) === true → 直接 return
         *          → 不取流、不刷新、无提示 → 停在试看，最长 10 分钟
         * ```
         * 这正是"开关的动作在另一个方向不生效"，与用户报的 bug 同类。
         *
         * ⚠️ 用 `=== false` / `=== true` 严格比较：`oldValue` 在"键从未存在过"
         * 时是 `undefined`，那种情况**不算重开**（用户从没开过，或存储被清过）。
         */
        if (isProxyReenabled(proxyChange.oldValue, proxyChange.newValue)) {
          const cleared = clearPgcReloadGuards();
          if (cleared > 0) {
            reportQuality({
              height: 0,
              note: `[PGC] 总开关已重开，已清 ${String(cleared)} 条刷新护栏（避免卡在试看）`,
            });
          }
        }
      }

      const change = changes[BADGE_ENABLED_KEY];
      if (!change) return;
      badgeEnabled = change.newValue !== false;
      paintBadge();
    });

    listenMainWorld();

    /**
     * 主世界脚本由浏览器在 `document_start` 直接注入
     * （`entrypoints/main-hook.content.ts`，`world: 'MAIN'`），这里**不再手工注入**。
     *
     * 只留一条可观测的自检：确认它真的跑起来了。没跑起来时诊断日志会明确说出来，
     * 而不是表现为"功能莫名其妙不生效"。
     */
    reportQuality({
      height: 0,
      note:
        (window as unknown as Record<string, unknown>).__PLUMA_MAIN__ === true
          ? '主世界已就绪（MAIN world 内容脚本）'
          : '主世界未就绪（检查 manifest 里是否有 world:MAIN 的内容脚本）',
    });

    report();

    /**
     * PGC：刷新后把播放位置还原（P2 的代价补偿）。
     *
     * 只在 PGC 播放页跑；`restoreResumeTime` 内部会**先看有没有记录**，
     * 没有记录就什么都不做 —— 所以普通视频页 / 首次进入都不会挂定时器。
     */
    const pgcPage = parsePlayPage(location.href);
    if (pgcPage?.kind === 'pgc') {
      const cid = pgcPage.epId ?? pgcPage.seasonId ?? '';
      if (cid) {
        restoreResumeTime(cid, (detail) =>
          reportQuality({ height: 0, note: `[PGC] 位置恢复：${detail}` }),
        );
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          report();
          watchPlaybackQuality(reportQuality);
        },
        { once: true },
      );
    } else {
      watchPlaybackQuality(reportQuality);
    }
  },
});

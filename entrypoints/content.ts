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
import { PageState } from '@/src/content/isolated/page-state';
import {
  isPreviewSsr,
  isStreamTruncated,
  loadCachedVideoInfo,
  readCidFromSsr,
  writePgcSessionCache,
} from '@/src/content/isolated/pgc-cache-inject';
import { fetchPgcPlayurl } from '@/src/content/isolated/pgc-fetch';
import {
  GUARD_KEY_PREFIX,
  buildPlayurlUrl,
  isAlreadyTried,
  makeGuard,
  parseGuard,
  shouldReload,
} from '@/src/content/isolated/pgc-reload-plan';
import { restoreResumeTime, saveResumeTime } from '@/src/content/isolated/pgc-resume';
import { mergeVideoInfo } from '@core/playinfo/pgc-merge';
import { writePgcCache } from '@platform/storage/pgc-cache-store';
import { BADGE_ENABLED_KEY, readBadgeEnabled } from '@platform/storage/ui-prefs-store';
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
      // 主世界先发 hello 时，立刻把配置推过去
      tellMainWorld(true);
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
       */
      void orchestratePgc(cid, d.data);
      return;
    }

    /** 页面自己的 playurl 响应原文（播放账号身份）—— 用同一套解析器算能力 */
    if (d.type === 'playurl-raw') {
      pageState.applyPlayback(d.json ?? null);
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

      const aud = (s.audio ?? []).map((a) => `${a.id}(${Math.round(a.bw / 1000)}k)`).join(',');
      const flac = s.flac
        ? `FLAC id=${s.flac.id} ${Math.round(s.flac.bw / 1000)}k${s.flac.sampleRate ? ` ${s.flac.sampleRate}Hz` : ''}`
        : '无';
      const dolby = s.dolby?.length
        ? s.dolby.map((a) => `${a.id}(${Math.round(a.bw / 1000)}k)`).join(',')
        : '无';

      // 视频轨按高度分组，标出各 codecid
      const vids = [...new Set((s.video ?? []).map((v) => `${v.h}p/cc${v.codecid}`))].join(',');

      reportQuality({
        height: 0,
        note:
          `下发轨道 视频=[${vids}] 音频=[${aud}] Hi-Res=${flac} 杜比=${dolby}` +
          ` 杜比视界=${s.dolbyVision ? '有' : '无'}`,
      });
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
      // 用实际播放数据更新角标。
      // 高度来自 <video>.videoHeight，编码来自 SourceBuffer 的实际 mime ——
      // 这两个都是"真的在解什么"的直接证据
      /**
       * ⚠️ `h.h` 为 0 时**不要覆盖**已有的有效高度。
       *
       * 切画质瞬间主世界会连发多条 `hdr`，其中几条 `h` 是 0（新轨还没 metadata）。
       * 旧代码无条件赋值，`playingHeight` 被归零 → 角标闪回「已接管」。
       *
       * 高度为 0 只表示"此刻读不到"，不是"没在播"。
       */
      const nextH = h.h ?? 0;
      if (nextH > 0) badgeState.playingHeight = nextH;
      badgeState.videoFamily = h.family ?? '';
      badgeState.audioFamily = h.audioFamily ?? '';
      // 'high' / 'standard' → 布尔；其他（'?'）表示读不到，保持 null
      badgeState.videoDynamicRange =
        h.video === 'high' ? true : h.video === 'standard' ? false : null;
      // HEVC profile 用来在详情里标 10bit（弱信号，仅作排查线索）
      badgeState.displayDynamicRange =
        h.display === 'high' ? true : h.display === 'standard' ? false : null;
      badgeState.hevcProfile = h.profile ?? '';
      // 实际帧率：来源是 playurl 轨道清单里的 frame_rate
      badgeState.frameRate = typeof h.frameRate === 'number' ? h.frameRate : 0;
      paintBadge();

      /**
       * 诊断：把角标判定的**完整输入**打出来。
       *
       * 为什么需要：用户环境有 HDR 显示能力，自动化测试环境没有，
       * 导致 `(dynamic-range: high)` 在两边结果不同，无法复现。
       * 这条日志让用户在自己机器上看一次视频，就能把真实输入带出来。
       *
       * 只记技术状态，不含任何凭据。
       */
      reportQuality({
        height: 0,
        note:
          `[角标输入] h=${String(h.h ?? 0)} fps=${String(h.frameRate ?? 0)}` +
          ` family=${h.family ?? '?'} audio=${h.audioFamily ?? '?'}` +
          ` profile=${h.profile ?? '?'}` +
          ` display=${h.display ?? '?'} video=${h.video ?? '?'}` +
          ` dv=${String(badgeState.dolbyVisionAvailable)}`,
      });

      reportQuality({
        height: h.h ?? 0,
        note:
          `画面 ${h.w ?? 0}x${h.h ?? 0} | 视频=${h.family ?? '?'}` +
          ` | 音频=${h.audioFamily ?? '?'}` +
          ` | 活跃 视频${h.vsb?.active ?? 0}/${h.vsb?.total ?? 0} 音频${h.asb?.active ?? 0}/${h.asb?.total ?? 0}` +
          ` | HDR=${h.display ?? '?'}/${h.video ?? '?'}`,
      });

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
async function orchestratePgc(cid: string, ssrData?: unknown): Promise<void> {
  const playInfo = parsePlayPage(location.href);
  const epId = playInfo?.kind === 'pgc' ? playInfo.epId : null;

  /**
   * ## 只需要看的集数不必取流
   *
   * 免费集 / 主账号本来就有权益的集数，SSR 流长度与 `timelength` 相符 ——
   * 注入完整流没有收益，反而可能把高清换成缓存里的旧 qn。
   */
  if (ssrData !== undefined && !isStreamTruncated(ssrData)) {
    reportQuality({
      height: 0,
      note: '[PGC] 流长度与 timelength 相符 —— 无需注入',
    });
    return;
  }

  const cached = await loadCachedVideoInfo(cid);
  if (cached) {
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
    let hadSync = false;
    try {
      hadSync = !!sessionStorage.getItem('pluma:pgc-vi:' + cid);
    } catch {
      /* 读不到当作没有 */
    }

    // 写同步通道 + 异步下发（后者兜底，前者才是关键路径）
    writePgcSessionCache(cid, cached, epId);
    window.postMessage(
      { __ns: NS, type: 'cfg', token: CHANNEL_TOKEN, enabled: true, pgcVideoInfo: cached },
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
      if (shouldReload({ alreadyTried, hasStream: true })) {
        reloadWithGuard(cid, `同步缓存刚写好（cid=${cid}），刷新进第二趟`);
      } else {
        reportQuality({
          height: 0,
          note: '[PGC] 同步缓存刚写好但本会话已刷过一次，不再刷新',
        });
      }
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
  const v = document.querySelector('video');
  if (v && Number.isFinite(v.currentTime)) saveResumeTime(cid, v.currentTime);
  try {
    sessionStorage.setItem(guardKey, JSON.stringify(makeGuard(Date.now())));
  } catch {
    // 写不进去就不刷 —— 没有标记会变成循环
    reportQuality({ height: 0, note: '[PGC] 无法写刷新标记（sessionStorage 不可用），不刷新' });
    return;
  }
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
  if (!shouldReload({ alreadyTried, hasStream: true })) {
    reportQuality({
      height: 0,
      note: '[PGC] 已缓存但本轮不刷新（本会话已刷过一次）',
    });
    return;
  }

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

  /**
   * 普通视频：登记页面，供 popup §2.3 的画质对比用。
   *
   * ⚠️ **PGC 页不登记**。§2.3 的对比依赖"`document_start` 那刻的 `__playinfo__`
   * 是主账号基线"（ADR 0014），而 PGC 页的 SSR 数据会被主世界改写成播放账号的流
   * （ADR 0019），那份基线不再可信。PGC 页的状态展示留给角标（走实际播放高度，不猜）。
   */
  if (info.kind === 'video') pageState.setPage(info.bvid, info.p);

  /** 状态键：视频页用 bvid，PGC 页用 `ep:` / `ss:` */
  const pageKey =
    info.kind === 'video' ? info.bvid : info.epId ? `ep:${info.epId}` : `ss:${info.seasonId ?? ''}`;
  const p = info.kind === 'video' ? info.p : 1;

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
    })) as { type?: string; activated?: boolean } | null;

    /**
     * 代理是否真的装上，**只以 background 的回报为准**。
     * 不能因为"配置了账号"就假定生效——同账号、无白名单路径等情况都会 false。
     */
    if (res?.type === 'page/activate:ok') {
      badgeState.proxying = res.activated === true;
      // 把 activate 的结果转给主世界：PGC 分支据此决定要不要接管播放器
      tellMainWorld(true, res.activated === true);
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

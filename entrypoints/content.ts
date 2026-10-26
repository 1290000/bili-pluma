/**
 * 内容脚本 —— 页面侧的编排层。
 *
 * 三件事：
 *   1. **注入主世界脚本**（藏 `__playinfo__` + 伪装本地会员状态）
 *   2. **报到**：告诉 background「这个标签页要代理 playurl」
 *   3. 观测：记录页面实际播放画质（诊断用）
 *
 * ⚠️ 本文件在 ISOLATED world：有 chrome API，但看不到页面的 JS 变量。
 * 碰页面变量的活交给 `public/main-world.js`（注入到主世界）。
 */

import { browser } from 'wxt/browser';

import { renderBadge, removeBadge } from '@/src/content/isolated/badge';
import {
  parseVideoPage,
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

/** 重画角标。所有字段变化后统一调这一个入口 */
function paintBadge(): void {
  renderBadge(tokensCss, badgeState);
}

/**
 * 注入主世界脚本。
 *
 * **必须用 src 引用扩展内的独立文件**，不能用内联 script：
 * MV3 默认 CSP 禁止执行内联脚本，内联方式会**静默失败**
 * ——插入语句成功返回，但脚本从未执行。这是排查了很久才发现的坑。
 *
 * `main-world.js` 在 `public/` 下，构建后位于扩展根目录，
 * 并由 manifest 的 `web_accessible_resources` 允许页面引用。
 */
function injectMainWorld(onInjected: (ok: boolean, detail: string) => void): void {
  const attach = (): boolean => {
    const parent = document.documentElement ?? document.head;
    if (!parent) return false;

    try {
      const script = document.createElement('script');
      // 用原生 chrome.runtime.getURL：WXT 的包装版对路径做了类型约束，
      // 只接受它识别的 HTML 入口，不认 public/ 下的静态资源
      script.src = chrome.runtime.getURL('main-world.js');
      script.async = false;
      parent.appendChild(script);
      // 不 remove：src 加载是异步的，提前移除会取消加载
      script.addEventListener('load', () => onInjected(true, '已加载'));
      script.addEventListener('error', () =>
        onInjected(false, '资源加载失败（检查 web_accessible_resources）'),
      );
      return true;
    } catch (e) {
      onInjected(
        false,
        `插入 script 抛错: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`,
      );
      return false;
    }
  };

  if (attach()) return;

  // documentElement 还没出来，每 10ms 重试
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (attach()) {
      window.clearInterval(timer);
      return;
    }
    if (tries >= 200) {
      window.clearInterval(timer);
      onInjected(false, `重试 ${tries} 次仍无 documentElement`);
    }
  }, 10);
}

/** 告知主世界脚本：代理已启用 */
function tellMainWorld(enabled: boolean): void {
  window.postMessage({ __ns: NS, type: 'cfg', token: CHANNEL_TOKEN, enabled }, '*');
}

/** 监听主世界的回执 */
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
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note: `主世界就绪 readyState=${f?.readyState ?? '?'} define=${f?.define ?? '?'} hadExisting=${String(f?.hadExisting)} playinfo=${f?.playinfo ?? '?'}`,
        })
        .catch(() => {});
      // 主世界先发 hello 时，立刻把配置推过去
      tellMainWorld(true);
      return;
    }

    if (d.type === 'ready') {
      tellMainWorld(true);
      return;
    }

    // 会员状态响应已被改写 —— 切换画质不再弹「开通大会员」的前提
    if (d.type === 'patch') {
      const p = d as { path?: string };
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note: `已改写会员状态响应: ${p.path ?? '?'}`,
        })
        .catch(() => {});
      return;
    }

    // SourceBuffer 装载成功（有数据写入）
    if (d.type === 'sb-ok' || d.type === 'sb-error') {
      const s = d as { mime?: string; kind?: string; buffered?: number };
      const label = s.kind === 'video' ? '视频轨' : '音轨';
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note:
            d.type === 'sb-ok'
              ? `${label}装载成功: ${s.mime ?? '?'} (缓冲 ${Math.round(s.buffered ?? 0)}s)`
              : `${label}装载失败: ${s.mime ?? '?'}`,
        })
        .catch(() => {});
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

      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note:
            `下发轨道 视频=[${vids}] 音频=[${aud}] Hi-Res=${flac} 杜比=${dolby}` +
            ` 杜比视界=${s.dolbyVision ? '有' : '无'}`,
        })
        .catch(() => {});
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
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note:
            `[角标输入] h=${String(h.h ?? 0)} fps=${String(h.frameRate ?? 0)}` +
            ` family=${h.family ?? '?'} audio=${h.audioFamily ?? '?'}` +
            ` profile=${h.profile ?? '?'}` +
            ` display=${h.display ?? '?'} video=${h.video ?? '?'}` +
            ` dv=${String(badgeState.dolbyVisionAvailable)}`,
        })
        .catch(() => {});

      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: h.h ?? 0,
          note:
            `画面 ${h.w ?? 0}x${h.h ?? 0} | 视频=${h.family ?? '?'}` +
            ` | 音频=${h.audioFamily ?? '?'}` +
            ` | 活跃 视频${h.vsb?.active ?? 0}/${h.vsb?.total ?? 0} 音频${h.asb?.active ?? 0}/${h.asb?.total ?? 0}` +
            ` | HDR=${h.display ?? '?'}/${h.video ?? '?'}`,
        })
        .catch(() => {});

      // 逐条明细单独打一行，切换音质时看这个
      if (h.vDetail || h.aDetail) {
        void browser.runtime
          .sendMessage({
            type: 'page/quality',
            height: 0,
            note: `轨道明细 视频[${h.vDetail ?? ''}] 音频[${h.aDetail ?? ''}]`,
          })
          .catch(() => {});
      }
      return;
    }

    // 播放器实际创建的 SourceBuffer 编码
    if (d.type === 'codec') {
      const c = d as { mime?: string; from?: string; kind?: string };
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note: `${c.kind === 'audio' ? '音频' : '视频'}编码(${c.from ?? '?'}): ${c.mime ?? '?'}`,
        })
        .catch(() => {});
      return;
    }

    // 页面真的发出了 playurl 请求 —— 这是 DNR 能不能生效的前提
    if (d.type === 'req') {
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note: `playurl 请求出现: ${d.method ?? 'GET'} ${(d.url ?? '').split('?')[0]}`,
        })
        .catch(() => {});
    }
  });
}

function report(): void {
  const info = parseVideoPage(location.href);
  if (!info) return;

  void browser.runtime
    .sendMessage({
      type: 'page/activate',
      bvid: info.bvid,
      p: info.p,
      deviceCookies: readDeviceCookies(document.cookie),
      // 主账号 mid 从**页面** cookie 读（普通分区），不从 background 发 nav 猜。
      primaryMid: readPrimaryMidFromCookie(document.cookie),
    })
    .then((res: { type?: string; activated?: boolean } | undefined) => {
      // 代理是否真的装上，**只以 background 的回报为准**。
      // 不能因为"配置了账号"就假定生效——同账号、无白名单路径等情况都会 false。
      badgeState.proxying = res?.type === 'page/activate:ok' && res.activated === true;
      if (badgeState.proxying) hasEverActivated = true;
      paintBadge();
    })
    .catch(() => {
      /**
       * background 未就绪 / 未配置 —— 静默失败。
       *
       * ## 不能一失败就把角标撤掉（这是"乱跳"的根因之一）
       *
       * `page/activate` 在 SPA 路由变化、切 P、播放器重建时会被**重复调用**。
       * 只要有一次 `.catch` 触发，旧代码就 `removeBadge()`，
       * 而 `removeBadge` 会把 `lastPaintedHeight` 清零 ——
       * 下一次 `paintBadge()` 时若高度恰好是 0，角标就闪回「已接管」。
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
    });
}

/** 观测页面实际播放画质，上报给 background 写进诊断日志 */
function watchPlaybackQuality(): void {
  let lastReported = -1;

  const sample = (): void => {
    const v = document.querySelector('video');
    if (!v) return;
    const h = v.videoHeight;
    if (!h || h === lastReported) return;
    lastReported = h;

    void browser.runtime.sendMessage({ type: 'page/quality', height: h }).catch(() => {});
  };

  for (const delay of [2000, 5000, 10000, 20000]) {
    window.setTimeout(sample, delay);
  }
}

export default defineContentScript({
  matches: ['*://*.bilibili.com/video/*'],
  // document_start：必须早于播放器初始化。
  // - __playinfo__ 要在播放器读它之前藏好
  // - playurl 只在页面加载时调一次，晚了就没机会
  runAt: 'document_start',
  main() {
    listenMainWorld();

    injectMainWorld((ok, detail) => {
      void browser.runtime
        .sendMessage({
          type: 'page/quality',
          height: 0,
          note: `主世界注入${ok ? '成功' : '失败'}: ${detail}`,
        })
        .catch(() => {});
    });

    report();

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          report();
          watchPlaybackQuality();
        },
        { once: true },
      );
    } else {
      watchPlaybackQuality();
    }
  },
});

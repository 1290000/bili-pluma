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

import {
  parseVideoPage,
  readDeviceCookies,
  readPrimaryMidFromCookie,
} from '@shared/utils/video-page';

/** 跨 world 通信的随机令牌。页面脚本能读到它，只用于防盲注 */
const CHANNEL_TOKEN = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const NS = '__PLUMA__';

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
          };
        }
      ).summary;
      if (!s) return;

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
          note: `下发轨道 视频=[${vids}] 音频=[${aud}] Hi-Res=${flac} 杜比=${dolby}`,
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
        canDecode?: string;
        audio?: string;
        audioFamily?: string;
        canPlayAudio?: string;
        vsb?: { total: number; active: number };
        asb?: { total: number; active: number };
        vDetail?: string;
        aDetail?: string;
      };
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
    .catch(() => {
      // background 未就绪 / 未配置 —— 静默失败，不打扰用户
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

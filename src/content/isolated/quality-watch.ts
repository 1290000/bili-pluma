/**
 * 页面实际播放画质的观测与上报（S3.1，2026-10-30 从 `entrypoints/content.ts` 下沉）
 *
 * ## 为什么放在 `src/content/isolated/`
 *
 * `entrypoints/` 的约定是「入口只跟消息协议打交道」（`docs/04-project-structure.md` §2）。
 * 而这段是**业务实现**：取 `<video>` 的 `videoHeight`、去重、按时间点采样，
 * 再交给注入的 `send` 上报。它与 WXT 的注册无关，放在入口里既测不到也看不清。
 *
 * ## 为什么 `send` 必须注入，不能自己调 `browser.runtime.sendMessage`
 *
 * 扩展被重新加载后，页面里旧的 content script 还活着，但 `chrome.runtime` 已失效。
 * 此时 `browser.runtime.sendMessage` 会**同步抛出** `Extension context invalidated`，
 * 而调用点只接得住 Promise 拒绝 —— 那次抛出会变成控制台里的未捕获错误，
 * 扩展管理页显示「错误 1 个」，用户以为插件坏了。
 *
 * 所以发送统一由入口的 `installSender()` 提供（内部 try/catch + 返回 null）。
 */

/** 采样时间点（毫秒，从 `main()` 调用时刻算起） */
export const QUALITY_SAMPLE_DELAYS_MS = [2000, 5000, 10000, 20000] as const;

export type QualityPayload = { height: number; note?: string };
export type QualitySender = (payload: QualityPayload) => void;

/**
 * 观测页面实际播放画质，在若干时间点各采样一次并上报。
 *
 * ## 为什么要去重（`lastReported`）
 *
 * 四个时间点很密集，而画质通常只在开播后变一两次。不去重的话背景日志会被
 * 同一条 1080 刷满，真正有用的"1080→2160"那次变化反而被淹掉。
 *
 * ## 为什么不用 `setInterval`
 *
 * 2026-10-25 的真实故障：「视频页挂后台一段时间，回来白屏 / 播放器无响应」，
 * 根因之一就是持续运行的定时器。这里是**有限次 `setTimeout`**，跑完即止。
 *
 * @param send   上报函数，由入口注入（见文件头）
 * @param getVideo 取当前 `<video>` 的函数，默认读 `document.querySelector('video')`。
 *   **注入是为了可测** —— 本模块不该被 `document` 绑死。
 */
export function watchPlaybackQuality(
  send: QualitySender,
  getVideo: () => { videoHeight: number } | null = () => {
    const v = document.querySelector('video');
    return v;
  },
): void {
  let lastReported = -1;

  const sample = (): void => {
    const v = getVideo();
    if (!v) return;
    const h = v.videoHeight;
    if (!h || h === lastReported) return;
    lastReported = h;

    send({ height: h });
  };

  for (const delay of QUALITY_SAMPLE_DELAYS_MS) {
    // 用 globalThis 而不是 window：本模块不绑死浏览器宿主，Node 里也能测。
    // （下沉前这里写的是 `window.setTimeout`，在 content script 里等价，
    //   但那让这段逻辑只能跑在 jsdom 下。）
    globalThis.setTimeout(sample, delay);
  }
}

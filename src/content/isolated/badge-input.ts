/**
 * 主世界 `hdr` / `playurl-tracks` 消息 → 角标状态的**纯函数**。
 *
 * ## 为什么从 `entrypoints/content.ts` 抽出来
 *
 * 那两条分支里有两条**踩过的坑**，但它们埋在 350 行的消息监听里，没有任何测试：
 *
 *   1. `h` 为 0 时**不能覆盖**已有高度（切画质瞬间主世界连发多条 `hdr`，
 *      其中几条 `h` 是 0，旧代码无条件赋值 → `playingHeight` 归零 → 角标闪回「已接管」）
 *   2. `video` / `display` 的 `'?'` 要映射成 `null` 而不是 `false`
 *      （`'?'` 是"读不到"，`'standard'` 才是"确认不是 HDR"）
 *
 * 抽成纯函数后这两条都能用单测锁住，且 `content.ts` 少 80 行。
 * 依赖方向：`entrypoints/*` → `src/content/*`，符合 AGENTS.md §5.1。
 */

/** 角标状态里本模块负责的那部分（与 `content.ts` 的 `badgeState` 结构兼容） */
export interface BadgeInputState {
  playingHeight: number;
  videoFamily: string;
  audioFamily: string;
  frameRate: number;
  videoDynamicRange: boolean | null;
  displayDynamicRange: boolean | null;
  hevcProfile: string;
}

/** 主世界 `hdr` 消息的载荷（字段全部可选：页面环境不同，能读到的也不同） */
export interface HdrPayload {
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
}

/**
 * 把 `hdr` 载荷写进角标状态（**就地修改**，调用方随后 `paintBadge()`）。
 *
 * ⚠️ 三条不变式，改这里之前先看单测：
 *   - `h` 为 0 / 缺失 → **保持原高度**（0 表示"此刻读不到"，不是"没在播"）
 *   - `video` / `display` 不是 `high`/`standard` → 置 `null`（未知），**不是** `false`
 *   - `family` / `profile` 缺失 → 写空串（角标据此省略该段文案）
 */
export function applyHdrInput(state: BadgeInputState, h: HdrPayload): void {
  const nextH = h.h ?? 0;
  if (nextH > 0) state.playingHeight = nextH;
  state.videoFamily = h.family ?? '';
  state.audioFamily = h.audioFamily ?? '';
  // 'high' / 'standard' → 布尔；其他（'?'）表示读不到，保持 null
  state.videoDynamicRange = h.video === 'high' ? true : h.video === 'standard' ? false : null;
  state.displayDynamicRange = h.display === 'high' ? true : h.display === 'standard' ? false : null;
  state.hevcProfile = h.profile ?? '';
  state.frameRate = typeof h.frameRate === 'number' ? h.frameRate : 0;
}

/**
 * 诊断日志：把角标判定的**完整输入**打出来。
 *
 * 为什么需要：用户环境有 HDR 显示能力，自动化测试环境没有，
 * 导致 `(dynamic-range: high)` 在两边结果不同，无法复现。
 * 这条日志让用户在自己机器上看一次视频，就能把真实输入带出来。
 * 只记技术状态，不含任何凭据。
 */
export function describeHdrInput(h: HdrPayload, dolbyVisionAvailable: boolean): string {
  return (
    `[角标输入] h=${String(h.h ?? 0)} fps=${String(h.frameRate ?? 0)}` +
    ` family=${h.family ?? '?'} audio=${h.audioFamily ?? '?'}` +
    ` profile=${h.profile ?? '?'}` +
    ` display=${h.display ?? '?'} video=${h.video ?? '?'}` +
    ` dv=${String(dolbyVisionAvailable)}`
  );
}

/** 主世界 `hdr` 消息里的播放统计（给"画面 / 轨道明细"两行日志用） */
export function describeHdrPlayback(h: HdrPayload): string {
  return (
    `画面 ${h.w ?? 0}x${h.h ?? 0} | 视频=${h.family ?? '?'}` +
    ` | 音频=${h.audioFamily ?? '?'}` +
    ` | 活跃 视频${h.vsb?.active ?? 0}/${h.vsb?.total ?? 0} 音频${h.asb?.active ?? 0}/${h.asb?.total ?? 0}` +
    ` | HDR=${h.display ?? '?'}/${h.video ?? '?'}`
  );
}

/** `playurl-tracks` 的轨道摘要（主世界已经压成这个形状） */
export interface TracksSummary {
  audio?: { id: number; bw: number }[];
  video?: { id: number; h: number; codecid: number; bw: number }[];
  flac?: { id: number; bw: number; sampleRate: number } | null;
  dolby?: { id: number; bw: number; type: number }[] | null;
  dolbyVision?: boolean;
}

/**
 * 一行日志：这次 playurl 到底下发了哪些轨（确认 Hi-Res / 杜比有没有）。
 *
 * 带宽统一按 kbps 展示 —— 原始 `bw` 是 bps，数字太大反而看不出量级。
 */
export function describeTracks(s: TracksSummary): string {
  const aud = (s.audio ?? []).map((a) => `${a.id}(${Math.round(a.bw / 1000)}k)`).join(',');
  const flac = s.flac
    ? `FLAC id=${s.flac.id} ${Math.round(s.flac.bw / 1000)}k${s.flac.sampleRate ? ` ${s.flac.sampleRate}Hz` : ''}`
    : '无';
  const dolby = s.dolby?.length
    ? s.dolby.map((a) => `${a.id}(${Math.round(a.bw / 1000)}k)`).join(',')
    : '无';
  // 视频轨按高度分组，标出各 codecid
  const vids = [...new Set((s.video ?? []).map((v) => `${v.h}p/cc${v.codecid}`))].join(',');

  return (
    `下发轨道 视频=[${vids}] 音频=[${aud}] Hi-Res=${flac} 杜比=${dolby}` +
    ` 杜比视界=${s.dolbyVision ? '有' : '无'}`
  );
}

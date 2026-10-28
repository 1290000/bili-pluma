/**
 * playurl 响应 → `PlayInfo`。
 *
 * 分层：`core/` 纯函数，零 IO、零浏览器 API，可在 Node 里全覆盖。
 *
 * ## 三条纪律
 *
 * 1. **永不抛异常。** 输入是网络响应，形状随时会变。解析失败返回 `null`，
 *    由调用方决定"当成拿不到画质"还是"报错"。
 * 2. **不补默认值骗人。** 缺字段就是 0 / `null` / 空数组，不假设"没写就是 30fps"。
 * 3. **不做业务判断。** "这个身份能拿到什么"是 `rank.ts` 的事；这里只做形状归一。
 *
 * ## 为什么同时接受 snake_case 和 camelCase
 *
 * 实测 wbi 版和旧版接口的字段名不完全一致（`frame_rate` / `frameRate`），
 * `src/content/main-world.js` 的 `summarizePlayurl()` 也是两个都试。
 * 这不是防御性编程，是**已知的真实差异**。
 */

import type { AudioTrack, DashData, PlayInfo, VideoTrack } from '@shared/types/playinfo';

/** 未知/非法输入一律收敛成 0，不做类型推断 */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 只接受数组，其他一律空数组 */
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 字符串数组（`accept_description` 是中文名列表） */
function strArray(v: unknown): string[] {
  return arr(v)
    .map((x) => (typeof x === 'string' ? x : ''))
    .filter((x) => x.length > 0);
}

/** 有限数字数组（`accept_quality`） */
function numArray(v: unknown): number[] {
  return arr(v)
    .map(num)
    .filter((n) => n > 0);
}

/**
 * 解析一条视频轨。
 *
 * ⚠️ **`baseUrl` 缺失也保留这条轨。** 能力统计（最高高度、最高帧率）只看 `height` / `frameRate`，
 * 与直链无关；直接丢掉会让"这个账号能拿到 4K"的判断变成"拿不到"。
 */
function parseVideoTrack(v: unknown): VideoTrack {
  const o = isRecord(v) ? v : {};
  const frameRateRaw = str(o.frame_rate) || str(o.frameRate);
  return {
    id: num(o.id),
    baseUrl: str(o.base_url) || str(o.baseUrl),
    backupUrl: strArray(o.backup_url ?? o.backupUrl),
    bandwidth: num(o.bandwidth) || num(o.band_width),
    codecid: num(o.codecid),
    width: num(o.width),
    height: num(o.height),
    frameRate: num(frameRateRaw),
    frameRateRaw,
    mimeType: str(o.mime_type) || str(o.mimeType),
  };
}

function parseAudioTrack(v: unknown): AudioTrack {
  const o = isRecord(v) ? v : {};
  return {
    id: num(o.id),
    baseUrl: str(o.base_url) || str(o.baseUrl),
    backupUrl: strArray(o.backup_url ?? o.backupUrl),
    bandwidth: num(o.bandwidth) || num(o.band_width),
    codecid: num(o.codecid),
    mimeType: str(o.mime_type) || str(o.mimeType),
  };
}

/**
 * 解析 `dash` 块。缺失时返回 `null`（番剧只有 `durl`）。
 */
function parseDash(v: unknown): DashData | null {
  if (!isRecord(v)) return null;

  // flac 有两种形态：`flac: null`，或 `flac: { display, audio }`
  const flacRaw = v.flac;
  const flacObj = isRecord(flacRaw) ? flacRaw : null;
  const flacAudioRaw = flacObj?.audio;
  const flacAudio =
    isRecord(flacAudioRaw) && Object.keys(flacAudioRaw).length > 0
      ? parseAudioTrack(flacAudioRaw)
      : null;

  const dolbyObj = isRecord(v.dolby) ? v.dolby : null;
  const dolbyAudio = arr(dolbyObj?.audio).map(parseAudioTrack);

  return {
    duration: num(v.duration),
    video: arr(v.video).map(parseVideoTrack),
    audio: arr(v.audio).map(parseAudioTrack),
    flacAudio,
    dolbyAudio,
    // 只认服务端明确的布尔 true；`undefined` / 字符串都不算
    dolbyVision: dolbyObj?.vision === true,
  };
}

/**
 * 从三种已知形状里取出"video_info 那一层"。
 *
 * | 来源 | 形状 | 取哪层 |
 * | --- | --- | --- |
 * | 普通视频 `/x/player/wbi/playurl` | `{code, data: {...}}` | `data` |
 * | PGC `/pgc/player/web/playurl` | `{code, result: {...}}` | **`result` 本身就是 video_info** |
 * | SSR 的 `__playinfo__` | 直接就是 data | 它自己 |
 *
 * ## `result` 分支是 2026-10-29 补的，原因是真机踩到
 *
 * 原来只认 `{data}` 和"自己长得像 data"两种。PGC 的响应是 `{code, result}`，
 * 而 `result` 上**没有** `data` 这层 —— 于是 `pickData` 返回 `null`，
 * `parsePlayurl` 返回 `null`，`capabilityOf` 返回 `null`。
 *
 * 三个 null 一路传下去：**popup 的徽章永远是空的，而且不报错**。
 * 番剧页看起来"插件没生效"，实际是解析器不认识那个形状。
 *
 * 判据与 `pgc-cache-inject.ts` 的 `readVideoInfo()` 保持一致：
 * `result` 上有 `dash` / `durl` / `timelength` 之一，就认为它是 video_info 本身。
 */
function pickData(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(raw.data)) return raw.data;

  /**
   * PGC：`result` 即 video_info。
   *
   * ⚠️ 判据**不能只写 `isRecord(raw.result)`** —— 有些普通视频接口也会返回
   * `result`，但里面是嵌套的 `{video_info: ...}`。只认"长得像 video_info"的形状，
   * 误认识的代价是把一份空壳当成能力，得出"这个身份什么都拿不到"的假结论。
   */
  if (isRecord(raw.result)) {
    const r = raw.result;
    const looksLikeVideoInfo = 'dash' in r || 'durl' in r || 'timelength' in r;
    if (looksLikeVideoInfo) return r;
    // `{result: {video_info}}` 这种嵌套形状也接一下（SSR 里出现过）
    if (isRecord(r.video_info)) return r.video_info;
  }

  const looksLikeData =
    'dash' in raw || 'durl' in raw || 'accept_quality' in raw || 'acceptQuality' in raw;
  return looksLikeData ? raw : null;
}

/**
 * 解析一次 playurl 响应**或** SSR 的 `__playinfo__`。
 *
 * @param raw `res.json()` 的结果，或 `window.__playinfo__` 的值（未知形状）
 * @returns 归一后的 `PlayInfo`；取不出 `data` 时返回 `null`
 *
 * ⚠️ **不检查 `code`。** 业务码（`-101` / `-412`）属于调用方要处理的错误，
 * 混进解析层会让"解析失败"和"身份失效"两种完全不同的原因混为一谈。
 * 调用方应自己先判断 `code === 0`。
 */
export function parsePlayurl(raw: unknown): PlayInfo | null {
  if (!isRecord(raw)) return null;

  const data = pickData(raw);
  if (!data) return null;

  const dash = parseDash(data.dash);
  const durl = Array.isArray(data.durl) && data.durl.length > 0 ? data.durl : null;

  return {
    quality: num(data.quality),
    acceptQuality: numArray(data.accept_quality ?? data.acceptQuality),
    acceptDescription: strArray(data.accept_description ?? data.acceptDescription),
    dash,
    durl,
  };
}

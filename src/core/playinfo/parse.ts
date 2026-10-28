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
 * 从两种形状里取出 `data`。
 *
 * - **接口响应**：`{ code, message, ttl, data: {...} }`
 * - **SSR 的 `__playinfo__`**：直接就是 `data` 本身（ADR 0007 记录的 `playurlSSRData.data`）
 *
 * 不猜"是哪种调用方"，只看形状：有 `data` 对象就用它，否则如果本身长得像 data 就用它自己。
 * 这样同一份解析逻辑能同时服务"体检表"和"主账号基线"（ADR 0014），不用维护两套。
 */
function pickData(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(raw.data)) return raw.data;

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

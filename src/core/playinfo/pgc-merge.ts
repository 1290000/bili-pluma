/**
 * PGC 取流响应的**合并**逻辑 —— 纯函数，零 IO、零浏览器 API。
 *
 * ## 为什么必须合并，不能替换
 *
 * 两个接口返回的 `result` 形状不同（2026-10-27 实测）：
 *
 * | 来源 | 形状 |
 * | --- | --- |
 * | `/pgc/player/web/playurl` | **扁平**：`{ dash, durls, quality, timelength, accept_quality, format, … }` |
 * | SSR 的 `__playinfo__.result` | **嵌套**：`{ arc, play_check, play_video_type, watch_progress, video_info: { … } }` |
 *
 * 播放器读的是 **SSR 形状**。直接替换的实测结果：`video.readyState = 0`、
 * `src` 都没设、**黑屏且不报错**（`poc/verify/poc-pgc-inject.cjs`）。
 *
 * 所以：以 SSR 为骨架，只把**流字段**换成接口给的。
 *
 * ## 为什么只换流字段，不改 `is_preview` / `play_check`
 *
 * 实测（`poc/probe/probe-pgc-is-preview.cjs`）：把这三个标记全改成"完整"，
 * `video.duration` 仍是 360 —— **播放器不按字段截断，是流本身就短**。
 * 反过来，只要给了 1440 秒的流，它就会播 1440 秒。
 *
 * 所以改那几个字段对"能不能播"毫无帮助，只会把界面伪装成"你本来就有权益" ——
 * 那是 ADR 0013 那一类需要单独授权的改写，**本路线不做**。
 */

/** 允许从接口搬进 `video_info` 的字段白名单 */
export const STREAM_FIELDS = [
  'quality',
  'timelength',
  'format',
  'dash',
  'durl',
  'durls',
  'accept_quality',
  'accept_description',
  'support_formats',
  'video_codecid',
  'fnval',
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从 SSR 的 `__playinfo__` 里取出 `result`。
 *
 * 兼容两种外壳：
 *   - `playurlSSRData.data`（= `{code, message, ttl, result}`，PGC 页的实际形状）
 *   - 直接是 `result` 本身
 */
export function pickSsrResult(playinfo: unknown): Record<string, unknown> | null {
  if (!isRecord(playinfo)) return null;
  if (isRecord(playinfo.result)) return playinfo.result;
  if (isRecord(playinfo.data) && isRecord(playinfo.data.result)) return playinfo.data.result;
  return null;
}

/**
 * 判断一份 `apiResult` 里有没有**真正的流**（不是只有元信息）。
 *
 * 为什么单独判：接口在无权益时也会返回 `quality` / `timelength` / `accept_quality`
 * 这些元字段。如果"搬到一个字段"就算成功，那么拿试看响应去合并也会返回一份
 * "看着改了、其实没流"的 `video_info` —— 播放器拿到它可能反而播不了。
 */
function hasStreamField(apiResult: Record<string, unknown>): boolean {
  const dash = apiResult.dash;
  if (isRecord(dash) && Array.isArray(dash.video) && dash.video.length > 0) return true;
  if (Array.isArray(apiResult.durl) && apiResult.durl.length > 0) return true;
  if (Array.isArray(apiResult.durls)) {
    for (const g of apiResult.durls) {
      if (isRecord(g) && Array.isArray(g.durl) && g.durl.length > 0) return true;
    }
  }
  return false;
}

/**
 * 把接口的流字段合并进 SSR 的 `video_info`。
 *
 * @param ssrVideoInfo SSR 原来的 `video_info`（提供骨架，例如 `is_preview` / `type`）
 * @param apiResult    `/pgc/player/web/playurl` 的 `result`
 * @returns 新的 `video_info`；接口**没给出真正的流**时返回 `null`（调用方不该替换）
 *
 * ⚠️ **不修改入参**：返回新对象。主世界那份 `__playinfo__` 会被别处引用，
 * 就地改容易出"改了一半"的中间态。
 *
 * ⚠️ **"有流"是硬条件，不是"搬到了字段"**：见 `hasStreamField` 的说明。
 */
export function mergeVideoInfo(
  ssrVideoInfo: unknown,
  apiResult: unknown,
): Record<string, unknown> | null {
  if (!isRecord(apiResult)) return null;
  if (!hasStreamField(apiResult)) return null;

  const base = isRecord(ssrVideoInfo) ? ssrVideoInfo : {};
  const out: Record<string, unknown> = { ...base };

  for (const key of STREAM_FIELDS) {
    const v = apiResult[key];
    if (v === undefined || v === null) continue;
    // 空数组不算"有数据"：接口偶尔会返回 `durls: []`，覆盖过去等于把流清空
    if (Array.isArray(v) && v.length === 0) continue;
    out[key] = v;
  }

  /**
   * ⚠️ **有 dash 就把 `durl` / `durls` 删掉**（2026-10-28 真机定位）。
   *
   * 现象：注入后 `dash.duration = 1441` 正确，但 `<video>.duration` 仍是 360、
   * `currentSrc` 指向 **durl** 的地址、`currentTime=600` 被夹回 360。
   *
   * → 播放器在 `durl` 存在时**优先走 durl**，SSR 那份 360 秒的试看 durl 一直在，
   * 注入的 dash 从来没被用过。"6 分 01 秒被拦"不是字段拦截，
   * 是**流真的只有 360 秒**。
   *
   * 所以：给了 dash 就抹掉 durl，强制播放器走 dash。
   * 缓存里只有 durl（没有 dash）时才保留 durl。
   */
  const hasDash = isRecord(out.dash) && Array.isArray(out.dash.video) && out.dash.video.length > 0;
  if (hasDash) {
    delete out.durl;
    delete out.durls;
  }

  return out;
}

/**
 * 判断这次响应到底是不是"有流"。
 *
 * 只看 `dash` / `durl` / `durls` 三处 —— 其余字段（`quality` / `timelength`）
 * 在无权益时也会有值，拿它当判据会把"试看"当成"成功"。
 */
export function hasPlayableStream(apiResult: unknown): boolean {
  if (!isRecord(apiResult)) return false;
  const dash = apiResult.dash;
  if (isRecord(dash) && Array.isArray(dash.video) && dash.video.length > 0) return true;
  if (Array.isArray(apiResult.durl) && apiResult.durl.length > 0) return true;
  if (Array.isArray(apiResult.durls)) {
    for (const g of apiResult.durls) {
      if (isRecord(g) && Array.isArray(g.durl) && g.durl.length > 0) return true;
    }
  }
  return false;
}

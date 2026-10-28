/**
 * PGC 完整流缓存下发 —— ISOLATED 侧（`entrypoints/content.ts`）。
 *
 * ## 为什么需要"下发"
 *
 * 主世界脚本没法用 `chrome.storage`（那是扩展 API，页面主世界没有）。
 * 而注入必须发生在 `__playinfo__` 赋值那一刻（同步），所以数据必须**先送到手里**。
 *
 * 安排：
 *   1. `document_start`：这里异步读缓存 → 拿到后 postMessage 给主世界
 *   2. 主世界收到后缓存进变量，等 `__playinfo__` 的 setter 一触发就同步替换
 *   3. 缓存晚到（少见）→ 主世界会补一次
 *
 * ## 命中与未命中
 *
 * - 命中 → 直接注入，**不发请求、不 reload**，和普通页面没区别
 * - 未命中 → 返回 `null`，由 `prepareFullStream` 去取流 + 触发一次 reload
 */

import type { PgcCacheEntry } from '@platform/storage/pgc-cache-store';
import { readPgcCache } from '@platform/storage/pgc-cache-store';

/** 从 URL 读出 cid 之外的信息；cid 只能从页面 SSR 拿，见 `readCidFromPlayinfo` */
export interface PgcContext {
  /** 章节 id。缓存与取流都靠它 */
  cid: string;
}

/**
 * 从页面 SSR 的 `__playinfo__` 读 cid。
 *
 * ⚠️ 主世界与 ISOLATED 是两个 world，**ISOLATED 读不到页面变量**。
 * 所以这里不是真的去读 `window.__playinfo__`，而是从**主世界已经报上来的**
 * `ssr-playinfo` 消息里取 —— 调用方负责把那份数据传进来。
 *
 * @param ssrData 主世界 `ssr-playinfo` 消息里的 `data`
 */
export function readCidFromSsr(ssrData: unknown): string | null {
  if (!ssrData || typeof ssrData !== 'object') return null;
  const o = ssrData as Record<string, unknown>;
  const result =
    (o.result as Record<string, unknown> | undefined) ??
    ((o.data as Record<string, unknown> | undefined)?.result as
      Record<string, unknown> | undefined);
  if (!result) return null;

  const arc = result.arc as Record<string, unknown> | undefined;
  const cid = arc?.cid ?? (result.video_info as Record<string, unknown> | undefined)?.cid;
  if (typeof cid === 'number' && Number.isFinite(cid) && cid > 0) return String(cid);
  if (typeof cid === 'string' && /^\d+$/.test(cid)) return cid;
  return null;
}

/**
 * 判断这份 SSR 数据是不是"只能试看"。
 *
 * 免费集 / 主账号本来有权益的集数不走 P2 —— 注入完整流没有收益，
 * 反而可能把高清换成别的（缓存可能是旧的另一个 qn）。
 */
export function isPreviewSsr(ssrData: unknown): boolean {
  if (!ssrData || typeof ssrData !== 'object') return false;
  const o = ssrData as Record<string, unknown>;
  const result =
    (o.result as Record<string, unknown> | undefined) ??
    ((o.data as Record<string, unknown> | undefined)?.result as
      Record<string, unknown> | undefined);
  if (!result) return false;
  if (result.play_video_type === 'preview') return true;
  const vi = result.video_info as Record<string, unknown> | undefined;
  return vi?.is_preview === true;
}

/**
 * 这份 SSR 数据里的流**是否短于完整集**。
 *
 * ## 为什么不能只看 `is_preview`（2026-10-28 真机踩到）
 *
 * 第二次进入同一集时实测：
 * ```
 * play_video_type: "whole"      ← 服务端说"完整集"
 * is_preview:      false
 * play_check:      "PLAY_WHOLE"
 * timelength:      1440083      ← 说完整集 24 分钟
 * hasDash:         true
 * ─────────────────────────────
 * video.duration:  360          ← 但媒体只有 6 分钟！
 * seekable.end:    360
 * ```
 *
 * **`play_video_type` / `is_preview` 完全不能反映"能播多久"。**
 * 按标志判断 → 判定"不是试看" → 不注入 → 用户卡在 6 分 01 秒。
 *
 * 真正的判据是：**dash 的实际时长 vs `timelength`**。差得多就是流被截断了。
 *
 * @returns `true` 表示"流不够长，需要注入完整流"
 */
export function isStreamTruncated(ssrData: unknown): boolean {
  const vi = readVideoInfo(ssrData);
  if (!vi) return false;

  const timelengthMs = typeof vi.timelength === 'number' ? vi.timelength : 0;

  /**
   * ## 单段 `durl` 优先（2026-10-28 加，`playview` 的响应形状）
   *
   * `/ogv/player/playview` 的响应是 `data.video_info`，而且**没有 `dash`**，
   * 完整时是单段 `durl`（长度 = timelength）、试看时是 `durls`（4 组 × 6 分钟）。
   *
   * ⚠️ **不能拿 `timelength` 判断能不能播**：`playview` 的 `timelength`
   * 是 1440000（整集 24 分钟），而 `durls` 只有 4 × 360 秒。
   * 必须看**流自己**有多长。
   */
  if (Array.isArray(vi.durl) && vi.durl.length > 0 && timelengthMs > 0) {
    const first = vi.durl[0] as Record<string, unknown> | undefined;
    const len = first && typeof first.length === 'number' ? first.length : 0;
    if (len > 0) return len < timelengthMs - TRUNCATION_SLACK_MS;
  }

  const dash = vi.dash as Record<string, unknown> | undefined;
  const dashSec = dash && typeof dash.duration === 'number' ? dash.duration : 0;

  // 有完整长度的 dash：够长就不用注入
  if (dashSec > 0 && timelengthMs > 0) {
    return dashSec * 1000 < timelengthMs - TRUNCATION_SLACK_MS;
  }

  // 没有 dash（纯 durl 流水线）：durl 组的总时长 vs timelength
  const durls = vi.durls;
  if (Array.isArray(durls) && durls.length > 0 && timelengthMs > 0) {
    let totalMs = 0;
    for (const g of durls) {
      if (!g || typeof g !== 'object') continue;
      const segs = (g as Record<string, unknown>).durl;
      if (!Array.isArray(segs)) continue;
      for (const s of segs) {
        if (s && typeof s === 'object') {
          const len = (s as Record<string, unknown>).length;
          if (typeof len === 'number') totalMs += len;
        }
      }
      break; // 只看第一组（各画质组时长相同）
    }
    if (totalMs > 0) return totalMs < timelengthMs - TRUNCATION_SLACK_MS;
  }

  // 判断不了 → 保守返回 false，不要贸然注入
  return false;
}

/**
 * 从各种形状的响应里取出 `video_info`。
 *
 * 三种已知形状（都实测过）：
 *
 * | 来源 | 形状 |
 * | --- | --- |
 * | SSR / `__playinfo__` | `{result: {video_info}}` 或 `{data: {result: {video_info}}}` |
 * | `/ogv/player/playview` | `{code, data: {arc, video_info}}` ← **没有 `result` 层** |
 * | `/pgc/player/web/playurl` | `{code, result: {…}}` ← `result` **本身就是 video_info** |
 *
 * @returns `video_info`；取不到返回 `null`
 */
function readVideoInfo(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;

  // SSR / __playinfo__
  const result =
    (o.result as Record<string, unknown> | undefined) ??
    ((o.data as Record<string, unknown> | undefined)?.result as
      Record<string, unknown> | undefined);
  if (result) {
    const vi = result.video_info as Record<string, unknown> | undefined;
    if (vi && typeof vi === 'object') return vi;
    /**
     * `/pgc/player/web/playurl` 的 `result` 本身就是 video_info
     * （判据：它有 `durl` / `dash` / `timelength` 之一）。
     */
    if ('durl' in result || 'dash' in result || 'timelength' in result) return result;
    return null;
  }

  // playview：{code, data:{arc, video_info}}
  const innerData = o.data as Record<string, unknown> | undefined;
  const vi2 = innerData?.video_info as Record<string, unknown> | undefined;
  if (vi2 && typeof vi2 === 'object') return vi2;

  return null;
}

/**
 * 判定容差：5 秒。
 *
 * 实测 `timelength = 1440083ms`、`dash.duration = 1441s`（= 1441000ms），
 * 差 917ms 属于正常取整。若不设容差，完整集也会被误判成"被截断"，
 * 于是每集都刷一次 —— 那不是功能，是骚扰。
 */
export const TRUNCATION_SLACK_MS = 5000;

/**
 * 读缓存，命中就返回可下发的 `video_info`。
 *
 * @returns 命中且未过期返回 `video_info`；否则 `null`
 */
export async function loadCachedVideoInfo(
  cid: string,
  now: number = Date.now(),
): Promise<Record<string, unknown> | null> {
  const hit: PgcCacheEntry | null = await readPgcCache(cid, now);
  return hit?.videoInfo ?? null;
}

/**
 * 同步缓存的键前缀 —— **必须与 `src/content/main-world.js` 的 `PGC_SS_PREFIX` 一致**。
 *
 * 两处各有一份是因为主世界是裸 JS（不参与 TS 编译），没法共享常量。
 * 改的时候要同时改两个文件；不一致的后果是"注入静默失效"，很难查。
 */
export const PGC_SS_PREFIX = 'pluma:pgc-vi:';

/**
 * `ep_id → cid` 映射的键前缀。
 *
 * ⚠️ **必须与 `src/content/main-world.js` 的 `pgcSwapPlayviewBody` 里用的字符串一致**
 * （那边是裸 JS，无法共享常量）。
 *
 * 用途：SPA 切集时 `/ogv/player/playview` 只给 `ep_id`，缓存却按 `cid` 存。
 */
export const PGC_EP_PREFIX = 'pluma:pgc-ep:';

/** 同步缓存的有效期：与 `PGC_CACHE_TTL_MS` 保持一致（100 分钟） */
export const PGC_SS_TTL_MS = 100 * 60 * 1000;

/**
 * 把完整流写进 `sessionStorage`，供**主世界同步读**。
 *
 * ## 为什么必须有这一份
 *
 * 2026-10-28 真机 trace：`patchedAt: 2032` vs `createPlayer: 409ms`。
 * 走 `chrome.storage`（异步）→ `postMessage`（排队）→ 106 KB 结构化克隆，
 * 合计 1.6 秒，**必然错过播放器取数窗口**。
 *
 * `sessionStorage` 是同步 API 且主世界可直接访问，所以在
 * `__playinfo__` 的 setter 里能微秒级读到。
 *
 * ## 失败不报错
 *
 * 隐私模式 / 配额满 / 超过 5 MB 上限时 `setItem` 会抛。
 * 写不进去只是"这次注入不生效"，不该让取流流程炸掉 —— 静默即可。
 */
export function writePgcSessionCache(
  cid: string,
  videoInfo: Record<string, unknown>,
  epId?: string | null,
): void {
  if (!cid || !videoInfo) return;
  try {
    sessionStorage.setItem(
      PGC_SS_PREFIX + cid,
      JSON.stringify({ vi: videoInfo, exp: Date.now() + PGC_SS_TTL_MS }),
    );

    /**
     * 同时写 `ep_id → cid` 的映射（键 `pluma:pgc-ep:{ep_id}`）。
     *
     * ## 为什么需要它（2026-10-28 实测）
     *
     * SPA 切集时页面发 `GET /ogv/player/playview?ep_id=…`，响应里**只有 ep_id、没有 cid**，
     * 而缓存是按 cid 存的。主世界要换流就必须先做这个映射。
     *
     * 写在这里而不是主世界：主世界看不到 ISOLATED 侧的 `parsePgcPage` 结果。
     */
    if (epId) sessionStorage.setItem(PGC_EP_PREFIX + epId, cid);
  } catch {
    /* 配额满 / 隐私模式：写不进去就算了，注入会退化成"没有缓存" */
  }
}

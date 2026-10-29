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
/** 流时长的候选来源；拿不到返回 0。 */
function streamDurationMs(vi: Record<string, unknown>): number {
  /**
   * ① `durl`：**把所有段相加**。
   *
   * 以前只看 `durl[0]`，多段完整流（durl 流水线）会被误判成截断 ——
   * 2026-10-29 verifier 探针抓到的反例：`{timelength:600000, durl:[300000,300000]}`。
   */
  if (Array.isArray(vi.durl) && vi.durl.length > 0) {
    let total = 0;
    for (const seg of vi.durl) {
      if (seg && typeof seg === 'object') {
        const len = (seg as Record<string, unknown>).length;
        if (typeof len === 'number' && len > 0) total += len;
      }
    }
    if (total > 0) return total;
  }

  // ② dash 顶层 duration（秒）
  const dash = vi.dash as Record<string, unknown> | undefined;
  const dashSec = dash && typeof dash.duration === 'number' ? dash.duration : 0;
  if (dashSec > 0) return dashSec * 1000;

  // ③ durls：第一组各段求和（各画质组时长相同；playview 试看 = 1 段 6 分钟）
  const durls = vi.durls;
  if (Array.isArray(durls) && durls.length > 0) {
    const first = durls[0] as Record<string, unknown> | undefined;
    const segs = first?.durl;
    if (Array.isArray(segs)) {
      let total = 0;
      for (const s of segs) {
        if (s && typeof s === 'object') {
          const len = (s as Record<string, unknown>).length;
          if (typeof len === 'number' && len > 0) total += len;
        }
      }
      if (total > 0) return total;
    }
  }

  return 0;
}

/**
 * `video_info` 的流是否短于参照时长。
 *
 * @param expectedMs 第二参照（SSR 的 `timelength` / 当前流时长）。
 *                   接口缺 `timelength` 时靠它兜底；0 表示没有第二参照。
 */
function isTruncatedVideoInfo(vi: Record<string, unknown>, expectedMs = 0): boolean {
  const timelengthMs = typeof vi.timelength === 'number' ? vi.timelength : 0;
  const refMs = Math.max(timelengthMs, expectedMs > 0 ? expectedMs : 0);
  if (!(refMs > 0)) return false;
  const durationMs = streamDurationMs(vi);
  if (!(durationMs > 0)) return false;
  return durationMs < refMs - TRUNCATION_SLACK_MS;
}

export function isStreamTruncated(ssrData: unknown): boolean {
  const vi = readVideoInfo(ssrData);
  return vi ? isTruncatedVideoInfo(vi) : false;
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
 * 这份 SSR 数据**是否已经不需要我们再管**（可以直接走"无需注入"）。
 *
 * ## 为什么不能只用 `!isStreamTruncated()`（2026-10-29 真机踩到）
 *
 * `ssr-playinfo` 上报的 `data` 是 `__playinfo__` 的**同一个对象引用**
 * （`main-world.js` 的 setter 里 `ssrPlayinfo = v`），而紧接着的
 * `pgcPatchPlayinfo(v)` 会 `r.video_info = next` **原地替换**。
 *
 * 于是第二趟（缓存命中、注入成功）时，ISOLATED 侧拿到的 SSR **已经是完整流**：
 *
 * ```
 * 第一趟（无缓存）  dash.duration = 180   → isStreamTruncated = true  → 走 cache 分支 ✅
 * 第二趟（有缓存）  dash.duration = 1166  → isStreamTruncated = false → 早退 ❌
 * ```
 *
 * **注入越成功，那条路越进不去** —— 表现为「重开开关后卡在试看」，
 * 且 `pluma:pgc-reload` 永远不会被写（真机证据）。
 *
 * ## 判据
 *
 * | 情况 | `pgcPatchedByUs` | `truncated` | 结论 |
 * | --- | --- | --- | --- |
 * | 首访免费集（SSR 本来就完整） | `false` | `false` | **跳过取流**（省一次请求，且不该换掉已到顶的画质） |
 * | 第二趟（我们注入成了完整流） | `true` | `false` | **继续走 cache 分支**（要让 reload 逻辑有机会跑） |
 * | 试看（真·截断） | 任意 | `true` | **继续走 cache 分支** |
 *
 * @param opts.pgcPatchedByUs SSR 里的流是不是主世界注入的结果
 * @param opts.truncated      流时长是否短于 `timelength`
 * @returns `true` 表示"不用再管，可以早退"
 */
export function canSkipPgcInjection(opts: {
  pgcPatchedByUs: boolean;
  truncated: boolean;
}): boolean {
  // 被我们改过的 SSR 不能作为"本来就完整"的证据
  if (opts.pgcPatchedByUs) return false;
  return !opts.truncated;
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
 * 长度判据的**薄包装**：直接收 `video_info` 本身。
 *
 * ## 为什么需要它
 *
 * `isStreamTruncated()` 的入参是**带外壳的整份数据**
 * （`{result: {video_info}}` / `{data: {result: …}}` / playview 的 `{data: {video_info}}`），
 * 因为它最早是给 `ssr-playinfo` 用的。
 *
 * 但写入/读取缓存的那几处手里只有**合并后的 `video_info`**
 * （`mergeVideoInfo()` 的返回值、`PgcCacheEntry.videoInfo`）。
 * 那些地方要判"够不够长"。
 *
 * ## 为什么不直接改 `isStreamTruncated` 的签名
 *
 * 它已有既有测试与 4 个调用方，改签名等于让所有调用点跟着动 —— 风险大于收益。
 *
 * ## 为什么不直接传 `videoInfo` 进去（它其实也能认）
 *
 * `readVideoInfo()` 确实有一条"`result` 本身就是 video_info"的兜底
 * （判据是有 `durl`/`dash`/`timelength` 之一），所以直接传也能跑通。
 * **但那是隐式兼容**：哪天那条兜底被改掉，这里会静默退化成"永远判不截断"，
 * 而判不截断的后果正是「坏数据被写进缓存」。显式包一层
 * （`{result: videoInfo}`）走的是**已有测试覆盖的主路径**，更稳。
 *
 * @param videoInfo 合并后的 `video_info`（`mergeVideoInfo()` 的返回值或缓存里的那份）
 * @returns `true` 表示**流短于 timelength**（试看流），不该当完整流用
 */
export function isVideoInfoTruncated(videoInfo: unknown, expectedMs = 0): boolean {
  if (!videoInfo || typeof videoInfo !== 'object') return false;
  return isTruncatedVideoInfo(videoInfo as Record<string, unknown>, expectedMs);
}

/**
 * `sessionStorage` 里那份同步缓存的原文**能不能当"有缓存"用**（2026-10-29 加）。
 *
 * ## 为什么不能只判"键在不在"
 *
 * 主世界必须在 `__playinfo__` 赋值的**同一毫秒**读完缓存并注入
 * （`createPlayer` 紧跟其后 0~2ms），所以它只读 `sessionStorage`。
 * ISOLATED 侧据此决定"要不要刷一次"（`hadSync`）。
 *
 * 踩过的真机：`sessionStorage` 里躺着一份**旧版本写坏的**缓存
 * （`durl[0].length: 180160` vs `timelength: 1166528`）——
 * 键在 → `hadSync = true` → 不刷新；而主世界读它时被自己的校验拒了
 * （`ssHit: false`）→ setter 位置没数据 → 只能等 `cfg` 补注入（晚 1450ms）
 * → 播放器早已用 SSR 的 180 秒流起播。**两侧判据不一致，症状是"永远 180 秒"。**
 *
 * 现在：**内容可用才算有**。坏缓存等同没有 → 走"写完同步缓存再刷一次"。
 *
 * @param raw `sessionStorage.getItem()` 的原文；`null` = 键不存在
 * @returns 能否当作"已有可用同步缓存"
 *
 * ⚠️ 判据用**长度**（`isVideoInfoTruncated`），不是"有没有 dash" ——
 * 完整集也可能是纯 `durl`（`fnval=0` 老路），拿 dash 判会误杀。
 */
export function isSyncCacheUsable(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { vi?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return false;
    const vi = parsed.vi;
    if (!vi || typeof vi !== 'object') return false;
    return !isVideoInfoTruncated(vi);
  } catch {
    // 解析失败 = 不可用（宁可多刷一次，也不要拿一坨坏数据去注入）
    return false;
  }
}

/**
 * 取流成功后，**这份合并结果该不该写进缓存并刷新**（2026-10-29 加，问题 5）。
 *
 * ## 为什么把它抽成纯函数
 *
 * 判断本身只有一行（`isVideoInfoTruncated(merged)`），但它决定的是
 * **"要不要写缓存" + "要不要刷新"两个动作**，而且这两件事在
 * `prepareFullStream` 里是耦合的 —— 一旦判断写错，坏数据会躺 100 分钟。
 *
 * 原先是内联在 `entrypoints/content.ts` 里的一个 `if`。那意味着：
 * **删掉它，所有测试仍然全绿**（反例验证实测过）。所以抽到这里，
 * 让"删掉守卫"这件事能被打红。
 *
 * ## ⚠️ 为什么是 `shouldWrite` 而不是 `return`
 *
 * 返回 `false` 时调用方应当**整个函数退出**：既不写缓存，也**不刷新**。
 * 因为 `prepareFullStream` 后续唯一的动作就是 `reloadWithGuard()`，
 * 而刷新的意义是"让第二趟去读这份缓存"。既然没写缓存：
 *   - 刷了也没有缓存可读 → 再取一次 → 又拿到试看 → 再刷 → **死循环**
 *   - 真正拦住循环的只有 `pluma:pgc-reload` 护栏（10 分钟 TTL），
 *     靠它兜底是"靠副作用"，不该是设计
 *
 * 所以这里明确回答"这次取流结果值得写入吗"，调用方据此决定继续还是退出。
 *
 * @param merged `mergeVideoInfo()` 的结果
 * @returns `true` = 是完整流，可以写缓存 + 刷新；`false` = 试看流，停止
 */
export function shouldWritePgcCache(merged: unknown, expectedMs = 0): boolean {
  if (!merged || typeof merged !== 'object') return false;
  return !isVideoInfoTruncated(merged, expectedMs);
}

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

/**
 * 从 `video_info` 里取"实际下发的最高视频高度"。
 *
 * 与 `isStreamTruncated` 是**两个不同的问题**：
 *
 * | 函数 | 回答 |
 * | --- | --- |
 * | `isStreamTruncated` | 这条流**够不够长**（能不能看完整集） |
 * | `maxVideoHeight` | 这条流**画质到没到顶**（4K/HDR 拿到了没） |
 *
 * ⚠️ **两者不能互相替代。** 真机实测（2026-10-29）：
 *
 * ```
 * ep733317（限免集）
 *   dash: 80@1080 64@720 32@480 16@360        ← 只给 1080
 *   timelength 1075582 vs dash.duration 1076s  ← 时长相符，不算截断
 *   但 accept_quality: [125,122,120,112,80,...] ← 内容有 4K/HDR/1080P+
 *   播放账号走 DNR 取流: 最高 2160，含 125/120/112  ← 本来能拿到
 * ```
 *
 * 旧逻辑只看 `isStreamTruncated` → 判"无需注入" → **播放账号根本没去取 4K**。
 *
 * @returns 最高高度；没有可用的视频轨时返回 `0`
 */
export function maxVideoHeight(videoInfo: unknown): number {
  if (!videoInfo || typeof videoInfo !== 'object') return 0;
  const vi = videoInfo as Record<string, unknown>;
  const dash = vi.dash as Record<string, unknown> | undefined;
  if (!dash) return 0;
  const tracks = dash.video;
  if (!Array.isArray(tracks)) return 0;

  let max = 0;
  for (const t of tracks) {
    if (!t || typeof t !== 'object') continue;
    const h = (t as Record<string, unknown>).height;
    if (typeof h === 'number' && h > max) max = h;
  }
  return max;
}

/**
 * 取到的流**画质是否严格高于**页面上现有那条。
 *
 * ## 为什么必须"严格高于"而不是"不低于"
 *
 * 相等时替换没有任何收益，却要付一次 `reload()` —— 用户会看到页面闪一下。
 * 宁可不动。
 *
 * ## 为什么这里不参考 `accept_quality`
 *
 * `accept_quality` 只表达"内容提供哪些档"，不表达"这个身份实际拿到了哪些轨"
 * （未登录时它连 8K 都会列出来）。用它预判会引入"漏取"的风险 ——
 * 而漏取正是当前这个 bug 的形态。**取一次、比结果，事实说话。**
 *
 * @param currentH 页面上现有的最高高度
 * @param fetched  播放账号取回来的 `video_info`
 * @returns `true` 表示"该用取回来的这份替换"
 */
export function isBetterStream(currentH: number, fetched: unknown): boolean {
  const fetchedH = maxVideoHeight(fetched);
  return fetchedH > currentH && fetchedH > 0;
}

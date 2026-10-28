/**
 * PGC 完整流缓存 —— P2 路线的地基（ADR 0020）。
 *
 * ## 为什么需要它
 *
 * 2026-10-28 实测证明 PGC 页的播放器**不使用** `requestConfig.reqHttpPlayUrlInfo`
 * （真容器 + 完整集数据 → `cbCalled: 0`），也**不读** `config.prefetch.playUrl.playUrl`。
 * 它只吃 `window.__playinfo__` 那一份，而那份是服务端在渲染 HTML 时写死的试看数据。
 *
 * 而 `createPlayer` 在 `__playinfo__` 赋值后 0~2ms 就被调用 —— 接口来不及返回。
 * 所以唯一能让播放器拿到完整流的办法是：**下一次加载时它已经在手边**。
 *
 * → 第一趟：取完整流写缓存 → `reload()`
 * → 第二趟：`document_start` 同步读缓存，就地替换 `__playinfo__.result.video_info`
 *
 * ## 为什么用 `storage.local` 而不是 localStorage
 *
 * `document_start` 时主世界脚本要**同步**拿到数据（`__playinfo__` 的 setter 是同步的），
 * 而 `chrome.storage` 是异步的。所以：
 *   - 缓存本体放 `storage.local`（跨标签页、跨 reload 都在，且能按 cid 收敛条数）
 *   - 二次加载时由 ISOLATED 侧异步预读，写进 `window` 上的一个位置供主世界同步取
 *
 * 两个写入时机都有 ISOLATED 侧参与，所以这里只放 `platform/`（能用 `chrome.storage`）。
 *
 * ## 过期
 *
 * B站流地址带 `deadline`，实测有效期约 110 分钟（`docs/03-open-questions.md` §3a）。
 * 缓存留 **100 分钟**，比实际短一点：宁可多取一次，不要给播放器一个过期的地址
 * —— 后者表现为"能播几秒然后卡住"，比直接取不到更难排查。
 */

const CACHE_KEY = 'pluma:pgc-playurl-cache';

/** 缓存有效期。B站流地址实测约 110 分钟，这里留 10 分钟余量 */
export const PGC_CACHE_TTL_MS = 100 * 60 * 1000;

/** 最多保留几集。超出按 `at` 淘汰最旧的 */
export const PGC_CACHE_MAX = 8;

/**
 * 一条缓存。
 *
 * `videoInfo` 是**已经合并好**的 `video_info`（SSR 骨架 + 接口的流字段），
 * 二次加载时直接整体替换，不做二次加工 —— 加工逻辑只有一份，在 `pgc-merge.ts`。
 */
export interface PgcCacheEntry {
  /** 章节 id：`cid`。同一集在 ep / ss 两种入口下 cid 相同，所以用它做 key */
  cid: string;
  /** 合并后的 `video_info`（`durls` / `dash` / `timelength` 已是完整集的） */
  videoInfo: Record<string, unknown>;
  /** 写入时刻（毫秒时间戳） */
  at: number;
}

type CacheBag = Record<string, PgcCacheEntry>;

/**
 * 读一集的缓存。
 *
 * @param cid 章节 id
 * @param now 时间戳（注入以便测试）
 * @returns 命中且未过期返回条目，否则 `null`
 */
export async function readPgcCache(
  cid: string,
  now: number = Date.now(),
): Promise<PgcCacheEntry | null> {
  if (!cid) return null;
  try {
    const bag = await chrome.storage.local.get(CACHE_KEY);
    const map = bag[CACHE_KEY] as CacheBag | undefined;
    if (!map || typeof map !== 'object') return null;

    const hit = map[cid];
    if (!hit || typeof hit !== 'object') return null;
    if (!hit.videoInfo || typeof hit.videoInfo !== 'object') return null;
    if (typeof hit.at !== 'number') return null;
    if (now - hit.at > PGC_CACHE_TTL_MS) return null;

    return hit;
  } catch {
    return null;
  }
}

/**
 * 写一集的缓存。
 *
 * 超过 `PGC_CACHE_MAX` 时按 `at` 淘汰最旧的 —— 不淘汰的话，
 * 看一季 12 集会留下 12 份各自几十 KB 的 `video_info`，白占存储。
 */
export async function writePgcCache(
  cid: string,
  videoInfo: Record<string, unknown>,
  now: number = Date.now(),
): Promise<void> {
  if (!cid || !videoInfo) return;
  try {
    const bag = await chrome.storage.local.get(CACHE_KEY);
    const map: CacheBag = (bag[CACHE_KEY] as CacheBag | undefined) ?? {};
    map[cid] = { cid, videoInfo, at: now };

    const entries = Object.values(map).sort((a, b) => b.at - a.at);
    const kept: CacheBag = {};
    for (const e of entries.slice(0, PGC_CACHE_MAX)) kept[e.cid] = e;

    await chrome.storage.local.set({ [CACHE_KEY]: kept });
  } catch {
    /* 写缓存失败不影响播放，静默 */
  }
}

/** 清空（退出播放账号 / 诊断页用） */
export async function clearPgcCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY).catch(() => {});
}

/**
 * 判断一份 `video_info` 是否"看起来是试看"。
 *
 * 缓存只应该在试看页使用 —— 免费集 / 已有权益的集数不需要走 P2，
 * 强行替换反而可能把高清换成别的东西。
 */
export function looksPreview(videoInfo: unknown): boolean {
  if (!videoInfo || typeof videoInfo !== 'object') return false;
  const vi = videoInfo as Record<string, unknown>;
  return vi.is_preview === true;
}

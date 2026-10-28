/**
 * 视频页解析 —— 纯函数，零 DOM、零 chrome API。
 *
 * 放在 `shared/` 而不是 content script 里，原因有二：
 *   1. content script 依赖 WXT 全局（`defineContentScript`），在 Node 里跑不了，测不了
 *   2. 这段逻辑（URL 怎么解析、哪些 cookie 能借）本身就和运行环境无关
 *
 * content script 只负责调用它 + 发消息。
 */

/** 可以从页面借的设备 Cookie（Q5 实测均为非 httpOnly） */
export const DEVICE_COOKIE_NAMES = [
  'buvid3',
  'buvid4',
  'buvid_fp',
  'b_nut',
  '_uuid',
  'bili_ticket',
  'bili_ticket_expires',
] as const;

/**
 * 受支持的播放页 URL 模式 —— **给 `chrome.tabs.query` 用**。
 *
 * 与 `parsePlayPage()` 必须覆盖同一批页面，否则会出现"判据说能播、查标签页查不到"
 * 的割裂：`platform/page/page-state-client.ts` 曾只写 `*://*.bilibili.com/video/*`，
 * 于是**开着番剧页时**，options 的主账号卡片与诊断页的「当前页取流数据」
 * 都显示"打开任意视频页后可见"（2026-10-28 审查发现，由 `check-page-gate` 抓出）。
 *
 * ⚠️ content script 的 `matches` **不用这个常量**：WXT 生成 manifest 时对入口文件做
 * 静态分析，取不到跨文件常量的值，manifest 里会变成空数组（等于不注入）。
 * 那两处必须写字面量，由 `scripts/check-page-gate.mjs` 断言"两个模式都在"。
 */
export const PLAY_PAGE_URL_PATTERNS = [
  '*://*.bilibili.com/video/*',
  '*://*.bilibili.com/bangumi/play/*',
] as const;

export interface VideoPageInfo {
  bvid: string;
  p: number;
}

/**
 * PGC 播放页信息（番剧 / 国创 / 电影 / 影视）。
 *
 * ⚠️ 这里**只做识别**，不判断"能不能播"。能不能播由页面 SSR 的
 * `play_video_type` / `is_preview` 决定，主世界拿到 `createPlayer` 时才判（ADR 0019）。
 */
export interface PgcPageInfo {
  kind: 'pgc';
  /** `/bangumi/play/ep3854821` → `'3854821'` */
  epId: string | null;
  /** `/bangumi/play/ss28747` → `'28747'` */
  seasonId: string | null;
}

/** 播放页的两种形态。`parsePlayPage` 的返回值 */
export type PlayPageInfo = (VideoPageInfo & { kind: 'video' }) | PgcPageInfo;

/**
 * 从 URL 解析视频页信息。非视频页返回 null。
 *
 * 只认 `/video/BVxxx`：
 *   - PGC（番剧/国创/电影）走 `parsePgcPage`（ADR 0019）
 *   - 直播 `/live/*` 不支持
 *   - legacy `/s/video/*` 不支持（B站已基本不用，且路径不同）
 */
export function parseVideoPage(url: string): VideoPageInfo | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  if (u.hostname !== 'www.bilibili.com' && u.hostname !== 'bilibili.com') return null;

  const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
  const bvid = m?.[1];
  if (!bvid) return null;

  const raw = Number(u.searchParams.get('p') ?? '1');
  const p = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;

  return { bvid, p };
}

/**
 * 从 URL 解析 PGC 播放页。非 PGC 播放页返回 null。
 *
 * 只认 `/bangumi/play/ep…` 与 `/bangumi/play/ss…`：
 *   - `/bangumi/media/md…` 是**详情页不是播放页**，返回 null
 *   - `/guochuang/…`、`/cinema/…` 是索引页，不解析
 *
 * ⚠️ **不解析 cid**：cid 在页面 SSR 数据里（`result.arc.cid`），
 * URL 里没有。主世界构造取流请求时从 `__playinfo__` 读。
 */
export function parsePgcPage(url: string): PgcPageInfo | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  if (u.hostname !== 'www.bilibili.com' && u.hostname !== 'bilibili.com') return null;

  const m = u.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)/);
  if (!m) return null;

  return m[1] === 'ep'
    ? { kind: 'pgc', epId: m[2] ?? null, seasonId: null }
    : { kind: 'pgc', epId: null, seasonId: m[2] ?? null };
}

/**
 * 解析任意播放页。视频页与 PGC 页的统一入口。
 *
 * @returns `null` 表示这不是一个受支持的播放页
 */
export function parsePlayPage(url: string): PlayPageInfo | null {
  const v = parseVideoPage(url);
  if (v) return { kind: 'video', ...v };
  return parsePgcPage(url);
}

/**
 * 从 `document.cookie` 字符串里挑出设备 Cookie。
 *
 * **只挑设备标识，绝不带出 SESSDATA / bili_jct / DedeUserID**——
 * 那三个属于登录凭据，由 vault 提供，不该从页面借。
 */
export function readDeviceCookies(rawCookie: string): Record<string, string> {
  const allowed: readonly string[] = DEVICE_COOKIE_NAMES;
  const out: Record<string, string> = {};

  for (const part of rawCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;

    const k = part.slice(0, eq).trim();
    if (!allowed.includes(k)) continue;

    out[k] = part.slice(eq + 1).trim();
  }

  return out;
}

/**
 * 从页面 cookie 里读主账号的 mid。
 *
 * 为什么要从**页面**读而不是从 background 发 nav 请求：
 * `incognito: "split"` 下扩展可能运行在无痕实例里，那个实例的 fetch 带的是
 * **无痕分区**的 cookie（即播放账号），拿它当"主账号"会得出"两账号相同"的错误结论，
 * 从而拒绝代理。
 *
 * 页面 cookie 里的 `DedeUserID` 是**主账号**的（普通分区），这才是可靠来源。
 *
 * @returns mid 字符串；读不到返回 null
 */
export function readPrimaryMidFromCookie(rawCookie: string): string | null {
  for (const part of rawCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== 'DedeUserID') continue;

    const v = part.slice(eq + 1).trim();
    return /^\d+$/.test(v) && v.length > 0 ? v : null;
  }
  return null;
}

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

export interface VideoPageInfo {
  bvid: string;
  p: number;
}

/**
 * 从 URL 解析视频页信息。非视频页返回 null。
 *
 * 只认 `/video/BVxxx`：
 *   - 番剧 `/bangumi/play/*` 不支持（ADR 0006）
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

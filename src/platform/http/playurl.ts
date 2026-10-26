/**
 * Cookie 头拼装 —— 把播放账号的凭据与页面的设备 Cookie 合成一个 `Cookie` 头值。
 *
 * ## 这个文件现在只做这一件事
 *
 * 曾经它还有一条"用播放账号身份**自己发** playurl"的路径（`fetchPlayurlAsPlayback`
 * + `playurlQuery` + WBI 密钥缓存），原本是给 options 的画质体检表用的。
 * 2026-10-26 砍掉体检表后它没有调用方了，一并删除（见
 * [ADR 0016](../../../docs/decisions/0016-drop-quality-report-page.md)）。
 *
 * **为什么删而不是留着"以后可能用"**：那条路径里的 `fnval=4048` 是**推算值、从未实测**
 * （Q9），留着就是一颗雷 —— 哪天有人调它，体检结论就会错（比如得出"播放账号也不支持
 * Hi-Res"，而实测 flac 明明装载成功）。而页面自己的 playurl 用的是 B站 自己的 fnval，
 * 天然正确 —— 我们不需要再发一次。
 *
 * ## 剩下的两个函数
 *
 * - `buildCookieHeader`：凭据覆盖同名设备 Cookie，其余按白名单保留
 * - `deviceCookiesFrom`：从 `document.cookie` 字符串里挑设备 Cookie
 *
 * 使用者是 `background/handlers/page.handler.ts`（装 DNR 规则前拼 Cookie）。
 *
 * ⚠️ **不要在这里拼 Cookie 头再 `fetch`**：`Cookie` 是 forbidden request header，
 * 脚本设置它会被静默丢弃。换 Cookie 只能走 DNR（见 ADR 0002 / 0006）。
 */

import { DEVICE_COOKIE_NAMES } from '@shared/constants/device-cookies';
import type { Credential } from '@shared/types/account';
import { parseCookie, pickCookie, serializeCookie } from '@shared/utils/cookie';

/**
 * 拼 Cookie 头：设备 Cookie 用主账号页面的，三个凭据字段用播放账号的。
 *
 * 为什么设备 Cookie 不换：设备和浏览器都没变，换 buvid 反而让风控觉得异常。
 * 为什么凭据必须同源：`SESSDATA` / `bili_jct` / `DedeUserID` 来自不同账号会 -101。
 */
export function buildCookieHeader(
  credential: Credential,
  deviceCookies: Record<string, string>,
): string {
  const device = pickCookie(deviceCookies, DEVICE_COOKIE_NAMES);
  return serializeCookie({
    ...device,
    SESSDATA: credential.sessdata,
    bili_jct: credential.biliJct,
    DedeUserID: credential.dedeUserId,
  });
}

/** 从 `document.cookie` 格式的字符串里挑出设备 Cookie */
export function deviceCookiesFrom(rawDocumentCookie: string): Record<string, string> {
  return pickCookie(parseCookie(rawDocumentCookie), DEVICE_COOKIE_NAMES);
}

/**
 * 需要从主账号页面借用的设备 Cookie 名单。
 *
 * **2026-10-25 实测**：以下 Cookie 全部 `httpOnly: false`，可从 `document.cookie` 读到，
 * 因此 manifest **不需要**申请 `cookies` 权限（见 docs/03-open-questions.md Q5）。
 *
 * 用途：代理播放账号的请求时，设备标识仍用浏览器当前这一套，避免触发 -412。
 */

export const DEVICE_COOKIE_NAMES = [
  'buvid3',
  'buvid4',
  'buvid_fp',
  'b_nut',
  '_uuid',
  'bili_ticket',
  'bili_ticket_expires',
] as const;

export type DeviceCookieName = (typeof DEVICE_COOKIE_NAMES)[number];

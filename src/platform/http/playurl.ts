/**
 * 用播放账号身份取流 —— 完整链路：
 *
 *   1. 读播放账号凭据（已解密）
 *   2. 从主账号页面借设备 Cookie
 *   3. 取 WBI 密钥（nav 接口，设备级、账号无关）
 *   4. 签名 playurl 参数
 *   5. DNR 临时规则换 Cookie → 发起请求 → 删规则
 *   6. 解析并返回
 *
 * 分层：本文件在 platform，可以碰 chrome / fetch；
 * 路径白名单与 Cookie 白名单来自 shared，签名算法来自 core。
 */

import { routeFor } from '@core/identity/router';
import { extractKeyFromUrl, mixinKey, signQuery } from '@core/wbi/signer';
import { DEVICE_COOKIE_NAMES } from '@shared/constants/device-cookies';
import { BILI_API_HOST } from '@shared/constants/routes';
import type { Credential } from '@shared/types/account';
import { parseCookie, pickCookie, serializeCookie } from '@shared/utils/cookie';

/** WBI 密钥缓存。设备级、账号无关，1 小时刷新一次 */
interface WbiKeys {
  imgKey: string;
  subKey: string;
  fetchedAt: number;
}

const WBI_TTL_MS = 60 * 60 * 1000;
let wbiCache: WbiKeys | null = null;

/** 测试用：清空 WBI 缓存 */
export function resetWbiCache(): void {
  wbiCache = null;
}

async function fetchWbiKeys(): Promise<WbiKeys> {
  const now = Date.now();
  if (wbiCache && now - wbiCache.fetchedAt < WBI_TTL_MS) return wbiCache;

  const res = await fetch(`https://${BILI_API_HOST}/x/web-interface/nav`, {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`nav HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  };

  const imgUrl = body.data?.wbi_img?.img_url;
  const subUrl = body.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) throw new Error('nav 未返回 wbi_img');

  wbiCache = {
    imgKey: extractKeyFromUrl(imgUrl),
    subKey: extractKeyFromUrl(subUrl),
    fetchedAt: now,
  };
  return wbiCache;
}

/**
 * 拼 Cookie 头：设备 Cookie 用主账号页面的，三个凭据字段用播放账号的。
 *
 * 为什么设备 Cookie 不换：设备和浏览器都没变，换 buvid 反而让风控觉得异常。
 * 为什么凭据必须同源：`SESSDATA` / `bili_jct` / `DedeUserID` 来自不同账号会 -101。
 */
export function buildCookieHeader(credential: Credential, deviceCookies: Record<string, string>): string {
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

export interface PlayurlParams {
  bvid: string;
  cid: number;
  qn: number | null;
}

/** playurl 的签名前参数。fnval=4048 是实测的官方前端值 */
export function playurlQuery(params: PlayurlParams, wts: number) {
  return {
    bvid: params.bvid,
    cid: String(params.cid),
    fnval: '4048',
    fourk: '1',
    qn: String(params.qn ?? 0),
    wts: String(wts),
  };
}

const PLAYURL_PATH = '/x/player/wbi/playurl';

/**
 * 用播放账号凭据请求 playurl。
 *
 * ⚠️ 路径必须过白名单。这不是防御性编程，是架构约束：
 * 白名单外的东西一律不代理（`shared/constants/routes.ts` 是唯一真相源）。
 */
export async function fetchPlayurlAsPlayback(
  credential: Credential,
  params: PlayurlParams,
  deviceCookies: Record<string, string>,
): Promise<unknown> {
  const { imgKey, subKey } = await fetchWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  const signed = signQuery(playurlQuery(params, wts), mixinKey(imgKey, subKey), wts);

  const url = `https://${BILI_API_HOST}${PLAYURL_PATH}?${signed}`;

  // 用 router 判定，而不是在这里写死判断。
  // 这是"路径白名单唯一真相源"的落地点：任何代理前都必须过 router。
  if (routeFor(url) !== 'playback') {
    throw new Error(`router 判定该 URL 不应代理: ${PLAYURL_PATH}`);
  }

  const cookie = buildCookieHeader(credential, deviceCookies);

  // ⚠️ 这里**不自己装 DNR 规则**（ADR 0006）。
  // 常驻规则由 `enableProxy()` 在配置播放账号时统一装好，值全局一致。
  // 请求方只需 `credentials: 'omit'` —— 浏览器自带的 cookie 被丢弃，
  // DNR 注入的播放账号凭据生效。
  //
  // 若代理未开启，这个请求会以「未登录」身份发出，服务端返回低画质，
  // 由调用方根据返回轨道判断并回退，不要在这里静默失败。
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    headers: { accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`playurl HTTP ${res.status}`);
  return res.json();
}

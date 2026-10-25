/**
 * 身份路由 —— 判定一个 URL 该用哪个账号的身份。
 *
 * 这是「请求级身份代理」的决策中心：**唯一**决定"这个请求归主账号还是播放账号"的地方。
 * 逻辑散落在别处就会出现"某个接口忘了判断"的漏洞，那是会串号的问题。
 *
 * 分层：纯函数，零 IO、零 chrome API，所以能用 Vitest 全覆盖。
 * 路径白名单来自 `shared/constants/routes.ts`（唯一真相源），不在这里硬编码。
 */

import { BILI_API_HOST, isProxyPath } from '@shared/constants/routes';

export type Identity = 'primary' | 'playback';

/**
 * 只有 api.bilibili.com 上的白名单路径才代理。
 *
 * 为什么限定到 `api.bilibili.com` 而不是 `*.bilibili.com`：
 *   - `passport.bilibili.com` 是登录接口，必须用浏览器自己的身份
 *   - `www.bilibili.com` 是页面资源
 *   - 取流接口实测都在 api 子域下
 * 收窄到单域名比子域通配安全得多，也避免了仿冒域名的绕过。
 */
const PROXY_HOST = BILI_API_HOST;

/**
 * 判断 URL 该走哪个身份。
 *
 * @param url 完整 URL 字符串
 * @returns `playback` 表示要用播放账号凭据代理，`primary` 表示不干预
 *
 * 非法输入一律返回 `primary`——**宁可少代理，不可错代理**。
 * 少代理的表现是"画质没提升"，错代理的表现是"点赞点到了另一个号"。
 */
export function routeFor(url: string): Identity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'primary';
  }

  // 只处理 https（http 会被服务端重定向，且不该有凭据走明文）
  if (parsed.protocol !== 'https:') return 'primary';

  if (parsed.hostname !== PROXY_HOST) return 'primary';

  // 只看 pathname。查询参数里出现 playurl 不算（`?redirect=/x/player/wbi/playurl`）
  return isProxyPath(parsed.pathname) ? 'playback' : 'primary';
}

/** 便捷包装：是否需要代理 */
export function shouldProxy(url: string): boolean {
  return routeFor(url) === 'playback';
}

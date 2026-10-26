/**
 * 代理路径白名单 —— **唯一真相源**。
 *
 * 所有匹配逻辑必须引用本文件，不许在别处硬编码路径字符串。
 * B站改路径时只改这一个文件。
 *
 * ⚠️ `enabled` 字段反映的是 **2026-10-25 的实测结论**，不是文档抄来的清单。
 * 来源：poc/verify/RESULT.md、docs/03-open-questions.md Q4、ADR 0007。
 */

export const BILI_API_HOST = 'api.bilibili.com';
export const BILI_WEB_HOST = 'www.bilibili.com';

/**
 * `nav` 接口 —— 用于探测播放账号凭据是否有效。
 *
 * ⚠️ **它不在代理白名单里**，也不需要：探活必须用**指定账号**的凭据，
 * 而白名单规则注入的是"全局那一个"。探活由 `platform/http/nav.ts`
 * 自己拼 Cookie 头（`credentials: 'omit'`）。
 *
 * 放在这里而不是散在别处，是为了和 B 站域名/路径变更保持单点维护。
 */
export const NAV_URL = `https://${BILI_API_HOST}/x/web-interface/nav`;

export interface ProxyRoute {
  path: string;
  method: 'GET' | 'POST';
  label: string;
  /** 只有 true 的路径会被代理 */
  enabled: boolean;
  /** 为什么启用/禁用，写实测依据而不是猜测 */
  note: string;
}

export const PROXY_ROUTES = [
  {
    path: '/x/player/wbi/playurl',
    method: 'GET',
    label: '普通视频取流（当前）',
    enabled: true,
    note: '实测确认在用。qn 不影响返回轨道，fnval=4048 即可拿到 2160p',
  },
  {
    path: '/x/player/playurl',
    method: 'GET',
    label: '普通视频取流（旧版兜底）',
    enabled: true,
    note: '本次未观测到，保留兜底。启用前需重新确认仍可用',
  },
  {
    path: '/pgc/player/web/v2/playurl',
    method: 'GET',
    label: '番剧取流（当前）',
    enabled: false,
    note: '实测：番剧页零请求、走 SSR 注入，此路径无效（ADR 0007）',
  },
  {
    path: '/pgc/player/web/playurl',
    method: 'GET',
    label: '番剧取流（旧版）',
    enabled: false,
    note: '同上，未观测到（ADR 0007）',
  },
  {
    path: '/ogv/player/playview',
    method: 'POST',
    label: '番剧 OGV 播放器',
    enabled: false,
    note: '同上，未观测到。原以为需要 csrf + WBI 重签，实际不存在该请求（ADR 0007）',
  },
  {
    path: '/xlive/web-room/v2/index/getRoomPlayInfo',
    method: 'GET',
    label: '直播取流（当前）',
    enabled: false,
    note: '未测。v1 不支持直播，开启前必须单独验证',
  },
  {
    path: '/room/v1/Room/playUrl',
    method: 'GET',
    label: '直播取流（旧版）',
    enabled: false,
    note: '未测。v1 不支持直播',
  },
] as const satisfies readonly ProxyRoute[];

/** 只有这些路径会被 DNR 规则命中 */
export const ENABLED_ROUTE_PATHS: readonly string[] = PROXY_ROUTES.filter((r) => r.enabled).map(
  (r) => r.path,
);

/**
 * 判断一个 pathname 是否在白名单内。
 *
 * 用 `===` 或 `startsWith(path + '/')` 而不是裸 `startsWith(path)`，
 * 否则 `/x/player/playurl` 会误匹配 `/x/player/playurlXxx`。
 */
export function isProxyPath(pathname: string): boolean {
  return ENABLED_ROUTE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

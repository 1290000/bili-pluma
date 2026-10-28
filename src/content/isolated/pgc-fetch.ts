/**
 * PGC 完整流取流 —— 页面内 `fetch`，靠 DNR 换成播放账号身份。
 *
 * ## 为什么必须在页面里发，不能在 background 发
 *
 * `Cookie` 是 forbidden request header，脚本设置它会被**静默丢弃**（`nav.ts` 踩过）。
 * 所以"以某个身份请求"只有一条合法路径：让浏览器自己带 Cookie，而 Cookie 由
 * DNR 在网络层替换。页面内 `fetch(credentials: 'include')` 正是被 DNR 规则命中的那种请求
 * （`resourceTypes: ['xmlhttprequest']` + GET + 路径匹配）。
 *
 * ## 为什么不用 `platform/http/fetcher.ts`
 *
 * 那个是给 `core` 用的通用客户端（background 侧）。这里要的语义不同：
 * **失败必须区分"没权益"和"网络挂了"**，因为前者不该触发刷新，后者可以重试。
 */

import { hasPlayableStream } from '@core/playinfo/pgc-merge';

/** 取流超时。实测 118–388ms，8 秒足够容错 */
export const FETCH_TIMEOUT_MS = 8_000;

export type FetchOutcome =
  | { kind: 'ok'; result: Record<string, unknown> }
  /** 服务端明确拒绝（无权益 / 风控）—— **不该重试，也不该刷新** */
  | { kind: 'denied'; code: number }
  /** 网络 / 超时 / 解析失败 —— 可以下次再试 */
  | { kind: 'error'; detail: string };

/**
 * 取一集的完整流。
 *
 * @param cid   章节 id
 * @param url   由 `buildPlayurlUrl` 生成
 */
export async function fetchPgcPlayurl(cid: string, url: string): Promise<FetchOutcome> {
  if (!cid) return { kind: 'error', detail: 'no-cid' };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      // include：让浏览器带上本分区的 bilibili cookie，再由 DNR 换成播放账号的
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: 'error', detail: e instanceof Error ? e.message.slice(0, 80) : 'fetch-threw' };
  }

  if (!res.ok) return { kind: 'error', detail: `http-${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', detail: 'bad-json' };
  }

  const o = body as Record<string, unknown> | null;
  const code = typeof o?.code === 'number' ? o.code : -1;

  if (code !== 0) {
    // -10403 地区限制 / -404 内容不存在 / -352 风控 …… 都算"服务端拒绝"
    return { kind: 'denied', code };
  }

  const result = o?.result;
  if (!result || typeof result !== 'object') return { kind: 'error', detail: 'no-result' };
  if (!hasPlayableStream(result)) return { kind: 'denied', code: 0 };

  return { kind: 'ok', result: result as Record<string, unknown> };
}

/**
 * 拉取「最新正式 Release」—— 唯一碰网络的地方（自动更新这条线上）。
 *
 * ## 为什么不用 `platform/http/fetcher.ts`
 *
 * 那个入口只做「发请求 + 超时 + 非 2xx 抛异常」，而这里需要三样它没有的东西：
 * `If-None-Match` 条件请求（省 60/h 的配额）、把 `304` 当成**正常结果**而不是异常、
 * 以及读 `x-ratelimit-*` 头判断是不是被限流。
 *
 * ## 失败**不抛异常**，而是返回带类型的结果
 *
 * 自动检查是后台行为，用户没在等它。抛异常会让调用方为了不炸而写 `catch {}`，
 * 于是"限流"和"没新版本"就被混成一个空分支 —— 而这两者后果完全不同：
 * 限流时**绝不能**把"没新版本"写进状态，否则用户会以为自己是新版。
 */

import type { LatestReleaseResult } from '@core/update/check';
import { parseLatestRelease } from '@core/update/release';
import { UPDATE_LATEST_API } from '@shared/constants/update';

// 结果类型定义在 core（端口契约），这里只负责实现，避免两处各写一份 union
export type { LatestReleaseResult };

export interface FetchLatestOptions {
  /** 上次响应给的 ETag；有就用条件请求 */
  etag: string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** `x-ratelimit-reset` 是**秒**级时间戳，转成毫秒。读不懂就是 `null`。 */
function readResetAt(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function isRateLimited(status: number, remaining: string | null): boolean {
  if (status !== 403 && status !== 429) return false;
  // 403 也可能是别的（比如 UA 被拦）。只有 remaining 明确为 0 才算限流。
  return remaining === '0';
}

export async function fetchLatestRelease(
  options: FetchLatestOptions,
): Promise<LatestReleaseResult> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (options.etag) headers['If-None-Match'] = options.etag;

  let response: Response;
  try {
    response = await fetch(UPDATE_LATEST_API, {
      method: 'GET',
      // 公开接口，**不带任何凭据**。这里是唯一一处跨站请求，别把用户身份带出去。
      credentials: 'omit',
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { kind: 'error', message };
  }

  const etag = response.headers.get('etag');

  if (response.status === 304) {
    return { kind: 'not-modified', etag };
  }

  if (isRateLimited(response.status, response.headers.get('x-ratelimit-remaining'))) {
    return {
      kind: 'rate-limited',
      resetAt: readResetAt(response.headers.get('x-ratelimit-reset')),
    };
  }

  if (!response.ok) {
    return { kind: 'error', message: `HTTP ${String(response.status)}` };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `响应不是 JSON：${message}` };
  }

  try {
    return { kind: 'ok', release: parseLatestRelease(json), etag };
  } catch (error) {
    // 结构不对（预发布 / 没有精简包 / 体积异常）也算 error，要让上层能显示原因
    return { kind: 'error', message: error instanceof Error ? error.message : '解析失败' };
  }
}

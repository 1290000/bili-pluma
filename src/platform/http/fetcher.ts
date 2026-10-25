/**
 * 统一请求入口 —— core 通过注入的 `HttpClient` 使用它，因此 core 里不出现 `fetch(`。
 *
 * 只做三件事：发请求、超时、把非 2xx 变成异常。
 * 业务判断（比如 B站的 code 含义）留在 core，不在这里。
 */

import type { HttpClient } from '@core/auth/qrcode';

export interface FetcherOptions {
  timeoutMs?: number;
  /** 是否带 cookie。扫码轮询需要带（同域会话），取流不需要 */
  credentials?: RequestCredentials;
}

export function createHttpClient(options: FetcherOptions = {}): HttpClient {
  const { timeoutMs = 10_000, credentials = 'include' } = options;

  return {
    async getJson<T>(url: string): Promise<T> {
      const res = await fetch(url, {
        method: 'GET',
        credentials,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${new URL(url).pathname}`);
      }

      return (await res.json()) as T;
    },
  };
}

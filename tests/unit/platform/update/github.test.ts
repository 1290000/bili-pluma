import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchLatestRelease } from '@platform/update/github';

const RELEASE_BODY = {
  tag_name: 'v1.2.0',
  draft: false,
  prerelease: false,
  published_at: '2026-11-16T00:00:00Z',
  assets: [
    {
      name: 'pluma-1.2.0.zip',
      size: 289_831,
      browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/pluma-1.2.0.zip',
    },
  ],
};

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchLatestRelease：请求本身', () => {
  it('不携带任何凭据（credentials: omit）', async () => {
    const calls = stubFetch(() =>
      Promise.resolve(jsonResponse(RELEASE_BODY, 200, { etag: 'W/"1"' })),
    );
    await fetchLatestRelease({ etag: null });
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('没有 ETag 时不发 If-None-Match', async () => {
    const calls = stubFetch(() => Promise.resolve(jsonResponse(RELEASE_BODY)));
    await fetchLatestRelease({ etag: null });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();
  });

  it('有 ETag 时发条件请求', async () => {
    const calls = stubFetch(() => Promise.resolve(jsonResponse(RELEASE_BODY)));
    await fetchLatestRelease({ etag: 'W/"abc"' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
    expect(headers.Accept).toBe('application/vnd.github+json');
  });
});

describe('fetchLatestRelease：结果分类', () => {
  it('200 ⇒ ok，并带回 ETag', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(RELEASE_BODY, 200, { etag: 'W/"1"' })));
    const result = await fetchLatestRelease({ etag: null });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.release.version).toBe('1.2.0');
    expect(result.etag).toBe('W/"1"');
  });

  it('304 ⇒ not-modified（不是错误）', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 304 })));
    const result = await fetchLatestRelease({ etag: 'W/"1"' });
    expect(result.kind).toBe('not-modified');
  });

  it('403 + remaining=0 ⇒ rate-limited，并把 reset 秒换成毫秒', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794757701' },
        }),
      ),
    );
    const result = await fetchLatestRelease({ etag: null });
    expect(result).toEqual({ kind: 'rate-limited', resetAt: 1794757701 * 1000 });
  });

  it('403 但 remaining 不是 0 ⇒ error（不许当成限流，否则会一直静默延后）', async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '12' } }),
      ),
    );
    const result = await fetchLatestRelease({ etag: null });
    expect(result.kind).toBe('error');
  });

  it('500 ⇒ error', async () => {
    stubFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
    const result = await fetchLatestRelease({ etag: null });
    expect(result).toEqual({ kind: 'error', message: 'HTTP 500' });
  });

  it('网络异常 ⇒ error，不抛', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const result = await fetchLatestRelease({ etag: null });
    expect(result.kind).toBe('error');
  });

  it('200 但不是 JSON ⇒ error', async () => {
    stubFetch(() => Promise.resolve(new Response('<html>', { status: 200 })));
    const result = await fetchLatestRelease({ etag: null });
    expect(result.kind).toBe('error');
  });

  it('200 且 JSON 合法但结构不对 ⇒ error 且带原因', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ ...RELEASE_BODY, prerelease: true })));
    const result = await fetchLatestRelease({ etag: null });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/预发布/);
  });
});

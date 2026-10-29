import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPgcPlayurl } from '../../../src/content/isolated/pgc-fetch';

/**
 * G1：取流入口必须区分「有流」和「完整流」。
 *
 * 2026-10-29 之前 `hasPlayableStream()` 只看有没有 dash/durl，试看流也会被
 * 当成 `kind: 'ok'`；调用方先 `applyPlayback()`、再合并，直到下游
 * `shouldWritePgcCache()` 才被拒 —— 上游说成功、下游说不行。
 */

const URL = 'https://api.bilibili.com/pgc/player/web/playurl?cid=1&fnval=4048';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function mockFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPgcPlayurl：有流 ≠ 完整流（G1）', () => {
  it('完整 dash → ok', async () => {
    mockFetch(async () =>
      jsonResponse({
        code: 0,
        result: {
          timelength: 1_440_083,
          dash: { duration: 1441, video: [{ id: 80 }] },
        },
      }),
    );

    const out = await fetchPgcPlayurl('1', URL);
    expect(out.kind).toBe('ok');
  });

  it('完整单段 durl（长度 = timelength）→ ok', async () => {
    mockFetch(async () =>
      jsonResponse({
        code: 0,
        result: { timelength: 1_166_528, durl: [{ length: 1_166_528, url: 'x' }] },
      }),
    );

    const out = await fetchPgcPlayurl('1', URL);
    expect(out.kind).toBe('ok');
  });

  it('试看 durl（180s vs timelength 19min）→ truncated，不再是 ok', async () => {
    mockFetch(async () =>
      jsonResponse({
        code: 0,
        result: { timelength: 1_166_528, durl: [{ length: 180_160, url: 'x' }] },
      }),
    );

    const out = await fetchPgcPlayurl('1', URL);
    expect(out).toEqual({ kind: 'truncated' });
  });

  it('playview 试看 durls（每画质组 6 分钟）→ truncated', async () => {
    mockFetch(async () =>
      jsonResponse({
        code: 0,
        result: {
          timelength: 1_440_000,
          durls: [{ durl: [{ length: 360_109, url: 'x' }] }],
        },
      }),
    );

    const out = await fetchPgcPlayurl('1', URL);
    expect(out).toEqual({ kind: 'truncated' });
  });

  it('只有元信息、没有流 → denied（不是 truncated）', async () => {
    mockFetch(async () =>
      jsonResponse({
        code: 0,
        result: { quality: 120, timelength: 1_440_083, accept_quality: [120] },
      }),
    );

    const out = await fetchPgcPlayurl('1', URL);
    expect(out).toEqual({ kind: 'denied', code: 0 });
  });

  it('服务端 code !== 0 → denied', async () => {
    mockFetch(async () => jsonResponse({ code: -10403, message: 'region' }));

    const out = await fetchPgcPlayurl('1', URL);
    expect(out).toEqual({ kind: 'denied', code: -10403 });
  });

  it('HTTP 非 2xx → error', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }) as unknown as Response);

    const out = await fetchPgcPlayurl('1', URL);
    expect(out).toEqual({ kind: 'error', detail: 'http-500' });
  });

  it('JSON 解析失败 → error', async () => {
    mockFetch(
      async () =>
        ({ ok: true, json: async () => Promise.reject(new Error('bad')) }) as unknown as Response,
    );

    const out = await fetchPgcPlayurl('1', URL);
    expect(out).toEqual({ kind: 'error', detail: 'bad-json' });
  });

  it('fetch 抛错 → error（不抛给调用方）', async () => {
    mockFetch(async () => Promise.reject(new Error('boom')));

    const out = await fetchPgcPlayurl('1', URL);
    expect(out.kind).toBe('error');
  });

  it('空 cid → error no-cid（不发请求）', async () => {
    const fn = mockFetch(async () => jsonResponse({ code: 0, result: {} }));

    const out = await fetchPgcPlayurl('', URL);
    expect(out).toEqual({ kind: 'error', detail: 'no-cid' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('expectedMs：接口缺 timelength 时用第二参照判截断', async () => {
    mockFetch(async () => jsonResponse({ code: 0, result: { durl: [{ length: 180_160 }] } }));

    const out = await fetchPgcPlayurl('1', URL, 1_166_528);
    expect(out).toEqual({ kind: 'truncated' });
  });

  it('expectedMs：完整流（段长 = 参照）→ ok', async () => {
    mockFetch(async () => jsonResponse({ code: 0, result: { durl: [{ length: 1_166_528 }] } }));

    const out = await fetchPgcPlayurl('1', URL, 1_166_528);
    expect(out.kind).toBe('ok');
  });
});

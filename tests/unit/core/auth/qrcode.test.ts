import { describe, expect, it } from 'vitest';

import { generateQr, isTerminal, pollQr, type HttpClient } from '@core/auth/qrcode';

/** 按 URL 片段返回预设响应，命中不到的抛错（避免测试静默通过） */
function fakeHttp(routes: Record<string, unknown>): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      for (const [fragment, body] of Object.entries(routes)) {
        if (url.includes(fragment)) return body as T;
      }
      throw new Error(`未预期的请求: ${url}`);
    },
  };
}

describe('generateQr', () => {
  it('正常返回 key 与要编码的内容', async () => {
    const http = fakeHttp({
      '/generate': {
        code: 0,
        message: 'OK',
        data: {
          url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc&from=main_web',
          qrcode_key: 'abc',
        },
      },
    });

    const result = await generateQr(http);
    expect(result.qrcodeKey).toBe('abc');
    expect(result.qrContent).toContain('qrcode_key=abc');
  });

  it('外层 code 非 0 时抛错', async () => {
    const http = fakeHttp({ '/generate': { code: -400, message: '请求错误' } });
    await expect(generateQr(http)).rejects.toThrow(/二维码生成失败/);
  });

  it('缺少 qrcode_key 时抛错（不能拿空 key 去轮询）', async () => {
    const http = fakeHttp({ '/generate': { code: 0, message: 'OK', data: { url: 'https://x' } } });
    await expect(generateQr(http)).rejects.toThrow(/二维码生成失败/);
  });
});

describe('pollQr', () => {
  const make = (innerCode: number, url = '', message = '') =>
    fakeHttp({
      '/poll': {
        code: 0,
        message: 'OK',
        data: { url, refresh_token: '', timestamp: 0, code: innerCode, message },
      },
    });

  it('86101 → 未扫码', async () => {
    expect(await pollQr(make(86101, '', '未扫码'), 'k')).toEqual({ kind: 'pending' });
  });

  it('86090 → 已扫码待确认', async () => {
    expect(await pollQr(make(86090, '', '已扫码'), 'k')).toEqual({ kind: 'scanned' });
  });

  it('86038 → 二维码失效', async () => {
    expect(await pollQr(make(86038, '', '二维码已失效'), 'k')).toEqual({ kind: 'expired' });
  });

  it('0 → 登录成功，带回跨域 url', async () => {
    const status = await pollQr(
      make(0, 'https://passport.biligame.com/x/crossDomain?ticket=t'),
      'k',
    );
    expect(status).toEqual({
      kind: 'success',
      crossDomainUrl: 'https://passport.biligame.com/x/crossDomain?ticket=t',
    });
  });

  it('外层 code 非 0 → error（不能被当成 pending 无限轮询）', async () => {
    const http = fakeHttp({ '/poll': { code: -412, message: '请求被拦截' } });
    const status = await pollQr(http, 'k');
    expect(status.kind).toBe('error');
    if (status.kind === 'error') {
      expect(status.code).toBe(-412);
    }
  });

  it('未知的内层 code → error 并带上原值', async () => {
    const status = await pollQr(make(12345, '', '没见过'), 'k');
    expect(status.kind).toBe('error');
    if (status.kind === 'error') {
      expect(status.code).toBe(12345);
    }
  });

  it('qrcode_key 会被 URL 编码', async () => {
    const seen: string[] = [];
    const http: HttpClient = {
      async getJson<T>(url: string): Promise<T> {
        seen.push(url);
        return { code: 0, message: 'OK', data: { code: 86101 } } as T;
      },
    };
    await pollQr(http, 'a b&c');
    expect(seen[0]).toContain('qrcode_key=a%20b%26c');
  });
});

describe('isTerminal', () => {
  it('pending / scanned 不算终止', () => {
    expect(isTerminal({ kind: 'pending' })).toBe(false);
    expect(isTerminal({ kind: 'scanned' })).toBe(false);
  });

  it('success / expired / error 算终止', () => {
    expect(isTerminal({ kind: 'success', crossDomainUrl: '' })).toBe(true);
    expect(isTerminal({ kind: 'expired' })).toBe(true);
    expect(isTerminal({ kind: 'error', code: 1, message: 'x' })).toBe(true);
  });
});

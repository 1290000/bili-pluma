import { describe, expect, it } from 'vitest';

import { buildCookieHeader, deviceCookiesFrom } from '@platform/http/playurl';
import type { Credential } from '@shared/types/account';

const credential: Credential = {
  sessdata: 'deadbeef,1700000000,1*FAKEsessdata',
  biliJct: '8bf1e88c2633143a485be4ad40e29c7e',
  dedeUserId: '{{playback_mid}}',
};

describe('buildCookieHeader', () => {
  it('凭据覆盖同名设备 Cookie', () => {
    const header = buildCookieHeader(credential, { SESSDATA: 'primary-should-be-replaced' });
    expect(header).toContain('SESSDATA=deadbeef,1700000000,1*FAKEsessdata');
    expect(header).not.toContain('primary-should-be-replaced');
  });

  it('保留设备 Cookie（buvid3 / buvid4 / bili_ticket）', () => {
    const header = buildCookieHeader(credential, {
      buvid3: 'ABC-123',
      buvid4: 'DEF==',
      bili_ticket: 'ticket-value',
    });
    expect(header).toContain('buvid3=ABC-123');
    expect(header).toContain('buvid4=DEF==');
    expect(header).toContain('bili_ticket=ticket-value');
  });

  it('过滤掉不在白名单里的 cookie（不能把无关 cookie 带出去）', () => {
    const header = buildCookieHeader(credential, {
      buvid3: 'keep',
      some_random: 'drop-me',
      tracking_id: 'drop-me-too',
    });
    expect(header).toContain('buvid3=keep');
    expect(header).not.toContain('some_random');
    expect(header).not.toContain('tracking_id');
  });

  it('三个凭据字段都在', () => {
    const header = buildCookieHeader(credential, {});
    expect(header).toContain('SESSDATA=');
    expect(header).toContain('bili_jct=');
    expect(header).toContain('DedeUserID=');
  });

  it('设备 Cookie 为空时只用凭据', () => {
    const header = buildCookieHeader(credential, {});
    expect(header.split('; ')).toHaveLength(3);
  });

  it('值里的逗号和等号原样保留（SESSDATA / buvid4 真实格式）', () => {
    const header = buildCookieHeader(
      { sessdata: 'a,b,c', biliJct: 'x', dedeUserId: '1' },
      { buvid4: 'AAA==' },
    );
    expect(header).toContain('SESSDATA=a,b,c');
    expect(header).toContain('buvid4=AAA==');
  });
});

describe('deviceCookiesFrom', () => {
  it('从 document.cookie 字符串里挑出设备 Cookie', () => {
    const raw = 'buvid3=B3; b_nut=1782538104; _uuid=UU; some_other=x';
    expect(deviceCookiesFrom(raw)).toEqual({ buvid3: 'B3', b_nut: '1782538104', _uuid: 'UU' });
  });

  it('空字符串返回空对象', () => {
    expect(deviceCookiesFrom('')).toEqual({});
  });
});

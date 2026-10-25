import { describe, expect, it } from 'vitest';

import { buildCookieHeader, deviceCookiesFrom, playurlQuery } from '@platform/http/playurl';
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

describe('playurlQuery', () => {
  const base = { bvid: 'BV1beNcz2ECq', cid: 36532588493, qn: null };

  it('fnval 固定 4048，fourk 固定 1（官方前端实测值）', () => {
    const q = playurlQuery(base, 1700000000);
    expect(q.fnval).toBe('4048');
    expect(q.fourk).toBe('1');
  });

  it('qn 为 null 时传 "0"（实测 qn 不影响返回轨道）', () => {
    expect(playurlQuery({ ...base, qn: null }, 1700000000).qn).toBe('0');
  });

  it('qn 有值时照传', () => {
    expect(playurlQuery({ ...base, qn: 80 }, 1700000000).qn).toBe('80');
  });

  it('bvid 与 cid 都带上且是字符串', () => {
    const q = playurlQuery(base, 1700000000);
    expect(q.bvid).toBe('BV1beNcz2ECq');
    expect(q.cid).toBe('36532588493');
  });

  it('wts 参与签名参数', () => {
    expect(playurlQuery(base, 1700000000).wts).toBe('1700000000');
  });

  it('不含任何凭据字段', () => {
    const q = JSON.stringify(playurlQuery(base, 1700000000));
    expect(q).not.toContain('SESSDATA');
    expect(q.toLowerCase()).not.toContain('cookie');
    expect(q).not.toContain('w_rid');
  });
});

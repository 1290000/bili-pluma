import { describe, expect, it } from 'vitest';

import { mergeCookie, parseCookie, pickCookie, serializeCookie } from '@shared/utils/cookie';

describe('parseCookie', () => {
  it('解析普通键值对', () => {
    expect(parseCookie('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('保留值里的逗号（SESSDATA 真实格式）', () => {
    const header = 'SESSDATA=deadbeef,1700000000,1*FAKEsessdata';
    expect(parseCookie(header)['SESSDATA']).toBe('deadbeef,1700000000,1*FAKEsessdata');
  });

  it('保留值里的等号（buvid4 的 base64 padding）', () => {
    expect(parseCookie('buvid4=ABC123==')['buvid4']).toBe('ABC123==');
  });

  it('不对值做 URL 解码（服务端要原样）', () => {
    expect(parseCookie('SESSDATA=a%2Cb')['SESSDATA']).toBe('a%2Cb');
  });

  it('忽略空段与没有等号的段', () => {
    expect(parseCookie('; a=1; ; junk; b=2;')).toEqual({ a: '1', b: '2' });
  });

  it('保留空值', () => {
    expect(parseCookie('a=')).toEqual({ a: '' });
  });

  it('空字符串返回空对象', () => {
    expect(parseCookie('')).toEqual({});
  });

  it('去掉键和值两侧的空白', () => {
    expect(parseCookie('  a = 1  ;  b=2  ')).toEqual({ a: '1', b: '2' });
  });
});

describe('serializeCookie', () => {
  it('按标准格式拼接', () => {
    expect(serializeCookie({ a: '1', b: '2' })).toBe('a=1; b=2');
  });

  it('空对象返回空字符串', () => {
    expect(serializeCookie({})).toBe('');
  });

  it('与 parseCookie 互为逆运算（往返不丢信息）', () => {
    const original = 'SESSDATA=deadbeef,1700000000,1*FAKEsessdata; buvid3=ABC==; b_nut=1782538104';
    expect(serializeCookie(parseCookie(original))).toBe(original);
  });
});

describe('mergeCookie', () => {
  it('后者覆盖前者，未覆盖的键保留', () => {
    expect(mergeCookie({ a: '1', b: '2' }, { b: 'x', c: '3' })).toEqual({ a: '1', b: 'x', c: '3' });
  });

  it('不修改入参', () => {
    const base = { a: '1' };
    mergeCookie(base, { a: '2' });
    expect(base).toEqual({ a: '1' });
  });
});

describe('pickCookie', () => {
  it('只挑指定名字', () => {
    expect(pickCookie({ a: '1', b: '2', c: '3' }, ['a', 'c'])).toEqual({ a: '1', c: '3' });
  });

  it('缺失的名字不产生 undefined 字段', () => {
    const out = pickCookie({ a: '1' }, ['a', 'zzz']);
    expect(out).toEqual({ a: '1' });
    expect('zzz' in out).toBe(false);
  });

  it('空名单返回空对象', () => {
    expect(pickCookie({ a: '1' }, [])).toEqual({});
  });
});

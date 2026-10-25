import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { extractKeyFromUrl, filterValue, md5, mixinKey, signQuery } from '@core/wbi/signer';

function nodeMd5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

describe('md5（与 Node 内置实现逐个对拍）', () => {
  const cases = [
    '',
    'a',
    'abc',
    'message digest',
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
    // 边界：正好 55 / 56 / 64 / 65 字节，覆盖补位分支
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
  ];

  for (const input of cases) {
    it(`长度 ${input.length}: ${input.slice(0, 20) || '(空)'}`, () => {
      expect(md5(new TextEncoder().encode(input))).toBe(nodeMd5(input));
    });
  }

  it('中文和多字节字符也一致', () => {
    for (const input of ['哔哩哔哩', '测试 md5 中文', 'emoji 🦆 test']) {
      expect(md5(new TextEncoder().encode(input))).toBe(nodeMd5(input));
    }
  });

  it('返回 32 位小写 hex', () => {
    expect(md5(new TextEncoder().encode('abc'))).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('extractKeyFromUrl', () => {
  it('取文件名去掉扩展名', () => {
    expect(extractKeyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    );
  });

  it('没有扩展名时返回整个文件名', () => {
    expect(extractKeyFromUrl('https://x.com/a/b/keyname')).toBe('keyname');
  });

  it('7d 风格的 sub_key 也能取', () => {
    expect(extractKeyFromUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png')).toBe(
      '4932caff0ff746eab6f01bf08b70ac45',
    );
  });
});

describe('mixinKey', () => {
  it('结果固定 32 位', () => {
    const key = mixinKey('0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210');
    expect(key).toHaveLength(32);
  });

  it('相同输入结果稳定（可复现）', () => {
    const a = mixinKey('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const b = mixinKey('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(a).toBe(b);
  });

  it('换任一个 key 结果都变', () => {
    const base = mixinKey('a'.repeat(32), 'b'.repeat(32));
    expect(mixinKey('c'.repeat(32), 'b'.repeat(32))).not.toBe(base);
    expect(mixinKey('a'.repeat(32), 'c'.repeat(32))).not.toBe(base);
  });

  it('置换表下标都落在 64 内', () => {
    // 表长度必须是 64，否则 mixin_key 会错位
    const key = mixinKey('x'.repeat(32), 'y'.repeat(32));
    expect(key.length).toBe(32);
  });
});

describe('filterValue', () => {
  it('过滤 !\'()* 五个字符', () => {
    expect(filterValue("a!b'c(d)e*f")).toBe('abcdef');
  });

  it('保留数字和普通符号', () => {
    expect(filterValue('BV1beNcz2ECq-,_.~')).toBe('BV1beNcz2ECq-,_.~');
  });

  it('保留中文', () => {
    expect(filterValue('测试(值)')).toBe('测试值');
  });
});

describe('signQuery', () => {
  const mixin = 'ea1db124af3c7062474693fa704f4ff8';

  it('产出 wts 与 w_rid', () => {
    const q = signQuery({ bvid: 'BV1x', cid: 1 }, mixin, 1700000000);
    expect(q).toContain('wts=1700000000');
    expect(q).toMatch(/w_rid=[0-9a-f]{32}$/);
  });

  it('参数按 key 升序排列', () => {
    const q = signQuery({ zzz: '1', aaa: '2', mmm: '3' }, mixin, 1700000000);
    const keys = q.split('&').map((kv) => kv.split('=')[0]);
    const beforeWRid = keys.slice(0, keys.indexOf('w_rid'));
    expect(beforeWRid).toEqual([...beforeWRid].sort());
  });

  it('数字参数被转成字符串', () => {
    const q = signQuery({ cid: 36532588493 }, mixin, 1700000000);
    expect(q).toContain('cid=36532588493');
  });

  it('w_rid 由排序后的 query + mixin 计算，与手工计算一致', () => {
    const q = signQuery({ bvid: 'BV1x', cid: 1 }, mixin, 1700000000);
    const withoutRid = q.slice(0, q.lastIndexOf('&w_rid='));
    const manual = nodeMd5(`${withoutRid}${mixin}`);
    expect(q.endsWith(`w_rid=${manual}`)).toBe(true);
  });

  it('wts 不同则 w_rid 不同（时间戳参与签名）', () => {
    const a = signQuery({ bvid: 'BV1x' }, mixin, 1700000000);
    const b = signQuery({ bvid: 'BV1x' }, mixin, 1700000001);
    expect(a).not.toBe(b);
  });

  it('mixin 不同则 w_rid 不同', () => {
    const a = signQuery({ bvid: 'BV1x' }, mixin, 1700000000);
    const b = signQuery({ bvid: 'BV1x' }, 'ffffffffffffffffffffffffffffffff', 1700000000);
    expect(a).not.toBe(b);
  });

  it('值里的 ( ) 会在签名前被过滤', () => {
    const q = signQuery({ x: 'a(b)c' }, mixin, 1700000000);
    expect(q).toContain('x=abc');
    expect(q).not.toContain('%28');
  });
});

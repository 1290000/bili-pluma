import { describe, expect, it } from 'vitest';

import {
  parsePgcPage,
  parsePlayPage,
  parseVideoPage,
  readDeviceCookies,
  readPrimaryMidFromCookie,
} from '@shared/utils/video-page';

describe('parseVideoPage', () => {
  it('普通视频页', () => {
    expect(parseVideoPage('https://www.bilibili.com/video/BV1beNcz2ECq/')).toEqual({
      bvid: 'BV1beNcz2ECq',
      p: 1,
    });
  });

  it('带分 P 参数', () => {
    expect(parseVideoPage('https://www.bilibili.com/video/BV1beNcz2ECq/?p=4')).toEqual({
      bvid: 'BV1beNcz2ECq',
      p: 4,
    });
  });

  it('带一堆追踪参数也能解析（真实分享链接）', () => {
    const url =
      'https://www.bilibili.com/video/BV1beNcz2ECq/?spm_id_from=333.788.videopod.episodes&vd_source=617d730f2671&p=2';
    expect(parseVideoPage(url)).toEqual({ bvid: 'BV1beNcz2ECq', p: 2 });
  });

  it('不带 www 的裸域名也认', () => {
    expect(parseVideoPage('https://bilibili.com/video/BV1x')).toEqual({ bvid: 'BV1x', p: 1 });
  });

  it('legacy /s/video/ 不解析', () => {
    expect(parseVideoPage('https://www.bilibili.com/s/video/BV1x')).toBeNull();
  });

  it('番剧页不由 parseVideoPage 解析（走 parsePgcPage）', () => {
    expect(parseVideoPage('https://www.bilibili.com/bangumi/play/ep3854821')).toBeNull();
  });

  it('直播页不解析', () => {
    expect(parseVideoPage('https://live.bilibili.com/123')).toBeNull();
  });

  it('首页不解析', () => {
    expect(parseVideoPage('https://www.bilibili.com/')).toBeNull();
  });

  it('非 bilibili 域名不解析', () => {
    expect(parseVideoPage('https://evil.com/video/BV1x')).toBeNull();
  });

  it('仿冒域名不解析', () => {
    expect(parseVideoPage('https://www.bilibili.com.evil.com/video/BV1x')).toBeNull();
  });

  it('p 为 0 / 负数 / 非数字时回落到 1', () => {
    expect(parseVideoPage('https://www.bilibili.com/video/BV1x?p=0')?.p).toBe(1);
    expect(parseVideoPage('https://www.bilibili.com/video/BV1x?p=-3')?.p).toBe(1);
    expect(parseVideoPage('https://www.bilibili.com/video/BV1x?p=abc')?.p).toBe(1);
  });

  it('p 是小数时向下取整', () => {
    expect(parseVideoPage('https://www.bilibili.com/video/BV1x?p=2.9')?.p).toBe(2);
  });

  it('bvid 里只有大小写字母和数字时能取到', () => {
    expect(parseVideoPage('https://www.bilibili.com/video/BV1beNcz2ECq')?.bvid).toBe(
      'BV1beNcz2ECq',
    );
  });

  it('/video/ 后面不是 BV 开头则不解析', () => {
    expect(parseVideoPage('https://www.bilibili.com/video/av12345')).toBeNull();
  });

  it('非法 URL 返回 null', () => {
    expect(parseVideoPage('not a url')).toBeNull();
    expect(parseVideoPage('')).toBeNull();
  });
});

describe('parsePgcPage（番剧 / 国创 / 电影，ADR 0019）', () => {
  it('ep 形式（单集）', () => {
    expect(parsePgcPage('https://www.bilibili.com/bangumi/play/ep3854821')).toEqual({
      kind: 'pgc',
      epId: '3854821',
      seasonId: null,
    });
  });

  it('ss 形式（整季）', () => {
    expect(parsePgcPage('https://www.bilibili.com/bangumi/play/ss28747')).toEqual({
      kind: 'pgc',
      epId: null,
      seasonId: '28747',
    });
  });

  it('带追踪参数也能解析（真实分享链接）', () => {
    expect(
      parsePgcPage('https://www.bilibili.com/bangumi/play/ss34412?from_spmid=666.4.0.1'),
    ).toEqual({ kind: 'pgc', epId: null, seasonId: '34412' });
  });

  it('详情页 /bangumi/media/md… 不是播放页，返回 null', () => {
    expect(parsePgcPage('https://www.bilibili.com/bangumi/media/md28223043')).toBeNull();
  });

  it('普通视频页不由 parsePgcPage 解析', () => {
    expect(parsePgcPage('https://www.bilibili.com/video/BV1x')).toBeNull();
  });

  it('仿冒域名不解析', () => {
    expect(parsePgcPage('https://www.bilibili.com.evil.com/bangumi/play/ss1')).toBeNull();
  });

  it('非法 URL 返回 null', () => {
    expect(parsePgcPage('not a url')).toBeNull();
  });
});

describe('parsePlayPage（统一入口）', () => {
  it('视频页带 kind', () => {
    expect(parsePlayPage('https://www.bilibili.com/video/BV1x?p=3')).toEqual({
      kind: 'video',
      bvid: 'BV1x',
      p: 3,
    });
  });

  it('PGC 页带 kind', () => {
    expect(parsePlayPage('https://www.bilibili.com/bangumi/play/ep1')).toEqual({
      kind: 'pgc',
      epId: '1',
      seasonId: null,
    });
  });

  it('都不是则 null', () => {
    expect(parsePlayPage('https://www.bilibili.com/')).toBeNull();
  });
});

describe('readDeviceCookies', () => {
  it('只挑白名单里的设备 Cookie', () => {
    const raw = 'buvid3=B3VAL; b_nut=1782538104; _uuid=UUID; some_tracker=drop';
    expect(readDeviceCookies(raw)).toEqual({ buvid3: 'B3VAL', b_nut: '1782538104', _uuid: 'UUID' });
  });

  it('绝不带出 SESSDATA / bili_jct / DedeUserID', () => {
    const raw = 'buvid3=B3; SESSDATA=secret; bili_jct=csrf; DedeUserID=123';
    const out = readDeviceCookies(raw);
    expect(out).not.toHaveProperty('SESSDATA');
    expect(out).not.toHaveProperty('bili_jct');
    expect(out).not.toHaveProperty('DedeUserID');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('csrf');
  });

  it('保留值里的逗号和等号（buvid4 / bili_ticket 真实格式）', () => {
    const raw = 'buvid4=ABC==,DEF==; bili_ticket=eyJhbGciOi.eyJleHAi.sig';
    const out = readDeviceCookies(raw);
    expect(out['buvid4']).toBe('ABC==,DEF==');
    expect(out['bili_ticket']).toBe('eyJhbGciOi.eyJleHAi.sig');
  });

  it('空字符串返回空对象', () => {
    expect(readDeviceCookies('')).toEqual({});
  });

  it('忽略无等号的段', () => {
    expect(readDeviceCookies('junk; buvid3=B3')).toEqual({ buvid3: 'B3' });
  });
});

describe('readPrimaryMidFromCookie', () => {
  it('从页面 cookie 读出主账号 mid', () => {
    expect(readPrimaryMidFromCookie('buvid3=B3; DedeUserID=1000001; bili_jct=x')).toBe('1000001');
  });

  it('读的是页面里的 DedeUserID，不是别的字段', () => {
    expect(readPrimaryMidFromCookie('DedeUserID__ckMd5=abc; DedeUserID=999')).toBe('999');
  });

  it('没有 DedeUserID 时返回 null（未登录）', () => {
    expect(readPrimaryMidFromCookie('buvid3=B3; b_nut=123')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(readPrimaryMidFromCookie('')).toBeNull();
  });

  it('值不是纯数字时返回 null（防止异常值被当成 mid）', () => {
    expect(readPrimaryMidFromCookie('DedeUserID=abc')).toBeNull();
    expect(readPrimaryMidFromCookie('DedeUserID=')).toBeNull();
    expect(readPrimaryMidFromCookie('DedeUserID=-1')).toBeNull();
  });

  it('大 mid 也不丢精度（返回字符串）', () => {
    expect(readPrimaryMidFromCookie('DedeUserID=1000002')).toBe('1000002');
  });
});

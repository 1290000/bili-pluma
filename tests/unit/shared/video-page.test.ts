import { describe, expect, it } from 'vitest';

import {
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

  it('番剧页不解析（v1 不支持，ADR 0006）', () => {
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
    expect(readPrimaryMidFromCookie('buvid3=B3; DedeUserID={{primary_mid}}; bili_jct=x')).toBe(
      '{{primary_mid}}',
    );
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
    expect(readPrimaryMidFromCookie('DedeUserID={{playback_mid}}')).toBe('{{playback_mid}}');
  });
});

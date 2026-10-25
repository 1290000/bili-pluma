/**
 * 身份路由的测试 —— **先于实现编写**（TDD）
 *
 * 期望值来源（不猜）：
 *   - `poc/verify/result-dnr-e2e.json`：实测 playurl 成功取到 8K
 *   - `poc/verify/result-qrlogin.json`：实测 passport 二维码接口
 *   - `src/shared/constants/routes.ts`：白名单唯一真相源
 *   - `docs/03-open-questions.md` Q4：番剧三路径实测无效
 */

import { describe, expect, it } from 'vitest';

import { routeFor } from '@core/identity/router';

const API = 'https://api.bilibili.com';

describe('走播放账号的路径', () => {
  it('playurl（当前版本）', () => {
    expect(routeFor(`${API}/x/player/wbi/playurl?bvid=BV1x&cid=1&fnval=4048`)).toBe('playback');
  });

  it('playurl（旧版兜底）', () => {
    expect(routeFor(`${API}/x/player/playurl?bvid=BV1x&cid=1`)).toBe('playback');
  });

  it('playurl 无查询参数也认', () => {
    expect(routeFor(`${API}/x/player/wbi/playurl`)).toBe('playback');
  });

  it('playurl 带哈希也认', () => {
    expect(routeFor(`${API}/x/player/wbi/playurl?bvid=x#frag`)).toBe('playback');
  });
});

describe('走主账号的路径（不代理）', () => {
  it('nav（拿 WBI 密钥，必须用主账号身份）', () => {
    expect(routeFor(`${API}/x/web-interface/nav`)).toBe('primary');
  });

  it('点赞接口（必须归主账号）', () => {
    expect(routeFor(`${API}/x/web-interface/archive/like`)).toBe('primary');
  });

  it('投币接口', () => {
    expect(routeFor(`${API}/x/web-interface/coin/add`)).toBe('primary');
  });

  it('收藏接口', () => {
    expect(routeFor(`${API}/x/v3/fav/resource/deal`)).toBe('primary');
  });

  it('评论接口', () => {
    expect(routeFor(`${API}/x/v2/reply/add`)).toBe('primary');
  });

  it('历史记录接口', () => {
    expect(routeFor(`${API}/x/web-interface/history/report`)).toBe('primary');
  });

  it('视频详情接口', () => {
    expect(routeFor(`${API}/x/web-interface/view?bvid=BV1x`)).toBe('primary');
  });

  it('首页推荐', () => {
    expect(routeFor(`${API}/x/web-interface/wbi/index/top/feed/rcmd`)).toBe('primary');
  });
});

describe('番剧路径（实测无效，不该代理）', () => {
  it('/pgc/player/web/v2/playurl 不代理（零请求，走 SSR）', () => {
    expect(routeFor(`${API}/pgc/player/web/v2/playurl?ep_id=1`)).toBe('primary');
  });

  it('/pgc/player/web/playurl 不代理', () => {
    expect(routeFor(`${API}/pgc/player/web/playurl?ep_id=1`)).toBe('primary');
  });

  it('/ogv/player/playview 不代理', () => {
    expect(routeFor(`${API}/ogv/player/playview`)).toBe('primary');
  });
});

describe('直播路径（未测，不该代理）', () => {
  it('getRoomPlayInfo 不代理', () => {
    expect(routeFor(`${API}/xlive/web-room/v2/index/getRoomPlayInfo?room_id=1`)).toBe('primary');
  });

  it('/room/v1/Room/playUrl 不代理', () => {
    expect(routeFor(`${API}/room/v1/Room/playUrl?cid=1`)).toBe('primary');
  });
});

describe('前缀误匹配（最容易写错的地方）', () => {
  it('playurl-extra 不能被当成 playurl', () => {
    expect(routeFor(`${API}/x/player/wbi/playurl-extra`)).toBe('primary');
  });

  it('playurlX 不能被当成 playurl', () => {
    expect(routeFor(`${API}/x/player/wbi/playurlX`)).toBe('primary');
  });

  it('my-playurl 不能被当成 playurl', () => {
    expect(routeFor(`${API}/x/my-playurl`)).toBe('primary');
  });

  it('子路径 /x/player/wbi/playurl/sub 算命中（服务端可能加子路由）', () => {
    expect(routeFor(`${API}/x/player/wbi/playurl/sub`)).toBe('playback');
  });
});

describe('域名判定', () => {
  it('非 bilibili 域名一律不代理', () => {
    expect(routeFor('https://evil.com/x/player/wbi/playurl')).toBe('primary');
  });

  it('bilibili 的仿冒域名不代理', () => {
    expect(routeFor('https://api.bilibili.com.evil.com/x/player/wbi/playurl')).toBe('primary');
  });

  it('bilibili.evil.com 后缀不代理', () => {
    expect(routeFor('https://bilibili.evil.com/x/player/wbi/playurl')).toBe('primary');
  });

  it('passport.bilibili.com 不代理（登录接口用浏览器自己的身份）', () => {
    expect(routeFor('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')).toBe('primary');
  });

  it('www.bilibili.com 的页面请求不代理', () => {
    expect(routeFor('https://www.bilibili.com/video/BV1x')).toBe('primary');
  });
});

describe('非法输入', () => {
  it('空字符串返回 primary', () => {
    expect(routeFor('')).toBe('primary');
  });

  it('非 URL 字符串返回 primary', () => {
    expect(routeFor('not a url')).toBe('primary');
  });

  it('相对路径返回 primary', () => {
    expect(routeFor('/x/player/wbi/playurl')).toBe('primary');
  });

  it('data: URI 返回 primary', () => {
    expect(routeFor('data:text/plain,hello')).toBe('primary');
  });

  it('chrome-extension:// 返回 primary', () => {
    expect(routeFor('chrome-extension://abc/login-window.html')).toBe('primary');
  });
});

describe('大小写与编码', () => {
  it('路径大小写不同不命中（B站路径区分大小写）', () => {
    expect(routeFor(`${API}/x/player/wbi/PlayURL`)).toBe('primary');
  });

  it('URL 编码的路径不命中（服务端会解码，但我们只匹配原始 path）', () => {
    expect(routeFor(`${API}/x/player/wbi/play%75rl`)).toBe('primary');
  });

  it('查询参数里出现 playurl 不影响判定', () => {
    expect(routeFor(`${API}/x/web-interface/nav?redirect=/x/player/wbi/playurl`)).toBe('primary');
  });
});

describe('幂等与确定性', () => {
  it('同一输入多次调用结果一致', () => {
    const url = `${API}/x/player/wbi/playurl?bvid=BV1x`;
    expect(routeFor(url)).toBe(routeFor(url));
    expect(routeFor(url)).toBe(routeFor(url));
  });

  it('返回值只有 primary / playback 两种', () => {
    const samples = [
      `${API}/x/player/wbi/playurl`,
      `${API}/x/web-interface/nav`,
      'https://evil.com/x',
      '',
      'not a url',
    ];
    for (const s of samples) {
      expect(['primary', 'playback']).toContain(routeFor(s));
    }
  });
});

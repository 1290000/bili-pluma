import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PageState } from '../../../src/content/isolated/page-state';

/**
 * 守的是"主账号基线不许被误认"。
 *
 * 这是 ADR 0014 验证门的代码侧守卫：`__playinfo__` 如果是页面发完 playurl 之后
 * 才写的，那份数据属于**播放账号**，必须判成不可用 —— 否则画质对比会永远显示
 * "没有提升"，而且不报错、不崩溃，只是静默谎报。
 *
 * fixture 来源见 `tests/unit/core/playinfo/parse.test.ts` 顶部注释。
 * 这里把"未登录的 480p 响应"当作主账号基线（真实的弱身份数据），
 * 把"播放账号的 4K 响应"当作播放账号侧。
 */

function load(name: string): unknown {
  const url = new URL(`../../fixtures/playinfo/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

const GUEST_480 = load('guest-480p.json');
const PLAYBACK_4K = load('playback-4k.json');

/** SSR 的 `__playinfo__` 是 data 本身，不是完整响应 */
function asSsrData(raw: unknown): unknown {
  return (raw as { data?: unknown }).data ?? null;
}

const T0 = 1_760_000_000_000;

function freshState(clock: { now: number } = { now: T0 }): PageState {
  return new PageState(() => clock.now);
}

describe('PageState：还没报到时', () => {
  it('view() 为 null（UI 该说"打开任意视频页"）', () => {
    expect(freshState().view()).toBeNull();
  });
});

describe('PageState：正常路径（SSR 基线可用）', () => {
  it('SSR + 播放账号 → 两侧能力与差异都算出来', () => {
    const s = freshState();
    s.setPage('BV1xx411c7mD', 1);
    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: { uname: '主账号', face: null },
    });
    s.applyPlayback(PLAYBACK_4K);

    const v = s.view();
    expect(v?.bvid).toBe('BV1xx411c7mD');
    expect(v?.primary.usable).toBe(true);
    expect(v?.primary.reason).toBe('ssr');
    expect(v?.primary.capability?.maxHeight).toBe(480);
    expect(v?.primary.user?.uname).toBe('主账号');
    expect(v?.playback?.capability?.maxHeight).toBe(2160);
    expect(v?.diff?.heightGain).toBe(1680);
    expect(v?.diff?.improved).toBe(true);
  });

  it('完整响应形状（{code,data}）也能吃（两种形状同一套解析）', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({ firstSeen: 'initial', playurlBefore: false, data: GUEST_480, user: null });
    expect(s.view()?.primary.capability?.maxHeight).toBe(480);
  });
});

describe('PageState：主账号基线的三种"不可用"', () => {
  it('客户端写入（发过 playurl 之后才赋值）→ client-written，且不出对比', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({
      firstSeen: 'set',
      playurlBefore: true,
      data: asSsrData(PLAYBACK_4K),
      user: null,
    });
    s.applyPlayback(PLAYBACK_4K);

    const v = s.view();
    expect(v?.primary.usable).toBe(false);
    expect(v?.primary.reason).toBe('client-written');
    // 关键：不许拿它当基线，所以没有对比结论
    expect(v?.diff).toBeNull();
  });

  it('页面根本没有 __playinfo__ → absent', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({ firstSeen: 'none', playurlBefore: false, data: null, user: null });
    expect(s.view()?.primary.reason).toBe('absent');
  });

  it('有数据但解析不出轨道 → unparsable', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({ firstSeen: 'initial', playurlBefore: false, data: {}, user: null });
    expect(s.view()?.primary.reason).toBe('unparsable');
    expect(s.view()?.primary.usable).toBe(false);
  });
});

describe('PageState：合并规则', () => {
  it('已拿到可用基线后，后到的坏消息不许把它抹掉', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: null,
    });
    // 延迟补报时状态可能变成 set/playurlBefore
    s.applySsr({ firstSeen: 'set', playurlBefore: true, data: asSsrData(PLAYBACK_4K), user: null });

    expect(s.view()?.primary.reason).toBe('ssr');
    expect(s.view()?.primary.capability?.maxHeight).toBe(480);
  });

  it('user 后到覆盖先到（__INITIAL_STATE__ 比 __playinfo__ 晚就绪）', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: null,
    });
    expect(s.view()?.primary.user).toBeNull();

    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: { uname: '晚到的昵称', face: 'https://i0.hdslb.com/x.jpg' },
    });
    expect(s.view()?.primary.user?.uname).toBe('晚到的昵称');
  });

  it('播放账号侧偶发一次坏响应，不清空已拿到的能力', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applyPlayback(PLAYBACK_4K);
    expect(s.view()?.playback?.capability?.maxHeight).toBe(2160);

    s.applyPlayback({ code: -412, message: '请求被拦截' });
    expect(s.view()?.playback?.capability?.maxHeight).toBe(2160);
  });
});

describe('PageState：换页必须清空', () => {
  it('切 P 后两侧数据清零（不许上一 P 的轨道冒充本 P）', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applySsr({
      firstSeen: 'initial',
      playurlBefore: false,
      data: asSsrData(GUEST_480),
      user: null,
    });
    s.applyPlayback(PLAYBACK_4K);
    expect(s.view()?.diff).not.toBeNull();

    s.setPage('BV1', 2);

    const v = s.view();
    expect(v?.p).toBe(2);
    expect(v?.primary.usable).toBe(false);
    expect(v?.playback).toBeNull();
    expect(v?.diff).toBeNull();
  });

  it('同一个 bvid 与分 P 重复报到不清空', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.applyPlayback(PLAYBACK_4K);
    s.setPage('BV1', 1);
    expect(s.view()?.playback?.capability?.maxHeight).toBe(2160);
  });
});

describe('PageState：时间戳来自注入的时钟（可测）', () => {
  it('每次变更都刷新 updatedAt', () => {
    const clock = { now: T0 };
    const s = freshState(clock);

    s.setPage('BV1', 1);
    expect(s.view()?.updatedAt).toBe(T0);

    clock.now = T0 + 5000;
    s.applyPlayback(PLAYBACK_4K);
    expect(s.view()?.updatedAt).toBe(T0 + 5000);
  });
});

describe('PageState：主账号是否登录（三态，不许把"还没读到"当游客）', () => {
  it('没调用过 setPrimaryMid → unknown', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    expect(s.view()?.primary.loggedIn).toBe('unknown');
  });

  it('⚠️ document_start 那次读不到（settled=false）→ 仍是 unknown', () => {
    // 这是最容易写错的一处：document_start 时 document.cookie 往往是空的，
    // 把 null 当"游客"会让每个刚打开的页面都闪一下「未登录主账号」
    const s = freshState();
    s.setPage('BV1', 1);
    s.setPrimaryMid(null, false);
    expect(s.view()?.primary.loggedIn).toBe('unknown');
  });

  it('DOM 就绪后仍读不到（settled=true）→ no', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.setPrimaryMid(null, true);
    expect(s.view()?.primary.loggedIn).toBe('no');
  });

  it('读到真实 mid → yes（即使那次是 document_start）', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.setPrimaryMid('{{primary_mid}}', false);
    expect(s.view()?.primary.loggedIn).toBe('yes');
  });

  it('先判成 no，之后读到 mid 会翻回 yes（账号不会在同一页里变成游客）', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.setPrimaryMid(null, true);
    expect(s.view()?.primary.loggedIn).toBe('no');

    s.setPrimaryMid('{{primary_mid}}', true);
    expect(s.view()?.primary.loggedIn).toBe('yes');
  });

  it('换页后回到 unknown（新页面要重新判断）', () => {
    const s = freshState();
    s.setPage('BV1', 1);
    s.setPrimaryMid('{{primary_mid}}', true);
    expect(s.view()?.primary.loggedIn).toBe('yes');

    s.setPage('BV1', 2);
    expect(s.view()?.primary.loggedIn).toBe('unknown');
  });
});

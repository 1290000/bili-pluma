/**
 * 主账号卡片的判据（问题 2 / 3）。
 *
 * ## 为什么这段逻辑值得单测
 *
 * 它曾经因为一条**过于宽泛**的纪律而让两个真机 bug 长期存在：
 *
 * > 「缓存不能在播放页兜底。播放页上读缓存会把'游客'显示成'某个昵称'。」
 *
 * 那条纪律的**担忧是对的**（游客被显示成上一个账号确实很糟），
 * 但结论错了 —— 它把"游客态"推广成"任何情况"：
 *
 *   - **番剧页主账号栏永远是空的**：实测该页根本没有 `__INITIAL_STATE__`，
 *     主世界读不到 `uname`。页面就是没数据，不兜底就永远空着。
 *   - **刚进视频页 1.5 秒内点 popup 也不显示**：主世界补报要 1500ms/5000ms。
 *
 * 修正是**按 `loggedIn` 分情况**，而不是一刀切。下面每条用例对应分支表的一行，
 * 少一条就可能退回到某个 bug。特别是 `loggedIn === 'no'` 那两条 ——
 * 它们守的正是原来那条纪律真正要防的东西。
 */

import { describe, expect, it } from 'vitest';

import { primaryPlaceholder, resolvePrimaryCard } from '@shared/utils/primary-card';

/** 缓存里存过的档案（模拟"上次在播放页读到了"） */
const CACHED = { uname: '上次的昵称', level: 5 };

describe('resolvePrimaryCard —— 播放页', () => {
  it('实时有昵称 → 用实时，source=live', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: '现在的昵称', level: 6, loggedIn: 'yes' } },
      CACHED,
    );
    expect(r).toEqual({ uname: '现在的昵称', level: 6, loggedIn: 'yes', source: 'live' });
  });

  it('实时有昵称时不读缓存（缓存不该覆盖实时）', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: '现在的昵称', level: 6, loggedIn: 'yes' } },
      CACHED,
    );
    expect(r.uname).toBe('现在的昵称');
    expect(r.source).not.toBe('cached');
  });

  it('★ 确认未登录（loggedIn=no）→ 绝不读缓存，如实报未登录', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: null, level: null, loggedIn: 'no' } },
      CACHED,
    );
    /**
     * 这是原纪律真正要守的东西：有缓存也**不能**用。
     * 把游客显示成"上次的昵称"= 编造身份，而那个昵称可能是上一个账号的。
     */
    expect(r).toEqual({ uname: null, level: null, loggedIn: 'no', source: 'none' });
  });

  it('★ 确认未登录且没有缓存 → 同样报未登录（不是 unknown）', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: null, level: null, loggedIn: 'no' } },
      null,
    );
    expect(r.loggedIn).toBe('no');
    expect(r.source).toBe('none');
  });

  it('★ unknown（数据还没到）+ 有缓存 → 缓存兜底（修问题 3）', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: null, level: null, loggedIn: 'unknown' } },
      CACHED,
    );
    expect(r).toEqual({ uname: '上次的昵称', level: 5, loggedIn: 'unknown', source: 'cached' });
    // ⚠️ loggedIn 必须保持 unknown —— 不能因为读到了缓存就谎称已登录
    expect(r.loggedIn).not.toBe('yes');
  });

  it('★ yes 但没有昵称（番剧页无 __INITIAL_STATE__）→ 缓存兜底（修问题 2）', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: null, level: null, loggedIn: 'yes' } },
      CACHED,
    );
    expect(r.uname).toBe('上次的昵称');
    expect(r.source).toBe('cached');
    expect(r.loggedIn).toBe('yes');
  });

  it('primary 整体为 null（content 还没报到）+ 有缓存 → 缓存兜底', () => {
    const r = resolvePrimaryCard({ kind: 'play', primary: null }, CACHED);
    expect(r).toEqual({ uname: '上次的昵称', level: 5, loggedIn: 'unknown', source: 'cached' });
  });

  it('primary 为 null 且无缓存 → 全空，但仍报 unknown（不是 no）', () => {
    const r = resolvePrimaryCard({ kind: 'play', primary: null }, null);
    expect(r).toEqual({ uname: null, level: null, loggedIn: 'unknown', source: 'none' });
  });

  it('uname 是空串（不是 null）也当"没有昵称"处理', () => {
    const r = resolvePrimaryCard(
      { kind: 'play', primary: { uname: '', level: 3, loggedIn: 'yes' } },
      CACHED,
    );
    expect(r.uname).toBe('上次的昵称');
    expect(r.source).toBe('cached');
  });
});

describe('resolvePrimaryCard —— 非播放页', () => {
  it('读缓存，loggedIn 记 yes（"过去登录过"）', () => {
    const r = resolvePrimaryCard({ kind: 'other' }, CACHED);
    expect(r).toEqual({ uname: '上次的昵称', level: 5, loggedIn: 'yes', source: 'cached' });
  });

  it('没有缓存 → 全空 + unknown', () => {
    const r = resolvePrimaryCard({ kind: 'other' }, null);
    expect(r).toEqual({ uname: null, level: null, loggedIn: 'unknown', source: 'none' });
  });
});

describe('primaryPlaceholder —— 没昵称时写什么', () => {
  it('未登录 → 「未登录」（任何页面）', () => {
    expect(primaryPlaceholder('play', 'no')).toBe('未登录');
    expect(primaryPlaceholder('other', 'no')).toBe('未登录');
  });

  it('★ 播放页 + unknown → 「读取中…」，绝不写"未登录"', () => {
    const text = primaryPlaceholder('play', 'unknown');
    expect(text).toBe('读取中…');
    /**
     * 这是问题 3 的文案侧防线：刚进视频页那 1.5 秒里 `loggedIn` 是 `unknown`，
     * 若渲染成"未登录"就是在编结论，而且落在这条最常见的使用路径上。
     */
    expect(text).not.toBe('未登录');
  });

  it('★ 播放页 + yes（登录了但页面没给昵称）→ 也不能写「打开视频页后可见」', () => {
    const text = primaryPlaceholder('play', 'yes');
    expect(text).toBe('读取中…');
    // 用户明明已经在视频页了，说"打开视频页后可见"等于说功能坏了
    expect(text).not.toContain('打开视频页');
  });

  it('非播放页 + unknown → 「打开视频页后可见」（那句话在这里成立）', () => {
    expect(primaryPlaceholder('other', 'unknown')).toBe('打开视频页后可见');
  });
});

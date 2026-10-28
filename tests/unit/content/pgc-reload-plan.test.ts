import { describe, expect, it } from 'vitest';

import {
  GUARD_TTL_MS,
  MAX_RELOAD_ATTEMPTS,
  RESUME_MIN_SECONDS,
  buildPlayurlUrl,
  isAlreadyTried,
  isGuardFresh,
  makeGuard,
  parseGuard,
  resumeTarget,
  shouldReload,
} from '../../../src/content/isolated/pgc-reload-plan';

/**
 * P2 的护栏逻辑。
 *
 * ## 这组测试守的是"绝不能刷新循环"
 *
 * 一次刷新循环对用户来说是灾难（页面无限重载、进度全丢、还可能触发风控）。
 * 所以"能不能刷"必须是纯函数，并且每个阻止刷新的条件都有一条测试。
 */

describe('shouldReload：两条护栏', () => {
  const base = { alreadyTried: false, hasStream: true };

  it('有流 + 没刷过 → 刷', () => {
    expect(shouldReload(base)).toBe(true);
  });

  it('取流结果没有流 → 不刷（这是最危险的一条：没流还刷就是死循环）', () => {
    expect(shouldReload({ ...base, hasStream: false })).toBe(false);
  });

  it('本次会话已试过 → 不刷', () => {
    expect(shouldReload({ ...base, alreadyTried: true })).toBe(false);
  });

  it('两个条件都不满足 → 不刷', () => {
    expect(shouldReload({ alreadyTried: true, hasStream: false })).toBe(false);
  });

  /**
   * ## `active` 曾经是第三条护栏，2026-10-28 移除
   *
   * 真机现场（ep3854815，清空缓存首次进入）：
   * ```
   * pluma:pgc-vi:41806202889     → 写入成功（19 轨 dash 含 2160p）
   * pluma:pgc-reload:41806202889 → 从未写入
   * video.duration               → 180，25 秒内不刷新
   * 页面角标                      → 没画（badgeState.proxying === false）
   * ```
   *
   * `page/activate` 的异步回复晚到/失败 → `active: false` → 明明取到了完整流却不刷
   * → 用户永远停在 180 秒试看 → **切 4K 时找不到轨，"切换失败"**。
   *
   * 而"取流成功"本身就证明 DNR 生效了（否则拿不到播放账号的 4K dash），
   * 所以这条护栏是多余且有害的。总开关关掉的情况由 `fetchPgcPlayurl`
   * 返回 `denied` / 降级提前拦住，轮不到这里。
   */
  it('不再有 active 这个字段（护栏只剩两条）', () => {
    // 传一个多余的 active: false 也不会阻止刷新 —— 它已不参与判定
    expect(
      shouldReload({ ...base, active: false } as unknown as {
        alreadyTried: boolean;
        hasStream: boolean;
      }),
    ).toBe(true);
  });
});

describe('parseGuard：sessionStorage 里可能是任何东西', () => {
  it('正常格式', () => {
    expect(parseGuard('{"attempts":1,"at":1000}')).toEqual({ attempts: 1, at: 1000 });
  });

  it('空 / null → null', () => {
    expect(parseGuard(null)).toBeNull();
    expect(parseGuard('')).toBeNull();
  });

  it('坏 JSON → null（不抛错）', () => {
    expect(parseGuard('{oops')).toBeNull();
    expect(parseGuard('undefined')).toBeNull();
  });

  it('字段缺失或类型不对 → null', () => {
    expect(parseGuard('{"attempts":1}')).toBeNull();
    expect(parseGuard('{"at":1000}')).toBeNull();
    expect(parseGuard('{"attempts":"1","at":1000}')).toBeNull();
  });
});

describe('isGuardFresh / isAlreadyTried', () => {
  const T = 1_000_000;

  it('刚写的标记算新鲜', () => {
    expect(isGuardFresh(makeGuard(T), T)).toBe(true);
  });

  it('超过 TTL 就过期（用户过 10 分钟回来可以再试一次）', () => {
    expect(isGuardFresh(makeGuard(T), T + GUARD_TTL_MS + 1)).toBe(false);
  });

  it('恰好等于 TTL 仍算新鲜（边界）', () => {
    expect(isGuardFresh(makeGuard(T), T + GUARD_TTL_MS)).toBe(true);
  });

  it('已刷过 → isAlreadyTried 为 true', () => {
    expect(isAlreadyTried(makeGuard(T), T)).toBe(true);
  });

  it('标记过期 → 不算"已试过"（允许再试）', () => {
    expect(isAlreadyTried(makeGuard(T), T + GUARD_TTL_MS + 1)).toBe(false);
  });

  it('没有标记 → 不算已试过', () => {
    expect(isAlreadyTried(null, T)).toBe(false);
  });

  it('attempts 小于上限时不算已试过', () => {
    expect(isAlreadyTried({ attempts: MAX_RELOAD_ATTEMPTS - 1, at: T }, T)).toBe(false);
  });
});

describe('buildPlayurlUrl：参数集来自实测', () => {
  it('只要 cid 就能调通（不需要 ep_id / WBI）', () => {
    const u = buildPlayurlUrl('281989571');
    expect(u).toContain('cid=281989571');
    expect(u).toContain('fnval=4048');
    expect(u).toContain('fourk=1');
    expect(u).not.toContain('ep_id');
    expect(u).not.toContain('w_rid');
  });

  it('cid 会被 URL 编码（防止奇怪输入拼进查询串）', () => {
    expect(buildPlayurlUrl('1&evil=1')).not.toContain('&evil=1');
    expect(buildPlayurlUrl('1&evil=1')).toContain('cid=1%26evil%3D1');
  });

  it('主机与时序路径固定', () => {
    expect(
      buildPlayurlUrl('1').startsWith('https://api.bilibili.com/pgc/player/web/playurl?'),
    ).toBe(true);
  });
});

describe('resumeTarget：刷新后恢复播放位置', () => {
  it('记了 600 秒、当前 0 秒 → 恢复到 600', () => {
    expect(resumeTarget(600, 0)).toBe(600);
  });

  it('太靠前（< 15 秒）不恢复（没必要）', () => {
    expect(resumeTarget(RESUME_MIN_SECONDS - 1, 0)).toBeNull();
  });

  it('当前已经播过记录位置 → 不往回跳（bfcache 恢复场景）', () => {
    expect(resumeTarget(600, 700)).toBeNull();
  });

  it('非法值不恢复', () => {
    expect(resumeTarget(null, 0)).toBeNull();
    expect(resumeTarget('600', 0)).toBeNull();
    expect(resumeTarget(NaN, 0)).toBeNull();
    expect(resumeTarget(undefined, 0)).toBeNull();
  });
});

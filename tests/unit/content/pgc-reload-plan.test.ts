import { describe, expect, it } from 'vitest';

import {
  GUARD_TTL_MS,
  MAX_RELOAD_ATTEMPTS,
  RESUME_MIN_SECONDS,
  buildPlayurlUrl,
  isAlreadyTried,
  isGuardFresh,
  makeGuard,
  makeGuardAttempts,
  parseGuard,
  resumeTarget,
  shouldReload,
  shouldResetGuardForBadCache,
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

  it('已刷满上限 → isAlreadyTried 为 true', () => {
    /**
     * ADR 0030 方案 c：上限从 1 提到 2，所以「刷过一次」**不再**等于"已试过"——
     * 那正是方案 c 要的：刷了没成还允许再试一次。
     *
     * 这里用 `MAX_RELOAD_ATTEMPTS` 而不是字面量，是为了让上限再变时
     * 这条断言跟着走，而不是变成一个新的"恰好没过"。
     */
    expect(isAlreadyTried(makeGuardAttempts(MAX_RELOAD_ATTEMPTS, T), T)).toBe(true);
  });

  it('只刷过 1 次但上限是 2 → 不算已试过（这才是 c 的核心行为变化）', () => {
    // 反例：把 MAX_RELOAD_ATTEMPTS 改回 1 → 本条必红
    expect(MAX_RELOAD_ATTEMPTS).toBeGreaterThan(1);
    expect(isAlreadyTried(makeGuardAttempts(1, T), T)).toBe(false);
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

/**
 * `shouldResetGuardForBadCache` —— 坏缓存自愈时作废护栏（2026-10-29，问题 5）。
 *
 * ## 它解决的是一个"护栏挡住合法路径"的死锁
 *
 * ```
 * 第 1 轮  坏缓存 → hadSync=true → 不刷新（老 bug），但 guard 已被写（attempts=1）
 * 第 2 轮  坏缓存被识别 → 想刷 → alreadyTried=true → **拒绝**
 *         → reloadIssued: 0、duration 停在 180、没有任何提示
 * ```
 *
 * 真机证据：guard 的 `at` 比那次加载只早 **2.4 分钟**（TTL 10 分钟），
 * 是上一轮留下的、仍然有效，于是把这一轮合法的刷新挡掉了。
 *
 * `MAX_RELOAD_ATTEMPTS = 1` 隐含假设「刷过一次就应该好了」，
 * 而坏缓存恰恰打破它 —— 第 1 次刷的时候缓存是坏的，刷了也没用。
 *
 * ⚠️ 反例验证：把 `shouldResetGuardForBadCache` 改成恒返回 `false`，
 * 下面第 1 条必红。
 */
describe('shouldResetGuardForBadCache：作废护栏的唯一条件', () => {
  it('① 确实丢弃了坏缓存 → 作废护栏', () => {
    expect(shouldResetGuardForBadCache(true)).toBe(true);
  });

  it('② 没有丢弃坏缓存 → **不动**护栏（防削弱正常防循环）', () => {
    /**
     * 这条是最重要的约束。
     *
     * `hadSync === false` 有两种成因：
     *   1. `sessionStorage` 那份是坏的（该清）
     *   2. `storage.local` 有、`sessionStorage` 还没写过（**正常首访第二趟**，不该清）
     *
     * 第 2 种情况下护栏本来就是对的 —— 它防的是"那次刷新失败后反复刷"。
     * 无条件清护栏会让 `alreadyTried` 永远为 false → 取流失败时**无限刷新**。
     */
    expect(shouldResetGuardForBadCache(false)).toBe(false);
  });

  it('③ 严格布尔：真值不等于 true 都不算', () => {
    /**
     * 与 `set-proxy` 通道的严格布尔口径一致。
     * 传进来 `"true"` / `1` 这种，说明调用方写错了，**不要**顺势清护栏。
     */
    expect(shouldResetGuardForBadCache(true)).toBe(true);
    // @ts-expect-error 故意传字符串，验证严格比较不把 "true" 当真
    expect(shouldResetGuardForBadCache('true')).toBe(false);
    // @ts-expect-error 故意传数字 1，验证严格比较不把真值当 true
    expect(shouldResetGuardForBadCache(1)).toBe(false);
    // @ts-expect-error 故意传 undefined，验证缺参时不清护栏
    expect(shouldResetGuardForBadCache(undefined)).toBe(false);
  });
});

/**
 * 端到端：**坏缓存 → 作废护栏 → 允许刷新**这条链走通（2026-10-29）。
 *
 * ## 为什么要把三个函数串起来测
 *
 * 单测各自绿不代表合起来对。真机那个死锁正是"三个函数各自都对，但组合起来
 * 永远返回 false"：
 *
 * ```
 * isAlreadyTried(guard, now)        → true   （护栏有效，2.4 分钟前写的）
 * shouldReload({ alreadyTried })    → false  （被护栏挡住）
 * shouldResetGuardForBadCache(true) → ?      （本该作废护栏）
 * ```
 *
 * 这条把三步按真实顺序走一遍，断言"清完之后 shouldReload 就放行了"。
 */
describe('端到端：坏缓存作废护栏后，刷新得以发生', () => {
  const NOW = 1_793_277_792_545; // 真机 guard 的时间戳

  /**
   * ⚠️ 2026-10-30（ADR 0030 方案 c）：这里必须构造**刷满上限**的护栏，
   * 不能再写 `makeGuard()`。
   *
   * `makeGuard()` 是 `attempts: 1`，在上限从 1 提到 2 之后它**不再**表示
   * "已试过" —— 继续用它会变成"测了一个本来就没被挡的状态"，
   * 断言虽然改成期望 false 也能过，但**这个测试就失去意义了**。
   * 它本意守的是"满额 → 挡住 → 清掉 → 放行"这条链，所以要用满额构造。
   */
  const fullGuard = () => makeGuardAttempts(MAX_RELOAD_ATTEMPTS, NOW - 2.4 * 60 * 1000);

  it('作废前：护栏满额 → shouldReload 拒绝（这就是真机卡住的状态）', () => {
    const guard = fullGuard();
    const alreadyTried = isAlreadyTried(parseGuard(JSON.stringify(guard)), NOW);

    expect(alreadyTried).toBe(true);
    expect(shouldReload({ alreadyTried, hasStream: true })).toBe(false);
  });

  it('作废后：护栏清空 → shouldReload 放行', () => {
    // 模拟 sessionStorage.removeItem 之后的读取结果
    const afterRemoval = parseGuard(null);
    const alreadyTried = isAlreadyTried(afterRemoval, NOW);

    expect(alreadyTried).toBe(false);
    expect(shouldReload({ alreadyTried, hasStream: true })).toBe(true);
  });

  it('三步串起来：坏缓存 → 决定作废 → 刷新放行', () => {
    const guard = fullGuard();
    const droppedBadCache = true;

    // 1. 先看作废前的判定（真机卡在这里）
    const before = isAlreadyTried(parseGuard(JSON.stringify(guard)), NOW);
    expect(shouldReload({ alreadyTried: before, hasStream: true })).toBe(false);

    // 2. 作废决策
    const reset = shouldResetGuardForBadCache(droppedBadCache);
    expect(reset).toBe(true);

    // 3. 作废后重新判定
    const guardAfterReset = reset ? parseGuard(null) : parseGuard(JSON.stringify(guard));
    const after = isAlreadyTried(guardAfterReset, NOW);
    expect(shouldReload({ alreadyTried: after, hasStream: true })).toBe(true);
  });

  it('⚠️ 没丢弃坏缓存时：即使护栏过期也不额外放宽', () => {
    /**
     * 防过度修复的反面：正常路径（首访第二趟）不该因为"想做自愈"而放宽。
     * 护栏过期后本来就允许再试一次，那是既有语义，不由这个改动提供。
     */
    const guard = fullGuard();
    const reset = shouldResetGuardForBadCache(false);
    expect(reset).toBe(false);

    // 不作废 → 仍按原逻辑判定（护栏满额 → 拒绝）
    const alreadyTried = isAlreadyTried(parseGuard(JSON.stringify(guard)), NOW);
    expect(shouldReload({ alreadyTried, hasStream: true })).toBe(false);
  });
});

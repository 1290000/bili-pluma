/**
 * P2 的"取流 + 二次加载"编排 —— 纯逻辑与护栏，不含 DOM / chrome API 调用。
 *
 * ## 一次完整的两趟
 *
 * ```
 * 第一趟（无缓存）
 *   页面照常播试看
 *   → 取 /pgc/player/web/playurl（页面身份，DNR 已把 Cookie 换成播放账号）
 *   → 合并成 video_info → 写缓存
 *   → location.reload()
 *
 * 第二趟（缓存命中）
 *   __playinfo__ 被赋值那一刻，主世界同步把 video_info 换成完整集的
 *   → 播放器读到的就是 1440 秒
 * ```
 *
 * ## 为什么护栏必须在这里（而不是散在调用点）
 *
 * 这条链路最危险的失败模式是**刷新循环**：取流失败 → 还是没缓存 → 再取 → 再刷。
 * 用户会看到页面无限重载。所以"什么时候可以刷"必须是**一个纯函数**，能用测试钉死。
 *
 * 三条硬护栏：
 *   1. `sessionStorage` 一次性标记 —— 同一集本次会话只刷一次
 *   2. 取流失败 / 返回无流 → **不刷**
 *   3. 总开关关 / 未激活 → **不刷**
 */

/** 一次刷新尝试的记忆（按 cid） */
export interface ReloadGuard {
  /** 已经为这个 cid 刷过几次 */
  attempts: number;
  /** 记录时刻（用于兜底：超过一定时间就重置，避免用户换个手气回来还生效） */
  at: number;
}

/** 同一集在同一会话里最多刷一次 */
export const MAX_RELOAD_ATTEMPTS = 1;

/** 标记的存活时间：10 分钟。超过就算"新的一次尝试"（用户可能换了网络 / 权益续上了） */
export const GUARD_TTL_MS = 10 * 60 * 1000;

/** 存进 sessionStorage 的键前缀 */
export const GUARD_KEY_PREFIX = 'pluma:pgc-reload:';

/**
 * 决定"要不要为这一集刷一次页面"。
 *
 * ## ⚠️ `active` 不参与判定（2026-10-28 真机定位后改）
 *
 * 原来三条护栏是 `active && hasStream && !alreadyTried`。`active` 来自
 * `page/activate` 的异步回复（`badgeState.proxying`），而**那个回复可能晚到或失败**：
 *
 * 真机实测（ep3854815，清空缓存后首次进入）：
 * ```
 * pluma:pgc-vi:41806202889  → 写入成功（19 轨 dash，含 2160p）
 * pluma:pgc-reload:41806202889 → **从未写入**
 * video.duration → 180（试看），25 秒内不刷新
 * 页面角标 → 根本没画（说明 badgeState.proxying === false）
 * ```
 *
 * 结果：明明取到了完整流、缓存也写好了，却**永远停在第一趟的 180 秒试看**。
 * 而"试看状态"正是用户报的「切画质失败」的根源 —— 播放器没有完整 dash 管道，
 * 切 4K 找不到轨，静默失败。
 *
 * **`active` 在这里本来就是多余的**：能通过 `credentials: 'include'` 取到
 * **播放账号的** 4K dash，就证明 DNR 换 Cookie 已经生效了 —— 那是取流成功的前提。
 * 而总开关关掉时，DNR 规则不会装，取流也拿不到 4K（会 `denied` 或降级），
 * 那条路径由 `fetchPgcPlayurl` 的 `kind !== 'ok'` 提前拦住，轮不到这里。
 *
 * 所以正确判据只有两条：**有流** 且 **没刷过**。
 *
 * @param opts.alreadyTried 这个 cid 在本次会话里是否已经刷过一次
 * @param opts.hasStream    取流结果里是否真的有流（`hasPlayableStream` 的结论）
 * @returns `true` 表示应该刷新
 */
export function shouldReload(opts: { alreadyTried: boolean; hasStream: boolean }): boolean {
  if (!opts.hasStream) return false;
  if (opts.alreadyTried) return false;
  return true;
}

/**
 * 判断一条刷新标记是否还有效（未超过 `GUARD_TTL_MS`）。
 *
 * @param guard 读出来的标记，`null` 表示没有
 * @param now   时间戳（注入以便测试）
 */
export function isGuardFresh(guard: ReloadGuard | null, now: number): boolean {
  if (!guard) return false;
  if (typeof guard.at !== 'number') return false;
  if (typeof guard.attempts !== 'number') return false;
  return now - guard.at <= GUARD_TTL_MS;
}

/**
 * 这条标记是否说明"已经刷过了、别再刷"。
 *
 * 与 `isGuardFresh` 配合使用：过期的标记不算数（用户过 10 分钟回来可以再试一次）。
 */
export function isAlreadyTried(guard: ReloadGuard | null, now: number): boolean {
  if (!isGuardFresh(guard, now)) return false;
  return guard !== null && guard.attempts >= MAX_RELOAD_ATTEMPTS;
}

/**
 * 解析刷新标记。**永不抛错** —— `sessionStorage` 里可能是任何东西
 * （别的扩展写的、旧版本格式、被用户手动改过）。
 */
export function parseGuard(raw: string | null): ReloadGuard | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.attempts !== 'number' || typeof o.at !== 'number') return null;
    return { attempts: o.attempts, at: o.at };
  } catch {
    return null;
  }
}

/** 构造"已刷过一次"的标记，供写入 `sessionStorage` */
export function makeGuard(now: number): ReloadGuard {
  return { attempts: 1, at: now };
}

/**
 * 组装取流 URL。
 *
 * 参数集来自 2026-10-27 实测：**只要 cid 就能调通**，不需要 `ep_id`、不需要 WBI 签名
 * （`?cid=…&avid=0&qn=80&fnval=4048&fnver=0&fourk=1` → `code: 0`）。
 *
 * `qn=80` 不影响返回的轨道列表（实测），只决定默认选中档；`fnval=4048` 含 DASH + 4K + Dolby。
 */
export function buildPlayurlUrl(cid: string): string {
  return (
    'https://api.bilibili.com/pgc/player/web/playurl' +
    `?cid=${encodeURIComponent(cid)}&avid=0&qn=80&fnval=4048&fnver=0&fourk=1`
  );
}

/** 播放位置记忆的键前缀（刷新后恢复用） */
export const RESUME_KEY_PREFIX = 'pluma:pgc-resume:';

/** 恢复位置的最小秒数：太靠前就不用恢复，让播放器自己决定 */
export const RESUME_MIN_SECONDS = 15;

/**
 * 该不该恢复播放位置。
 *
 * @param saved 记下的秒数（可能不存在 / 非数字）
 * @param now   当前秒数
 * @returns 要恢复的目标秒数，`null` 表示不用恢复
 */
export function resumeTarget(saved: unknown, now: number): number | null {
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return null;
  if (saved < RESUME_MIN_SECONDS) return null;
  // 已经播过这个位置了（比如浏览器缓存的 bfcache），不用往回跳
  if (now >= saved) return null;
  return saved;
}

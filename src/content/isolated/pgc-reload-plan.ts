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

/**
 * 同一集在同一会话里最多刷几次（ADR 0030 方案 c：**2**）。
 *
 * ## 为什么从 1 提到 2
 *
 * 记 1 的语义是「刷过一次就够」，隐含假设「刷一次就会好」。但真机上存在
 * 「刷了但没成」的情况（第二趟注入失败 / 播放器没采用缓存），那时一次
 * 根本不够 —— 用户就静默卡在试看，最长等满 `GUARD_TTL_MS`。
 *
 * ## ⚠️ 它是**上限**，不是主判据
 *
 * 主判据是 `guardActionForOutcome()` 的**结果**：一旦观测到「已达目标」
 * （`injected` / `native-complete`），护栏立即清空，**与这个上限无关** ——
 * 成功的集数永远不会用到第 2 次。
 *
 * 这个上限只兜住「一直没成」的那条线：允许再试一次，然后停手。
 * 提到 2 而不更高，是因为每次重试都要用户看一次 1~2 秒的闪屏
 * （ADR 0030 §「c 的代价」，2026-10-30 用户拍板接受两次闪屏）。
 */
export const MAX_RELOAD_ATTEMPTS = 2;

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
 * 构造「已刷过第 n 次」的标记。
 *
 * ⚠️ `at` 每次刷新都更新：TTL 的含义是「距**最后一次**刷新多久」，不是「距第一次」。
 * 若沿用首次的 `at`，连刷两次也可能在第三次前刚好跨过 TTL，等于护栏自己松手。
 *
 * @param attempts 已经刷过几次（写入时 = 这一轮即将发生的刷新次数）
 * @param now 当前时刻
 */
export function makeGuardAttempts(attempts: number, now: number): ReloadGuard {
  return { attempts, at: now };
}

/**
 * 一轮页面加载**观测到的结果**（ADR 0030 方案 c 的输入）。
 *
 * ## 为什么把"结果"做成显式枚举而不是几个布尔
 *
 * 方案 c 的全部主张是「护栏该记结果，不该记次数」。若这里也传一堆
 * `boolean` 组合（`patched` / `truncated` / `cached`…），组合爆炸之后
 * 各种非法组合就只能靠调用方纪律保证 —— 那正是 a 方案的老毛病。
 * 收成 4 个**互斥**状态，每一态在表里有一行，缺一态编译不过。
 */
export type PgcRoundOutcome =
  /** 注入成功：这一轮的流**是我们注入的**（`pgcPatchedByUs === true`） */
  | 'injected'
  /** 本来就完整：SSR 自己就是完整流，不是我们注入的（免费集 / 已有权益 / 已到顶） */
  | 'native-complete'
  /** 仍是试看：SSR 截断，且没有可用缓存（这一轮没成功） */
  | 'still-truncated'
  /** 判不了：缺判据（`truncated` 未知 / 没有缓存信息）—— 不许当成失败 */
  | 'unknown';

/**
 * 这一轮观测结果下，护栏该怎么变（ADR 0030 方案 c）。
 *
 * ## 语义（一张表说完）
 *
 * | `outcome` | 含义 | 护栏动作 | 理由 |
 * | --- | --- | --- | --- |
 * | `injected` | 刷了且成功了 | **清掉** | 本集本会话已达目标，护栏再无意义 |
 * | `native-complete` | 本来就完整 | **清掉** | 同上（没有"达目标"的必要，也就不需要拦） |
 * | `still-truncated` | 刷了但没成功 | **保留**，允许再刷一次 | 这才是护栏该拦的：同一原因反复刷 |
 * | `unknown` | 判不了 | **保留**，但**不消耗**新的尝试 | 「判不了就放行」≠「判不了就清」 |
 *
 * ## `unknown` 为什么不清也不加
 *
 * 清掉 = 在判不了的情况下放开无限刷新（ADR 0020 的反面）。
 * 加一次 = 把"没观测到"当成"尝试过"，会让一次缺数据的加载白吃掉重试机会。
 * 所以维持原样：**没证据就不改变状态**。
 *
 * ## 与 `shouldReload()` 的关系
 *
 * 本函数只回答「护栏该怎么变」，**不回答「该不该刷」**。要不要刷仍看
 * `shouldReload({ alreadyTried })`，由调用方在本轮**开始**时问；
 * 本函数在**结束时**用观测结果更新护栏，供**下一轮**判断。
 * 两者分开是刻意的：a 方案的病根就是把"这次刷不刷"和"上次成没成"混在一个计数里。
 *
 * @param outcome 这一轮观测到的结果
 * @returns `'clear'` = 删掉护栏；`'keep'` = 不动；`'retry'` = 次数 +1（允许再刷一次）
 */
export function guardActionForOutcome(outcome: PgcRoundOutcome): 'clear' | 'keep' | 'retry' {
  switch (outcome) {
    case 'injected':
    case 'native-complete':
      return 'clear';
    case 'still-truncated':
      return 'retry';
    case 'unknown':
      return 'keep';
  }
}

/**
 * 这一轮观测结果是否已经「达到目标」（ADR 0030 方案 c 的判据）。
 *
 * 单独导出而不是让调用方自己判 `outcome === 'injected'`：
 * 「达目标」与「护栏怎么变」是两个概念，将来前者可能加状态（比如
 * 用户手动切到最高画质也算达成），而后者不该跟着变。
 */
export function isRoundSatisfied(outcome: PgcRoundOutcome): boolean {
  return outcome === 'injected' || outcome === 'native-complete';
}

/**
 * 这个刷新护栏该不该被**作废**（2026-10-29 加，问题 5 的「坏缓存自愈」）。
 *
 * ## 为什么护栏会挡住一条合法路径
 *
 * `MAX_RELOAD_ATTEMPTS = 1` 的语义是「**同一集本会话刷过一次就够**」，
 * 它隐含假设：**刷过一次就应该好了**。
 *
 * 但坏缓存的场景打破了这个假设：
 *
 * ```
 * 第 1 轮  坏缓存 → hadSync=true → 不刷新（老的 bug），但 guard 已被写
 * 第 2 轮  坏缓存被识别 → hadSync=false → **想刷** → alreadyTried=true → 拒绝
 *         → 停在 180 秒，且没有任何提示
 * ```
 *
 * 护栏数的是**次数**，它不知道第 1 次刷的时候缓存是坏的、所以刷了也没用。
 *
 * ## 判定规则
 *
 * **只有「刚丢弃了一份坏缓存」这一个事件**才作废护栏。理由：那个失效原因
 * （缓存内容坏）**已经被处理掉了**，下一次刷新是**不同原因**驱动的，
 * 理应允许。这与护栏的设计意图一致 —— 防的是"同一个原因反复刷"。
 *
 * ## ⚠️ 为什么不能顺手在 `hadSync === false` 时清
 *
 * `hadSync === false` 有两种成因：
 *   1. `sessionStorage` 那份是坏的（该清）
 *   2. `storage.local` 有、`sessionStorage` 还没写过（**正常首访第二趟**，不该清）
 *
 * 第 2 种情况下护栏本来就是对的（防止那次刷新失败后反复刷）。
 * 区分这两种，必须由调用方判断"是不是真的丢弃了坏数据"，不能靠这个函数猜。
 *
 * ## 为什么作废护栏不会打开"无限刷新"
 *
 * 因为 `shouldWritePgcCache()` 那道闸在刷新**之前**就 return 了：
 *
 * ```
 * 坏缓存 → 丢弃 → 作废护栏 → 取流
 *   ├─ 取到好流 → 写缓存 → reload → 第二趟 setter 有数据 → 注入成功（1 次刷新，结束）
 *   └─ 仍是试看 → shouldWritePgcCache=false → **return，不写也不刷** → 循环终止
 * ```
 *
 * 所以最坏情况是"用户每次手动刷新都多一次取流请求"，**不会自动循环**。
 *
 * @param droppedBadCache 调用方是否**确实**丢弃了一份截断流
 * @returns `true` 表示应当删掉这一集的 guard，让刷新得以发生
 */
export function shouldResetGuardForBadCache(droppedBadCache: boolean): boolean {
  return droppedBadCache === true;
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

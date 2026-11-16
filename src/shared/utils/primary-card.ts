/**
 * 主账号卡片的原料选择 —— **纯函数**，无 DOM / 无 chrome API。
 *
 * ## 为什么从 `entrypoints/popup/main.tsx` 里抽出来
 *
 * 这段逻辑决定「主账号栏显示什么」，是问题 2/3 的落点，也是**最容易再犯错的地方**
 * （它曾经因为一条"缓存不能在播放页兜底"的纪律而让两个真机 bug 长期存在）。
 * 放在 TSX 里等于没有测试 —— popup 组件依赖 `chrome.*` 与 Preact，跑不起来。
 *
 * 所以：**"该从哪读"是纯函数，"真去读"由调用方做**。
 * 判据有测试（`tests/unit/shared/primary-card.test.ts`），取数在 `main.tsx`。
 *
 * ## 两条纪律（改之前先读完）
 *
 * 1. **`loggedIn === 'no'` 时绝不读缓存。** 那是"确认未登录"（DOM 就绪后读不到
 *    `DedeUserID`）。此时显示缓存昵称 = 把游客说成"某个账号"，而那可能是上一个账号。
 * 2. **`unknown` 绝不渲染成"未登录"。** `unknown` 的语义是"还没读到"，
 *    把它说成"没登录"是在编结论 —— 而"刚进视频页就点 popup"正是最常见的路径。
 */

/** 主账号卡片的原料。`source` 只给自动化快照与测试用，展示层不体现 */
export interface PrimaryCard {
  uname: string | null;
  level: number | null;
  loggedIn: 'yes' | 'no' | 'unknown';
  source: 'live' | 'cached' | 'none';
}

/** 缓存的显示档案（`storage.local` 里的 `PrimaryProfile`，ADR 0025） */
export interface CachedProfile {
  uname: string;
  level: number | null;
}

/** 当前页视图。与 `popup/main.tsx` 的 `PageView` 同形状 */
export type CardPage = { kind: 'play'; primary: PlayPrimarySnapshot | null } | { kind: 'other' };

/** 播放页上 content 实时报来的主账号片段 */
export interface PlayPrimarySnapshot {
  uname: string | null;
  level: number | null;
  loggedIn: 'yes' | 'no' | 'unknown';
}

/**
 * 决定主账号卡片该显示什么。
 *
 * @param page    当前页（`kind: 'play'` 时带实时快照，可能为 `null` = 数据还没到）
 * @param cached  缓存里的显示档案（`null` = 没存过）
 * @returns 卡片原料。**永不抛错**，最差返回 `source: 'none'` 的全空值
 *
 * ## 分支表（少一条都会出 bug，见过两次）
 *
 * | 页 | 实时昵称 | `loggedIn` | 结果 | 出处 |
 * | --- | --- | --- | --- | --- |
 * | 播放页 | 有 | 任意 | 实时 | 正常路径 |
 * | 播放页 | 无 | `'no'` | **空 + `no`**，不读缓存 | 原纪律，防"游客显示成别人" |
 * | 播放页 | 无 | `'unknown'` | 缓存兜底 | 修问题 3（刚进页面 1.5s 内） |
 * | 播放页 | 无 | `'yes'` | 缓存兜底 | 修问题 2（番剧页无 `__INITIAL_STATE__`） |
 * | 非播放页 | —— | —— | 缓存（`loggedIn` 记 `'yes'`） | 无 content script，ADR 0025 |
 */
export function resolvePrimaryCard(page: CardPage, cached: CachedProfile | null): PrimaryCard {
  if (page.kind === 'play') {
    const info = page.primary;
    const loggedIn: PrimaryCard['loggedIn'] = info?.loggedIn ?? 'unknown';
    const liveUname = info?.uname || null;

    if (liveUname) {
      return { uname: liveUname, level: info?.level ?? null, loggedIn, source: 'live' };
    }

    // ⚠️ 纪律 1：确认未登录时不读缓存。删了这一条就会把游客显示成别人。
    if (loggedIn === 'no') {
      return { uname: null, level: null, loggedIn: 'no', source: 'none' };
    }

    // `unknown`（数据没到）/ `yes`（登录了但页面没给昵称）→ 缓存兜底
    if (cached) {
      return { uname: cached.uname, level: cached.level, loggedIn, source: 'cached' };
    }
    return { uname: null, level: null, loggedIn, source: 'none' };
  }

  /**
   * 非播放页：只读缓存。
   *
   * `loggedIn` 记 `'yes'` —— 能存下这份档案说明**存的那一刻**读到了
   * `DedeUserID`（`savePrimaryProfile()` 的签名强制要求）。
   * 这是它对"当前是否登录"的全部保证：**过去登录过**。
   * 所以文案不能说"已登录"，只能说昵称。
   */
  if (!cached) return { uname: null, level: null, loggedIn: 'unknown', source: 'none' };
  return { uname: cached.uname, level: cached.level, loggedIn: 'yes', source: 'cached' };
}

/**
 * 播放页拿到**实时**主账号时，用它压过缓存结果。
 *
 * ## 为什么必须有这一步（2026-11-16，用户报的真机问题）
 *
 * 现象：在播放页退出取流账号后，主账号卡一直显示「读取中…」，
 * **必须刷新整个页面**才恢复。
 *
 * 根因是两条各自都成立的规则撞在一起：
 *  1. `account/remove` 会 `clearPrimaryProfile()`（理由：用户点"退出"的心理预期是
 *     "不用这个扩展了"，还留着他的昵称说不通）
 *  2. 面板的 `readPrimary()` **只读缓存**，实时值传的是 `null`
 *     （原注释说"实时覆盖在模型重取时由 panel-data 自己拼"—— 而 `buildPanelModel`
 *     当时是直接把入参 `primary` 赋给 `account.primary`，**那句拼接根本不存在**）
 *
 * 于是缓存一清，A 卡就退到 `loggedIn: 'unknown'` → 「读取中…」；
 * 而缓存的唯一写入方是"播放页加载时保存档案"，所以只有刷新页面才能重新填上。
 *
 * ## 判据
 *
 * - `live.user.uname` 有值 → 实时优先。这比缓存**更新**，也能修"缓存过期 7 天"
 *   在播放页仍显示旧昵称的问题
 * - 没有 live → **保持原样**，不推断成「未登录」：`user` 为 null 也可能只是数据没到
 *
 * @param primary 已由缓存 / 调用方算好的卡片
 * @param live    播放页 `pageView.primary.user`；非播放页传 `null`。
 *                这里只要求 `uname` / `level` 两个字段 —— 不引 `PrimaryUser`
 *                是为了让本文件继续保持"零依赖共享层"（与 `PlayPrimarySnapshot`
 *                本地声明同一个理由）。
 */
export function withLivePrimaryUser(
  primary: PrimaryCard,
  live: { uname: string; level: number | null } | null | undefined,
): PrimaryCard {
  if (!live?.uname) return primary;
  /**
   * `loggedIn` 记 `'yes'` 不是编数据：`user` 里能读到昵称，说明那一刻页面
   * 就是从登录态渲染出来的。读不到昵称的情况走上面的早退，不会到这。
   */
  return { uname: live.uname, level: live.level ?? null, loggedIn: 'yes', source: 'live' };
}

/**
 * 主账号栏在**没有昵称**时该写什么。
 *
 * ## 为什么不能一律写「打开视频页后可见」
 *
 * 那句话只在**非播放页**成立。在播放页上写它是**错的**：用户明明已经在视频页，
 * 却被告知"打开视频页后可见"，读起来像功能坏了 —— 这正是问题 2 的表现之一。
 *
 * ⚠️ 纪律 2：**播放页 + `unknown` 必须写「读取中…」，绝不能写"未登录"。**
 *
 * @param kind      当前页类型
 * @param loggedIn  主账号登录三态
 */
export function primaryPlaceholder(
  kind: 'play' | 'other',
  loggedIn: PrimaryCard['loggedIn'],
): string {
  if (loggedIn === 'no') return '未登录';
  if (kind === 'play') return '读取中…';
  return '打开视频页后可见';
}

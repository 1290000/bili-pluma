/**
 * Popup 的状态判定 —— 纯函数，零 UI、零 chrome API。
 *
 * ## 为什么抽出来
 *
 * "该显示哪种状态"是本项目**最容易错**的一块 UI 逻辑：
 * 判错顺序会让 popup 骗人（比如开关坏着却显示"已接管"）。
 * 埋在 TSX 里就只能靠肉眼看，抽到 `core/` 才能用 Vitest 覆盖。
 *
 * 依赖方向：`entrypoints/popup` → `core/`，符合分层（见 AGENTS.md §5.1）。
 */

import type { StatBucket } from '@shared/types/stats';

/** 与 `messages.ts` 的 `account/summary:ok` 对齐的最小视图 */
export interface PopupAccount {
  uname: string;
  mid: number;
  vipLabel: 'none' | 'monthly' | 'annual';
  expireAt: number | null;
  healthy: boolean;
  checkedAt: number;
  reason: string | null;
}

/** popup 需要的全部输入 */
export interface PopupSnapshot {
  proxy: { enabled: boolean; hasCredential: boolean; ruleCount: number };
  configured: boolean;
  account: PopupAccount | null;
  /** 12 个时间窗的原始统计。用于算样本数与成功率 */
  buckets: StatBucket[];
  /**
   * 当前标签页是不是**受支持的播放页**（普通视频 / 番剧 / 国创 / 电影）。
   *
   * popup 自己没有页面上下文，判断不了 —— 由 `entrypoints/popup/main.tsx`
   * 查活动标签页后填入。规范里的「状态 5：非播放页」就靠它。
   *
   * ⚠️ 值叫 `play` 而不是 `video`：判据是 `parsePlayPage()`（`shared/utils/video-page.ts`），
   * 它同时认 `/video/BV…` 与 `/bangumi/play/ep…`。曾经叫 `video` 且判据写死 `/video/`，
   * 结果**番剧页 popup 一律显示「未生效」**，而那时 PGC 代理正在正常工作
   * （2026-10-28 审查发现）。
   */
  page: { kind: 'play' } | { kind: 'other' };
}

export type PopupTone = 'neutral' | 'good' | 'warn' | 'bad';

export type PopupState =
  | 'not-configured'
  | 'credential-missing'
  | 'expired'
  | 'stopped'
  | 'not-video'
  | 'inconsistent'
  | 'degraded'
  | 'active';

export interface PopupView {
  state: PopupState;
  pill: string;
  tone: PopupTone;
  line: string;
  /** 是否该把主按钮换成"扫码登录" */
  needsLogin: boolean;
}

/**
 * "已降级"的成功率阈值。
 *
 * 为什么是 0.6：playurl 一次失败通常就意味着这个页面的画质没提上去，
 * 用户体感上"一半以上失败"已经很明显。定太低会因网络抖动频繁误报；
 * 定太高（0.9）则几乎永远触发不了。
 */
export const DEGRADED_RATE = 0.6;

/**
 * 样本数下限。
 *
 * 2 个请求全成功不该说"100% 正常"，1 个失败也不该说"50% 崩了"。
 * 少于这个数时**不下降级结论**——宁可不说，也不能说错。
 */
export const MIN_SAMPLES = 3;

export function countSamples(buckets: readonly StatBucket[]): number {
  return buckets.reduce((n, b) => n + b.ok + b.fail, 0);
}

/**
 * 算成功率。样本不足或没有样本时返回 null。
 *
 * **null 与 0 是两个意思**：null = 不知道，0 = 全失败。
 * UI 必须区别对待，否则"刚装上还没用过"会被画成"全部失败"。
 */
export function sampleRate(buckets: readonly StatBucket[]): number | null {
  const total = countSamples(buckets);
  if (total < MIN_SAMPLES) return null;
  const ok = buckets.reduce((n, b) => n + b.ok, 0);
  return ok / total;
}

/**
 * 判定该显示哪种状态。
 *
 * ## 顺序不能调换
 *
 * 每一条都在挡掉后面那条的误判：
 *
 *   1. **未配置** —— 此时开关状态无关，没有凭据就没有规则
 *   2. **读取失败**（已配置但拿不到资料）—— 不能显示成"未配置"，
 *      否则会引导用户去扫一个已经存在的账号
 *   3. **凭据失效** —— 必须排在"已接管"前面，否则用户以为在生效
 *   4. **已停用** —— 用户主动关的，**不是故障**，不能报警
 *   5. **未生效**（当前页不是视频页）—— 能解释结果，但不如用户自己的操作直接
 *   6. **不一致** —— 开关开着但 0 条规则
 *   7. **已降级** —— 成功率低
 *   8. **已接管**
 *
 * 第 4 条排在降级前面很关键：用户自己关掉的，成功率低是预期结果，
 * 不该跳出来说"代理有问题"。
 */
export function describePopup(snap: PopupSnapshot): PopupView {
  const { proxy, configured, account, buckets, page } = snap;

  /**
   * 「未生效」：有播放账号、开关开着，但当前页不是视频页。
   *
   * 排序依据（02-ui-spec §3）：**能解释当前结果的状态优先**。
   *   - 用户自己关掉开关（已停用）> 当前页不对（未生效）
   *   - 凭据失效 > 未生效 ？反过来：用户在首页时，"凭据失效"要他去重扫，
   *     而他此刻并不在看视频，扫完也没得看。所以未生效排在凭据校验之前。
   */
  const notVideo = (): PopupView => ({
    state: 'not-video',
    pill: '未生效',
    tone: 'neutral',
    line: '当前页不是视频页，打开任意视频查看效果',
    needsLogin: false,
  });

  if (!configured) {
    return {
      state: 'not-configured',
      pill: '未配置',
      tone: 'neutral',
      line: '还没配置播放账号',
      needsLogin: true,
    };
  }

  /**
   * ## `account === null` 不再直接判"凭据失效"
   *
   * 这是踩过的坑。`account` 为 null 的真实原因有两种：
   *
   *   1. 凭据真的坏了（读不出 / 已失效）
   *   2. **探活这条路走不通**，但凭据其实是好的
   *
   * 第二种很常见：探活要发 `nav` 请求，而请求可能因为分区不对、网络、
   * 风控而不确定。这时如果直接报"凭据失效"，用户会看到
   * **"画质明明是 4K，popup 却说凭据失效"** —— 比不提示更让人困惑。
   *
   * 判据改成看**规则有没有装上**：DNR 规则在 → 代理在正常工作 → 不该报警。
   * 规则不在 → 才是真的没起来，需要重新配置。
   */
  if (!account) {
    /**
     * ## 判断顺序：`hasCredential` 优先于 `ruleCount`
     *
     * 踩过的 bug：第一次点扩展图标总是提示"凭据失效，需要重新扫码"，
     * 再点一次就正常显示"已接管"。
     *
     * 原因是首次打开时 `account/summary` 还在探测中（`nav` 请求要往返），
     * 返回 `account: null`；而当时若用户不在视频页，`ruleCount` 也恰好是 0。
     * 旧逻辑只看 `ruleCount > 0`，于是走进"凭据失效"。
     *
     * 但 `proxy.hasCredential` 来自 `storage.local` 里**密文是否存在**，
     * 是同步可读、不依赖网络的**硬证据**。它说有，就一定有。
     *
     * 所以：**凭据在 → 不报警**。拿不到资料只是"暂时不知道是谁"，
     * 不是"需要重新扫码"。
     */
    if (proxy.hasCredential) {
      // 有凭据但不在播放页 → 说「未生效」比说「已接管」诚实
      if (page.kind !== 'play') return notVideo();
      return {
        state: 'active',
        pill: '已接管',
        tone: 'good',
        line: proxy.enabled ? '取流已由播放账号接管' : '凭据已配置，但代理处于停用状态',
        needsLogin: false,
      };
    }
    return {
      state: 'credential-missing',
      pill: '凭据失效',
      tone: 'bad',
      line: '播放账号凭据读取失败，需要重新扫码',
      needsLogin: true,
    };
  }

  /**
   * ⚠️ 「已停用」必须排在**健康检查之前**。
   *
   * 用户自己把开关关掉时，那是当下最能解释"为什么没 4K"的事实。
   * 如果先报"凭据失效"，用户会去重扫一个本来好用的号，
   * 扫完发现还是没画质——因为开关压根没开。这是纯粹的误导。
   *
   * 顺序原则：**能解释当前结果的状态优先**，与用户操作相关的优先于与后台校验相关的。
   */
  if (!proxy.enabled) {
    return {
      state: 'stopped',
      pill: '已停用',
      tone: 'neutral',
      line: '当前使用主账号画质',
      needsLogin: false,
    };
  }

  /**
   * 顺序说明：**已停用 > 未生效 > 凭据校验**。
   *
   * 用户自己关掉开关时，那是当下最能解释"为什么没 4K"的事实（02-ui-spec §3 状态 6）；
   * 排在它后面的是"当前页不对"——同样能解释，但与用户操作无关；
   * 再往后才是后台校验（凭据失效 / 异常 / 降级）。
   */
  if (page.kind !== 'play') return notVideo();

  if (!account.healthy) {
    /**
     * `healthy: false` 有两种来源，必须区别对待：
     *
     *   1. **明确失效**（reason 含 `-101`）→ 凭据真的坏了，必须让用户重扫
     *   2. **探测不确定**（网络 / 分区不对 / 风控）→ 只是"确认不了"，
     *      不该让用户去重扫一个本来好用的账号
     *
     * 判据：`reason` 里出现 `-101` 才算第 1 种。
     * `core/auth/account-info.ts` 里 `judgeNav` 对 `-101` 生成的 reason
     * 固定是「账号未登录（-101）」，这里按这个特征匹配。
     *
     * 此外，只要 DNR 规则还在、开关还开着，实际取流就是正常的——
     * 那种情况下即使探测失败也不该报警（用户能播 4K 却被告知要重扫，最误导）。
     */
    const definitivelyExpired =
      typeof account.reason === 'string' && account.reason.includes('-101');
    const proxyWorking = proxy.enabled && proxy.ruleCount > 0;

    if (definitivelyExpired && !proxyWorking) {
      return {
        state: 'expired',
        pill: '凭据失效',
        tone: 'bad',
        line: account.reason ? `播放账号登录已过期（${account.reason}）` : '播放账号登录已过期',
        needsLogin: true,
      };
    }

    return {
      state: 'active',
      pill: '已接管',
      tone: 'good',
      line: '取流已由播放账号接管（凭据校验未通过，但代理仍在工作）',
      needsLogin: false,
    };
  }

  /**
   * `ruleCount === 0` 才是"确认没规则"的不一致状态。
   *
   * `-1` 表示**读不到**规则列表（background 侧 API 抛错），
   * 那是"不知道"，不能报成异常——否则用户会去关开一次开关试图修复，
   * 而实际什么都没坏。
   */
  if (proxy.ruleCount === 0) {
    return {
      state: 'inconsistent',
      pill: '异常',
      tone: 'bad',
      line: '开关开着但规则没装上，请关闭再开启一次',
      needsLogin: false,
    };
  }

  const rate = sampleRate(buckets);
  if (rate !== null && rate < DEGRADED_RATE) {
    return {
      state: 'degraded',
      pill: '已降级',
      tone: 'warn',
      line: `代理正常但取流常失败（成功率 ${String(Math.round(rate * 100))}%），视频仍可正常播放`,
      needsLogin: false,
    };
  }

  return {
    state: 'active',
    pill: '已接管',
    tone: 'good',
    line: '取流已由播放账号接管',
    needsLogin: false,
  };
}

/**
 * 会员到期日的相对描述。
 *
 * 用相对时间而不是绝对日期：用户看 popup 时想的是"要不要续费"，
 * 不是"2026-11-30 是周几"。
 *
 * ⚠️ 用 `floor` 不是 `ceil`。踩过：`ceil` 会把"还有 1 小时"算成
 * "1 天后到期"，把"还剩 1 天零 1 分钟"显示成"2 天后"——
 * 到期提醒宁可保守（显得更紧急），也不能往后拖。
 */
export function describeExpiry(expireAt: number | null, now: number): string {
  if (!expireAt) return '';
  const ms = expireAt - now;
  if (ms <= 0) return '已过期';

  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return '今天到期';
  if (days <= 30) return `${String(days)} 天后到期`;
  /**
   * 超过一年就用"年"。
   *
   * 不加这一档的话，一个 3 年期的会员会显示"36 个月后到期"；
   * 更糟的是**单位算错时**会显示"698197 个月后到期"——
   * 那种数字没人读得懂，也就没人发现它是 bug（2026-10-26 真实发生）。
   */
  if (days > 365) return `${String(Math.floor(days / 365))} 年后到期`;
  return `${String(Math.floor(days / 30))} 个月后到期`;
}

/** 会员类型 + 到期日，拼成账号卡片第二行 */
export function describeVip(
  account: Pick<PopupAccount, 'vipLabel' | 'expireAt'>,
  now: number,
): string {
  const base =
    account.vipLabel === 'annual'
      ? '年度大会员'
      : account.vipLabel === 'monthly'
        ? '大会员'
        : '非会员';
  const exp = describeExpiry(account.expireAt, now);
  return exp ? `${base} · ${exp}` : base;
}

/**
 * 检查闸门 —— 「什么时候该自动去问一次有没有新版本」。
 *
 * 三个输入决定一件事：**开关、间隔、上次检查时间**。这里刻意不碰 storage、
 * 不碰网络，只做判断，这样它能被穷举测。
 *
 * ## 为什么 `autoEnabled` 必须先判
 *
 * 如果先算间隔、再判开关，那么"关掉开关后的第一次加载"仍然会发请求
 * （因为间隔早就过了），开关就成了摆设。这类顺序 bug 不会报错，只会让用户
 * 觉得"我明明关了它还在联网"。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CheckGateInput {
  /** 当前时间（毫秒时间戳） */
  now: number;
  /** 上次自动检查完成的时间；从未检查过传 `null` */
  lastCheckAt: number | null;
  /** 间隔天数，**必须 ≥ 1**；非整数按向下取整 */
  intervalDays: number;
  /** 面板上的「自动检查」开关 */
  autoEnabled: boolean;
}

/** 间隔天数归一化。非法值直接抛错 —— 静默钳制会把"配置写错了"藏起来。 */
export function normalizeIntervalDays(intervalDays: number): number {
  if (!Number.isFinite(intervalDays) || intervalDays < 1) {
    throw new Error(`检查间隔必须是 ≥1 的有限数字，收到：${String(intervalDays)}`);
  }
  return Math.floor(intervalDays);
}

/**
 * 该不该自动检查。
 *
 * 判据顺序（**不许调换**）：开关 → 从未查过 → 时钟回拨 → 间隔是否已过。
 */
export function shouldCheck(input: CheckGateInput): boolean {
  // 1) 开关关掉：一次网络请求都不许发
  if (!input.autoEnabled) return false;

  const intervalDays = normalizeIntervalDays(input.intervalDays);

  // 2) 从没查过：第一次加载就该查
  if (input.lastCheckAt === null) return true;

  // 3) 时钟回拨（用户改系统时间 / NTP 校正）：按"该查"处理。
  //    否则 lastCheckAt 在未来会让闸门永久关闭，用户再也收不到更新提示。
  if (input.now < input.lastCheckAt) return true;

  // 4) 间隔已过
  return input.now - input.lastCheckAt >= intervalDays * MS_PER_DAY;
}

/** 下一次自动检查最早发生在什么时候。给 UI 显示"下次检查"用。 */
export function nextCheckAt(
  lastCheckAt: number | null,
  intervalDays: number,
  from: number,
): number {
  const interval = normalizeIntervalDays(intervalDays) * MS_PER_DAY;
  if (lastCheckAt === null) return from;
  // 已经过点（lastCheckAt + 间隔 < now）⇒ 下一次机会就是"现在"，不是"现在再加一个间隔"
  return Math.max(lastCheckAt + interval, from);
}

/**
 * 手动「检查更新」是否可用。
 *
 * 手动检查**不受 `autoEnabled` 影响**（关掉自动也允许手动），只受冷却限制 ——
 * 冷却纯粹是为了保护未认证的 60 次/小时配额。
 */
export function canManualCheck(
  lastManualCheckAt: number | null,
  now: number,
  cooldownMs: number,
): boolean {
  if (lastManualCheckAt === null) return true;
  if (now < lastManualCheckAt) return true;
  return now - lastManualCheckAt >= cooldownMs;
}

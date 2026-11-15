/**
 * 自动更新的状态形状与纯转换 —— **这里不读写 storage**，存取在 `platform/`。
 *
 * 为什么单独拆出来：state 会被三处同时改（SW 启动、面板操作、更新窗口），
 * 如果每处各自 `set({...})` 拼对象，`exactOptionalPropertyTypes` 帮不了你，
 * 迟早出现"某处漏写字段把它清成 undefined"。所以所有变更都走这里的函数。
 */

import { isNewer } from '@core/update/version';

/** 更新流程所处的阶段。`dismissed` 是"有新版本但用户把提示条关了"。 */
export type UpdatePhase =
  'idle' | 'available' | 'dismissed' | 'downloading' | 'writing' | 'pending-reload' | 'failed';

export interface LatestRelease {
  /** 已剥掉 `v` 前缀，形如 `1.2.0` */
  version: string;
  /** `pluma-<version>.zip` 的下载地址 */
  zipUrl: string;
  sizeBytes: number;
  /** 发布时间（ISO 字符串，原样来自 API） */
  publishedAt: string;
}

/** 已经 reload、但**尚未确认**是否真的生效的那一次更新。 */
export interface PendingUpdate {
  from: string;
  to: string;
  at: number;
}

export interface UpdateState {
  /** 面板「自动检查」开关。**只**影响自动发起检查，不影响手动。 */
  autoCheckEnabled: boolean;
  /** 自动检查间隔（天）。默认 1。 */
  intervalDays: number;
  /** 上次**成功**完成检查的时间。失败不更新，见 plan §5 的限流处理。 */
  lastCheckAt: number | null;
  /** 上次手动检查时间，只用于冷却。 */
  lastManualCheckAt: number | null;
  /** 条件请求用的 ETag，省配额。 */
  etag: string | null;
  /** 最近一次拿到的正式版信息。 */
  latest: LatestRelease | null;
  /** 用户点过「×」的那个版本。只压提示，不改变"有新版本"这个事实。 */
  dismissedVersion: string | null;
  /** reload 前后对不上的时候要靠它报"目录选错了"。 */
  pendingUpdate: PendingUpdate | null;
  /** 上一次成功生效的版本，用于开面板时提示"已更新到 vX"。 */
  lastAppliedVersion: string | null;
}

export const DEFAULT_UPDATE_STATE: UpdateState = {
  autoCheckEnabled: true,
  intervalDays: 1,
  lastCheckAt: null,
  lastManualCheckAt: null,
  etag: null,
  latest: null,
  dismissedVersion: null,
  pendingUpdate: null,
  lastAppliedVersion: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numOr(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseLatest(value: unknown): LatestRelease | null {
  if (!isRecord(value)) return null;
  const version = strOrNull(value.version);
  const zipUrl = strOrNull(value.zipUrl);
  if (!version || !zipUrl) return null;
  return {
    version,
    zipUrl,
    sizeBytes: numOr(value.sizeBytes, 0, 0),
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : '',
  };
}

function parsePending(value: unknown): PendingUpdate | null {
  if (!isRecord(value)) return null;
  const from = strOrNull(value.from);
  const to = strOrNull(value.to);
  if (!from || !to) return null;
  return { from, to, at: numOr(value.at, 0, 0) };
}

/**
 * 从 storage 里读出来的东西**一律不可信**（可能是上一个版本写的、可能被手改）。
 * 任何字段不合法就退回默认值，绝不让坏数据把整个更新流程卡死。
 */
export function normalizeUpdateState(raw: unknown): UpdateState {
  if (!isRecord(raw)) return { ...DEFAULT_UPDATE_STATE };
  return {
    autoCheckEnabled: typeof raw.autoCheckEnabled === 'boolean' ? raw.autoCheckEnabled : true,
    intervalDays: Math.floor(numOr(raw.intervalDays, DEFAULT_UPDATE_STATE.intervalDays, 1)),
    lastCheckAt: numOrNull(raw.lastCheckAt),
    lastManualCheckAt: numOrNull(raw.lastManualCheckAt),
    etag: strOrNull(raw.etag),
    latest: parseLatest(raw.latest),
    dismissedVersion: strOrNull(raw.dismissedVersion),
    pendingUpdate: parsePending(raw.pendingUpdate),
    lastAppliedVersion: strOrNull(raw.lastAppliedVersion),
  };
}

/** 是否存在"比当前版本新"的正式版。**与提示是否显示无关**。 */
export function isUpdateAvailable(state: UpdateState, currentVersion: string): boolean {
  if (!state.latest) return false;
  try {
    return isNewer(state.latest.version, currentVersion);
  } catch {
    // 版本号解析不了 ⇒ 当作"没有更新"。宁可漏提示，也不要在 UI 上显示一个乱码版本号。
    return false;
  }
}

/** 当前该不该**主动提示**（红点 / 提示条）。用户关掉的那一版不再提示。 */
export function shouldPrompt(state: UpdateState, currentVersion: string): boolean {
  if (!isUpdateAvailable(state, currentVersion)) return false;
  return state.dismissedVersion !== state.latest?.version;
}

/** 记录一次检查结果。`lastCheckAt` 只在**成功**时由调用方传进来。 */
export function withCheckResult(
  state: UpdateState,
  result: { at: number; etag: string | null; latest: LatestRelease | null },
): UpdateState {
  return {
    ...state,
    lastCheckAt: result.at,
    etag: result.etag,
    latest: result.latest,
  };
}

/** 检查失败（网络 / 限流）时**不动 `lastCheckAt`**，只记手动冷却。 */
export function withFailedCheck(state: UpdateState, at: number, manual: boolean): UpdateState {
  return manual ? { ...state, lastManualCheckAt: at } : state;
}

export function withDismissed(state: UpdateState, version: string): UpdateState {
  return { ...state, dismissedVersion: version };
}

export function withAutoCheck(state: UpdateState, enabled: boolean): UpdateState {
  return { ...state, autoCheckEnabled: enabled };
}

/**
 * 切换自动检查开关。
 *
 * ⚠️ **不清 `lastCheckAt`**：重新打开开关时如果间隔已经过了，下一次加载会立刻补查一次
 * （用户刚打开开关就是想让它工作）。这一点有单测钉住。
 */
export function withIntervalDays(state: UpdateState, days: number): UpdateState {
  return { ...state, intervalDays: Math.max(1, Math.floor(days)) };
}

export function withPendingUpdate(state: UpdateState, pending: PendingUpdate): UpdateState {
  return { ...state, pendingUpdate: pending };
}

export function withApplied(state: UpdateState, version: string): UpdateState {
  return { ...state, pendingUpdate: null, lastAppliedVersion: version };
}

/** 用于 UI 文案的三态。**不要让调用方自己拼**。 */
export function resolvePhase(state: UpdateState, currentVersion: string): UpdatePhase {
  if (state.pendingUpdate) return 'pending-reload';
  if (!isUpdateAvailable(state, currentVersion)) return 'idle';
  return state.dismissedVersion === state.latest?.version ? 'dismissed' : 'available';
}

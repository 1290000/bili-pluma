/**
 * 自动更新的状态形状与纯转换 —— **这里不读写 storage**，存取在 `platform/`。
 *
 * 为什么单独拆出来：state 会被三处同时改（SW 启动、面板操作、更新窗口），
 * 如果每处各自 `set({...})` 拼对象，`exactOptionalPropertyTypes` 帮不了你，
 * 迟早出现"某处漏写字段把它清成 undefined"。所以所有变更都走这里的函数。
 */

import { isNewer } from '@core/update/version';
import type { UpdatePhase, UpdateStatusView } from '@shared/types/update';

/**
 * 阶段枚举**定义在 `shared/types/update.ts`**，这里只转出一次。
 *
 * 理由：它是发给 UI 的 DTO 字段，而 `shared` 不能 import `core`（方向反了）。
 * 放在 shared + core 反向引用，比两边各写一份 union 安全 —— 后者加值只改一处时
 * 不会报错，只会让某处 switch 静默落进 default。
 */
export type { UpdatePhase };

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

/**
 * 一次**没生效**的更新。
 *
 * 判定方式只有一条：reload 之后 SW 启动时，`getManifest().version` 还是旧值。
 * 这说明写进去的文件没有被加载 —— 最常见的原因是**用户选错了目录**
 * （写进了 Downloads 里的旧解压目录，而不是当前加载的那个）。
 *
 * 不记这条的话，用户会看到"更新完成"然后发现版本没变，且毫无线索。
 */
export interface FailedUpdate {
  /** 本该变成的版本 */
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
  /** 上一次 reload 后没生效的更新（多半是目录选错了） */
  lastFailedUpdate: FailedUpdate | null;
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
  lastFailedUpdate: null,
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

function parseFailed(value: unknown): FailedUpdate | null {
  if (!isRecord(value)) return null;
  const to = strOrNull(value.to);
  if (!to) return null;
  return { to, at: numOr(value.at, 0, 0) };
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
    lastFailedUpdate: parseFailed(raw.lastFailedUpdate),
  };
}

/**
 * 「线上版本是否比当前**新**」—— **全仓唯一判据**。
 *
 * ## 为什么需要这个包装（2026-11-17 真机 bug 的直接原因）
 *
 * 面板和更新窗口曾经各自写 `latest !== currentVersion` 来判断"有没有更新"。
 * 那是**字符串不等**，不是"更新"：本地跑 1.2.0、线上最新 1.1.0（用户装了
 * 更新的包，但还没发布）时，`'1.1.0' !== '1.2.0'` 为真 ⇒ 界面上半部分报
 * **「有新版本」**，下半部分用 `phase`（走 `isNewer`，正确）却把按钮**禁用** ——
 * 同一个面板自相矛盾。更新窗口更糟：它会让「立即更新」可点，等于允许**降级安装**。
 *
 * 所以判据只能有一处：`isNewer`（逐段数字比较）。这个函数再补两件事：
 *
 * 1. `latest === null`（没查过 / 没拿到）⇒ `false`。调用方**不必**先判空。
 * 2. `isNewer` 在版本号解析不了时会抛 —— 在这里吞掉，统一成 `false`。
 *    否则每个调用方都要自己写 try/catch，迟早有人漏写，然后一个乱码版本号
 *    把面板整块炸掉。
 *
 * ⚠️ **`false` 的含义是"没有可装的更新"，不是"已是最新"**。
 * 这两件事在 UI 上必须分开：`latest === null` 是"根本没比过"，
 * 不能拿 `false` 去显示「已是最新」（那是谎报）。
 *
 * @param latest 线上最新正式版（`UpdateStatusView.latestVersion`），没查到传 `null`
 * @param current 当前安装的版本
 */
export function isNewerThan(latest: string | null, current: string): boolean {
  if (latest === null) return false;
  try {
    return isNewer(latest, current);
  } catch {
    // 版本号解析不了 ⇒ 当作"没有更新"。宁可漏提示，也不要在 UI 上显示一个乱码版本号。
    return false;
  }
}

/**
 * 是否存在"比当前版本新"的正式版。**与提示是否显示无关**。
 *
 * 只是 `isNewerThan` 的 state 版包装 —— 判据与 try/catch **不在这里重复**，
 * 否则两条路会以不同的方式漂移。
 */
export function isUpdateAvailable(state: UpdateState, currentVersion: string): boolean {
  return isNewerThan(state.latest?.version ?? null, currentVersion);
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

/**
 * `304 Not Modified`：这是一次**成功**的检查。
 *
 * `lastCheckAt` 必须推进 —— 否则下一次加载会立刻再发一次条件请求，
 * "每天查一次"就退化成"每次打开都查一次"。
 */
export function withNoChange(
  state: UpdateState,
  result: { at: number; etag: string | null },
): UpdateState {
  return { ...state, lastCheckAt: result.at, etag: result.etag ?? state.etag };
}

/** 只记手动检查时间（用于冷却），不碰其他字段。 */
export function withManualCheckAt(state: UpdateState, at: number): UpdateState {
  return { ...state, lastManualCheckAt: at };
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
  return { ...state, pendingUpdate: null, lastAppliedVersion: version, lastFailedUpdate: null };
}

/**
 * reload 后版本没变 ⇒ 这次更新**没生效**。
 *
 * 清掉 `pendingUpdate`（重试已经结束，答案就是"没成"），留下 `lastFailedUpdate`
 * 让面板能说人话。不许静默 —— 用户为这件事点过一次目录授权。
 */
export function withFailedUpdate(state: UpdateState, failed: FailedUpdate): UpdateState {
  return { ...state, pendingUpdate: null, lastFailedUpdate: failed };
}

/** 用于 UI 文案的三态。**不要让调用方自己拼**。 */
export function resolvePhase(state: UpdateState, currentVersion: string): UpdatePhase {
  if (state.pendingUpdate) return 'pending-reload';
  if (!isUpdateAvailable(state, currentVersion)) return 'idle';
  return state.dismissedVersion === state.latest?.version ? 'dismissed' : 'available';
}

/**
 * `UpdateState` → 面板/更新窗口认识的 DTO。
 *
 * ## 为什么放在 `resolvePhase` 紧后面
 *
 * 这两件事本来就是同一件：`phase` 的判据**只能有一处**（`resolvePhase`），
 * 而 `toStatusView` 是它唯一的对外出口。放一起，改动时想漏掉另一半都难。
 *
 * ## 为什么它在 `core` 而不是 background 的 handler 里
 *
 * 它是**纯函数**：只读 `state` 字段 + 调 `resolvePhase`，不碰 `chrome`。
 * 而它有两个消费者，分居两个上下文：
 *
 * | 消费者 | 上下文 |
 * | --- | --- |
 * | `background/handlers/update.handler.ts` | SW |
 * | `entrypoints/content-panel.content.ts` | content script（`storage.onChanged` 同步） |
 *
 * 留在 handler 里会让 content script 去 import background 的代码 ——
 * 方向反了（AGENTS.md §5.1 只允许 `entrypoints → background`，那是给 SW 入口用的，
 * 不是给 content 用的）。搬进 core 之后两边都从同一个地方取。
 *
 * @param state 归一化后的更新状态
 * @param version 当前安装的版本（`getManifest().version`，由调用方用
 *   `platform/update/version.ts` 的 `currentVersion()` 取 —— core 不碰 chrome）
 */
export function toStatusView(state: UpdateState, version: string): UpdateStatusView {
  return {
    currentVersion: version,
    latestVersion: state.latest?.version ?? null,
    latestSizeBytes: state.latest?.sizeBytes ?? null,
    latestZipUrl: state.latest?.zipUrl ?? null,
    phase: resolvePhase(state, version),
    autoCheckEnabled: state.autoCheckEnabled,
    intervalDays: state.intervalDays,
    lastCheckAt: state.lastCheckAt,
    lastAppliedVersion: state.lastAppliedVersion,
    lastFailedVersion: state.lastFailedUpdate?.to ?? null,
  };
}

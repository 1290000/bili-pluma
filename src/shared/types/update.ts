/**
 * 自动更新的**对外 DTO** —— 面板与 background 之间只传这些。
 *
 * ## 为什么不直接把 `UpdateState` 传到 UI
 *
 * 依赖方向是 `shared ← core ← platform`。`UpdateState` 在 core 里，
 * 如果 `messages.ts`（shared）直接 import 它，方向就反了。
 *
 * 所以对外的形状定义在这里，core 反过来引这里的 union —— **只有一份定义**，
 * 不会出现"两处各写一个 phase，加值只改一处"的漂移。
 *
 * ⚠️ 这里**不含任何凭据**，也不含 GitHub 返回的原始字段（只留判断需要的）。
 */

/**
 * 更新流程所处阶段。
 *
 * `downloading` / `writing` 目前只有更新窗口内部用；先定义好，
 * 免得后面加时又要动一批 switch。
 */
export type UpdatePhase =
  'idle' | 'available' | 'dismissed' | 'downloading' | 'writing' | 'pending-reload' | 'failed';

/** 一次检查的结局。`skipped` 包含"闸门没到"与"手动冷却中"。 */
export type UpdateCheckOutcome = 'skipped' | 'ok' | 'unchanged' | 'rate-limited' | 'failed';

/** 面板「关于」tab 需要的全部信息。 */
export interface UpdateStatusView {
  /** 当前安装的版本（`chrome.runtime.getManifest().version`） */
  currentVersion: string;
  /** 最近一次检查看到的正式版；从没查过是 `null` */
  latestVersion: string | null;
  /** 对应 zip 的体积，给"283 KB"这种文案用 */
  latestSizeBytes: number | null;
  /** 三态/四态（见 `UpdatePhase`） */
  phase: UpdatePhase;
  autoCheckEnabled: boolean;
  intervalDays: number;
  lastCheckAt: number | null;
  /** 上一次成功生效的版本，用于"已更新到 vX" */
  lastAppliedVersion: string | null;
}

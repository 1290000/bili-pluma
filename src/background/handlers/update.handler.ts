/**
 * 自动更新的消息入口 —— 面板问、这里答；SW 启动时也走这里跑一次自动检查。
 *
 * ## 一条硬规矩：`handleUpdateCheck` **不许**吞掉"结果是什么"
 *
 * 面板需要区分 `ok` / `unchanged`（304）/ `rate-limited` / `failed`，
 * 因为四种情况该说的话完全不同（"已是最新" / "已是最新" / "GitHub 限流，X 分钟后重试" /
 * "检查失败：<原因>"）。把后两种混成"检查失败"，用户就永远不知道该等还是该报 bug。
 */

import { runCheck, type ReleaseSource } from '@core/update/check';
import {
  resolvePhase,
  shouldPrompt,
  withApplied,
  withAutoCheck,
  withFailedUpdate,
  type UpdateState,
} from '@core/update/state';
import { fetchLatestRelease } from '@platform/update/github';
import { readUpdateState, writeUpdateState } from '@platform/update/state-store';
import { UPDATE_MANUAL_COOLDOWN_MS } from '@shared/constants/update';
import type { UpdateCheckOutcome, UpdateStatusView } from '@shared/types/update';

/** 真实实现；测试里换成桩。 */
const defaultSource: ReleaseSource = {
  latest: (etag) => fetchLatestRelease({ etag }),
};

function currentVersion(): string {
  // `getManifest()` 在扩展任何上下文里都有；万一拿不到也不该把更新功能弄崩
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

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

/**
 * 工具栏角标：**只在"有新版本且用户没关过这一版"时亮**。
 *
 * 用 `•` 而不是数字 —— 数字会被读成"未读消息数"，而这里没有"几条"的概念。
 */
export async function applyUpdateBadge(state: UpdateState, version: string): Promise<void> {
  const text = shouldPrompt(state, version) ? '•' : '';
  try {
    await chrome.action.setBadgeText({ text });
  } catch {
    /* SW 被唤醒的极早期可能拿不到 action，角标失败不该影响检查本身 */
  }
}

export async function handleUpdateStatus(): Promise<{
  type: 'update/status:ok';
  status: UpdateStatusView;
}> {
  const state = await readUpdateState();
  return { type: 'update/status:ok', status: toStatusView(state, currentVersion()) };
}

export async function handleUpdateCheck(
  manual: boolean,
  source: ReleaseSource = defaultSource,
): Promise<{
  type: 'update/check:ok';
  status: UpdateStatusView;
  outcome: UpdateCheckOutcome;
  reason: string | null;
}> {
  const state = await readUpdateState();
  const version = currentVersion();

  const result = await runCheck({
    state,
    currentVersion: version,
    now: Date.now(),
    manual,
    manualCooldownMs: UPDATE_MANUAL_COOLDOWN_MS,
    source,
  });

  // 只有状态**真的变了**才写：失败/限流时 runCheck 会原样返回同一个对象，
  // 写它既没用，又会白触发 storage.onChanged 让面板白刷新一次。
  if (result.state !== state) {
    await writeUpdateState(result.state);
  }
  await applyUpdateBadge(result.state, version);

  return {
    type: 'update/check:ok',
    status: toStatusView(result.state, version),
    outcome: result.outcome,
    reason: result.reason,
  };
}

export async function handleUpdateAuto(enabled: boolean): Promise<{
  type: 'update/auto:ok';
  status: UpdateStatusView;
}> {
  const state = withAutoCheck(await readUpdateState(), enabled);
  await writeUpdateState(state);
  await applyUpdateBadge(state, currentVersion());
  return { type: 'update/auto:ok', status: toStatusView(state, currentVersion()) };
}

/**
 * SW 启动时的**更新后自检**。
 *
 * ## 这是"目录选错了"的唯一硬判据
 *
 * 更新窗口写完文件后记 `pendingUpdate { from, to }` 再 `runtime.reload()`。
 * SW 重启时如果 `getManifest().version === to` → 真的生效了；
 * 否则说明**写进去的文件没有被加载** —— 最常见就是用户选了另一个目录
 * （比如 Downloads 里那个旧解压目录）。本地只能做浅校验（有没有 manifest），
 * 证明不了"是不是当前加载的那个"，所以必须靠这一次重启来回答。
 *
 * ⚠️ 不许静默：用户为这件事点过一次目录授权，没成必须告诉他为什么。
 */
export async function checkPendingUpdate(): Promise<void> {
  const state = await readUpdateState();
  const pending = state.pendingUpdate;
  if (!pending) return;

  const version = currentVersion();
  if (version === pending.to) {
    await writeUpdateState(withApplied(state, version));
    return;
  }
  await writeUpdateState(withFailedUpdate(state, { to: pending.to, at: pending.at }));
}

/**
 * SW 启动时的自动检查 —— **完全静默**。
 *
 * 用户没在等它。任何失败（限流、断网、解析失败）都只体现在状态里，
 * 由面板下次打开时显示，绝不弹通知、绝不打断。
 */
export async function runStartupUpdateCheck(): Promise<void> {
  try {
    const state = await readUpdateState();
    const version = currentVersion();
    const result = await runCheck({
      state,
      currentVersion: version,
      now: Date.now(),
      manual: false,
      manualCooldownMs: UPDATE_MANUAL_COOLDOWN_MS,
      source: defaultSource,
    });
    if (result.state !== state) await writeUpdateState(result.state);
    await applyUpdateBadge(result.state, version);
  } catch {
    /* 自动检查失败一律静默：它是后台行为，不该产生可见噪音 */
  }
}

/**
 * 打开更新窗口。
 *
 * 用 `chrome.windows.create` 而不是 `tabs.create`：这是个有明确终点的任务窗口，
 * 不是一个要留在标签栏里的页面。尺寸固定，避免它被拉成半个屏幕。
 */
export async function handleUpdateOpen(): Promise<{ type: 'update/open:ok'; opened: boolean }> {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('update.html'),
      type: 'popup',
      width: 440,
      height: 600,
    });
    return { type: 'update/open:ok', opened: true };
  } catch {
    return { type: 'update/open:ok', opened: false };
  }
}

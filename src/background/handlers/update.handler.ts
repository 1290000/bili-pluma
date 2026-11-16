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
  shouldPrompt,
  toStatusView,
  withApplied,
  withAutoCheck,
  withDismissed,
  withFailedUpdate,
  type UpdateState,
} from '@core/update/state';
import { fetchLatestRelease } from '@platform/update/github';
import { readUpdateState, writeUpdateState } from '@platform/update/state-store';
import { currentVersion } from '@platform/update/version';
import { UPDATE_MANUAL_COOLDOWN_MS } from '@shared/constants/update';
import type { UpdateCheckOutcome, UpdateStatusView } from '@shared/types/update';

/** 真实实现；测试里换成桩。 */
const defaultSource: ReleaseSource = {
  latest: (etag) => fetchLatestRelease({ etag }),
};

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
 * 把「当前这一版」标记为已读（2026-11-17）。
 *
 * ## 什么时候被调用
 *
 * 用户打开面板的「关于」Tab，且当时 `phase === 'available'` —— 视为已读。
 * 判据在面板侧（`panel.ts` 的 `dismissedFor`，**按版本号**防重），这里只管落盘。
 *
 * ## 为什么**必须**顺手调 `applyUpdateBadge`
 *
 * 红点由面板自己按 `phase` 画，但工具栏角标是 background 写的。
 * 漏掉这一句 → Tab 上红点没了、工具栏那个 `•` 还亮着，而用户已经没有
 * 任何入口能消掉它（「关于」Tab 是唯一入口）—— 那就是这个功能原本的 bug。
 *
 * ## 没有 `latest` 时**原样返回**
 *
 * 不能"没数据就记一个版本号"：`dismissedVersion` 只该等于**用户真正看见过的**
 * 那一版。凭空写一个值会让下一版更新出现时"已经算关过了"，红点永远不亮。
 *
 * ## 幂等：已经记过这一版就**不再写盘**
 *
 * 面板侧已有防重，但这里仍要早退 —— 它是一条**公开的消息**，任何调用方
 * （将来的 popup、自动化脚本）重复发都不该产生副作用：
 * 多余的一次 `writeUpdateState` 会推一次 `storage.onChanged`，
 * 所有监听者（面板自己、更新窗口）都要白重画一帧。
 *
 * ⚠️ 早退**只跳写盘**，`applyUpdateBadge` 照调 —— 理由写在分支里那一段。
 */
export async function handleUpdateDismiss(): Promise<{
  type: 'update/dismiss:ok';
  status: UpdateStatusView;
}> {
  const state = await readUpdateState();
  const version = currentVersion();

  if (state.latest === null) {
    // 没查过 / 查不到最新版 ⇒ 无事可做，也不许伪造一个 dismissedVersion
    return { type: 'update/dismiss:ok', status: toStatusView(state, version) };
  }

  // 已经记过这一版 ⇒ 不写盘，但**角标仍要补一次**
  if (state.dismissedVersion === state.latest.version) {
    /**
     * ⚠️ 这里**只跳过写盘，不跳过 `applyUpdateBadge`**（2026-11-17 三轮）。
     *
     * 角标是幂等的 `setBadgeText`，多调一次没有副作用；而漏调一次的代价不对称：
     * 上一次的 `setBadgeText` 可能**自己失败**了（它内部 `catch` 掉，SW 刚被唤醒时
     * 拿不到 `action`），那时 `dismissedVersion` 已经落盘 —— 如果这里也跳过，
     * 工具栏那个 `•` 就**再也不会**被补消，而用户唯一的消除入口就是这条消息。
     *
     * 这是"界面说 A、实际 B"的经典形状：状态说已读，角标还亮着。
     */
    await applyUpdateBadge(state, version);
    return { type: 'update/dismiss:ok', status: toStatusView(state, version) };
  }

  const next = withDismissed(state, state.latest.version);
  // `withDismissed` 恒返回新对象（不像 `withFailedCheck` 可能原样返回），
  // 所以这里无需比较引用即可写 —— 那一次写是有意义的：phase 从 available 变 dismissed。
  await writeUpdateState(next);
  await applyUpdateBadge(next, version);
  return { type: 'update/dismiss:ok', status: toStatusView(next, version) };
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

/**
 * 第二趟：把之前记下的播放位置还原回去。
 *
 * ## 为什么需要它
 *
 * P2 的代价是"首次进入某集刷一次页面"。刷新会丢掉进度 —— 用户从第 3 分钟开始，
 * 刷完回到第 0 分钟，体感很差。所以刷新前把 `currentTime` 记进 `sessionStorage`，
 * 第二趟等 `<video>` 有元数据后 `seek` 回去。
 *
 * ## 为什么不能立刻 seek
 *
 * `createPlayer` 之后 `<video>` 要等 `loadedmetadata` 才有 `duration`，
 * 在那之前设 `currentTime` 会被浏览器忽略（或抛 `InvalidStateError`）。
 *
 * ## 为什么只试有限次数
 *
 * 播放器可能重建（切集、切画质），监听器会被新实例「抢走」。
 * 用一个带上限的轮询 + `loadedmetadata` 双保险，30 秒内没成功就放弃 ——
 * 卡在一个永远不会来的事件上比"没恢复"更糟。
 */

import { RESUME_KEY_PREFIX, resumeTarget } from './pgc-reload-plan';

/** 最多等多久（毫秒）。超过就放弃，避免长期挂着一个定时器 */
const RESUME_TIMEOUT_MS = 30_000;

/** 轮询间隔 */
const RESUME_POLL_MS = 500;

/** 存/读播放位置 */
export function saveResumeTime(cid: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    sessionStorage.setItem(RESUME_KEY_PREFIX + cid, String(Math.floor(seconds)));
  } catch {
    /* 隐私模式 / 配额满：记不住就算了，不影响主流程 */
  }
}

export function clearResumeTime(cid: string): void {
  try {
    sessionStorage.removeItem(RESUME_KEY_PREFIX + cid);
  } catch {
    /* 同上 */
  }
}

function readResumeTime(cid: string): number | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY_PREFIX + cid);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 尝试把播放位置还原。
 *
 * @param cid   章节 id（决定读哪个键）
 * @param onDone 还原成功或放弃时回调一次，便于写诊断日志
 */
export function restoreResumeTime(cid: string, onDone: (detail: string) => void): void {
  const saved = readResumeTime(cid);
  if (saved === null) return;

  const startedAt = Date.now();
  let done = false;

  const finish = (detail: string): void => {
    if (done) return;
    done = true;
    window.clearInterval(timer);
    clearResumeTime(cid);
    onDone(detail);
  };

  const attempt = (): void => {
    if (done) return;
    const v = document.querySelector('video');
    const target = resumeTarget(saved, v?.currentTime ?? 0);
    if (target === null) {
      // 已经播过这个位置了（bfcache 恢复）或位置太靠前 —— 不用管
      if (v && v.currentTime >= saved) finish(`无需恢复（当前 ${Math.round(v.currentTime)}s）`);
      return;
    }
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;

    try {
      v.currentTime = target;
      finish(`已恢复到 ${target}s`);
    } catch {
      // metadata 还没就绪：下一轮再试
    }
    if (Date.now() - startedAt > RESUME_TIMEOUT_MS) finish('超时放弃恢复');
  };

  const timer = window.setInterval(attempt, RESUME_POLL_MS);
  attempt();
  // 兜底：即便一轮都没成功，也要在超时后收尾
  window.setTimeout(() => finish('超时放弃恢复'), RESUME_TIMEOUT_MS + RESUME_POLL_MS);
}

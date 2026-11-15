/**
 * 更新状态落盘 —— `chrome.storage.local`，单键。
 *
 * ## 为什么单独一个键，而不是拆成 autoCheck / interval / latest 三个
 *
 * 这些字段是**一起变**的：一次检查会同时改 `lastCheckAt` / `etag` / `latest`。
 * 拆成三个键就得保证三次 `set` 都成功，中间失败会留下"时间推进了但版本没更新"
 * 这种自相矛盾的状态。单键一次写，结构上不可能半新半旧。
 *
 * 读的时候一律过 `normalizeUpdateState` —— 键里的东西可能是上一个版本写的。
 */

import { normalizeUpdateState, type UpdateState } from '@core/update/state';

const STATE_KEY = 'pluma:update-state';

/** 供 content script 监听 `storage.onChanged` 时比对键名 */
export const UPDATE_STATE_KEY = STATE_KEY;

export async function readUpdateState(): Promise<UpdateState> {
  const bag = await chrome.storage.local
    .get(STATE_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  return normalizeUpdateState(bag[STATE_KEY]);
}

export async function writeUpdateState(state: UpdateState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

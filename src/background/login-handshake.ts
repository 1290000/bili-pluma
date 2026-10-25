/**
 * 登录握手 —— 解决 split 模式下"两个实例各自弹窗"的问题。
 *
 * ## 约束
 * `incognito: "split"` 下普通/无痕 background 是两个**互不通信**的实例：
 *   - 内存变量不共享
 *   - `windows.getAll()` / `tabs.query()` 看不到对方分区的窗口
 *   - 只有 `chrome.storage.local` 是共享的（官方文档明确说明）
 *
 * ## 做法
 * 用 storage 做双向握手：
 *
 *   1. 两个实例都会收到 action.onClicked
 *   2. 各自尝试开自己的界面（普通实例通常失败，无痕实例成功）
 *   3. **成功的那个**写入 `login-ready` 标记
 *   4. **失败的那个**先弹说明页，但弹完后持续监听 `login-ready`
 *      —— 一旦看到它出现，**自动关掉自己的说明页**
 *
 * 这样用户看到的是：说明页闪一下 → 二维码窗口出现 → 说明页自己消失。
 * 如果二维码窗口始终没出现（真的没开 InPrivate 权限），说明页保留。
 */

const READY_KEY = 'pluma:login-ready';

/** 二维码窗口已就绪的标记存活时间 */
const READY_TTL_MS = 60 * 1000;

export interface ReadyMark {
  at: number;
}

/** 标记"二维码窗口已打开"（由成功创建窗口的实例调用） */
export async function markLoginReady(): Promise<void> {
  const mark: ReadyMark = { at: Date.now() };
  await chrome.storage.local.set({ [READY_KEY]: mark });
}

/** 清除就绪标记 */
export async function clearLoginReady(): Promise<void> {
  await chrome.storage.local.remove(READY_KEY).catch(() => {});
}

/** 读取就绪标记；过期的视为不存在 */
export async function readLoginReady(): Promise<ReadyMark | null> {
  const bag = await chrome.storage.local.get(READY_KEY);
  const m = bag[READY_KEY] as ReadyMark | undefined;
  if (!m || typeof m.at !== 'number') return null;
  if (Date.now() - m.at > READY_TTL_MS) return null;
  return m;
}

/**
 * 等二维码窗口出现。出现后调用 onReady，超时后调用 onTimeout。
 *
 * @param timeoutMs 最多等多久（给用户开 InPrivate 的时间）
 */
export function watchForLoginReady(onReady: () => void, timeoutMs = 8000): () => void {
  let done = false;

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    cleanup();
    // 超时不做任何事——说明页保留，让用户看到指引
  }, timeoutMs);

  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(READY_KEY in changes)) return;
    if (done) return;
    done = true;
    cleanup();
    onReady();
  };

  function cleanup(): void {
    clearTimeout(timer);
    chrome.storage.onChanged.removeListener(listener);
  }

  chrome.storage.onChanged.addListener(listener);
  return cleanup;
}

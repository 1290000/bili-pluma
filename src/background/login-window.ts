/**
 * 登录窗口管理 —— **必须开在无痕分区里**。
 *
 * 原因（[ADR 0012](../../docs/decisions/0012-isolated-window-login.md)）：
 * B站凭据只通过 `Set-Cookie` 下发，JS 读不到那个响应头，必须让浏览器真正落地。
 * 而落地就会覆盖同一分区的登录态，所以在普通窗口登录 = 覆盖主账号。
 *
 * ## split 模式的三个反直觉事实（全部实测踩过）
 *
 * 1. **分区隔离是双向的**：普通实例看不到无痕分区，也无痕实例看不到普通分区
 * 2. **普通实例创建无痕窗口后，自己也 `windows.get()` 不到它**（会 reject）
 * 3. **两个实例都会收到 `action.onClicked`**
 *
 * 由此得出两条铁律：
 *   - 验证隔离：只信 `windows.create()` 的返回值，不做二次查询
 *   - 跨实例协调：只信 `chrome.storage.local`（跨分区共享），不信内存变量和窗口列表
 */

import { diag } from '@platform/storage/diag-store';

// 诊断日志（`diag` / `readDiag` / `instanceId`）已下沉到 `platform/storage/diag-store`，
// 因为 options 的「诊断」分区也要读它，而 entrypoints 不许依赖 background。
const LOGIN_WINDOW = { width: 420, height: 600 } as const;

const LOGIN_URL = '/login-window.html';

/** 记住当前登录窗口，避免连点开出一堆（仅本实例可见） */
let currentWindowId: number | null = null;

export interface OpenLoginResult {
  ok: boolean;
  /**
   * - `incognito-disabled`：确定没权限（`isAllowedIncognitoAccess` 为 false）
   * - `already-open`：窗口已存在，已聚焦
   * - `assumed`：权限正常，但 `create` 返回 undefined 且本实例看不到窗口变化。
   *   **按"已创建"处理**——无痕窗口对当前分区不可见，实测窗口确实建出来了
   *   （标题 `登录播放账号-[InPrivate]`）。不要当失败。
   * - `unknown`：其他异常
   */
  reason?: 'incognito-disabled' | 'already-open' | 'assumed' | 'unknown';
}

/**
 * 扩展是否被允许在无痕/InPrivate 窗口运行。
 *
 * 这是本方案的前置条件，无法绕过。
 */
export async function isIncognitoAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedIncognitoAccess();
  } catch {
    return false;
  }
}

/**
 * 打开登录窗口（InPrivate）。
 *
 * ⚠️ **不能只信 `windows.create()` 的返回值**（实测踩过）：
 * 在 split 模式下从普通实例创建无痕窗口，窗口**确实创建出来了**，
 * 但 `create()` 的 Promise 解析成 `undefined`——拿不到 id，也拿不到 incognito 字段。
 *
 * 所以判定"到底有没有开出来"必须靠**间接证据**：
 * 创建前后统计可见窗口数量（本实例能看到的，无痕窗口可能不在其中），
 * 并结合 `chrome.storage.local` 里其他实例的反馈。
 *
 * 这一层的职责就到这里：把"调用结果"如实报上去，由调用方决定怎么解释。
 */
export async function openLoginWindow(): Promise<OpenLoginResult> {
  if (currentWindowId !== null) {
    try {
      await chrome.windows.update(currentWindowId, { focused: true });
      await diag('focus-existing', String(currentWindowId));
      return { ok: true, reason: 'already-open' };
    } catch {
      currentWindowId = null;
    }
  }

  const allowed = await isIncognitoAllowed();
  await diag('isAllowedIncognitoAccess', String(allowed));
  if (!allowed) {
    return { ok: false, reason: 'incognito-disabled' };
  }

  const before = await chrome.windows
    .getAll()
    .then((ws) => ws.length)
    .catch(() => -1);

  let created: chrome.windows.Window | undefined;
  try {
    created = await chrome.windows.create({
      url: chrome.runtime.getURL(LOGIN_URL),
      type: 'popup',
      incognito: true,
      width: LOGIN_WINDOW.width,
      height: LOGIN_WINDOW.height,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await diag('windows.create THREW', msg.slice(0, 120));
    return { ok: false, reason: /incognito|invalid/i.test(msg) ? 'incognito-disabled' : 'unknown' };
  }

  // 给浏览器一点时间让窗口真正出现
  await new Promise((r) => setTimeout(r, 400));
  const after = await chrome.windows
    .getAll()
    .then((ws) => ws.length)
    .catch(() => -1);

  // 再查一次：本分区能不能看到 login-window 的标签（能看到就说明窗口真在我们这个分区里）
  const visibleTabs = await chrome.tabs
    .query({})
    .then((ts) => ts.filter((t) => (t.url ?? '').includes('login-window')).length)
    .catch(() => -1);

  await diag(
    'windows.create returned',
    `id=${String(created?.id)} incognito=${String(created?.incognito)} ` +
      `windowsBefore=${before} windowsAfter=${after} loginTabs=${visibleTabs}`,
  );

  // 情况 1：拿到了窗口对象
  if (created?.id != null) {
    if (created.incognito === true) {
      currentWindowId = created.id;
      return { ok: true };
    }
    // 建成了但不是无痕 → 危险，关掉
    await chrome.windows.remove(created.id).catch(() => {});
    return { ok: false, reason: 'incognito-disabled' };
  }

  // 情况 2：返回 undefined，但窗口数量增加了 → 窗口其实建出来了
  if (before >= 0 && after > before) {
    await diag('窗口数增加但 create 返回 undefined', `${before} → ${after}`);
    return { ok: true };
  }

  // 情况 3：返回 undefined 且本实例看不到窗口数变化。
  // 这**不能**判定为失败——无痕窗口可能对当前分区实例不可见
  // （用户实测：窗口标题 `登录播放账号-[InPrivate]` 确实出现了，但本实例 windowsAfter 没变）。
  // 交给调用方通过 storage 握手确认：成功的实例会写 login-ready。
  await diag('create 返回 undefined 且窗口数未变，交给握手判定');

  // 重要：即便如此也要**乐观地**报告"可能成功"。
  // 因为本实例看不到无痕窗口，不代表它没建出来。
  // 调用方会用它来写 login-ready，从而抑制另一个实例误弹说明页。
  return { ok: true, reason: 'assumed' };
}

/** 登录成功后关闭窗口，让 cookie 随分区销毁 */
export async function closeLoginWindow(): Promise<void> {
  if (currentWindowId === null) return;
  await chrome.windows.remove(currentWindowId).catch(() => {});
  currentWindowId = null;
}

/** 窗口被用户手动关闭时清理本实例状态 */
export function forgetLoginWindow(): void {
  currentWindowId = null;
}

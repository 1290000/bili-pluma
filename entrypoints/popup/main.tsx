/**
 * Popup —— **只负责一个开关**：开启 / 关闭页内悬浮入口。
 *
 * ## 为什么 popup 只剩这点东西（ADR 0033 阶段 4，2026-11-10）
 *
 * 用户明确要求「完全废除 options 页」，并把所有功能迁进**页内面板**。
 * 原来 popup 承担的状态查看、画质对比、双账号卡、净化偏好、诊断入口
 * **全部已在面板里**，留在这里就是两份要同步维护的 UI —— 那必然漂移。
 *
 * ## 为什么 popup 本身不删
 *
 * 用户决定保留 `default_popup`（ADR 0033 决定三）。原因很实际：
 * 有 `default_popup` 时 `chrome.action.onClicked` **永不触发**（`02` §8 已记录），
 * 所以 popup 不能承担"唤起面板"的职责 —— 它只能放**持久开关**。
 *
 * 而这个开关有它的位置：用户关掉悬浮入口后，面板就不渲染了，
 * **那时唯一能把它打开的地方就是 popup**。这是一个闭环，不是冗余。
 *
 * ## 没有消息通道
 *
 * 只读写 `storage.local` 一个键，content script 靠 `onChanged` 响应。
 * 打开 popup 时面板会立刻出现/消失，**不需要刷新页面**。
 */

import { readPanelEntryEnabled, writePanelEntryEnabled } from '@platform/storage/ui-prefs-store';
import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import '@/src/design/tokens.css';
import './style.css';

function App() {
  /**
   * `null` = 还没读出来。
   *
   * ⚠️ 此时开关**禁用**，不能当成"关"—— 把"未知"画成"关"会让用户
   * 以为功能自己关掉了（`ui-prefs-store.ts` 的文件头记过这个坑）。
   */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void readPanelEntryEnabled().then(setEnabled);
  }, []);

  /**
   * 拨开关。
   *
   * **乐观更新**：先动 UI 再落盘，失败回滚。
   * 理由：popup 失焦即销毁，`storage.local.set` 在冷启动时可能要几十毫秒，
   * 等往返再动 UI 用户会以为没点中而反复点。
   */
  const toggle = useCallback(async (next: boolean) => {
    setBusy(true);
    setError(null);
    setEnabled(next);
    try {
      await writePanelEntryEnabled(next);
    } catch (e) {
      setEnabled(!next);
      setError(e instanceof Error ? e.message.slice(0, 60) : '保存失败');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div class="popup">
      <header class="bar">
        <span class="brand">
          <img class="brand-logo" src={chrome.runtime.getURL('icon/128.png')} alt="" />
          Pluma
        </span>
        <span class="pill pill-neutral">页内面板</span>
      </header>

      <main class="body">
        <label class="row">
          <span class="row-label">
            显示悬浮入口
            <span class="row-hint">
              在 B站 页面左侧显示贴边入口，鼠标移入展开面板（画质 / 净化 / 账号）。
            </span>
          </span>
          <span class={`switch ${enabled === true ? 'on' : ''} ${busy ? 'busy' : ''}`}>
            <input
              type="checkbox"
              checked={enabled === true}
              disabled={busy || enabled === null}
              onChange={(e) => void toggle((e.target as HTMLInputElement).checked)}
            />
            <span class="knob" />
          </span>
        </label>

        {enabled === false && (
          <p class="hint">
            关掉后页面上没有任何入口。重新打开这一页就能再打开它 —— 这是唯一的地方。
          </p>
        )}

        {error && <p class="hint danger">{error}</p>}
      </main>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);

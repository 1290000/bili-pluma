/**
 * 显示页 —— 回答"界面上显示什么"。
 *
 * 现在只有两行：角标开关（可操作）+ 深色模式（只读）。
 *
 * ⚠️ 为什么单开一页而不是塞进「账号」或「诊断」：
 * 塞账号页会让人以为角标跟账号绑定；塞诊断页会让人以为它是排查工具（排查完就该关掉）。
 * 它是常驻的显示偏好，和那两件事都无关。
 *
 * ⚠️ 角标开关**不需要刷新页面**：content script 监听 `storage.onChanged`，
 * 保存后立刻重画（见 `entrypoints/content.ts` 的 `paintBadge`）。
 */

import { readBadgeEnabled, writeBadgeEnabled } from '@platform/storage/ui-prefs-store';
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { Card } from '../ui';

export function DisplaySection(): JSX.Element {
  /** `null` = 还没读出来（此时禁用开关，避免把"未知"当成"关"） */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readBadgeEnabled().then(setEnabled);
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setBusy(true);
    setEnabled(next); // 乐观更新：开关要跟手，失败再回滚
    try {
      await writeBadgeEnabled(next);
    } catch {
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Card title="显示">
      <p class="lede">播放器右下角的角标，以及界面是否跟随系统深色模式。</p>

      <label class="pref">
        <span class="pref-label">
          页内角标
          <span class="pref-hint">
            在播放器右下角显示当前实际分辨率、帧率、音频编码。关掉后立即消失，不需要刷新。
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

      <div class="pref readonly">
        <span class="pref-label">
          深色模式
          <span class="pref-hint">
            跟随系统设置（由 tokens.css 的 prefers-color-scheme 决定），暂不提供手动切换。
          </span>
        </span>
        <span class="pref-value">跟随系统</span>
      </div>
    </Card>
  );
}

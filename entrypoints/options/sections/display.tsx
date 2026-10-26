/**
 * 显示页 —— 回答"界面上显示什么"。
 *
 * 待实现（`02-ui-spec.md` §4.5）：
 * - 页内角标开关（存 `storage.local`，`badge.ts` 读它；关掉后**刷新页面**才消失）
 * - 深色模式：跟随系统，由 `tokens.css` 的 `prefers-color-scheme` 决定，暂不提供手动切换
 *
 * ⚠️ 为什么单开一页而不是塞进「账号」或「诊断」：
 * 塞账号页会让人以为角标跟账号绑定；塞诊断页会让人以为它是排查工具（排查完就该关掉）。
 * 它是常驻的显示偏好，和那两件事都无关。
 */

import { Card, Pending } from '../ui';
import type { JSX } from 'preact';

export function DisplaySection(): JSX.Element {
  return (
    <Card title="显示">
      <p class="lede">播放器右下角的角标，以及界面跟随系统深色模式。</p>
      <Pending items={['页内角标开关', '深色模式跟随系统（已由 tokens.css 支持，仅需确认）']} />
    </Card>
  );
}

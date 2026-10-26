/**
 * 诊断页 —— 回答"出问题时看这里"。
 *
 * 这一页是**唯一现在就能用的**：现有的自检页（`entrypoints/diagnostics/`）
 * 已经能显示 DNR 规则、InPrivate 权限、当前页取流数据。骨架阶段先把它挂过来，
 * 不重写 —— 那 200 行是排查 InPrivate 权限问题的唯一手段，重写风险大于收益。
 *
 * 待实现（`02-ui-spec.md` §4.4）：
 * - 路径命中日志（最近 200 条，cookie 一律脱敏）
 * - 失败原因分布（饼图 / 堆叠条）
 * - 一键导出诊断包（**默认不含凭据**）
 * - 白名单版本号与"是否已过期"
 */

import { Card, Pending } from '../ui';
import type { JSX } from 'preact';

function openSelfCheck(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
}

export function DiagnosticsSection(): JSX.Element {
  return (
    <Card title="诊断">
      <p class="lede">
        出问题时先看自检页：它显示 DNR 规则、InPrivate 权限、凭据状态， 以及当前页两侧的取流数据。
      </p>

      <div class="actions">
        <button class="primary" onClick={openSelfCheck}>
          打开自检页
        </button>
        <span class="actions-note">新标签页打开，内容随页面刷新</span>
      </div>

      <Pending
        items={[
          '路径命中日志（最近 200 条，cookie 脱敏）',
          '失败原因分布',
          '一键导出诊断包（默认不含任何凭据）',
          '白名单版本号与升级提示（不做远程拉取，见 Q15）',
        ]}
      />
    </Card>
  );
}

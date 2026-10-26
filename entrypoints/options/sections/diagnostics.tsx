/**
 * 诊断分区 —— 回答"出问题时看这里"。
 *
 * ## 它正在取代独立的自检页
 *
 * 取数逻辑在 `platform/diagnostics/collect.ts`，两处共用。迁移顺序：
 * 先让这里显示同样的数据 → 用户逐行核对 → 再删 `entrypoints/diagnostics/`。
 *
 * ## 三块内容
 *
 * 1. **自检信息**：InPrivate 权限 / 分区 / 凭据 / DNR 规则 / 当前页取流数据
 * 2. **音质环境**：折叠块。**能测的只有 FLAC 一行**，杜比只能给检查清单
 * 3. **诊断日志**：最近 N 条，带实例 ID（`split` 下普通/无痕是两个 SW）
 *
 * ⚠️ 导出**不含任何凭据**。`collectFacts` 只产出状态与计数，`readDiag` 只有步骤名，
 * 两者都不带 cookie 值。
 */

import {
  collectFacts,
  readDiag,
  tipFor,
  type DiagEntry,
  type DiagRow,
} from '@platform/diagnostics/collect';
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { Card } from '../ui';

/** 一行事实。`ok` 决定颜色：true 绿、false 红、省略为中性 */
function Facts(props: { rows: DiagRow[] }): JSX.Element {
  return (
    <div class="rows">
      {props.rows.map((r, i) => (
        <div class="row" key={`${r.label}-${String(i)}`}>
          <span class="key">{r.label}</span>
          <span class={`val ${r.ok === true ? 'good' : r.ok === false ? 'bad' : ''}`}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 音质环境自检 —— 只有 FLAC 能真测，其余给清单 */
function AudioCheck(): JSX.Element {
  // `canPlayType` 返回 'probably' | 'maybe' | ''，空串就是不支持
  const flac = (() => {
    try {
      return new Audio().canPlayType('audio/flac');
    } catch {
      return '';
    }
  })();

  return (
    <div class="rows">
      <div class="row">
        <span class="key">FLAC 解码（Hi-Res）</span>
        <span class={`val ${flac ? 'good' : 'bad'}`}>
          {flac ? `支持（${flac}）` : '不支持 —— 换新版 Chrome / Edge'}
        </span>
      </div>
      <div class="row">
        <span class="key">杜比全景声（EC-3）</span>
        <span class="val">扩展读不到，请按下面三条自查</span>
      </div>
    </div>
  );
}

export function DiagnosticsSection(): JSX.Element {
  const [facts, setFacts] = useState<DiagRow[] | null>(null);
  const [logs, setLogs] = useState<DiagEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    const [f, l] = await Promise.all([collectFacts(), readDiag()]);
    setFacts(f);
    setLogs(l);
    setBusy(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 导出诊断包（下载 JSON）。
   *
   * 用 Blob + `<a download>`，**不申请 `downloads` 权限** —— 扩展页面里这样就够了。
   * 内容只有状态快照 + 日志，**不含任何凭据**（见文件头注释）。
   */
  const exportDiag = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      facts: facts ?? [],
      logs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pluma-diagnostic-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [facts, logs]);

  return (
    <>
      <Card title="自检信息">
        <div class="actions">
          <button class="ghost" disabled={busy} onClick={() => void refresh()}>
            {busy ? '读取中…' : '刷新'}
          </button>
          <button class="ghost" disabled={!facts} onClick={exportDiag}>
            导出诊断包
          </button>
          <span class="actions-note">导出内容不含任何凭据</span>
        </div>

        {facts ? <Facts rows={facts} /> : <p class="empty">正在读取…</p>}
        {facts && <p class="hint">{tipFor(facts)}</p>}
      </Card>

      <Card title="音质环境">
        <p class="lede">
          Hi-Res 通常开箱可用；杜比全景声需要系统层面配合。
          <strong>扩展不做任何解码</strong>，这里只告诉你缺什么。
        </p>
        <details class="fold">
          <summary>这台机器能放 Hi-Res / 杜比吗</summary>
          <AudioCheck />
          <p class="fold-note">杜比要三条同时成立，扩展读不到前两条，只能你自查：</p>
          <ol class="fold-list">
            <li>
              装 Microsoft 的 EC-3 解码扩展（Store ID <code>9nvjqjbdkn97</code>）
            </li>
            <li>
              地址栏进 <code>edge://flags</code> 或 <code>chrome://flags</code>，搜{' '}
              <code>media foundation</code>，选 Enabled，重启浏览器
            </li>
            <li>系统声音设置 → 输出设备格式 / 空间音频，设为杜比全景声</li>
          </ol>
        </details>
      </Card>

      <Card title="诊断日志">
        <p class="lede">
          最近 {logs.length} 条，时间正序。`split` 模式下普通 / 无痕是两个 SW 实例， 靠方括号里的 ID
          区分。
        </p>
        {logs.length === 0 ? (
          <p class="empty">（空）</p>
        ) : (
          <div class="rows">
            {logs.map((e, i) => (
              <div class="row" key={`${String(e.at)}-${String(i)}`}>
                <span class="key">
                  {new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  {e.from ? ` [${e.from}]` : ''} {e.step}
                </span>
                <span class="val">{e.detail ?? ''}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

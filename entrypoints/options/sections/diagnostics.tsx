/**
 * 诊断分区 —— 回答"出问题时看这里"。
 *
 * ## 它已经取代了独立的自检页
 *
 * 取数逻辑在 `platform/diagnostics/collect.ts`。原来那个独立页
 * （`entrypoints/diagnostics/`）2026-10-26 已删除 —— 删之前做过逐行比对
 * （16 行事实全同），不是凭感觉删的。
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

/**
 * 音质环境自检。
 *
 * ## 判据来自 2026-10-26 实测，不是猜的
 *
 * | 查询 | 结果 | 说明 |
 * | --- | --- | --- |
 * | `canPlayType('audio/flac')` | `probably` | 能用 |
 * | `canPlayType('audio/ogg; codecs=flac')` | `probably` | 能用 |
 * | `canPlayType('audio/mp4; codecs=flac')` | `probably` | **B站 Hi-Res 走的是这条**（fMP4 封装） |
 * | `MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')` | `true` | 杜比全景声解码器**在** |
 * | `canPlayType('audio/ec-3')` | 空 | 但裸 MIME 查不出来，**不能用它判断** |
 *
 * ⚠️ 曾经这一行写的是"扩展读不到，请按下面三条自查" —— **那是错的**，
 * 实测 `isTypeSupported` 查得出来。把能测的说成测不到，等于白丢一个诊断项。
 *
 * ⚠️ 但 `isTypeSupported` 只证明**解码器存在**，不证明**系统音频链路**
 * 支持空间音频（还要开系统空间音频 + 对应输出设备）。所以两件事分开写：
 * 解码器由这里测，链路引导用户自查。**不要因为测到了 true 就说"杜比可用"。**
 */
function AudioCheck(): JSX.Element {
  // `canPlayType` 返回 'probably' | 'maybe' | ''，空串就是不支持
  const probe = (mime: string): string => {
    try {
      return new Audio().canPlayType(mime);
    } catch {
      return '';
    }
  };

  // B站的 Hi-Res 是 FLAC in fMP4，所以优先看这条；退而求其次看裸 audio/flac
  const flacMp4 = probe('audio/mp4; codecs=flac');
  const flacRaw = probe('audio/flac');
  const flacOk = Boolean(flacMp4 || flacRaw);

  const ec3 = (() => {
    try {
      return MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"');
    } catch {
      return false;
    }
  })();

  return (
    <div class="rows">
      <div class="row">
        <span class="key">FLAC 解码（Hi-Res）</span>
        <span class={`val ${flacOk ? 'good' : 'bad'}`}>
          {flacOk ? `支持（${flacMp4 || flacRaw}）` : '不支持 —— 换新版 Chrome / Edge'}
        </span>
      </div>
      <div class="row">
        <span class="key">EC-3 解码（杜比全景声）</span>
        <span class={`val ${ec3 ? 'good' : 'bad'}`}>
          {ec3 ? '解码器在（见下方链路自查）' : '解码器缺失 —— 见下方自查'}
        </span>
      </div>
      <div class="row">
        <span class="key">空间音频输出链路</span>
        <span class="val">浏览器读不到，请按下面三条自查</span>
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
        <p class="lede">Hi-Res 通常开箱可用；杜比全景声需要系统层面配合。</p>
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

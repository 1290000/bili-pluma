/**
 * 面板的诊断视图 —— 自检信息 + 诊断日志 + 导出 JSON。
 *
 * ## 数据全部复用，不重写
 *
 * | 数据 | 来源 | 为什么不能复制 |
 * | --- | --- | --- |
 * | 自检信息 | `collectFacts()` | 它是「诊断事实的唯一数据源」（`collect.ts` 文件头） |
 * | 日志 | `readDiag()` | 环形缓冲的读取口径只有一处 |
 * | 提示 | `tipFor()` | 两处 UI 各算一份必然出现"一边说正常、一边说异常" |
 *
 * ## ⚠️ 凭据边界（`AGENTS.md` §5.2）
 *
 * 导出的 JSON **绝不含凭据**。防线有两条：
 *
 * 1. `collectFacts()` 本来就只产状态与计数（且 `collect.ts` 有一条源码级断言
 *    禁止它输出 `requestHeaders`）
 * 2. 本文件的 `buildExportPayload()` 只包**四个固定字段**，见那里的注释
 *
 * 单测：`tests/unit/content/panel-diagnostics-export.test.ts`
 *
 * ## 与 options 那份的关系
 *
 * 阶段 4 会删掉 `entrypoints/options/`。为了**诊断包形状不因搬家而变化**，
 * `buildExportPayload()` 的字段与顺序与 options 的 `exportDiag()` 保持一致
 * （`exportedAt` / `version` / `facts` / `logs`）。有单测守着。
 */

import type { DiagEntry, DiagRow } from '@platform/diagnostics/collect';
import { tipFor } from '@platform/diagnostics/collect';
import { el } from './dom';

/**
 * 导出 payload 的字段与顺序 —— **与 options 的 `exportDiag()` 一致**。
 *
 * ## 为什么写死这四个字段，而不是"把 rows 和 logs 原样 stringify"
 *
 * 因为"只包这四个"本身就是一道**凭据防线**：
 * 将来谁想在诊断数据里加一个字段，就必须先改这里 ——
 * 而那一步会撞上 `panel-diagnostics-export.test.ts` 的形状守卫。
 *
 * 如果直接 `JSON.stringify({ ...collectFacts(), ...readDiag() })`，
 * 加字段是**无声的**，泄漏也是无声的。
 */
export interface ExportPayloadSource {
  rows: readonly DiagRow[];
  logs: readonly DiagEntry[];
  /** 扩展版本；调用方从 `chrome.runtime.getManifest().version` 取 */
  version: string;
  /** 导出时刻（注入以便测试固定） */
  now: Date;
  /**
   * 定位追踪（`pluma:diag-trace` 的最近一条）。
   *
   * ## 为什么必须进导出（2026-11-10 第七轮）
   *
   * 主日志是 30 条环形缓冲，`page/quality` 每几秒写一轮就能把它冲干净 ——
   * 定位信息活不下来。所以 `diag/facts` 的结果另写一条**覆盖式**追踪。
   *
   * 导出里带上它，smoke 就**一定能读到**，不依赖面板是否把那一块渲染出来。
   *
   * `null` = 没有追踪记录（还没触发过）。
   */
  trace: {
    at: number;
    step: string;
    detail: string;
    from: string;
  } | null;
  /**
   * `diag/facts` 应答里的调试回显（2026-11-10 第八轮）。
   *
   * ## 为什么它和 `trace` 并存
   *
   * `trace` 走 storage，**真机上写不进去**（smoke 实测）。
   * `echo` 走**消息应答**，从没丢过。
   *
   * 两个都放进导出：`trace` 能写就是额外信息，写不进时有 `echo` 兜底。
   *
   * 内容形如 `entered | incognito=ok:true windows=nil cookies=ERR:TypeError ...`。
   * `null` = 还没有 / 老版本 background。
   */
  echo: string | null;
}

/** 组装导出 JSON 的文本。**不开新的字段**，见上面注释 */
export function buildExportPayload(src: ExportPayloadSource): string {
  return JSON.stringify(
    {
      exportedAt: src.now.toISOString(),
      version: src.version,
      facts: src.rows,
      logs: src.logs,
      /**
       * ⚠️ 这是第五个字段。加它是因为**前四个装不下定位信息**
       * （`logs` 是环形缓冲，会被高频日志挤掉）。
       *
       * 它仍然遵守"绝不含凭据"：`detail` 只由 `diag/facts` 的应答摘要构成
       * （四项环境事实，不含任何凭据值、不含 token）。
       * `panel-diagnostics-export.test.ts` 的扫描覆盖了它。
       */
      trace: src.trace,
      /**
       * ⚠️ 第六个字段。理由与 `trace` 相同但更硬：
       * `trace` 走 storage 可能写不进，`echo` 走**消息应答**从没丢过。
       * 两者并存，任一路能通就能定位。
       *
       * 仍然不含凭据：内容只是四项环境事实的执行摘要
       * （`ok:true` / `nil` / `ERR:...` / `TIMEOUT`），不涉及任何账号数据。
       */
      echo: src.echo,
    },
    null,
    2,
  );
}

/** 导出文件名（带时间戳，避免多次导出互相覆盖） */
export function exportFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pluma-diag-${stamp}.json`;
}

/**
 * 触发浏览器下载。
 *
 * ## 为什么不用 `chrome.downloads`
 *
 * 那要申请 `downloads` 权限，而本项目**不新增权限**（`AGENTS.md` §3 决策 6 的邻域：
 * 能不加就不加）。Blob + `<a download>` 完全够用，且不经过扩展 API。
 *
 * ⚠️ 在 Shadow DOM 里创建 `<a>` 没问题 —— 但**必须 attach 到 document 才能点击**
 * （detached 元素在部分浏览器里 `click()` 不触发下载）。用完立刻摘掉。
 */
export function downloadJson(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  // 不渲染、不占位；只为让 click() 生效
  a.style.display = 'none';
  (document.body ?? document.documentElement).appendChild(a);
  a.click();
  a.remove();
  /**
   * 延迟 revoke：立刻 revoke 在部分浏览器里会让下载中断。
   * 用 setTimeout(0) 已经够 —— 点击是同步处理的。
   */
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** 一行自检事实：`ok===true` 绿 / `false` 红 / 省略中性 */
function factRow(r: DiagRow): HTMLElement {
  const row = el('div', `diag-row${r.ok === true ? ' ok' : r.ok === false ? ' bad' : ''}`);
  row.appendChild(el('span', 'diag-label', r.label));
  row.appendChild(el('span', 'diag-value', r.value));
  return row;
}

/** 一条诊断日志：`step` + 时间 + 可选 detail */
function logRow(e: DiagEntry): HTMLElement {
  const row = el('div', 'diag-log');
  const t = new Date(e.at);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  row.appendChild(el('span', 'diag-time', `${hh}:${mm}:${ss}`));
  row.appendChild(el('span', 'diag-step', e.step));
  if (e.detail) row.appendChild(el('span', 'diag-detail', e.detail));
  return row;
}

/**
 * 诊断二级浮层的界面。
 *
 * @param back 返回上一级
 */
export function diagnosticsPane(
  data: { rows: readonly DiagRow[]; logs: readonly DiagEntry[]; version: string },
  actions: { back: () => void; exportJson: () => void; refresh: () => void },
): HTMLElement {
  const box = el('div', 'tab-pane');

  const bar = el('div', 'sub-bar');
  const backBtn = el('button', 'sub-back');
  backBtn.type = 'button';
  backBtn.textContent = '‹ 返回';
  backBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.back();
  });
  bar.appendChild(backBtn);
  bar.appendChild(el('span', 'sub-title', '诊断'));

  /**
   * 手动刷新（2026-11-10 第七轮加）。
   *
   * 面板现在**每次进入诊断浮层都会重取**，这个按钮是给"我就在这一屏等着，
   * 想再看一次"的场景 —— 诊断工具最要紧的是能看到"现在此刻"的状态，
   * 而不是让人反复退出再进入。
   */
  const refreshBtn = el('button', 'sub-back', '⟳');
  refreshBtn.type = 'button';
  refreshBtn.setAttribute('aria-label', '重新采集');
  refreshBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.refresh();
  });
  bar.appendChild(refreshBtn);

  box.appendChild(bar);

  // ── 一句"该看哪"（与 options 同一个 tipFor）──
  box.appendChild(el('p', 'pane-note', tipFor(data.rows)));

  // ── 自检信息 ──
  box.appendChild(el('p', 'diag-section', '自检信息'));
  const facts = el('div', 'diag-facts');
  for (const r of data.rows) facts.appendChild(factRow(r));
  box.appendChild(facts);

  // ── 诊断日志 ──
  box.appendChild(el('p', 'diag-section', `诊断日志（最近 ${String(data.logs.length)} 条）`));
  if (data.logs.length === 0) {
    box.appendChild(el('p', 'pane-note', '还没有日志。'));
  } else {
    const logs = el('div', 'diag-logs');
    /**
     * **最新在上**（倒序显示）。
     *
     * `readDiag()` 返回的是时间正序（导出按那个顺序，见 `diag-store.ts` 的注释）。
     * 界面倒序是**渲染层的事**，不要为了显示去改数据层顺序。
     */
    for (const e of [...data.logs].reverse()) logs.appendChild(logRow(e));
    box.appendChild(logs);
  }

  // ── 导出 ──
  const exportBtn = el('button', 'sub-entry');
  exportBtn.type = 'button';
  exportBtn.appendChild(el('span', undefined, '导出诊断 JSON'));
  exportBtn.appendChild(el('span', 'sub-entry-hint', '不含任何凭据'));
  exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    actions.exportJson();
  });
  box.appendChild(exportBtn);

  box.appendChild(
    el(
      'p',
      'pane-note',
      '面板侧取流通道的结局会记在日志里（panel/page-state · kind=…），排查时先看它。',
    ),
  );

  return box;
}

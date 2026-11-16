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
 * 2. 本文件的 `buildExportPayload()` 只包**固定字段**，见那里的注释
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
 * 一次「读诊断日志」这件事本身**成没成**。
 *
 * ## 为什么必须有一个独立的"成没成"（2026-11-12，task-26）
 *
 * `readDiag()` 内部是 `catch { return [] }` —— **读失败和"真的一条都没有"
 * 返回的是同一个值 `[]`**。如果 `ok` 用 `logs.length > 0` 去推，那么
 * **孤儿态（`Extension context invalidated`）会被推成"没有日志"**，
 * 而这正是用户两次导出拿到 `"logs": []` 却以为是"没记录"的原因。
 *
 * 所以 `ok` 必须是**这次读取真的没抛错**，由 `panel.ts` 在调用点自己
 * try/catch 得到（**沿路看清：「不改 `readDiag()` 的返回值语义」**）。
 *
 * 详见 `poc/probe/diag-export/REPORT.md`。
 */
export interface LogsMeta {
  /** 本次是否真的读到了 storage。`false` = 读失败（孤儿态 / 权限），**不是"没有日志"** */
  ok: boolean;
  /**
   * 读失败时的错误串，已**白名单化 + 截断**（见 `describeLogsError()`）。
   * `null` = 没失败（或错误串本身不可识别）。
   */
  err: string | null;
  /** 读到的条数。`ok === false` 时恒为 0，但**必须结合 `ok` 看** */
  count: number;
  /** 环形缓冲上限（`DIAG_LIMIT`，从 `diag-store` 导入，不写死） */
  limit: number;
  /** 读日志的那个实例（split 下普通/无痕是两个 SW） */
  instanceId: string;
  /** 读取时刻（`Date.now()`） */
  readAt: number;
}

/**
 * 错误串**白名单化**。
 *
 * ## 为什么不能 `String(e)` 原样透传（2026-11-12，task-26）
 *
 * 导出包是整个项目里**唯一一个会离开本机的文件**，而这道防线是"只包固定字段"
 * （见 `buildExportPayload()`）。把 `String(e)` 直接放进去，等于给任何未来的
 * 异常对象开了一条**不受控的字符串出口** —— 它的 `message` 里有什么我们不知道
 * （可能是 DNR 规则全文、可能是带 cookie 的 URL）。
 *
 * 所以只认**已知的固定串**，其余一律归成 `'unknown'`；并且任何情况下都截断。
 * 用户仍然能区分"孤儿态"和"别的失败"，而不会有一字节未知内容被带出去。
 */
export function describeLogsError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  /**
   * 只认这几个固定串。`Extension context invalidated.` 是 Chrome 在
   * "content script 所属扩展上下文已被销毁"时的固定错误串 —— 它正是孤儿态的指纹。
   */
  const KNOWN: readonly [string, string][] = [
    ['Extension context invalidated', 'Extension context invalidated.'],
    ['chrome.runtime is undefined', 'chrome.runtime is undefined'],
    ['Cannot read properties of undefined', 'chrome.runtime is undefined'],
    ['The message port closed', 'The message port closed'],
  ];
  for (const [needle, label] of KNOWN) {
    if (raw.includes(needle)) return label;
  }
  return 'unknown';
}

/**
 * 导出 payload 的字段与顺序 —— **与 options 的 `exportDiag()` 一致**。
 *
 * ## 为什么写死这几个字段，而不是"把 rows 和 logs 原样 stringify"
 *
 * 因为"只包这几个"本身就是一道**凭据防线**：
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
   * 主日志是环形缓冲（上限 `DIAG_LIMIT`，见 `src/platform/storage/diag-store.ts`），
   * `page/quality` 每几秒写一轮就能把它冲干净 ——
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
  /**
   * 诊断日志这一次**读成没读成**（2026-11-12，task-26 第七个字段）。
   *
   * ## 为什么日志本身不够，还要一个"读成没读成"
   *
   * 用户两次导出拿到 `"logs": []`，以为"这台机器没记日志"，
   * 而实际是**孤儿态**（`Extension context invalidated`）—— `readDiag()`
   * 的静默 `catch { return [] }` 把"读失败"和"真没有"压成了同一个值。
   *
   * 只给 `count` 修不了这个缺陷：孤儿态下 `count` 依旧是 `0`，
   * 和"真的没有日志"**长得一模一样**。所以这里必须有独立的 `ok`。
   */
  logsMeta: LogsMeta;
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
      /**
       * ⚠️ 第七个字段（2026-11-12，task-26）。
       *
       * **仍然遵守"绝不含凭据"，而且这一条的约束比前六个更硬**，因为它带了一个
       * 自由文本字段 `err`。三道闸：
       *
       * 1. `err` **不是** `String(e)`，而是 `describeLogsError()` 的**白名单**
       *    输出（只可能是 `'Extension context invalidated.'` / `'unknown'` 等
       *    几个固定串），所以不存在"意外对象被带出去"这条路
       * 2. 其余五个字段都是**计数 / 布尔 / 实例 id / 时间戳**（`instanceId` 是
       *    `Math.random().toString(36)` 的 6 位，与任何账号无关）
       * 3. `panel-diagnostics-export.test.ts` 的形状守卫与凭据扫描都覆盖了它
       *
       * 为什么值得多加这一个字段：没有它，孤儿态导出的 `logs: []` 会
       * **伪装成"没有日志"**，而导出恰恰是最需要它诚实的那一刻。
       */
      logsMeta: src.logsMeta,
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

/**
 * 一行自检事实：`ok===true` 绿 / `false` 红 / 省略中性。
 *
 * ## 2026-11-16：行首加状态点
 *
 * 原来只有**数值**变颜色 —— 一屏十几行时，观众要靠读右列的每一个字才能判断
 * "哪几项不对"。加一个 6px 的点在最左列，这一列就成了纵向扫描轴（方案 §2.1 D3）。
 *
 * ⚠️ **`ok === undefined` 也要渲染一个透明点**：不能"没有状态就不占位"，
 * 否则同一列里有点与没点的行，标签起始位置差 12px，看起来像没对齐。
 */
function factRow(r: DiagRow): HTMLElement {
  const tone = r.ok === true ? ' ok' : r.ok === false ? ' bad' : '';
  const row = el('div', `diag-row${tone}`);
  row.appendChild(el('span', 'diag-dot'));
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
 * `logsMeta` **缺失时**的唯一兜底（渲染侧与导出侧共用，不许各写一份）。
 *
 * ## 为什么必须收敛到一处（2026-11-12，task-28）
 *
 * task-26 的崩溃原文是
 * `TypeError: Cannot read properties of undefined (reading 'ok')`
 * @ `diagnosticsPane` —— 渲染侧直接读了 `data.logsMeta.ok`，而**导出侧
 * 早就有一份 `?? {...}` 兜底**。「一侧有、一侧没有」这种**不对称**正是崩的原因：
 * 两个地方各自决定"缺了怎么办"，就总有一天忘了改其中一个。
 *
 * 只补 `:341` 还不够 —— 后面 `:357` 读 `.err` 会**接着崩**（verifier 独立复现：
 * 补第一处后错误后移到 `reading 'err'`）。所以**先把 `logsMeta` 收敛成变量**，
 * 后面每一处都读这个变量，从结构上消灭"第二处漏了"的可能。
 *
 * ## 为什么兜底语义是「不可信」而不是「正常」
 *
 * `ok: true` 会说"日志一切正常"，可我们**根本没拿到 `logsMeta`** ——
 * 那等于把一次崩溃换成一句谎话（用户看到「还没有日志。」而实际是读不到）。
 * 缺数据时唯一诚实的说法是**读失败**，所以 `ok: false` + `err: 'unknown'`，
 * 渲染出来就是「诊断日志读取失败 → 刷新页面」。
 *
 * `count: 0` 是事实（兜底时确实一条都没有），`limit` / `instanceId` / `readAt`
 * 只用于显示与定位，取中性值即可 —— **它们不参与"是否可信"的判断**。
 *
 * ## 本项目对「能否被真值覆盖」的判定依据（2026-11-12，task-28/29/30）
 *
 * 这是本轮收敛出来、engineer 与 verifier **双方独立同意**的口径
 * （verifier 的判据 D 落成「观测类相等、动作类允许不同」）。
 * 判断一个新字段该不该被覆盖，只看**它的主语是什么**：
 *
 * | 类别 | 字段 | 主语 | 能否用真值覆盖 |
 * | --- | --- | --- | --- |
 * | **观测结果** | `ok` / `err` / `count` | **日志存储**（"读到了没有"） | ❌ **不许** |
 * | **动作属性** | `limit` / `instanceId` / `readAt` | **这次读取 / 导出动作本身** | ✅ **可以** |
 *
 * 为什么这么分：
 * - 观测类字段来自 `probeLogsReadability()` 的**实际观测**。调用方没给数据时我们
 *   **没有观测**，用真值覆盖＝未做过的观测冒充观测结果，那是谎报。
 * - 动作类字段由**当前这个动作当场产生**（上限是编译期常量、实例 id 与时刻
 *   是此刻的），与"日志读没读到"**无关**。所以兜底时取中性占位、导出时取真值，
 *   两种情况下都在说真话。
 *
 * ⇒ 导出侧 `panel.ts` 的兜底因此写成
 * `{ ...describeLogsMetaFallback(), limit, instanceId, readAt }`
 * —— 只覆盖动作类，观测类保持兜底的"不可信"值。**两侧同源就靠这一条。**
 */
export function describeLogsMetaFallback(): LogsMeta {
  return { ok: false, err: 'unknown', count: 0, limit: 0, instanceId: 'unknown', readAt: 0 };
}

/**
 * 诊断二级浮层的界面。
 *
 * @param back 返回上一级
 */
export function diagnosticsPane(
  data: {
    rows: readonly DiagRow[];
    logs: readonly DiagEntry[];
    version: string;
    /**
     * ⚠️ **可以不传**：调用方在"还没采到诊断"时会传 `undefined`。
     * 全函数只通过下面这个 `meta` 变量读它，不许再写 `data.logsMeta.…`。
     */
    logsMeta?: LogsMeta | undefined;
  },
  actions: { back: () => void; exportJson: () => void; refresh: () => void },
): HTMLElement {
  const box = el('div', 'tab-pane');
  /**
   * ## 唯一的读取入口（task-28）
   *
   * 这个函数体内部**只有这一处**碰 `data.logsMeta`。下面 `:341` 与 `:357`
   * 两处崩溃点都改成读 `meta` → 结构上不可能再出现"补了一处漏了另一处"。
   */
  const meta: LogsMeta = data.logsMeta ?? describeLogsMetaFallback();

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
  /**
   * ## ⚠️ 读失败**不许**画成「还没有日志。」（2026-11-12，task-26）
   *
   * 用户最容易看到的就是这一行。旧实现只判 `logs.length === 0`，
   * 于是**孤儿态（扩展上下文已失效）**和**真的没记过日志**渲染出**完全相同**的
   * 「还没有日志。」—— 而前者是"页面需要刷新"，后者才是"一切正常"。
   *
   * 这是用户两次导出 `logs: []` 却以为"没记录"的同一类错误，只是发生在界面上。
   *
   * ⚠️ `ok === false` 与 `count === 0` **必须分开判**：前者是故障，后者是空态。
   */
  if (!meta.ok) {
    box.appendChild(el('p', 'diag-section', '诊断日志'));
    const failed = el('div', 'diag-row bad');
    // 与 factRow 同样的点占位，保证这一行与上面几行的标签左边缘对齐
    failed.appendChild(el('span', 'diag-dot'));
    failed.appendChild(el('span', 'diag-label', '诊断日志读取失败'));
    /**
     * 文案只说**用户能做的事**，不解释内部原因（§5.2：不把内部错误原样泼给用户）。
     * 孤儿态的处置就是刷新页面 —— 扩展更新后旧 content script 的 chrome API 已失效。
     */
    failed.appendChild(
      el('span', 'diag-value', '页面里的扩展已经失效（扩展可能刚更新过）—— 刷新页面后重开面板再看'),
    );
    box.appendChild(failed);
    /**
     * 把识别出来的错误串放在下面一行（已白名单化，不会带出未知内容）。
     * 它同时**出现在导出里**，真机排查时两者能对上。
     */
    if (meta.err !== null) {
      box.appendChild(el('p', 'pane-note', `（${meta.err}）`));
    }
  } else {
    box.appendChild(
      el(
        'p',
        'diag-section',
        `诊断日志（最近 ${String(data.logs.length)} 条${data.logs.length >= meta.limit ? `，已达上限 ${String(meta.limit)} 条，更早的被挤掉了` : ''}）`,
      ),
    );
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

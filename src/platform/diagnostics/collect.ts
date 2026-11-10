/**
 * 自检数据的采集 —— options「诊断」分区的唯一数据源。
 * （原独立自检页 2026-10-26 已并入并删除。）
 *
 * ## 为什么抽出来
 *
 * 这两处显示的是同一批事实（InPrivate 权限 / 分区 / 凭据 / DNR 规则 / 当前页取流数据）。
 * 抄两遍必然漂移 —— 而漂移的后果是**排障时两个页面给出不同结论**，那比只有一个页面更糟。
 *
 * ## 分层
 *
 * `platform/` 是唯一允许碰 `chrome.*` 的地方；本文件只采集"事实"，不做展示。
 * 文案（`tipFor`）虽然是文案，但它是对这批事实的**解读规则**，跟数据强耦合，
 * 所以也放这里 —— 两处 UI 都调它，就不会出现"一边说正常一边说异常"。
 */

import { queryPageState } from '@platform/page/page-state-client';
import { ROUTES_CHECKED_AT, ROUTES_REVISION } from '@shared/constants/routes';
import { readDiag, diag } from '@platform/storage/diag-store';
import type { PageTracksView, PrimaryBaselineReason } from '@shared/types/playinfo';

export interface DiagRow {
  label: string;
  value: string;
  /** `true` = 正常，`false` = 需要关注，省略 = 中性 */
  ok?: boolean;
}

/**
 * 主账号基线不可用的原因，翻成人话。
 *
 * ⚠️ `client-written` 是**最需要警惕**的一条：它意味着 `__playinfo__` 是页面发完
 * playurl 之后自己写的，那份数据属于播放账号身份。拿它当基线会让画质对比
 * 永远显示"没有提升"（ADR 0014 的验证门就是查这个）。
 */
const REASON_TEXT: Record<PrimaryBaselineReason, string> = {
  ssr: 'SSR，可用',
  'client-written': '⚠️ 客户端写入（播放账号身份）→ 不可用',
  absent: '页面没有 __playinfo__',
  unparsable: '有数据但解析不出轨道',
};

/**
 * 调用方**自己就在那个页面里**时（页内面板），直接传当前页数据。
 *
 * ## ⚠️ `undefined` 与 `null` 是两个不同的意思，**不要合并**
 *
 * | 传值 | 含义 | 行为 |
 * | --- | --- | --- |
 * | 不传（`undefined`） | "我不知道，你去查" | 走 `queryPageState()` —— **options 的现行行为** |
 * | `null` | "我查过了，就是没有" | **不查**，直接报"没有取流数据" |
 * | `PageTracksView` | "我手里就有" | **不查**，用它渲染那几行 |
 *
 * 合并这两者会出一个具体的错：面板在**首页 / 直播页**时手里就是 `null`，
 * 若当成 `undefined` 去 `queryPageState()`，那个函数会用 `chrome.tabs.query`
 * 找一个**别的**视频标签页 —— 于是面板在首页显示"打开任意视频页后可见"，
 * 甚至显示**另一个标签页**的取流数据。那是错的：面板说的是"当前页"。
 *
 * 单测：`tests/unit/platform/collect-injected-view.test.ts`。
 */
export interface CollectOptions {
  /** 见上方表格。不传 = 自己去查（options 行为不变） */
  pageView?: PageTracksView | null;
}

/** 当前页两侧的取流数据 —— ADR 0014 的验证门就看这几行 */
async function pageTracksRows(injected?: PageTracksView | null): Promise<DiagRow[]> {
  const rows: DiagRow[] = [];

  /**
   * 三种情况（见 `CollectOptions` 的表格）：
   *   - `undefined` → 自己去查（options）
   *   - `null`      → 调用方查过了，就是没有
   *   - 有对象      → 用调用方给的
   *
   * ⚠️ 用 `injected !== undefined` 而不是 `injected`：
   * 后者会把 `null` 也当成"没传"，于是面板在首页又去 `queryPageState()`，
   * 拿到**别的标签页**的数据 —— 那正是本参数要修的问题。
   */
  if (injected !== undefined) {
    if (injected === null) {
      rows.push({
        label: '当前页取流数据',
        value: '本页没有取流数据（首页 / 直播页，或本页不是播放页）',
      });
      return rows;
    }
    return pageTracksRowsFrom(injected, rows);
  }

  const res = await queryPageState();

  if (res.kind === 'no-tab') {
    rows.push({
      label: '当前页取流数据',
      value: '没有打开的 B站视频页 —— 先打开一个视频，再回来',
    });
    return rows;
  }
  if (res.kind === 'no-content-script') {
    rows.push({
      label: '当前页取流数据',
      value: `标签页「${res.title}」没有 content script —— 刷新那个视频页再试`,
    });
    return rows;
  }
  if (res.kind === 'not-ready') {
    rows.push({ label: '当前页取流数据', value: 'content 在，但还没报到（稍等再点一次）' });
    return rows;
  }

  return pageTracksRowsFrom(res.view, rows);
}

/**
 * 把一份 `PageTracksView` 渲染成诊断行。
 *
 * 从原 `pageTracksRows()` 的后半段**原样切出**（不重写逻辑），
 * 两条入口共用：options 走 `queryPageState()` 拿到的 view，面板走自己手里的 view。
 */
function pageTracksRowsFrom(v: PageTracksView, rows: DiagRow[]): DiagRow[] {
  const primary = v.primary;
  const playback = v.playback?.capability ?? null;

  rows.push({
    label: `主账号基线 · ${v.pageKey} P${String(v.p)}`,
    value:
      REASON_TEXT[primary.reason] +
      (primary.capability ? ` · 最高 ${String(primary.capability.maxHeight)}p` : ''),
    ok: primary.usable,
  });

  rows.push({
    label: '播放账号（页面 playurl 响应）',
    value:
      playback !== null
        ? `最高 ${String(playback.maxHeight)}p · ${String(playback.videoCount)} 条视频轨` +
          (playback.hasHiRes ? ' · Hi-Res' : '') +
          (playback.hasDolbyAudio ? ' · 杜比音频' : '')
        : v.playback === null
          ? '尚未收到 playurl 响应'
          : '收到但解析不出轨道',
    ...(playback !== null ? { ok: true } : {}),
  });

  rows.push({
    label: '对比结论',
    value: v.diff
      ? v.diff.improved
        ? `提升 ${String(v.diff.heightGain)}p` +
          (v.diff.frameRateGain > 0 ? ` · +${String(v.diff.frameRateGain)}fps` : '') +
          (v.diff.hiResGained ? ' · +Hi-Res' : '')
        : '无提升（两侧能力相同，或播放账号更弱）'
      : '无法比较（缺一侧数据）',
    ...(v.diff ? { ok: v.diff.improved } : {}),
  });

  rows.push({
    label: '主账号昵称（页面读取）',
    value: primary.user?.uname || '（未读到，可能未登录或页面还没就绪）',
  });

  return rows;
}

/** 总开关状态（只读） */
async function proxyState(): Promise<{ enabled: boolean; ruleCount: number }> {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'proxy/status' });
    if (r?.type === 'proxy/status:ok') return { enabled: r.enabled, ruleCount: r.ruleCount };
  } catch {
    // 读不到就按"关"处理 —— 宁可少代理，不可错代理
  }
  return { enabled: false, ruleCount: 0 };
}

/** 最近 1 小时的取流失败次数。读不到就当 0（不因为读不到而报警） */
async function recentFailures(): Promise<number> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'stats/recent' })) as
      { type?: string; buckets?: { ok: number; fail: number }[] } | undefined;
    if (r?.type !== 'stats/recent:ok' || !Array.isArray(r.buckets)) return 0;
    return r.buckets.reduce((n, b) => n + b.fail, 0);
  } catch {
    return 0;
  }
}

/**
 * 最近一次 `diag/facts` 应答里的 `echo`（调试验证用）。
 *
 * ## 为什么用模块级变量而不是返回值（2026-11-10 第八轮）
 *
 * `diagFacts()` 的返回值被 `collectFacts()` 用来拼四行自检；
 * 而 `echo` 只有排查时才需要。把它单开一路，调用方不用改签名就能读。
 *
 * ## 为什么不用 storage
 *
 * 前七轮证明 storage 通道在真机上不可靠（`diag()` 被挤掉、`trace()` 写不进）。
 * 这个变量活在 content script 的内存里，**同一次页面会话内一定读得到**。
 *
 * `null` = 还没有成功解析过应答 / 老版本 background 没回 echo。
 */
let lastDiagEcho: string | null = null;

/**
 * 读最近一次 `diag/facts` 的调试回显。
 *
 * 调用方（面板）把它放进导出 JSON，排查时**不依赖任何存储通道**。
 */
export function readLastDiagEcho(): string | null {
  return lastDiagEcho;
}

/**
 * 读诊断环境事实（`diag/facts`）。
 *
 * ## 为什么不能在这里直接调 chrome API
 *
 * 本函数有两个调用方：options 页（扩展页面）和**页内面板**（content script）。
 * 而在 content script 里 `chrome.windows` / `chrome.cookies` /
 * `chrome.declarativeNetRequest` / `chrome.extension.isAllowedIncognitoAccess`
 * **整个是 `undefined`**（2026-11-09 真机实测），不是权限不足 —— 是命名空间不存在。
 *
 * 所以统一走 background 代查，**两个调用方都走同一条路** ——
 * 那样 options 与面板的自检结论才不会因为运行环境不同而不一致。
 *
 * @returns 四项事实；任一项为 `null` 表示**那一项读失败**（不是"值是 0/false"）。
 *   整条消息失败时四项全 `null`。
 *
 *   ⚠️ `echo` 通过 `lastDiagEcho` 单独导出（见下方），因为调用方多数只关心四项。
 */
async function diagFacts(): Promise<{
  incognitoAllowed: boolean | null;
  windows: { total: number; incognito: number } | null;
  cookieStores: string[] | null;
  dnrRuleIds: { path: number[]; tab: number[] } | null;
}> {
  /** 四项全 null 的返回值。多处复用，避免各处抄一份 */
  const none = {
    incognitoAllowed: null,
    windows: null,
    cookieStores: null,
    dnrRuleIds: null,
  } as const;

  /**
   * ## 每一步都留痕（2026-11-10 第五轮，smoke 说"一条 diag/facts 日志都没有"）
   *
   * ### 为什么原实现会"零日志"
   *
   * 原来的结构是：
   * ```ts
   * try {
   *   const res = await sendMessage(...);
   *   if (res?.type === 'diag/facts:ok' && res.facts) { return 正常值; }
   * } catch { /* 静默 *\/ }
   * return 四项全 null;   // ← 不抛错、不写日志
   * ```
   *
   * **"零日志 + 四项全 null"至少有四种来源**，而它们在里面**完全同形**：
   *
   * | 来源 | 说明 |
   * | --- | --- |
   * | `sendMessage` 抛错 | 接收方不存在 / 扩展上下文失效 |
   * | 应答是 `undefined` | 有监听器 `return true` 却没调 `sendResponse` |
   * | `type` 不是 `:ok` | 走到了 `:err`（那时 background 侧**应该有**日志） |
   * | 形状对不上 | `facts` 字段缺失/改名 |
   *
   * 上一轮"零日志"被误读成"handler 从未被调用"，但那只排除了第一种。
   * 所以现在**每个分支都写一行**，并且把**原始应答 JSON** 打进日志 ——
   * 只要能看到它，根因立刻确定。
   *
   * ⚠️ 一律 `void ... .catch(() => {})`：诊断日志不能拖慢、更不能让自检失败。
   */
  const trace = (line: string): void => {
    void diag('diag/facts', line.slice(0, 300)).catch(() => {});
  };

  let res: unknown;
  try {
    res = await chrome.runtime.sendMessage({ type: 'diag/facts' });
    /**
     * ## 先记原始应答，再解析
     *
     * 这一行是本轮最关键的信息：它区分"没到 background"与"到了但应答不对"。
     * ⚠️ 用 `JSON.stringify` 前先处理 undefined / 循环引用 ——
     * `JSON.stringify(undefined)` 返回 `undefined`（不是字符串），
     * 直接 `.slice()` 会抛 TypeError，而那会让诊断本身炸掉。
     */
    let raw: string;
    try {
      const s = JSON.stringify(res);
      raw = s === undefined ? 'undefined' : s;
    } catch {
      raw = String(res);
    }
    trace(`reply: ${raw.slice(0, 280)}`);
  } catch (e) {
    const detail =
      e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : String(e);
    trace(`send-error: ${detail.slice(0, 200)}`);
    return none;
  }

  // 分支 1：空应答 —— 有监听器 return true 却没 sendResponse，或根本没到 background
  if (!res) {
    trace('branch: empty-reply');
    return none;
  }

  const r = res as { type?: unknown; facts?: unknown };

  // 分支 2：type 不是 :ok（含 :err / 类型名不匹配 / 根本没 type）
  if (r.type !== 'diag/facts:ok') {
    trace(`branch: ${typeof r.type === 'string' ? r.type : '(no-type)'}`);
    return none;
  }

  // 分支 3：:ok 但 facts 缺失
  if (!r.facts) {
    trace('branch: no-facts');
    return none;
  }

  const f = r.facts as {
    incognitoAllowed?: boolean | null;
    windows?: { total: number; incognito: number } | null;
    cookieStores?: string[] | null;
    dnrRuleIds?: { path: number[]; tab: number[] } | null;
  };

  /**
   * 分支 4：解析成功。
   *
   * ⚠️ 这一条 `trace()` 写的是 storage —— 前七轮已经证明它在真机上可能写不进去。
   * 所以**同时**把 `echo` 存到模块级变量，供 `collectFacts()` 的调用方读走、
   * 最终进导出 JSON（不依赖 storage）。
   */
  const rawEcho = (res as { echo?: unknown }).echo;
  lastDiagEcho = typeof rawEcho === 'string' ? rawEcho : null;
  trace(
    `branch: ok | incognito=${String(f.incognitoAllowed)} ` +
      `windows=${f.windows ? String(f.windows.total) : 'null'} ` +
      `cookies=${Array.isArray(f.cookieStores) ? f.cookieStores.join(',') : 'null'} ` +
      `dnr=${f.dnrRuleIds ? `${String(f.dnrRuleIds.path.length)}/${String(f.dnrRuleIds.tab.length)}` : 'null'}`,
  );

  return {
    incognitoAllowed: typeof f.incognitoAllowed === 'boolean' ? f.incognitoAllowed : null,
    windows:
      f.windows && typeof f.windows.total === 'number'
        ? { total: f.windows.total, incognito: f.windows.incognito }
        : null,
    cookieStores: Array.isArray(f.cookieStores)
      ? f.cookieStores.filter((s): s is string => typeof s === 'string')
      : null,
    dnrRuleIds:
      f.dnrRuleIds && Array.isArray(f.dnrRuleIds.path) && Array.isArray(f.dnrRuleIds.tab)
        ? { path: f.dnrRuleIds.path, tab: f.dnrRuleIds.tab }
        : null,
  };
}

/**
 * 采集全部自检事实。
 *
 * ⚠️ **每项独立**：某一项读失败只影响那一项，不会把整份状态抹平成
 * "什么都没配置"（`proxy.handler` 里踩过这个坑，见它的注释）。
 */
export async function collectFacts(opts: CollectOptions = {}): Promise<DiagRow[]> {
  const rows: DiagRow[] = [];
  const put = (label: string, value: unknown, ok?: boolean): void => {
    rows.push({ label, value: String(value), ...(ok === undefined ? {} : { ok }) });
  };

  /**
   * 先取环境事实（一次往返）。下面 1) / 3) / 4) / 7) 都用它。
   *
   * ⚠️ 不要改成在这里直接 `chrome.windows.getAll()` —— 面板是 content script，
   * 那些命名空间不存在（见 `diagFacts()` 的注释）。
   */
  const facts = await diagFacts();

  // 1) InPrivate 权限 —— 这是整个隔离登录方案的前置条件
  if (facts.incognitoAllowed === null) {
    // 读不到 → **不 put ok**（中性行），绝不写成"未允许"——那是把未知当失败
    put('InPrivate 权限', '读取失败（background 未返回这一项）');
  } else {
    put('InPrivate 权限', facts.incognitoAllowed ? '已允许' : '未允许', facts.incognitoAllowed);
  }

  // 2) 当前页取流数据
  //
  // ⚠️ 把 `opts.pageView` **原样传下去**（可能是 `undefined` / `null` / 对象），
  // 不要在这里做 `?? undefined` 之类的归一 —— 三者语义不同，见 `CollectOptions`。
  for (const r of await pageTracksRows(opts.pageView)) rows.push(r);

  // 3) 窗口
  if (facts.windows === null) {
    put('窗口列表', '读取失败（background 未返回这一项）');
  } else {
    put('可见窗口数', facts.windows.total);
    put('无痕窗口数（当前分区可见）', facts.windows.incognito);
  }

  // 4) cookie 分区
  if (facts.cookieStores === null) {
    put('cookie 分区', '读取失败（background 未返回这一项）');
  } else {
    put('可见 cookie 分区', facts.cookieStores.join(', ') || '(空)');
  }

  // 5) 凭据是否已配置
  try {
    const bag = await chrome.storage.local.get('pluma:vault:blob');
    const has = !!bag['pluma:vault:blob'];
    put('播放账号凭据', has ? '已配置' : '未配置', has);
  } catch (e) {
    put('凭据状态', '读取失败: ' + String(e));
  }

  // 6) 总开关
  //
  // ⚠️ `ok` 不能只看 enabled：开关开着但规则数为 0 是**最危险的状态** ——
  // 代码以为在代理，实际一条规则都没有。这里必须标红，否则自检页会骗人。
  const proxy = await proxyState();
  const ruleCountKnown = proxy.ruleCount >= 0;
  const consistent = !proxy.enabled || !ruleCountKnown || proxy.ruleCount > 0;
  const countText = !ruleCountKnown
    ? '规则数读不到（background 侧失败）'
    : `${String(proxy.ruleCount)} 条路径规则${consistent ? '' : '，⚠️ 不一致'}`;
  put('播放代理总开关', proxy.enabled ? `已开启（${countText}）` : '已关闭', consistent);

  // 7) DNR 规则 —— "取流是否生效"的直接证据
  //
  // ⚠️ 读不到时**不产出行**（走 `tipFor()` 的 `undefined` 中性分支），
  // 不要 `put('DNR 全局路径规则', '读取失败')` —— 那一行会带上 label，
  // 于是 `tipFor()` 会找到它并认为"读到了"，判据就退化成 `ok === undefined`。
  if (facts.dnrRuleIds !== null) {
    const pathRules = facts.dnrRuleIds.path;
    const tabRules = facts.dnrRuleIds.tab;

    /**
     * `ok` 的判据：数组长度 > 0。
     *
     * ⚠️ 注意"读到了 0 条"与"读不到"是两件事：
     *   - 读到 0 条 → `ok: false` → `tipFor()` **允许报警**（规则确实没装上）
     *   - 读不到   → **不产出行** → `tipFor()` 走中性分支
     */
    put('DNR 全局路径规则', pathRules.length, pathRules.length > 0);
    for (const id of pathRules.slice(0, 5)) put(`  ${String(id)}`, '(规则 id)', true);

    put('DNR 标签页规则', tabRules.length, tabRules.length > 0);
    for (const id of tabRules.slice(0, 5)) put(`  ${String(id)}`, '(标签页规则 id)', true);
  }

  // 8) manifest
  try {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
      incognito?: string;
    };
    put('manifest incognito', manifest.incognito ?? '(未设置)');
  } catch {
    put('manifest incognito', '读取失败');
  }

  // 9) 白名单版本 —— **纯信息，永远中性色**
  //
  // 不做"超过 N 天就变琥珀"：B站 一年不改接口的话白名单一年不用动，
  // 那个颜色会一直亮着，最后没人看。日期回答的是"这份清单是哪天的"，不是"它过期了"。
  put('代理路径白名单', `r${String(ROUTES_REVISION)} · 核对于 ${ROUTES_CHECKED_AT}`);

  // 10) **按证据报警**：只有真的出现取流失败，才提示"可能是接口变了"
  const fails = await recentFailures();
  if (fails > 0) {
    put(
      '白名单是否过期',
      `最近 ${String(fails)} 次取流失败 —— 如果刷新后仍持续，可能是接口路径变了，` +
        '去仓库看看有没有新版本',
    );
  }

  return rows;
}

/**
 * 根据事实给一句"该看哪"的解读。
 *
 * 两处 UI 都调它 —— 否则会出现"自检页说正常、诊断分区说异常"这种自相矛盾。
 *
 * ## ⚠️ 三态判据：`ok === false`（失败）/ `ok === true`（正常）/ **行不存在（未知）**
 *
 * ### 2026-11-10 真机修的恐慌性误报
 *
 * 现场：4K 正常在播、总开关显示「已开启（3 条路径规则）」，
 * 而诊断浮层顶部红字报「代理开了但全局规则没装上 —— 打开视频页不会生效」。
 *
 * 根因：`DNR 全局路径规则` 那一行**只在 `getSessionRules()` 成功时才被 `put()`**
 * （它在 `try` 块里）。而**面板的 content script 环境里 `chrome.declarativeNetRequest`
 * 整个是 `undefined`** → 抛错 → 走 catch → 那一行**根本不存在**。
 *
 * 于是 `!pathRow?.ok` 对 `undefined` 求值为 `true` → 触发"没装上"。
 *
 * 这是把**"读不到（未知）"当成"没装上（失败）"** —— 与 `02-ui-spec.md` §7
 * 「把'开关关闭'表达成功能失败」是同一类错误。而且它在**任何页面都会误报**，
 * 用户看到会以为功能坏了。
 *
 * ### 现在的判据
 *
 * | 情况 | 含义 | 文案 |
 * | --- | --- | --- |
 * | `row === undefined` | 那项压根没产出行（读取失败/环境不支持） | **中性**："状态未知"，不报警 |
 * | `row.ok === false` | 读到了，且确实是坏的 | **报警** |
 * | `row.ok === true` | 读到了，正常 | 往下走 |
 *
 * ⚠️ 不要写 `!row?.ok` —— 那两条会被合并成同一条路径。
 */
export function tipFor(rows: readonly DiagRow[]): string {
  const proxyRow = rows.find((r) => r.label === '播放代理总开关');
  const pathRow = rows.find((r) => r.label === 'DNR 全局路径规则');
  const tabRow = rows.find((r) => r.label === 'DNR 标签页规则');
  // 主账号基线优先：它是 ADR 0014 的验证门，比 DNR 状态更值得先看
  const primaryRow = rows.find((r) => r.label.startsWith('主账号基线'));

  if (primaryRow && primaryRow.ok === false) {
    return '主账号基线不可用';
  }

  /**
   * 总开关。
   *
   * ⚠️ 与下面两条不同：**没有这一行**时也要报警。
   * 理由：`播放代理总开关` 是 `collectFacts()` 里**无条件 `put()`** 的
   * （不在 try 里，见 `proxyState()` 的 `put`）。所以正常情况下它永远存在；
   * 不存在只可能是调用方喂了残缺数据 —— 那种情况说"读不到"比说"已关闭"安全。
   */
  if (proxyRow && proxyRow.ok === false) {
    return '代理已关闭，所有请求以主账号身份发出（开关在面板「画质」Tab）。';
  }
  if (proxyRow === undefined) {
    return '代理状态未知（这一项没有采到）。';
  }

  // ── DNR 全局路径规则：三态 ──
  if (pathRow === undefined) {
    /**
     * ⚠️ 文案里**不许出现"没装上"四个字**。
     *
     * 单测断言的是 `not.toContain('没装上')` —— 如果中性文案自己带这四个字，
     * 那条断言会永远红（或者反过来，一旦有人把它改成"可能没装上"就骗过了测试）。
     * 中性就要**彻底中性**：只说"未知"，不说任何与失败相近的词。
     */
    return '规则状态未知：当前环境读不到 DNR 规则，这不代表规则没生效。';
  }
  if (pathRow.ok === false) {
    return '代理开了但全局规则没装上 —— 打开视频页不会生效，检查 background 的启动自愈日志。';
  }

  // ── DNR 标签页规则：三态 ──
  if (tabRow === undefined) {
    return '全局规则正常；标签页规则状态未知（当前环境读不到）。';
  }
  if (tabRow.ok === false) {
    return '全局规则正常。标签页规则为 0 表示当前没有打开视频页（正常）。';
  }

  return '规则齐全。两者都有 = 视频页正在被代理。';
}

/** 诊断日志（时间正序）。条数上限见 `diag-store` 的 `DIAG_LIMIT` */
export { readDiag };
export type { DiagEntry } from '@platform/storage/diag-store';

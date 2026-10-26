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
import { readDiag } from '@platform/storage/diag-store';
import type { PrimaryBaselineReason } from '@shared/types/playinfo';

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

/** 当前页两侧的取流数据 —— ADR 0014 的验证门就看这几行 */
async function pageTracksRows(): Promise<DiagRow[]> {
  const rows: DiagRow[] = [];
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

  const v = res.view;
  const primary = v.primary;
  const playback = v.playback?.capability ?? null;

  rows.push({
    label: `主账号基线 · ${v.bvid} P${String(v.p)}`,
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
 * 采集全部自检事实。
 *
 * ⚠️ **每项独立 try**：某一项读失败只影响那一项，不会把整份状态抹平成
 * "什么都没配置"（`proxy.handler` 里踩过这个坑，见它的注释）。
 */
export async function collectFacts(): Promise<DiagRow[]> {
  const rows: DiagRow[] = [];
  const put = (label: string, value: unknown, ok?: boolean): void => {
    rows.push({ label, value: String(value), ...(ok === undefined ? {} : { ok }) });
  };

  // 1) InPrivate 权限 —— 这是整个隔离登录方案的前置条件
  try {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    put('InPrivate 权限', allowed ? '已允许' : '未允许', allowed);
  } catch (e) {
    put('InPrivate 权限', '读取失败: ' + String(e));
  }

  // 2) 当前页取流数据
  for (const r of await pageTracksRows()) rows.push(r);

  // 3) 窗口
  try {
    const wins = await chrome.windows.getAll();
    put('可见窗口数', wins.length);
    put('无痕窗口数（当前分区可见）', wins.filter((w) => w.incognito).length);
  } catch (e) {
    put('窗口列表', '读取失败: ' + String(e));
  }

  // 4) cookie 分区
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    put('可见 cookie 分区', stores.map((s) => s.id).join(', ') || '(空)');
  } catch (e) {
    put('cookie 分区', '读取失败: ' + String(e));
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
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const pathRules = rules.filter((r) => r.id >= 10000 && r.id < 11000);
    const tabRules = rules.filter((r) => r.id >= 20000 && r.id < 30000);

    put('DNR 全局路径规则', pathRules.length, pathRules.length > 0);
    for (const r of pathRules.slice(0, 5)) {
      put(`  ${r.id}`, `filter=${r.condition.urlFilter ?? '-'}`, true);
    }

    put('DNR 标签页规则', tabRules.length, tabRules.length > 0);
    for (const r of tabRules.slice(0, 5)) {
      put(
        `  ${r.id}`,
        `tabIds=[${(r.condition.tabIds ?? []).join(',')}] filter=${r.condition.urlFilter ?? '-'}`,
        true,
      );
    }

    // 不属于我们的规则也报出来，避免"规则数对不上"的困惑
    const ours = new Set([...pathRules, ...tabRules].map((r) => r.id));
    const others = rules.filter((r) => !ours.has(r.id));
    if (others.length > 0) put('DNR 其他规则', others.length);
  } catch (e) {
    put('DNR 规则', '读取失败: ' + String(e));
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
 */
export function tipFor(rows: readonly DiagRow[]): string {
  const proxyRow = rows.find((r) => r.label === '播放代理总开关');
  const pathRow = rows.find((r) => r.label === 'DNR 全局路径规则');
  const tabRow = rows.find((r) => r.label === 'DNR 标签页规则');
  // 主账号基线优先：它是 ADR 0014 的验证门，比 DNR 状态更值得先看
  const primaryRow = rows.find((r) => r.label.startsWith('主账号基线'));
  const playbackRow = rows.find((r) => r.label.startsWith('播放账号（页面'));

  if (primaryRow && primaryRow.ok === false) {
    return (
      '主账号基线不可用 —— 这正是 ADR 0014 验证门没过的样子：画质对比会显示「未知」' +
      '而不是编一个数字。若原因写着「客户端写入」，说明 __playinfo__ 不是 SSR 的。'
    );
  }
  if (primaryRow?.ok && playbackRow?.ok) {
    return '两侧数据都在。「对比结论」那行就是 popup §2.3 显示的内容。';
  }
  if (!proxyRow?.ok) {
    return '代理已关闭，所有请求以主账号身份发出（开关在 popup 里）。';
  }
  if (!pathRow?.ok) {
    return '代理开了但全局规则没装上 —— 打开视频页不会生效，检查 background 的启动自愈日志。';
  }
  if (!tabRow?.ok) {
    return '全局规则正常。标签页规则为 0 表示当前没有打开视频页（正常）。';
  }
  return '规则齐全。两者都有 = 视频页正在被代理。';
}

/** 诊断日志（时间正序）。条数上限见 `diag-store` 的 `DIAG_LIMIT` */
export { readDiag };
export type { DiagEntry } from '@platform/storage/diag-store';

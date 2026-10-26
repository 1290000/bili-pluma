/**
 * 诊断页 —— 一键查看扩展当前真实状态。
 *
 * 为什么需要：InPrivate 权限 / 分区可见性这类问题，光看现象猜不出来。
 * 让用户一键打开这个页面，比反复试探快得多。
 */

import '@/src/design/tokens.css';
import './style.css';

import type { PageTracksView, PrimaryBaselineReason } from '@shared/types/playinfo';

interface Row {
  label: string;
  value: string;
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
 * 找"要查哪个标签页"。
 *
 * ⚠️ **不能用 `query({ active: true, currentWindow: true })`。**
 * 本页是 `options_ui.open_in_tab` 打开的，它自己就是活动标签页 ——
 * 那样查到的永远是自检页，`sendMessage` 必然失败，看起来像"没有 content script"。
 *
 * 所以按 URL 过滤 B站视频页，再在其中优先选活动的、否则选最近访问的。
 */
async function pickVideoTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs
    .query({ url: ['*://*.bilibili.com/video/*'] })
    .catch(() => [] as chrome.tabs.Tab[]);
  if (tabs.length === 0) return null;

  const active = tabs.find((t) => t.active);
  if (active) return active;

  // 没有活动的就取最近访问的（`lastAccessed` 缺失时退化成第一个）
  return tabs.reduce<chrome.tabs.Tab>((best, t) => {
    const a = t.lastAccessed ?? 0;
    const b = best.lastAccessed ?? 0;
    return a > b ? t : best;
  }, tabs[0] as chrome.tabs.Tab);
}

/** 直连当前标签页的 content script，取两侧取流数据 */
async function readPageTracks(): Promise<Row[]> {
  const rows: Row[] = [];

  const tab = await pickVideoTab();
  if (!tab || typeof tab.id !== 'number') {
    rows.push({
      label: '当前页取流数据',
      value: '没有打开的 B站视频页 —— 先打开一个视频，再回到这里',
    });
    return rows;
  }

  let reply: { type?: string; view?: PageTracksView; reason?: string } | undefined;
  try {
    reply = await chrome.tabs.sendMessage(tab.id, { type: 'page/summary:get' });
  } catch {
    // 没有 content script（页面在扩展安装前就打开了 / 扩展刚更新）时 sendMessage 会抛
    rows.push({
      label: '当前页取流数据',
      value: `标签页「${tab.title ?? tab.url ?? '?'}」没有 content script —— 刷新那个视频页再试`,
    });
    return rows;
  }

  if (reply?.type !== 'page/summary:ok' || !reply.view) {
    rows.push({ label: '当前页取流数据', value: 'content 在，但还没报到（稍等再点一次）' });
    return rows;
  }

  const v = reply.view;
  const primary = v.primary;
  const playback = v.playback?.capability ?? null;

  rows.push({
    label: `主账号基线 · ${v.bvid} P${String(v.p)}`,
    value:
      `${REASON_TEXT[primary.reason]}` +
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

/**
 * 读取总开关状态（只读）。
 *
 * 这里是**调试页**，只显示状态供排查用。
 * 切换开关属于产品 UI，归 popup，不放这里。
 */
async function readProxyState(): Promise<{ enabled: boolean; ruleCount: number }> {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'proxy/status' });
    if (r?.type === 'proxy/status:ok') return { enabled: r.enabled, ruleCount: r.ruleCount };
  } catch {
    // 忽略，返回默认
  }
  return { enabled: false, ruleCount: 0 };
}

async function collect(): Promise<Row[]> {
  const rows: Row[] = [];

  const put = (label: string, value: unknown, ok?: boolean): void => {
    rows.push({ label, value: String(value), ...(ok === undefined ? {} : { ok }) });
  };

  // 1) InPrivate 权限
  try {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    put('InPrivate 权限', allowed ? '已允许' : '未允许', allowed);
  } catch (e) {
    put('InPrivate 权限', '读取失败: ' + String(e));
  }

  // 1b) ★ 当前页的取流数据 —— ADR 0014 的验证门就查这几行
  for (const r of await readPageTracks()) rows.push(r);

  // 2) 窗口
  try {
    const wins = await chrome.windows.getAll();
    put('可见窗口数', wins.length);
    put('无痕窗口数（当前分区可见）', wins.filter((w) => w.incognito).length);
  } catch (e) {
    put('窗口列表', '读取失败: ' + String(e));
  }

  // 3) cookie 分区
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    put('可见 cookie 分区', stores.map((s) => s.id).join(', ') || '(空)');
  } catch (e) {
    put('cookie 分区', '读取失败: ' + String(e));
  }

  // 4) 凭据是否已配置
  try {
    const bag = await chrome.storage.local.get('pluma:vault:blob');
    const has = !!bag['pluma:vault:blob'];
    put('播放账号凭据', has ? '已配置' : '未配置', has);
  } catch (e) {
    put('凭据状态', '读取失败: ' + String(e));
  }

  // 4b) 总开关（ADR 0006 硬性配套）
  //
  // ⚠️ `ok` 标记不能只看 enabled。开关开着但规则数为 0 是**最危险的状态**——
  // 代码以为在代理，实际一条规则都没有。这里必须标红，否则自检页会骗人。
  const proxy = await readProxyState();

  /**
   * 一致性判定要分清"确认没规则"和"读不到规则"。
   *
   * `ruleCount === -1` 是 background 报的"读不到"（API 抛错），
   * 这时不能说"不一致"，只能说"背景侧读不到"——后者是要排查的另一个问题。
   *
   * ⚠️ 这里曾经把 -1 当成 0 处理，导致诊断页显示"⚠️ 不一致"，
   * 而下面第 5 节自己调 getSessionRules() 又能看到 2 条规则，
   * 两行数字互相矛盾，反而增加排查成本。
   */
  const ruleCountKnown = proxy.ruleCount >= 0;
  const proxyConsistent = !proxy.enabled || !ruleCountKnown || proxy.ruleCount > 0;

  const countText = !ruleCountKnown
    ? '规则数读不到（background 侧失败）'
    : `${String(proxy.ruleCount)} 条路径规则${proxyConsistent ? '' : '，⚠️ 不一致'}`;

  put('播放代理总开关', proxy.enabled ? `已开启（${countText}）` : '已关闭', proxyConsistent);

  // 5) ★ DNR 规则 —— 这是"取流是否生效"的直接证据
  // 分两类：全局路径规则（10000-10999）+ 标签页限定规则（20000-29999）
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

    // 其他规则（不属于我们的）也报出来，避免"规则数对不上"的困惑
    const ours = new Set([...pathRules, ...tabRules].map((r) => r.id));
    const others = rules.filter((r) => !ours.has(r.id));
    if (others.length > 0) put('DNR 其他规则', others.length);
  } catch (e) {
    put('DNR 规则', '读取失败: ' + String(e));
  }

  // 6) manifest
  try {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
      incognito?: string;
    };
    put('manifest incognito', manifest.incognito ?? '(未设置)');
  } catch {
    put('manifest incognito', '读取失败');
  }

  // 7) 诊断日志
  try {
    const bag = await chrome.storage.local.get('pluma:diag');
    const list =
      (bag['pluma:diag'] as
        { at: number; step: string; detail?: string; from?: string }[] | undefined) ?? [];
    if (list.length === 0) {
      put('诊断日志', '（空）');
    } else {
      for (const e of list.slice(-12)) {
        const time = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
        const tag = e.from ? `[${e.from}] ` : '';
        put(`${time} ${tag}${e.step}`, e.detail ?? '');
      }
    }
  } catch (e) {
    put('诊断日志', '读取失败: ' + String(e));
  }

  return rows;
}

function render(rows: Row[]): void {
  const root = document.getElementById('app');
  if (!root) return;

  root.innerHTML = '';

  const h = document.createElement('h1');
  h.className = 'title';
  h.textContent = 'Pluma 自检';
  root.appendChild(h);

  const list = document.createElement('div');
  list.className = 'rows';

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';

    const k = document.createElement('span');
    k.className = 'key';
    k.textContent = r.label;

    const v = document.createElement('span');
    v.className = 'val' + (r.ok === true ? ' good' : r.ok === false ? ' bad' : '');
    v.textContent = r.value;

    row.append(k, v);
    list.appendChild(row);
  }

  root.appendChild(list);

  const tip = document.createElement('p');
  tip.className = 'tip';
  // 代理状态已经在 rows 里显示，这里只给解读提示
  const proxyRow = rows.find((r) => r.label === '播放代理总开关');
  const pathRow = rows.find((r) => r.label === 'DNR 全局路径规则');
  const tabRow = rows.find((r) => r.label === 'DNR 标签页规则');

  // 主账号基线优先：它是 ADR 0014 的验证门，比 DNR 状态更值得先看
  const primaryRow = rows.find((r) => r.label.startsWith('主账号基线'));
  const playbackRow = rows.find((r) => r.label.startsWith('播放账号（页面'));

  if (primaryRow && primaryRow.ok === false) {
    tip.textContent =
      '主账号基线不可用 —— 这正是 ADR 0014 验证门没过的样子：画质对比会显示「未知」' +
      '而不是编一个数字。若原因写着「客户端写入」，说明 __playinfo__ 不是 SSR 的，' +
      '需要回到决策阶段重选基线来源。';
  } else if (primaryRow?.ok && playbackRow?.ok) {
    tip.textContent =
      '两侧数据都在。「对比结论」那行就是 popup §2.3 将要显示的内容 —— ' +
      '先确认它符合预期，再做界面。';
  } else if (!proxyRow?.ok) {
    tip.textContent = '代理已关闭，所有请求以主账号身份发出（开关在 P2 的 popup 里）。';
  } else if (!pathRow?.ok) {
    tip.textContent =
      '代理开了但全局规则没装上 —— 打开视频页不会生效，检查 background 的启动自愈日志。';
  } else if (!tabRow?.ok) {
    tip.textContent = '全局规则正常。标签页规则为 0 表示当前没有打开视频页（正常）。';
  } else {
    tip.textContent = '规则齐全。两者都有 = 视频页正在被代理。';
  }
  root.appendChild(tip);
}

void collect().then(render);

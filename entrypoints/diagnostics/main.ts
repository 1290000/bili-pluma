/**
 * 诊断页 —— 一键查看扩展当前真实状态。
 *
 * 为什么需要：InPrivate 权限 / 分区可见性这类问题，光看现象猜不出来。
 * 让用户一键打开这个页面，比反复试探快得多。
 */

import '@/src/design/tokens.css';
import './style.css';

interface Row {
  label: string;
  value: string;
  ok?: boolean;
}

/**
 * 读取总开关状态（只读）。
 *
 * 这里是**调试页**，只显示状态供排查用。
 * 切换开关属于产品 UI，归 P2 的 popup，不放这里。
 */
async function readProxyState(): Promise<{ enabled: boolean }> {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'proxy/status' });
    if (r?.type === 'proxy/status:ok') return { enabled: r.enabled };
  } catch {
    // 忽略，返回默认
  }
  return { enabled: false };
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
  const proxy = await readProxyState();
  put('播放代理总开关', proxy.enabled ? '已开启' : '已关闭', proxy.enabled);

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

  if (!proxyRow?.ok) {
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

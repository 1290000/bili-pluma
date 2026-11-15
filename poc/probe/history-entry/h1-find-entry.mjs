/**
 * H1 探测：找 B 站首页右上角「历史」入口。
 *
 * 只读：不点击任何东西，只读 DOM 与属性。
 * 输出：候选元素的选择器、位置、有没有 shadowRoot。
 */
import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const SESSION = process.env.BSK_SESSION;

function evaluate(expr) {
  // ⚠️ 表达式是**位置参数**（`bsk evaluate --session S --tab-id T --json <EXPR>`），
  // 不是 `--expr`。`shell:false` + 数组参数 = 不经过任何 shell 转义（`!` / 引号原样传）。
  const r = spawnSync(
    BSK,
    ['evaluate', '--session', SESSION, '--tab-id', process.env.BSK_TAB, '--json', expr],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
  );
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  if (r.status !== 0) {
    throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 500)}`);
  }
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const out = {};

  // 1) 找所有可能的历史入口：href 含 history 的链接
  const links = [...document.querySelectorAll('a[href*="history"]')].map(a => ({
    href: a.getAttribute('href'),
    cls: a.className,
    text: (a.textContent || '').trim().slice(0, 20),
    parentCls: a.parentElement ? a.parentElement.className : null,
    shadow: a.shadowRoot !== null,
  }));
  out.historyLinks = links.slice(0, 10);

  // 2) 顶栏区域：header 相关的顶层容器
  const headerSel = ['header', '.bili-header', '.bili-header__bar', '.mini-header', '[class*="header"]'];
  out.headers = [];
  for (const sel of headerSel) {
    const els = [...document.querySelectorAll(sel)].slice(0, 4);
    for (const el of els) {
      out.headers.push({
        sel,
        tag: el.tagName,
        cls: String(el.className).slice(0, 120),
        id: el.id || null,
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        hasShadow: el.shadowRoot !== null,
      });
    }
  }

  // 3) 全局统计：页面里有没有任何 shadow host（open）
  const hosts = [...document.querySelectorAll('*')].filter(el => el.shadowRoot !== null);
  out.openShadowHosts = hosts.slice(0, 15).map(el => ({
    tag: el.tagName,
    cls: String(el.className).slice(0, 100),
    id: el.id || null,
  }));
  out.openShadowHostCount = hosts.length;

  // 4) 自定义元素（web component 的强提示：标签名含连字符）
  const custom = [...document.querySelectorAll('*')].filter(el => el.tagName.includes('-'));
  out.customElements = [...new Set(custom.map(el => el.tagName.toLowerCase()))].slice(0, 30);

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));

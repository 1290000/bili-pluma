/**
 * H4c：hover → **在浮层仍挂载时**立刻探测（上一轮因为浮层已卸载导致误判）。
 *
 * 上一轮的教训：`v-popover.is-bottom` 容器常驻，但内容（`v-popover-content` 里的列表）
 * 是**按需注入 / 移出时清空**的 —— 所以"能查到容器"不等于"查到了浮层内容"。
 * 这里的判据是：**浮层内容区（history-panel-popover）里有真实渲染出的后代**。
 */
import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const SESSION = process.env.BSK_SESSION;
const TAB = process.env.BSK_TAB;

function evaluate(expr) {
  const r = spawnSync(
    BSK,
    ['evaluate', '--session', SESSION, '--tab-id', TAB, '--json', expr],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
  );
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  if (r.status !== 0) throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 600)}`);
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const VOID = new Set(['img','br','hr','input','meta','link','source','track','wbr','area','base','col','embed','param']);

  const entry = document.querySelector('.v-popover-wrap.history-entry');
  const trigger = entry.querySelector('.right-entry__item-trigger') || entry;
  const r0 = trigger.getBoundingClientRect();
  for (const t of ['mouseover','mouseenter','mousemove']) {
    trigger.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window,
      clientX: Math.round(r0.x + r0.width/2), clientY: Math.round(r0.y + r0.height/2) }));
  }
  await sleep(1200);   // 等 Vue 渲染

  // ── 定位浮层内容区（不是那个常驻的 v-popover 壳）──
  const panel = document.querySelector('.history-panel-popover');
  if (!panel) return JSON.stringify({ fatal: 'history-panel-popover not found after hover' });

  const rendered = [...panel.querySelectorAll('*')].filter(e => {
    const rr = e.getBoundingClientRect();
    return rr.width > 0 && rr.height > 0;
  });

  out.panel = {
    cls: String(panel.className),
    childCount: panel.children.length,
    childCls: [...panel.children].map(c => String(c.className).slice(0,80)),
    innerHTMLLen: panel.innerHTML.length,
    renderedDescendantCount: rendered.length,
    rect: (() => { const rr = panel.getBoundingClientRect(); return {x:Math.round(rr.x),y:Math.round(rr.y),w:Math.round(rr.width),h:Math.round(rr.height)}; })(),
  };

  // ── H4 核心：这个内容区里有没有 shadow host？──
  out.openShadowHostsInsidePanel = [...panel.querySelectorAll('*')]
    .filter(e => e.shadowRoot !== null)
    .map(e => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0,80) }));

  // ── closed shadow 交叉排除（限定在浮层内，排除 void）──
  const suspects = [];
  for (const el of panel.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (VOID.has(tag)) continue;
    if (el.shadowRoot !== null) continue;
    if (el.childNodes.length !== 0) continue;
    const rr = el.getBoundingClientRect();
    if (rr.width < 40 || rr.height < 20) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    suspects.push({ tag, cls: String(el.className).slice(0,80), w: Math.round(rr.width), h: Math.round(rr.height) });
  }
  out.closedShadowSuspectsInPanel = suspects.slice(0, 15);

  // ── H2 结构：历史条目 ──
  const items = [...panel.querySelectorAll('a[href*="/video/"]')].slice(0, 3);
  out.historyItems = items.map(a => ({
    tag: a.tagName,
    href: a.getAttribute('href'),
    cls: String(a.className).slice(0, 100),
    parentCls: a.parentElement ? String(a.parentElement.className).slice(0, 100) : null,
    grandParentCls: a.parentElement && a.parentElement.parentElement
      ? String(a.parentElement.parentElement.className).slice(0, 100) : null,
  }));
  out.historyItemCount = panel.querySelectorAll('a[href*="/video/"]').length;

  // 条目容器（列表）
  const listCand = [...panel.querySelectorAll('*')].filter(e =>
    /list|content|item/i.test(String(e.className)) && e.querySelectorAll('a[href*="/video/"]').length > 2);
  out.listContainers = [...new Set(listCand.map(e => String(e.className)))].slice(0, 10);

  // ── 「查看全部」入口 ──
  const allLink = [...panel.querySelectorAll('a,[class*="more"],[class*="footer"]')]
    .filter(e => /全部|更多|history/.test(e.textContent || '') || /history\/?$/.test(e.getAttribute && e.getAttribute('href') || ''))
    .slice(0, 5)
    .map(e => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0,80),
                 text: (e.textContent||'').trim().slice(0,20), href: e.getAttribute('href') || null }));
  out.viewAllLinks = allLink;

  // ── 顶部 tab（今天/昨天/更早 之类的分区） ──
  out.tabs = [...panel.querySelectorAll('[class*="tabs-panel__item"]')]
    .map(e => ({ cls: String(e.className).slice(0,80), text: (e.textContent||'').trim().slice(0,10) }));

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));

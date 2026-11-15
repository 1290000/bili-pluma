/**
 * H4 复核：排除 img 等自闭合元素后，重新确认「没有 closed shadow host」。
 *
 * 第一轮的 `closedShadowSuspects` 全是 `<img>` —— img 本来就没有子节点，
 * 那是**假阳性**。这里只保留"可能是容器"的标签，并加一条更强的判据：
 * 若某元素是 closed shadow host，它的 `attachShadow` 已被调用过，外部无法再挂；
 * 可用 `el.shadowRoot === null && el.childNodes.length === 0 && 有渲染尺寸`
 * 同时成立来怀疑，但**必须排除 void 元素**（img/br/hr/input...）。
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
  if (!entry) return JSON.stringify({ fatal: 'entry missing' });
  const trigger = entry.querySelector('.right-entry__item-trigger') || entry;
  const r0 = trigger.getBoundingClientRect();
  for (const t of ['mouseover','mouseenter','mousemove']) {
    trigger.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window,
      clientX: Math.round(r0.x + r0.width/2), clientY: Math.round(r0.y + r0.height/2) }));
  }
  await sleep(900);

  // ── 复核 1：open shadow host（排除 bsk overlay）──
  const openHosts = [...document.querySelectorAll('*')]
    .filter(el => el.shadowRoot !== null && el.tagName.toLowerCase() !== 'browser-skill-overlay');
  out.openShadowHostsExcludingBsk = openHosts.map(el => ({
    tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,100), id: el.id || null,
  }));

  // ── 复核 2：可能是 closed shadow host 的容器（排除 void 元素）──
  const suspects = [];
  for (const el of document.querySelectorAll('body *')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'browser-skill-overlay') continue;
    if (VOID.has(tag)) continue;                       // ← 关键：排除 void 元素
    if (el.shadowRoot !== null) continue;              // open，已记录
    if (el.childNodes.length !== 0) continue;          // 有子节点 = 普通 DOM
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    suspects.push({ tag, cls: String(el.className).slice(0,100), id: el.id || null,
      w: Math.round(r.width), h: Math.round(r.height) });
  }
  out.closedShadowSuspectsAfterVoidExclusion = suspects.slice(0, 20);

  // ── 复核 3：浮层内部再扫一遍（若浮层内容在 closed shadow 里，浮层容器自身会是"空壳"）──
  const pop = document.querySelector('.v-popover.is-bottom');
  if (pop) {
    out.popover = {
      cls: String(pop.className),
      childCount: pop.children.length,
      childCls: [...pop.children].map(c => String(c.className).slice(0,80)),
      innerHTMLLen: pop.innerHTML.length,
      // 浮层内是否还有 open shadow host
      innerOpenShadowHosts: [...pop.querySelectorAll('*')].filter(e => e.shadowRoot !== null).length,
      // 浮层内有多少个真正渲染出内容的元素（>0 说明内容就在普通 DOM 里）
      renderedDescendants: [...pop.querySelectorAll('*')].filter(e => {
        const rr = e.getBoundingClientRect(); return rr.width > 0 && rr.height > 0;
      }).length,
    };
  }

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));

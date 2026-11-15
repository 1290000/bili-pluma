/**
 * H4 探测：悬停历史入口 → 浮层是不是 shadow DOM。
 *
 * ## 判定纪律（cross-check，两法交叉）
 *
 * 1. **open 扫描**：`document.querySelectorAll('*')` 里 `shadowRoot !== null` 的 → open shadow host
 * 2. **closed 排除**：closed shadow host 从外部看 `shadowRoot === null`，但
 *    - 它的 `children` / `innerHTML` 为空却渲染出了内容，或
 *    - `getBoundingClientRect()` 有尺寸但无子节点
 *    两条任一成立 = 疑似 closed
 *
 * ⚠️ bsk 自己的 `browser-skill-overlay` 是 open shadow host，**必须排除**它。
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
  if (r.status !== 0) {
    throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 600)}`);
  }
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const entry = document.querySelector('.v-popover-wrap.history-entry');
  if (!entry) return JSON.stringify({ fatal: 'history-entry not found' });

  out.entrySelector = '.v-popover-wrap.history-entry';
  out.beforeHover = {
    children: entry.children.length,
    childCls: [...entry.children].map(c => String(c.className).slice(0, 80)),
  };

  // ── hover 触发 ──
  const trigger = entry.querySelector('.right-entry__item-trigger') || entry;
  const rect = (trigger || entry).getBoundingClientRect();
  out.triggerRect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };

  // 用真实 mouse 事件模拟（mouseenter/mouseover/mousemove 都发，覆盖不同监听方式）
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
    trigger.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(rect.x + rect.width / 2),
      clientY: Math.round(rect.y + rect.height / 2),
    }));
  }
  await sleep(900);

  // ── 探测 1：open shadow host 全量扫描（排除 bsk 自己）──
  const allHosts = [...document.querySelectorAll('*')].filter(el => el.shadowRoot !== null);
  out.openShadowHosts = allHosts.map(el => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className).slice(0, 100),
    id: el.id || null,
    isBskOverlay: el.tagName.toLowerCase() === 'browser-skill-overlay',
  }));
  out.openShadowHostCountExcludingBsk = allHosts.filter(el => el.tagName.toLowerCase() !== 'browser-skill-overlay').length;

  // ── 探测 2：浮层容器候选 ──
  // v-popover 会在 hover 后往 wrap 里插一个浮层；也可能挂到 body 上
  const wrapAfter = [...entry.children].map(c => String(c.className).slice(0, 100));
  out.entryChildrenAfterHover = wrapAfter;

  const cands = [];
  const push = (el, how) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    cands.push({
      how,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 120),
      id: el.id || null,
      childCount: el.children.length,
      innerHTMLLen: (el.innerHTML || '').length,
      textLen: (el.textContent || '').trim().length,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      position: getComputedStyle(el).position,
      shadow: el.shadowRoot !== null,
      isBskOverlay: el.tagName.toLowerCase() === 'browser-skill-overlay',
    });
  };

  // 2a. entry 的子节点（v-popover 的常见挂载点）
  for (const c of entry.children) push(c, 'entry-child');
  // 2b. entry 内任意 popover 类名的元素
  for (const el of entry.querySelectorAll('[class*="popover"],[class*="content"],[class*="panel"]')) push(el, 'entry-descendant:popover-like');
  // 2c. body 直接子的新增节点（挂到 body 的方案）
  for (const c of document.body.children) {
    const cls = String(c.className);
    if (/popover|history|dropdown|popper|tooltip/i.test(cls)) push(c, 'body-child:name-match');
  }
  out.candidates = cands;

  // ── 探测 3：closed shadow 的交叉排除 ──
  // 找"有尺寸、有渲染、但 children.length===0 且 innerHTML 为空"的元素 = 疑似 closed host
  const suspects = [];
  const scan = document.querySelectorAll('body *');
  for (const el of scan) {
    if (el.tagName.toLowerCase() === 'browser-skill-overlay') continue;
    if (el.shadowRoot !== null) continue;            // open，已在探测 1 记录
    if (el.children.length !== 0) continue;           // 有子节点 = 普通 DOM
    if ((el.textContent || '').trim().length > 0) continue; // 有文本 = 普通 DOM
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) continue;      // 太小，不值得怀疑
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    suspects.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 100),
      id: el.id || null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  out.closedShadowSuspects = suspects.slice(0, 20);

  out.hoveredSuccessfully = cands.some(c => c.rect.h > 40 && c.rect.w > 100);

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));

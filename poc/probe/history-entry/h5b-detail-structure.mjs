/**
 * H5b：历史详情页列表结构 + 无限滚动判据。
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
  if (r.status !== 0) throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 800)}`);
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  const list = document.querySelector('.history-list');
  if (!list) return JSON.stringify({ fatal: 'no .history-list' });

  out.listCls = list.className;
  out.directChildren = [...list.children].slice(0, 5)
    .map(c => ({ tag: c.tagName.toLowerCase(), cls: String(c.className).slice(0, 80) }));

  // 分组（按日期）
  const groups = [...list.querySelectorAll('.history-section')];
  out.groupCount = groups.length;
  out.groupHeadings = groups.slice(0, 6).map(g => {
    const h = g.querySelector('p, h1, h2, h3, [class*="date"], [class*="title"]');
    return { cls: String(g.className).slice(0, 60),
             heading: h ? (h.textContent || '').trim().slice(0, 20) : null };
  });

  // 条目
  const items = [...list.querySelectorAll('.bili-video-card')];
  out.itemCount = items.length;
  out.sampleItem = items[0] ? {
    cls: String(items[0].className).slice(0, 120),
    innerCls: [...items[0].querySelectorAll('[class]')].slice(0, 10)
      .map(e => String(e.className).slice(0, 60)),
    hasDeleteBtn: !!items[0].querySelector('[class*="delete"], [class*="remove"]'),
  } : null;

  // 无限滚动判据：记录滚动前的条目数，滚到底再数
  const beforeCount = items.length;
  const beforeHeight = document.documentElement.scrollHeight;
  window.scrollTo(0, document.documentElement.scrollHeight);
  await sleep(2500);
  const afterCount = list.querySelectorAll('.bili-video-card').length;
  const afterHeight = document.documentElement.scrollHeight;

  out.infiniteScroll = {
    beforeCount, afterCount,
    beforeHeight, afterHeight,
    grew: afterCount > beforeCount || afterHeight > beforeHeight,
  };

  out.hasPaginationControl = [...document.querySelectorAll('[class*="pagination"],[class*="pager"]')]
    .map(e => String(e.className).slice(0, 80)).slice(0, 5);

  // 回到顶部（恢复现场）
  window.scrollTo(0, 0);

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));

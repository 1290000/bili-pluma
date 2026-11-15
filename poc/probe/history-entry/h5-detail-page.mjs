/**
 * H5 探测：历史详情页 —— 独立页面还是 SPA 路由？分页 / 无限滚动？
 *
 * 判据：
 *   1. 从首页点「查看全部」（或直接导航）到 /history 后，
 *      `performance.getEntriesByType('navigation')[0].type` 与 document 是否**整体重载**
 *   2. 列表容器 + 是否有分页控件 / 滚动加载
 *   3. 详情页首屏请求（是否同样打 history/cursor）
 */
import { spawnSync } from 'node:child_process';

const BSK = process.env.BSK_BIN || 'bsk';
const SESSION = process.env.BSK_SESSION;
const TAB = process.env.BSK_TAB;

function evaluate(expr, tab) {
  const r = spawnSync(
    BSK,
    ['evaluate', '--session', SESSION, '--tab-id', tab || TAB, '--json', expr],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false },
  );
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  if (r.status !== 0) throw new Error(`evaluate failed (${r.status}): ${(r.stderr || out).slice(0, 800)}`);
  const parsed = JSON.parse(out);
  const v = parsed.value ?? parsed.result ?? parsed;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const EXPR = String.raw`(() => {
  const out = {};
  out.href = location.href;
  out.title = document.title;

  // 1) 这是独立页面吗：刷新计数标记（由外部注入）是否存在
  out.hasOldMarker = !!window.__HIST_MARKER__;

  // 2) 列表容器
  const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
  out.videoAnchorCount = anchors.length;

  // 候选列表容器：包含多个 video 链接的最近公共祖先
  const containers = [...document.querySelectorAll('*')].filter(el =>
    el.querySelectorAll('a[href*="/video/"]').length > 3);
  out.listContainers = [...new Set(
    containers.map(el => String(el.className)).filter(Boolean)
  )].slice(0, 12);

  // 3) 分页控件
  out.pagination = [...document.querySelectorAll('[class*="pagination"],[class*="pager"],[class*="page-"]')]
    .slice(0, 6).map(el => String(el.className).slice(0, 80));

  // 4) 滚动加载：页面高度 vs 视口
  out.scroll = {
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    bodyHeight: document.body.scrollHeight,
  };

  // 5) 首屏条目结构（前 2 条）
  out.sampleItems = anchors.slice(0, 2).map(a => ({
    tag: a.tagName,
    href: a.getAttribute('href'),
    cls: String(a.className).slice(0, 120),
    parentCls: a.parentElement ? String(a.parentElement.className).slice(0, 120) : null,
    grandCls: a.parentElement && a.parentElement.parentElement
      ? String(a.parentElement.parentElement.className).slice(0, 120) : null,
  }));

  // 6) 有没有「删除历史」类按钮（只统计，不点击）
  out.dangerButtons = [...document.querySelectorAll('*')]
    .filter(el => el.children.length === 0 && /^(删除|清除)/.test((el.textContent || '').trim()))
    .slice(0, 5)
    .map(el => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80),
                  text: (el.textContent || '').trim().slice(0, 10) }));

  return JSON.stringify(out);
})()`;

console.log(evaluate(EXPR));

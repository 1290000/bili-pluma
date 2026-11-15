// Q0 生死线（修正版 v2）：首屏 SSR 那 10 张卡，是否独立于 rcmd 返回？
//
// ## 为什么 v1 的判据不成立
//
// v1 只比「SSR 的 BV 序列 S」与「rcmd 一次响应的 BV 序列 R」的重合度，
// 但 feed/rcmd 是**随机推荐接口**，两次请求本来就不会一样 ——
// 「重合度低」可以被随机性解释，**不能证明独立性**。
//
// ## v2 三个实验（缺一不可）
//
//   Q0-a  同一时刻对照：同一会话、同一身份、几秒内
//         ① include-cookie fetch 首页主文档 → S（SSR 内联推荐 BV 序列）
//         ② 紧接着 fetch 一次 feed/rcmd → R
//         比 |S ∩ R|
//
//   Q0-b  基线对照（**没有它 Q0-a 无效**）：
//         连发两次 feed/rcmd → R1、R2，比 |R1 ∩ R2|
//         这是"随机推荐的自然重合度"。只有 |S ∩ R| **显著低于**它，"独立一批"才成立。
//
//   Q0-c  DOM 顺序：页面加载稳定后 DOM 前 10 个 BV vs S
//         直接回答"用户看到的第 1–10 张到底是不是 SSR 那批"
//
// ## 红线
// 只读：fetch 主文档 / 拦截响应 / 滚动。不点击视频、不发写请求、不登录登出、不打印凭据。
//
// 用法：
//   node poc/probe/feed-cover/probe-q0-bv-overlap.mjs --session <sid> --tab <tab>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};

const SESSION = arg('session');
const TAB = arg('tab');
if (!SESSION || !TAB) {
  console.error('用法：node probe-q0-bv-overlap.mjs --session <sid> --tab <tab>');
  process.exit(2);
}

const BSK_ENV = {
  ...process.env,
  BSK_HOME: process.env.BSK_HOME || 'C:\\Users\\i1290\\.bsk',
  BSK_AUTO_START: '0',
};

const evaluate = (expr) =>
  execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), expr], {
    env: BSK_ENV,
    encoding: 'utf8',
    shell: false, // shell:true 会二次解析 ! 与 "
    maxBuffer: 64 * 1024 * 1024,
  });

// 全部逻辑放在页面里跑（一次 evaluate 完成三个实验），避免多次跨 IPC 造成时序漂移
const MAIN_EXPR = `(async () => {
  const RCMD = '/x/web-interface/wbi/index/top/feed/rcmd';
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const uniq = (a) => [...new Set(a)];
  const inter = (a, b) => { const B = new Set(b); return [...new Set(a)].filter((x) => B.has(x)); };

  const out = { steps: [], meta: { url: location.href, at: new Date().toISOString() } };

  // ── ① SSR 主文档（include cookie，与真实首屏同身份）──
  const htmlRes = await fetch('https://www.bilibili.com/?_t=' + Date.now(), {
    credentials: 'include', cache: 'no-store',
  });
  const html = await htmlRes.text();

  // SSR 内联推荐的精确提取：
  //
  // 2026-11-11 实测：bili-video-card 字面量在 HTML 里出现 269 次
  // （绝大多数在 CSS 规则与 JS 里），而 is-rcmd 恰好 10 次 —— 那 10 次才是真卡片。
  // v1 按 bili-video-card 切分会命中 CSS → 每片取不到 BV → S 全 null（已修正）。
  //
  // 正确做法：只认 <div class="bili-video-card is-rcmd ..."> 这种标签开头形态。
  //
  // ⚠️ 模板字符串里 \b \d \s 会被吞成 "b" "d" "s" —— 必须写 \\b。
  //    2026-11-11 踩过一次：写成 \bbili-video-card\b 导致 0 命中、S 全空。
  const CARD_OPEN_RE = /<div class="[^"]*\\bbili-video-card\\b[^"]*\\bis-rcmd\\b[^"]*"/g;
  const opens = [];
  let mm;
  while ((mm = CARD_OPEN_RE.exec(html)) !== null) {
    opens.push({ start: mm.index, end: mm.index + mm[0].length });
  }
  const ssrCards = [];
  for (let i = 0; i < opens.length; i++) {
    const segEnd = i + 1 < opens.length ? opens[i + 1].start : Math.min(html.length, opens[i].start + 6000);
    const seg = html.slice(opens[i].start, segEnd);
    const bv = (seg.match(BV_RE) || [])[0] || null;
    // 标题：优先 .bili-video-card__info--tit 的 title 属性
    const title =
      (seg.match(/bili-video-card__info--tit[^>]*title="([^"]{1,80})"/) || [, ''])[1] ||
      (seg.match(/title="([^"]{4,80})"/) || [, ''])[1] ||
      '';
    ssrCards.push({ bv, title });
    if (ssrCards.length >= 30) break;
  }
  const S = ssrCards.map((c) => c.bv).filter(Boolean);
  out.steps.push({
    name: 'SSR-HTML',
    htmlLen: html.length,
    rcmdOccur: (html.match(/bili-video-card[^"]*is-rcmd/g) || []).length,
    cardCount: ssrCards.length,
    S,
    ssrCards,
  });

  // ── ② 连发两次 feed/rcmd（Q0-b 基线）──
  const fetchRcmd = async (label) => {
    const url = 'https://api.bilibili.com' + RCMD +
      '?web_location=1430650&ps=12&fresh_type=4&fresh_idx=1&fresh_idx_1h=1&fresh_type_val=_t' + Date.now();
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    const items = j?.data?.item || [];
    return {
      label, status: j?.code,
      rawCount: items.length,
      bvs: items.map((it) => it?.bvid).filter(Boolean),
      gotos: items.map((it) => it?.goto ?? null),
    };
  };

  const Rc1 = await fetchRcmd('R1');
  await new Promise((r) => setTimeout(r, 1200));
  const Rc2 = await fetchRcmd('R2');
  out.steps.push({ name: 'rcmd-R1', ...Rc1 });
  out.steps.push({ name: 'rcmd-R2', ...Rc2 });

  // ── ③ DOM（页面已加载稳定后，读取真实渲染顺序）──
  await new Promise((r) => setTimeout(r, 800));
  const cards = [...document.querySelectorAll('.bili-video-card')];
  const domCards = cards.map((c, i) => {
    const t = c.querySelector('.bili-video-card__info--tit');
    return {
      idx: i,
      isRcmd: c.classList.contains('is-rcmd'),
      bv: (c.innerHTML.match(BV_RE) || [])[0] || null,
      title: (t?.getAttribute('title') || t?.textContent || '').trim().slice(0, 40),
    };
  });
  const domSeq = domCards.map((c) => c.bv).filter(Boolean);
  out.steps.push({ name: 'DOM', domCardCount: cards.length, domSeq, domCards: domCards.slice(0, 20) });

  // ── 计算 ──
  const Sset = uniq(S);
  const R1 = uniq(Rc1.bvs);
  const R2 = uniq(Rc2.bvs);
  const SR1 = inter(Sset, R1);
  const SR2 = inter(Sset, R2);
  const R1R2 = inter(R1, R2);
  const domFirst10 = domSeq.slice(0, 10);
  const ssrFirst10 = Sset.slice(0, 10);
  const domMatchesSsrExactly = JSON.stringify(domFirst10) === JSON.stringify(ssrFirst10);

  out.calc = {
    // Q0-a
    a: {
      size_S: Sset.length, size_R1: R1.length,
      intersection_S_R1: SR1.length,
      ratio_S_in_R1: Sset.length ? +(SR1.length / Sset.length).toFixed(3) : null,
      S_in_R1_bvs: SR1,
      S_not_in_R1_bvs: Sset.filter((x) => !R1.includes(x)),
    },
    // Q0-b 基线
    b: {
      size_R1: R1.length, size_R2: R2.length,
      intersection_R1_R2: R1R2.length,
      baseline_ratio: (R1.length + R2.length) ? +( (2 * R1R2.length) / (R1.length + R2.length) ).toFixed(3) : null,
      R1_R2_common_bvs: R1R2,
    },
    // 第二个 SSR 口径（对 R2）
    a2: {
      intersection_S_R2: SR2.length,
      ratio_S_in_R2: Sset.length ? +(SR2.length / Sset.length).toFixed(3) : null,
    },
    // Q0-c
    c: {
      domFirst10, ssrFirst10,
      domMatchesSsrExactly,
      ssr_10_all_in_dom: ssrFirst10.every((bv) => domSeq.includes(bv)),
      dom_first10_all_in_ssr: domFirst10.every((bv) => Sset.includes(bv)),
    },
  };

  return JSON.stringify(out);
})()`
  // bsk evaluate 的表达式是位置参数；IIFE 末必须 )()，否则 stringify Promise 得到 {}
  .concat('');

function main() {
  console.log('=== 运行 Q0（页面内一次完成 a/b/c）===');
  const raw = evaluate(MAIN_EXPR);
  let result;
  try {
    const s = raw.indexOf('{');
    result = JSON.parse(raw.slice(s));
  } catch (e) {
    console.error('解析失败，原始输出：');
    console.error(raw.slice(0, 4000));
    process.exit(1);
  }

  // ── 人可读摘要 ──
  const c = result.calc;
  console.log('\n### Q0-a：SSR ∩ rcmd 首次');
  console.log(`  |S(SSR)| = ${c.a.size_S}, |R1| = ${c.a.size_R1}`);
  console.log(`  |S ∩ R1| = ${c.a.intersection_S_R1}  (S 覆盖率 ${(c.a.ratio_S_in_R1 * 100).toFixed(1)}%)`);
  console.log(`  S 中不在 R1 里的: ${c.a.S_not_in_R1_bvs.length} 个 →`, c.a.S_not_in_R1_bvs.join(', '));
  console.log(`  S 中在 R1 里的:   ${c.a.S_in_R1_bvs.length} 个 →`, c.a.S_in_R1_bvs.join(', '));

  console.log('\n### Q0-b：基线（两次 rcmd 的自然重合度）');
  console.log(`  |R1| = ${c.b.size_R1}, |R2| = ${c.b.size_R2}`);
  console.log(`  |R1 ∩ R2| = ${c.b.intersection_R1_R2}, 基线重合率 = ${(c.b.baseline_ratio * 100).toFixed(1)}%`);
  console.log(`  共同 BV:`, c.b.R1_R2_common_bvs.join(', '));

  console.log('\n### Q0-c：DOM 前 10 vs SSR 前 10');
  console.log('  DOM 前10 :', JSON.stringify(c.c.domFirst10));
  console.log('  SSR 前10 :', JSON.stringify(c.c.ssrFirst10));
  console.log(`  完全一致（含顺序）= ${c.c.domMatchesSsrExactly}`);
  console.log(`  SSR 10 全在 DOM 里   = ${c.c.ssr_10_all_in_dom}`);
  console.log(`  DOM 前10 全在 SSR 里 = ${c.c.dom_first10_all_in_ssr}`);

  // ── 原始列表（Lead 要求可自行核对）──
  const ssr = result.steps.find((s) => s.name === 'SSR-HTML');
  const r1 = result.steps.find((s) => s.name === 'rcmd-R1');
  const r2 = result.steps.find((s) => s.name === 'rcmd-R2');
  const dom = result.steps.find((s) => s.name === 'DOM');

  console.log('\n### 原始 BV 列表（可自行核对重合度）');
  console.log('\nSSR (S):');
  (ssr?.ssrCards || []).forEach((x, i) => console.log(`  ${String(i).padStart(2)} ${x.bv}  ${x.title}`));
  console.log(`\nR1 (feed/rcmd 第1次, status=${r1?.status}, raw=${r1?.rawCount}):`);
  (r1?.bvs || []).forEach((bv, i) => console.log(`  ${String(i).padStart(2)} ${bv}  goto=${r1.gotos?.[i]}`));
  console.log(`\nR2 (feed/rcmd 第2次, status=${r2?.status}, raw=${r2?.rawCount}):`);
  (r2?.bvs || []).forEach((bv, i) => console.log(`  ${String(i).padStart(2)} ${bv}  goto=${r2.gotos?.[i]}`));
  console.log(`\nDOM (前 20 张, 总 ${dom?.domCardCount}):`);
  (dom?.domCards || []).forEach((x) => console.log(`  ${String(x.idx).padStart(2)} isRcmd=${x.isRcmd}  ${x.bv}  ${x.title}`));

  // ── 落盘原始 JSON ──
  fs.writeFileSync('poc/probe/feed-cover/q0-result.json', JSON.stringify(result, null, 2), 'utf8');
  console.log('\n原始 JSON 已写入 poc/probe/feed-cover/q0-result.json');
}

main();

/**
 * feed-boundary 探针：用 iframe（**禁止执行脚本**）交叉验证 SSR 卡片数。
 *
 * ## 为什么需要这一路
 * Q1 主路是"字符串统计 HTML"，理论上可能与"解析后的 DOM 卡片数"不同。
 * 这里用 `<iframe sandbox>`（**不给 allow-scripts**）加载首页：
 * 浏览器会解析 HTML 并构建 DOM，但**一行 JS 都不执行**。
 * 这最接近"document_start 之后、rcmd 之前"的真实 DOM。
 *
 * ⚠️ sandbox 无 allow-scripts 时是 opaque origin，`contentDocument` 可读
 * （需要 `allow-same-origin`，但那会启用脚本能力……所以改为只统计 iframe 不读 DOM，
 *  靠 `srcdoc` 方式拿不到真实页面）。
 *
 * 因此这里改用**等价可行**的办法：在主文档里用 `DOMParser` 解析同一份 HTML。
 * `DOMParser` 构建的文档**不执行脚本**、不加载资源，是纯解析结果。
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-q1b-domparser.mjs --session <sid> --tab <tabId> [--rounds 5]');
  process.exit(2);
}

const ROUNDS = Number(get('--rounds') || 5);

const SAMPLE = `(async()=>{
  const h=await fetch('https://www.bilibili.com/?_t='+Date.now(),{credentials:'include',cache:'no-store'}).then(r=>r.text());
  const doc=new DOMParser().parseFromString(h,'text/html');
  const cards=doc.querySelectorAll('.bili-video-card');
  const rcmdCards=doc.querySelectorAll('.bili-video-card.is-rcmd');
  // 每张卡的 BV（判"是真实卡还是骨架"）
  const bvs=[...rcmdCards].map(e=>{
    const a=e.querySelector('a[href*="/video/BV"]');
    return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null;
  });
  const withBv=bvs.filter(Boolean).length;
  const titles=doc.querySelectorAll('.bili-video-card__info--tit').length;
  return JSON.stringify({allCards:cards.length,rcmdCards:rcmdCards.length,withBv,titles});
})()`;

const rows = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const r = evaluate(session, tab, SAMPLE);
  try {
    const p = JSON.parse(r.out);
    rows.push(p);
    console.log(`第 ${i} 次: .bili-video-card=${p.allCards}  .is-rcmd=${p.rcmdCards}  有BV=${p.withBv}  标题=${p.titles}`);
  } catch {
    console.log(`第 ${i} 次 FAIL: ${(r.err || r.out || '').slice(0, 200)}`);
  }
  if (i < ROUNDS) evaluate(session, tab, `new Promise(r=>setTimeout(()=>r('ok'),3200))`);
}

const counts = rows.map((x) => x.rcmdCards);
if (counts.length) {
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  console.log('\n=== Q1b（DOMParser 交叉验证）===');
  console.log('is-rcmd 数组:', JSON.stringify(counts));
  console.log('均值:', mean.toFixed(3), '标准差:', sd.toFixed(3));
  console.log('有BV数组:', JSON.stringify(rows.map((x) => x.withBv)));
}

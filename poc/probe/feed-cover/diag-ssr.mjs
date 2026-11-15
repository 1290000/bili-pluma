// 诊断：SSR HTML 里 is-rcmd 卡片的真实形态
// 用法：node diag-ssr.mjs --session <sid> --tab <tab>
import { execFileSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SESSION = arg('session');
const TAB = arg('tab');

const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const EXPR = `(async () => {
  const res = await fetch('https://www.bilibili.com/?_t=' + Date.now(), { credentials: 'include', cache: 'no-store' });
  const html = await res.text();
  const CARD_OPEN_RE = /<div class="[^"]*\\bbili-video-card\\b[^"]*\\bis-rcmd\\b[^"]*"/g;
  const opens = [];
  let mm;
  while ((mm = CARD_OPEN_RE.exec(html)) !== null) opens.push(mm.index);
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const samples = [];
  for (let i = 0; i < Math.min(4, opens.length); i++) {
    const seg = html.slice(opens[i], opens[i] + 1500);
    samples.push({ i: i, start: opens[i], bv: (seg.match(BV_RE) || [])[0] || null, head: seg.slice(0, 110) });
  }
  const f = html.indexOf('is-rcmd');
  return JSON.stringify({
    len: html.length,
    rcmdCount: (html.match(/is-rcmd/g) || []).length,
    cardOpenMatches: opens.length,
    samples: samples,
    firstRcmdIdx: f,
    around: f >= 0 ? html.slice(f - 60, f + 800).replace(/\\s+/g, ' ') : null
  });
})()`;

const out = execFileSync('bsk', ['evaluate', '--session', SESSION, '--tab-id', String(TAB), EXPR], {
  env: ENV,
  encoding: 'utf8',
  shell: false,
  maxBuffer: 32 * 1024 * 1024,
});
const s = out.indexOf('{');
console.log(JSON.stringify(JSON.parse(out.slice(s)), null, 1));

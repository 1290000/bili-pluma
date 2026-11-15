// 补充：order:9999 之后，"上移到首屏的卡"到底是 A 的批次还是 B 的？
//
// ## 为什么这条决定方案成败
//   `order:9999` 确实改变了首屏 BV 集合。但改变后出现在首屏的，是：
//     (a) 原本排在 `.feed-card` **后面**的那些卡（= .bili-feed-card 直接子元素 = B 批）→ 方案有意义
//     (b) 还是 `.feed-card` 内部的卡换了个顺序（= 还是 A 的内容）→ 方案无意义
//
// ## 判据
//   变换前，记录每个 `.bili-video-card` 所属的**祖先容器类型**：
//     - 祖先里有 `.feed-card` → A 批
//     - 没有 `.feed-card`（直接是 grid 子元素 .bili-feed-card 内） → B 批
//   变换后，看首屏可见卡里 A/B 各占多少。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SI = arg('session');
const TAB = arg('tab');
const ENV = { ...process.env, BSK_HOME: 'C:\\Users\\i1290\\.bsk', BSK_AUTO_START: '0' };

const runBs = (args) =>
  execFileSync('bsk', args, { env: ENV, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
const evaluate = (expr) => {
  const out = runBs(['evaluate', '--session', SI, '--tab-id', TAB, expr]);
  const i = out.search(/[{[]/);
  try {
    return JSON.parse(out.slice(i));
  } catch {
    return { raw: out.slice(0, 500) };
  }
};

const EXPR = `(async () => {
  const BV_RE = /BV[0-9A-Za-z]{10}/g;
  const bvOf = (el) => { const a = el.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(BV_RE) || [''])[0] : null; };
  const vh = window.innerHeight;

  /** 判定这张卡属于 A 批（祖先有 .feed-card）还是 B 批 */
  const batchOf = (el) => el.closest('.feed-card') ? 'A' : (el.closest('.bili-feed-card') ? 'B' : 'other');

  const snap = () => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    const rows = cards.map(c => {
      const r = c.getBoundingClientRect();
      return {
        bv: bvOf(c),
        batch: batchOf(c),
        top: Math.round(r.top + window.scrollY),
        h: Math.round(r.height),
        w: Math.round(r.width),
        inVP: r.top < vh && r.bottom > 0 && r.width > 0 && r.height > 0,
      };
    });
    const inVp = rows.filter(r => r.inVP);
    const count = (arr, b) => arr.filter(r => r.batch === b).length;
    return {
      total: rows.length,
      inVpCount: inVp.length,
      inVpA: count(inVp, 'A'),
      inVpB: count(inVp, 'B'),
      inVpOther: count(inVp, 'other'),
      inVpBvs: inVp.map(r => r.bv).filter(Boolean),
      inVpBatches: inVp.map(r => r.batch),
      allBatches: { A: count(rows, 'A'), B: count(rows, 'B'), other: count(rows, 'other') },
    };
  };

  const before = snap();

  // 施加 order:9999
  const touched = [];
  document.querySelectorAll('.feed-card').forEach(el => {
    touched.push({ el, prev: el.style.getPropertyValue('order'), prio: el.style.getPropertyPriority('order') });
    el.style.setProperty('order', '9999', 'important');
  });
  void document.body.offsetHeight;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 600));

  const after = snap();

  // 恢复
  touched.reverse().forEach(t => { if (t.prev) t.el.style.setProperty('order', t.prev, t.prio); else t.el.style.removeProperty('order'); });

  return JSON.stringify({ before, after });
})()`;

console.log('=== order:9999 后，首屏里 A/B 各占多少 ===');
const r = evaluate(EXPR);
if (r.raw) {
  console.log('失败:', JSON.stringify(r).slice(0, 400));
  process.exit(1);
}

const show = (label, s) => {
  console.log(`\n${label}`);
  console.log(`  全页批次分布: A=${s.allBatches.A} B=${s.allBatches.B} other=${s.allBatches.other}`);
  console.log(`  首屏可见: ${s.inVpCount} 张  →  A=${s.inVpA}  B=${s.inVpB}  other=${s.inVpOther}`);
  console.log(`  首屏批次序列: ${s.inVpBatches.join(' ')}`);
  console.log(`  首屏 BV: ${s.inVpBvs.join(', ')}`);
};

show('【变换前】', r.before);
show('【变换后 order:9999】', r.after);

console.log('\n=== 判读 ===');
console.log(`  首屏 A 批: ${r.before.inVpA} → ${r.after.inVpA}`);
console.log(`  首屏 B 批: ${r.before.inVpB} → ${r.after.inVpB}`);
if (r.after.inVpB > r.before.inVpB) {
  console.log('  ✅ B 批（.bili-feed-card 直接子元素）确实上移进了首屏 → 方案有意义');
} else {
  console.log('  ❌ B 批没有更多进入首屏 → 只是 A 内部换序，方案无意义');
}

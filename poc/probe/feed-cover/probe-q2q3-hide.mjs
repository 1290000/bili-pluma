/**
 * feed-cover 探针 Q2/Q3：**隐藏首屏 10 张后，无限滚动还触发吗？**
 *
 * ## 为什么这是生死线
 * B站的"加载更多"很可能挂在某个 sentinel 元素的 IntersectionObserver 上
 * （ADR 0031 附录提到过 `.load-more-anchor`）。
 * 若用 `display:none` 隐藏卡片，会改变布局高度 → sentinel 位置变化 →
 * observer 可能**提前触发**（更糟：反复触发）或**永不触发**。
 *
 * ## 方法
 * A/B 对照，每次都在**同一个页面加载**后独立操作（不 reload），
 * 通过在 HTML 里注入一个 `<style>` 实现隐藏，测三种方式：
 *   A. 基线（不隐藏）
 *   B. display:none 前 10 张
 *   C. visibility:hidden 前 10 张
 *   D. height:0;overflow:hidden;margin:0;padding:0 前 10 张
 * 每种都：滚到底 → 等 4 秒 → 看 rcmd 请求数增量 + 卡片数增量。
 *
 * ⚠️ 只读：只改页面样式 + 滚动，不点视频、不发写请求。
 * ⚠️ 每次测完**恢复原状**（移除 style），保证下一轮是干净基线。
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
  console.error('用法: node probe-q2q3-hide.mjs --session <sid> --tab <tabId> --mode <baseline|display|visibility|height>');
  process.exit(2);
}

const MODE = get('--mode') || 'baseline';

const CSS = {
  baseline: '',
  display: '.bili-video-card:nth-of-type(-n+10){display:none!important}',
  visibility: '.bili-video-card:nth-of-type(-n+10){visibility:hidden!important}',
  height: '.bili-video-card:nth-of-type(-n+10){height:0!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important}',
};

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

// 注入隐藏样式（baseline 时什么也不注入，只清掉残留）
const css = CSS[MODE];
step(
  `[${MODE}] 注入隐藏样式`,
  `(()=>{
     const old=document.getElementById('__fc_hide__');
     if(old) old.remove();
     ${css ? `const st=document.createElement('style'); st.id='__fc_hide__'; st.textContent=${JSON.stringify(css)}; document.head.appendChild(st);` : `/* baseline: 不注入 */`}
     return JSON.stringify({
       injected:${css ? 'true' : 'false'},
       docHeight:document.documentElement.scrollHeight,
       visibleCards:[...document.querySelectorAll('.bili-video-card')].filter(e=>{
         const r=e.getBoundingClientRect(); return r.height>0 && getComputedStyle(e).visibility!=='hidden';
       }).length
     });
   })()`,
);

// 基线快照
const before = step(
  `[${MODE}] 滚动前快照`,
  `(()=>{
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     return JSON.stringify({
       rcmdCount:rcmd,
       allCards:document.querySelectorAll('.bili-video-card').length,
       docHeight:document.documentElement.scrollHeight,
       scrollY:Math.round(window.scrollY)
     });
   })()`,
);

// 滚到底
step(
  `[${MODE}] 滚到底并等 5 秒`,
  `(async()=>{
     window.scrollTo(0,document.documentElement.scrollHeight);
     await new Promise(r=>setTimeout(r,5200));
     return 'done';
   })()`,
);

// 结果
const after = step(
  `[${MODE}] 滚动后结果`,
  `(()=>{
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd/.test(e.name)).length;
     return JSON.stringify({
       rcmdCount:rcmd,
       allCards:document.querySelectorAll('.bili-video-card').length,
       docHeight:document.documentElement.scrollHeight,
       scrollY:Math.round(window.scrollY)
     });
   })()`,
);

if (before && after) {
  console.log('\n=== 汇总 ===');
  console.log(
    JSON.stringify({
      mode: MODE,
      rcmdDelta: after.rcmdCount - before.rcmdCount,
      cardDelta: after.allCards - before.allCards,
      docHeightBefore: before.docHeight,
      docHeightAfter: after.docHeight,
    }),
  );
}

// 清理
evaluate(session, tab, `(()=>{const o=document.getElementById('__fc_hide__'); if(o) o.remove(); return 1})()`);

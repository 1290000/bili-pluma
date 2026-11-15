/**
 * 取证脚本 O2：用**真实鼠标事件**点"换一换"（O1 的 `btn.click()` 无效）。
 *
 * O1 结论：`feed-roll-btn` 的 `click()` 没触发任何请求（rcmdDelta=0）。
 * 可能原因：B站用 mousedown/mouseup 而非 click，或按钮被包在别的监听上。
 * 这里依次尝试 dispatch 一组完整事件序列。
 */
import { evaluate } from './bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-o2-switch.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 2600));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'O2-1 点击前快照',
  `(()=>{
     const bvs=[...document.querySelectorAll('.bili-video-card')]
       .map(e=>{const a=e.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null}).filter(Boolean);
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd|index\\/top\\/rcmd/.test(e.name)).length;
     window.__P={bvs,rcmd};
     return JSON.stringify({cards:bvs.length,first5:bvs.slice(0,5),rcmd});
   })()`,
);

step(
  'O2-2 用完整鼠标事件序列点"换一换"',
  `(()=>{
     const btn=document.querySelector('.feed-roll-btn button.roll-btn')||document.querySelector('.feed-roll-btn');
     if(!btn) return JSON.stringify({ok:false,reason:'no-btn'});
     btn.scrollIntoView({block:'center'});
     const r=btn.getBoundingClientRect();
     const opt={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
     ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t=>{
       const ev = t.startsWith('pointer') ? new PointerEvent(t,opt) : new MouseEvent(t,opt);
       btn.dispatchEvent(ev);
     });
     return JSON.stringify({ok:true,tag:btn.tagName,cls:(btn.className||'').toString().slice(0,50)});
   })()`,
);

step(
  'O2-3 点击后对比',
  `(async()=>{
     await new Promise(r=>setTimeout(r,3500));
     const bvs=[...document.querySelectorAll('.bili-video-card')]
       .map(e=>{const a=e.querySelector('a[href*="/video/BV"]');return a?(a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[])[0]:null}).filter(Boolean);
     const rcmd=performance.getEntriesByType('resource').filter(e=>/feed\\/rcmd|index\\/top\\/rcmd/.test(e.name)).length;
     const before=(window.__P&&window.__P.bvs)||[];
     const after=new Set(bvs);
     const overlap=before.filter(b=>after.has(b)).length;
     return JSON.stringify({
       beforeCards:before.length, afterCards:bvs.length,
       beforeFirst5:before.slice(0,5), afterFirst5:bvs.slice(0,5),
       overlap, rcmdBefore:(window.__P&&window.__P.rcmd), rcmdAfter:rcmd,
       rcmdDelta:rcmd-((window.__P&&window.__P.rcmd)||0),
       fullyReplaced:before.length>0&&overlap===0
     });
   })()`,
);

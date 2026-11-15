/**
 * feed-cover 探针 Q4b：grid 容器里 `order` 为什么没生效，以及有没有替代手法。
 *
 * ## 现状
 * `.container.is-version8` 是 `display:grid`、48 个子元素。
 * 给 `.feed-card` 设 `order:-1` **没有移动**它们。
 *
 * ## 可能原因
 * a. `.feed-card` 不是 grid 的直接子元素（隔了一层）
 * b. grid 用了 `grid-area` / `grid-row-start` 之类的**显式定位**，`order` 被覆盖
 * c. `order` 在 grid 里只影响「自动放置」的项，显式定位的不受影响
 *
 * ## 本探针要做
 * 1. 打印 grid 的完整模板与每个 `.feed-card` 的 grid 定位
 * 2. 直接在 **grid 直接子元素** 上试 order
 * 3. 试另一条路：`grid-auto-flow: row dense` + order
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
  console.error('用法: node probe-q4b-grid.mjs --session <sid> --tab <tabId>');
  process.exit(2);
}

const step = (label, expr) => {
  const r = evaluate(session, tab, expr);
  console.log(`\n### ${label}`);
  if (!r.ok) {
    console.log('  FAIL', (r.err || r.out || '').slice(0, 400));
    return null;
  }
  console.log('  ' + r.out.slice(0, 3000));
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

step(
  'Q4b-1 grid 容器的完整布局属性',
  `(()=>{
     const c=document.querySelector('.container.is-version8');
     if(!c) return JSON.stringify({found:false});
     const cs=getComputedStyle(c);
     return JSON.stringify({
       found:true,
       display:cs.display,
       gridTemplateColumns:cs.gridTemplateColumns.slice(0,120),
       gridTemplateRows:cs.gridTemplateRows.slice(0,80),
       gridAutoFlow:cs.gridAutoFlow,
       gap:cs.gap,
       children:c.children.length,
       childClasses:[...c.children].slice(0,6).map(e=>(e.className||'').toString().slice(0,40))
     });
   })()`,
);

step(
  'Q4b-2 第一个 .feed-card 是否为 grid 直接子元素 + 它的 grid 定位',
  `(()=>{
     const card=document.querySelector('.feed-card');
     if(!card) return JSON.stringify({found:false});
     const gp=card.parentElement;
     const cs=getComputedStyle(card);
     return JSON.stringify({
       found:true,
       parentCls:(gp.className||'').toString().slice(0,50),
       parentDisplay:getComputedStyle(gp).display,
       parentIsGridContainer: gp.classList.contains('container'),
       cardGridColumn:cs.gridColumn,
       cardGridRow:cs.gridRow,
       cardGridArea:cs.gridArea,
       cardOrder:cs.order,
       cardPosition:cs.position
     });
   })()`,
);

step(
  'Q4b-3 在 grid 直接子元素上试 order:-1',
  `(()=>{
     const old=document.getElementById('__fc_g2__'); if(old) old.remove();
     const grid=document.querySelector('.container.is-version8');
     if(!grid) return JSON.stringify({ok:false});
     const kids=[...grid.children];
     const before=kids.slice(0,4).map(e=>({cls:(e.className||'').toString().slice(0,30),top:Math.round(e.getBoundingClientRect().top)}));
     kids.slice(-6).forEach(e=>e.classList.add('__fc_g2__'));
     const st=document.createElement('style'); st.id='__fc_g2__';
     st.textContent='.__fc_g2__{order:-999!important}';
     document.head.appendChild(st);
     const after=kids.slice(0,4).map(e=>({cls:(e.className||'').toString().slice(0,30),top:Math.round(e.getBoundingClientRect().top)}));
     return JSON.stringify({
       ok:true,
       gridChildren:kids.length,
       before,after,
       moved:JSON.stringify(before.map(x=>x.top))!==JSON.stringify(after.map(x=>x.top))
     });
   })()`,
);

evaluate(
  session,
  tab,
  `(()=>{document.querySelectorAll('.__fc_g2__').forEach(e=>e.classList.remove('__fc_g2__'));const o=document.getElementById('__fc_g2__');if(o)o.remove();return 1})()`,
);

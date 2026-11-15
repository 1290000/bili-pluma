// 用**与工程师测试完全相同的函数**复算，再和它注释里写的数字对比。
// 目的：判定「134」这个申报数字是否与实现一致（不是判文案好坏）。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync('entrypoints/need-incognito/index.html', 'utf8');
const doc = new JSDOM(HTML).window.document;

// ↓ 逐字复制 tests/unit/content/need-incognito-copy.test.ts 的 visibleText()
function visibleText(d) {
  const clone = d.body.cloneNode(true);
  for (const el of clone.querySelectorAll('script, style, details, [hidden]')) el.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function collapsedText(d) {
  const parts = [...d.body.querySelectorAll('details')].map((x) =>
    (x.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
  return parts.join(' ');
}

const v = visibleText(doc);
const c = collapsedText(doc);
console.log(`visibleText() (工程师口径)  = ${v.length}`);
console.log(`collapsedText() (工程师口径) = ${c.length}`);
console.log('');
console.log('工程师注释申报：可见 134 / 折叠 143');
console.log(`可见差: ${134 - v.length}   折叠差: ${143 - c.length}`);

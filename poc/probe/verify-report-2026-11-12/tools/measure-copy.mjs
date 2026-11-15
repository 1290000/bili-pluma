// 独立统计 InPrivate 说明页的可见文本量（verifier 自写，不复用工程师的测试函数）。
//
// 为什么要自己写一份：工程师的 `need-incognito-copy.test.ts` 用的是
// `clone.textContent`（textContent 会把 `<code>` 里的空白原样带出）。
// 用户看到的是浏览器排版后的文本，口径应当接近 `innerText`。
// 两份结果都算出来并列，差异本身也是证据。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync('entrypoints/need-incognito/index.html', 'utf8');
const dom = new JSDOM(HTML);
const doc = dom.window.document;

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function visibleViaClone() {
  const clone = doc.body.cloneNode(true);
  for (const el of clone.querySelectorAll('script, style, details, [hidden]')) el.remove();
  return collapse(clone.textContent ?? '');
}

// 近似 innerText：块级元素之间补空格（jsdom 没有 innerText）
const BLOCK = 'p,h1,h2,h3,li,ol,ul,summary,div,details,br,button';
function visibleViaBlocks() {
  const clone = doc.body.cloneNode(true);
  for (const el of clone.querySelectorAll('script, style, details, [hidden]')) el.remove();
  for (const el of clone.querySelectorAll(BLOCK)) {
    el.appendChild(doc.createTextNode(' '));
  }
  return collapse(clone.textContent ?? '');
}

function collapsed() {
  return collapse(
    [...doc.querySelectorAll('details')]
      .map((d) => d.textContent ?? '')
      .join(' '),
  );
}

const v1 = visibleViaClone();
const v2 = visibleViaBlocks();
const c = collapsed();

console.log(`默认可见（textContent 口径，同工程师测试） : ${v1.length} 字`);
console.log(`默认可见（块级补空格口径，近似 innerText）  : ${v2.length} 字`);
console.log(`折叠内（details）                          : ${c.length} 字`);
console.log('');
console.log('--- 默认可见文本原文 ---');
console.log(v2);
console.log('');
console.log(`<ol> 个数            : ${doc.querySelectorAll('ol').length}`);
console.log(`<ol> 步数            : ${doc.querySelectorAll('ol > li').length}`);
console.log(`<details> 个数        : ${doc.querySelectorAll('details').length}`);
console.log(`<button> 个数        : ${doc.querySelectorAll('button').length}`);
console.log('');
console.log('--- 逐控件（用户要点的东西）---');
for (const b of doc.querySelectorAll('button')) {
  const hidden = b.closest('[hidden]');
  console.log(`button${hidden ? ' [hidden]' : ''}: "${collapse(b.textContent)}"`);
}
console.log('');
console.log('--- 事实核对（是否还有陈旧指代 / 浏览器名错误）---');
const all = HTML;
for (const [label, re] of [
  ['「点图标」类陈旧指代', /(重新)?点(工具栏)?图标/],
  ['承诺「自动变绿」', /自动变绿/],
  ['「马上 / 立刻」类空头承诺', /马上|立刻/],
  ['写死 chrome:// 而不判浏览器', /chrome:\/\//],
  ['出现 edge:// 硬编码', /edge:\/\//],
]) {
  const m = all.match(re);
  console.log(`${label}: ${m ? `命中「${m[0]}」` : '无'}`);
}

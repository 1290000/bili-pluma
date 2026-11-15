// 测「改前基线」，用 **git 里的 HEAD 版本**，不经过 PowerShell 重编码。
// 输出写进 stdout，由调用方 tee 到 logs/。
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const FILE = 'entrypoints/need-incognito/index.html';
const html = execFileSync('git', ['show', `HEAD:${FILE}`], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
const doc = new JSDOM(html).window.document;

function visible(d) {
  const c = d.body.cloneNode(true);
  for (const e of c.querySelectorAll('script, style, details, [hidden]')) e.remove();
  return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function collapsed(d) {
  return [...d.body.querySelectorAll('details')]
    .map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join(' ');
}

const v = visible(doc);
const c = collapsed(doc);
console.log(`HEAD(${FILE}) 默认可见 = ${v.length} 字`);
console.log(`HEAD 折叠内          = ${c.length} 字`);
console.log(`HEAD 合计            = ${v.length + c.length} 字`);
console.log('');
console.log('--- HEAD 默认可见原文 ---');
console.log(v);
console.log('');
console.log('--- HEAD 折叠内原文 ---');
console.log(c);
console.log('');
console.log(`HEAD <ol> 个数 = ${doc.querySelectorAll('ol').length}`);
console.log(`HEAD <ol> 步数 = ${doc.querySelectorAll('ol > li').length}`);
console.log(`HEAD <details> = ${doc.querySelectorAll('details').length}`);
console.log(`HEAD <button>  = ${doc.querySelectorAll('button').length}`);

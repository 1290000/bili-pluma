// 从 bsk snapshot 的 text 里找 Pluma 面板内容
import fs from 'node:fs';

const bytes = fs.readFileSync('D:/Temp/snap.json');
// PowerShell 的 `1>` 会用 UTF-16LE 写文件，Node 按 utf8 读会乱码 → 按 BOM 判断编码
let raw;
if (bytes[0] === 0xff && bytes[1] === 0xfe) {
  raw = bytes.toString('utf16le');
} else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
  raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
} else {
  raw = bytes.toString('utf8');
}
raw = raw.trim();
const j = JSON.parse(raw);
const text = j.text || '';

const lines = text.split('\n');
console.log(`snapshot 共 ${lines.length} 行`);

// 找含关键词的行
const kw = /pluma|账号|取流|代理|画质|扩展|暂停|接管/i;
const hits = lines.filter((l) => kw.test(l));
console.log(`\n=== 命中 ${hits.length} 行 ===`);
hits.slice(0, 60).forEach((l) => console.log(l));

// 另外打印最后 40 行（面板通常在 DOM 末尾注入）
console.log('\n=== 最后 40 行 ===');
lines.slice(-40).forEach((l) => console.log(l));

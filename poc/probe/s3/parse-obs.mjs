import fs from 'node:fs';
const b = fs.readFileSync('D:/Temp/obs.json');
const raw = b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8');
let j;
try {
  j = JSON.parse(raw.trim().replace(/^\uFEFF/, ''));
} catch (e) {
  console.log('parse fail:', e.message);
  console.log('head:', raw.slice(0, 400));
  process.exit(1);
}
console.log('top keys:', Object.keys(j).join(', '));
const s = JSON.stringify(j);
console.log('length:', s.length);
const re = /"(bounds|rect|x|y|width|height|box|size)":/g;
const found = [...new Set((s.match(re) || []))];
console.log('geometry fields:', found.length ? found.join(' ') : 'NONE');
if (found.length) {
  // 打印含几何的前几处
  const idx = s.search(re);
  console.log('sample:', s.slice(Math.max(0, idx - 200), idx + 400));
}

const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
let j;
try { j = JSON.parse(raw); } catch (e) { console.error('json parse failed:', e.message); process.exit(1); }
const h = typeof j.html === 'string' ? j.html : '';
const pats = ['__playinfo__', 'playinfo', 'playurl', 'accept_quality', 'acceptQuality', '"quality"', '"dash"', '__INITIAL_STATE__', '"fnval"', '"qn"', 'upower', '"vipStatus"', 'dimension', 'playurlSSRData', 'video_info'];
for (const p of pats) {
  let count = 0;
  let i = 0;
  while ((i = h.indexOf(p, i)) !== -1) { count++; i += p.length; }
  console.log(JSON.stringify(p), count);
}
console.log('byte_size', j.byte_size, 'html_len', h.length);

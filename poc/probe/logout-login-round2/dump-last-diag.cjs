// Read-only: dump EVERY entry of the LATEST parseable snapshot of `pluma:diag`.
// Same LevelDB scan as read-diag-current.cjs, but instead of summarising each
// occurrence it keeps the one whose last entry has the greatest timestamp and
// prints all of its entries in chronological order.
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.env.LOCALAPPDATA +
  '/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const key = 'pluma:diag';
let best = null; // { arr, where, occurrence, len }

for (const f of fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const s = buf.toString('utf8');
  let idx = 0;
  let found = 0;
  while ((idx = s.indexOf(key, idx)) !== -1) {
    found += 1;
    const tail = s.slice(idx, idx + 200000);
    const start = tail.indexOf('[{');
    if (start === -1) {
      idx += key.length;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < tail.length; i++) {
      const ch = tail[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      idx += key.length;
      continue;
    }
    const raw = tail.slice(start, end + 1);
    try {
      const arr = JSON.parse(raw);
      const lastAt = arr.length ? Number(arr[arr.length - 1].at) : 0;
      if (!best || lastAt > best.lastAt) {
        best = { arr, where: f, occurrence: found, len: raw.length, lastAt };
      }
    } catch {
      // ignore unparseable torn snapshots
    }
    idx += key.length;
  }
}

if (!best) {
  console.log('NO parseable pluma:diag snapshot found');
  process.exit(1);
}

const fmt = (at) =>
  new Date(Number(at)).toLocaleString('zh-CN', { hour12: false }) +
  '.' +
  String(Number(at) % 1000).padStart(3, '0');

console.log(
  'LATEST snapshot: ' + best.where + ' occurrence#' + best.occurrence + ' entries=' + best.arr.length + ' chars=' + best.len,
);
console.log('window: ' + fmt(best.arr[0].at) + '  ->  ' + fmt(best.arr[best.arr.length - 1].at));
console.log('');
for (let i = 0; i < best.arr.length; i++) {
  const e = best.arr[i];
  const detail = e.detail === undefined || e.detail === '' ? '' : ' | ' + String(e.detail);
  console.log('[' + String(i).padStart(2, '0') + '] ' + fmt(e.at) + '  ' + e.step + detail);
}

// Read-only: dump EVERY parseable occurrence of `pluma:diag`, newest last,
// printing all entries of each so we can locate what happened around a given
// wall-clock moment. The 30-entry ring buffer means earlier snapshots contain
// history that the latest snapshot has already dropped.
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.env.LOCALAPPDATA +
  '/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const key = 'pluma:diag';
const occ = [];

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
    try {
      const arr = JSON.parse(tail.slice(start, end + 1));
      if (arr.length) {
        occ.push({ file: f, n: found, arr, firstAt: Number(arr[0].at), lastAt: Number(arr[arr.length - 1].at) });
      }
    } catch {
      /* torn snapshot */
    }
    idx += key.length;
  }
}

// Sort by the snapshot's own first timestamp so we walk history forward.
occ.sort((a, b) => a.firstAt - b.firstAt);

const fmt = (at) => new Date(Number(at)).toLocaleString('zh-CN', { hour12: false });

// Build the union of every distinct entry (dedupe by at+step+detail), so the
// ring-buffer truncation of any single snapshot does not hide older events.
const seen = new Set();
const union = [];
for (const o of occ) {
  for (const e of o.arr) {
    const k = e.at + '|' + e.step + '|' + (e.detail || '');
    if (seen.has(k)) continue;
    seen.add(k);
    union.push(e);
  }
}
union.sort((a, b) => Number(a.at) - Number(b.at));

console.log('snapshots parsed = ' + occ.length);
console.log('distinct entries (union) = ' + union.length);
if (union.length) {
  console.log('history window: ' + fmt(union[0].at) + '  ->  ' + fmt(union[union.length - 1].at));
}
console.log('');
console.log('=== NON-panel/page-state entries, chronological (full history) ===');
for (const e of union) {
  if (e.step === 'panel/page-state') continue;
  const detail = e.detail === undefined || e.detail === '' ? '' : ' | ' + String(e.detail);
  console.log(fmt(e.at) + '  ' + e.step + detail);
}

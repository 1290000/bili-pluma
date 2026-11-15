// Read-only: show the `from` (background instance id) column for every diag
// entry. In incognito:"split" mode the normal and incognito Service Worker each
// get their own DIAG array, and INSTANCE_ID (diag-store.ts:42) differs per
// instance -- so this column tells us WHICH background answered each click.
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.env.LOCALAPPDATA +
  '/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const key = 'pluma:diag';
const seen = new Set();
const union = [];

for (const f of fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const s = buf.toString('utf8');
  let idx = 0;
  while ((idx = s.indexOf(key, idx)) !== -1) {
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
    if (end !== -1) {
      try {
        for (const e of JSON.parse(tail.slice(start, end + 1))) {
          const k = e.at + '|' + e.step + '|' + (e.detail || '') + '|' + (e.from || '');
          if (seen.has(k)) continue;
          seen.add(k);
          union.push(e);
        }
      } catch {
        /* torn */
      }
    }
    idx += key.length;
  }
}

union.sort((a, b) => Number(a.at) - Number(b.at));
const fmt = (at) => new Date(Number(at)).toLocaleString('zh-CN', { hour12: false });

const froms = new Map();
for (const e of union) {
  const f = e.from || '(none)';
  froms.set(f, (froms.get(f) || 0) + 1);
}
console.log('=== distinct `from` values (background instances) ===');
for (const [f, n] of [...froms.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('  from=' + f + '  entries=' + n);
}
console.log('');
console.log('=== login-chain entries with their `from` ===');
for (const e of union) {
  if (e.step === 'panel/page-state') continue;
  if (!/login|Incognito|说明页|windows\.create|create 返回/.test(e.step)) continue;
  const detail = e.detail ? ' | ' + String(e.detail) : '';
  console.log(fmt(e.at) + '  [from=' + (e.from || '?') + ']  ' + e.step + detail);
}

// Read-only: extract the CURRENT value of `pluma:diag` from Edge's LevelDB.
// Chrome stores storage.local entries as JSON-ish records in .ldb/.log files.
// We look for the key `pluma:diag` and grab the JSON array that follows it.
const fs = require('node:fs');
const path = require('node:path');

const dir =
  process.env.LOCALAPPDATA +
  '/Microsoft/Edge/User Data/Default/Local Extension Settings/fgmggjhdbgaclcbeaopajghpnhgkmfnf';

const key = 'pluma:diag';

for (const f of fs.readdirSync(dir).filter((x) => /\.(ldb|log)$/.test(x))) {
  const buf = fs.readFileSync(path.join(dir, f));
  const s = buf.toString('utf8');
  let idx = 0;
  let found = 0;
  while ((idx = s.indexOf(key, idx)) !== -1) {
    found += 1;
    // The value follows the key; take a generous window and try to parse the
    // JSON array out of it.
    const tail = s.slice(idx, idx + 200000);
    const start = tail.indexOf('[{');
    if (start === -1) {
      idx += key.length;
      continue;
    }
    // Find the matching close bracket by scanning with a string-aware scanner.
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
      console.log(
        f + ': occurrence#' + found + ' parsed OK, ' + arr.length + ' entries, ' + raw.length + ' chars',
      );
      if (arr.length) {
        console.log('  first at=' + new Date(arr[0].at).toLocaleString('zh-CN', { hour12: false }) + ' step=' + arr[0].step);
        console.log('  last  at=' + new Date(arr[arr.length - 1].at).toLocaleString('zh-CN', { hour12: false }) + ' step=' + arr[arr.length - 1].step);
        const hasExplainer = arr.filter((e) => String(e.step).includes('说明页'));
        console.log('  entries mentioning 说明页 = ' + hasExplainer.length);
      }
    } catch (e) {
      console.log(f + ': occurrence#' + found + ' JSON.parse FAILED (' + String(e.message).slice(0, 60) + '), len=' + raw.length);
    }
    idx += key.length;
  }
  if (!found) console.log(f + ': key not present');
}

/**
 * 只读：列出本机已安装扩展里，content_scripts.matches 覆盖
 * `chrome-extension://` 或全站的那几个。
 *
 * 目的：`ERR_BLOCKED_BY_CLIENT` 在 InPrivate 窗口里的扩展页面上出现时，
 * 需要排除"别的扩展往扩展页面注入脚本并改 DOM"这条路径。
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'C:/Users/i1290/AppData/Local/Microsoft/Edge/User Data/Default/Extensions';

const SUSPICIOUS = /^(<all_urls>|chrome-extension:\/\/.*|file:\/\/.*|\*:\/\/\*\/\*)$/;

function main() {
  const ids = fs.readdirSync(BASE).filter((n) => /^[a-p]{32}$/.test(n));
  const rows = [];
  for (const id of ids) {
    const versions = fs
      .readdirSync(path.join(BASE, id))
      .filter((v) => /^\d/.test(v))
      .sort();
    const version = versions[versions.length - 1];
    if (!version) continue;
    const mf = path.join(BASE, id, version, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch {
      continue;
    }
    const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
    const all = [...new Set(cs.flatMap((c) => c.matches || []))];
    const suspicious = all.filter((x) => SUSPICIOUS.test(x));
    rows.push({
      id,
      version,
      name: manifest.name,
      csCount: cs.length,
      suspicious,
      allMatches: all,
    });
  }
  rows.sort((a, b) => b.suspicious.length - a.suspicious.length);
  for (const r of rows) {
    const flag = r.suspicious.length > 0 ? '  <<< 覆盖扩展页/全站' : '';
    console.log(`${r.id} v${r.version} "${r.name}" cs=${r.csCount}${flag}`);
    if (r.suspicious.length > 0) console.log(`    suspicious: ${JSON.stringify(r.suspicious)}`);
  }
  console.log(`\nTOTAL extensions scanned = ${rows.length}`);
}

main();

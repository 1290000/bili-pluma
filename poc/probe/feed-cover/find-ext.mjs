// 只读：从 Edge 的扩展元数据里找出 Pluma 的扩展 ID 与状态
// 不读任何凭据，只读 extension id / name / state。
import fs from 'node:fs';
import path from 'node:path';

const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default');
const candidates = ['Secure Preferences', 'Preferences'];

for (const c of candidates) {
  const p = path.join(base, c);
  if (!fs.existsSync(p)) {
    console.log(`${c}: (missing)`);
    continue;
  }
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.log(`${c}: parse fail ${e.message}`);
    continue;
  }
  const settings = j.extensions?.settings || {};
  const rows = [];
  for (const [id, v] of Object.entries(settings)) {
    const name = v?.manifest?.name;
    if (!name) continue;
    // 只关心可能的 Pluma / bili / 以及未打包扩展（location 4 = unpacked）
    const interesting =
      /pluma|bili|danmaku|wxt/i.test(name) ||
      v.location === 4 ||
      (v.path && /Pluma|pluma/i.test(v.path));
    if (!interesting) continue;
    rows.push({
      id,
      name,
      version: v.manifest?.version,
      location: v.location,
      state: v.state,
      disable_reasons: v.disable_reasons,
      path: v.path,
    });
  }
  console.log(`\n=== ${c} ===`);
  if (!rows.length) console.log('  (no matching extension)');
  rows.forEach((r) => console.log('  ' + JSON.stringify(r)));
}

// 列出 Edge 里所有扩展（id + name + location），不加过滤
import fs from 'node:fs';
import path from 'node:path';

const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default');
for (const c of ['Secure Preferences', 'Preferences']) {
  const p = path.join(base, c);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const settings = j.extensions?.settings || {};
  const rows = Object.entries(settings)
    .map(([id, v]) => ({
      id,
      name: v?.manifest?.name ?? null,
      location: v?.location ?? null,
      state: v?.state ?? null,
      path: v?.path ?? null,
    }))
    .filter((r) => r.name);
  console.log(`\n=== ${c}: ${rows.length} extensions ===`);
  rows.forEach((r) => console.log(`  ${r.id}  loc=${r.location} state=${r.state}  ${r.name}  ${r.path ?? ''}`));
}

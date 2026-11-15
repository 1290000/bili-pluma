// 在所有 Edge 配置里找 Pluma 扩展 ID（只读）
import fs from 'node:fs';
import path from 'node:path';

const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
const files = ['Default/Secure Preferences', 'Default/Preferences', 'Local State'];

const seen = new Set();
for (const f of files) {
  const p = path.join(base, f);
  if (!fs.existsSync(p)) continue;
  let raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  // 直接在原文里搜 "bili-pluma" / "Pluma"
  const idxs = [];
  let i = -1;
  while ((i = raw.indexOf('pluma', i + 1)) >= 0) idxs.push(i);
  console.log(`\n=== ${f}: 含 "pluma" ${idxs.length} 处 ===`);
  idxs.slice(0, 6).forEach((idx) => {
    console.log('  …' + raw.slice(Math.max(0, idx - 160), idx + 120).replace(/\s+/g, ' '));
  });

  // 尝试解析并找 manifest.name === 'Pluma'
  try {
    const j = JSON.parse(raw);
    const settings = j.extensions?.settings || {};
    for (const [id, v] of Object.entries(settings)) {
      const name = v?.manifest?.name;
      if (name && /pluma/i.test(name)) {
        console.log(`  ★ FOUND id=${id} name=${name} path=${v.path} loc=${v.location} state=${v.state}`);
        seen.add(id);
      }
    }
  } catch (e) {
    console.log('  (parse fail: ' + e.message.slice(0, 80) + ')');
  }
}
console.log('\n=== 汇总 ===', [...seen]);

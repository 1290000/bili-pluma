import { readFileSync } from 'node:fs';

const code = readFileSync('tests/unit/content/panel/orphan-hint.test.ts', 'utf8');
for (const n of ['buildProbe', 'buildFallbackProbe']) {
  const re = new RegExp('function\\s+' + n + '\\s*\\(');
  const at = code.search(re);
  console.log(n, 'at =', at);
  console.log('  head =', JSON.stringify(code.slice(at, at + 120)));
}

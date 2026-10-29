import fs from 'node:fs';

// 阶段0 S0.3 的权威取数口径：node LF 计数
// 用法: node scripts/loc.mjs [文件...] ；无参数时用默认清单
// 为什么需要它：PowerShell 5.1 的 Get-Content 在本仓库系统性少读
// （main-world.js 报 2963，实际 3779），Measure-Object -Line 不计空行，两者都不可用。
const DEFAULTS = [
  'src/content/main-world.js',
  'entrypoints/content.ts',
  'src/content/isolated/pgc-cache-inject.ts',
  'src/platform/http/dnr.ts',
  'src/shared/types/messages.ts',
  'src/shared/constants/routes.ts',
  'src/shared/utils/page-snapshot.ts',
  'entrypoints/background.ts',
];

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
let bad = 0;
console.log("行数（node LF 口径：split('\\n').length）");
console.log('');
for (const f of files) {
  try {
    const s = fs.readFileSync(f, 'utf8');
    const total = s.split('\n').length;
    const blank = (s.match(/^\s*$/gm) || []).length;
    console.log(
      String(total).padStart(6) +
        ' total' +
        String(blank).padStart(6) +
        ' blank' +
        String(total - blank).padStart(6) +
        ' code   ' +
        f,
    );
  } catch (e) {
    bad += 1;
    console.log('  ERR  ' + f + '  ' + e.message);
  }
}
if (bad) process.exit(1);

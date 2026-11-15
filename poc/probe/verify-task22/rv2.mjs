// task-23 独立反向验证（RV）—— 安全版：单文件、备份→变异→跑测试→**精确还原**→校验 SHA。
// 禁止 git checkout/stash/reset（项目里有人因此丢过 51 个文件改动）。
//
// 用法: node rv2.mjs <1|2|3>

import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const TESTS = [
  'tests/unit/background/need-incognito-create-diag.test.ts',
  'tests/unit/content/panel-login-outcome.test.ts',
];

const NO_TESTS = /No test files found|no tests|Test Files\s+no tests/i;
const HAS_SYNTAX = /SyntaxError|Unexpected token|Transform failed|Failed to parse/i;
const SUMMARY = /(Tests\s+.*|Test Files\s+.*|✓|×)/;

function runTests() {
  try {
    const out = execFileSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--reporter=verbose', ...TESTS],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return { out, code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

function summarize(out) {
  const lines = out.split('\n').filter((l) => SUMMARY.test(l));
  return lines.map((l) => '    ' + l.trim()).join('\n');
}

const CASE = process.argv[2];
const MUTATIONS = {
  1: {
    file: 'entrypoints/background.ts',
    label: '缺陷1：create 改回空 catch（保持花括号配平）',
    from: `    try {
      created = await chrome.windows.create({
        url: chrome.runtime.getURL('/need-incognito.html'),
        type: 'popup',
        width: 460,
        height: 420,
      });
    } catch (e) {
      createError = e instanceof Error ? \`\${e.name}: \${e.message}\` : String(e);
    }`,
    to: `    created = await chrome.windows.create({
      url: chrome.runtime.getURL('/need-incognito.html'),
      type: 'popup',
      width: 460,
      height: 420,
    }).catch(() => {});`,
  },
  2: {
    file: 'src/content/panel/login-outcome.ts',
    label: '缺陷2：停用 already-open 分支（落回成功文案）',
    from: `  if (res.reason === 'already-open') {`,
    to: `  if (res.reason === 'already-open' && false) {`,
  },
  3: {
    file: 'src/content/panel/login-outcome.ts',
    label: '缺陷3：文案加回「再点一次」',
    from: `请到扩展详情页把它打开 —— 打开后回到这里重新点「扫码登录」`,
    to: `请到扩展详情页把它打开，再点一次`,
  },
};

const m = MUTATIONS[CASE];
if (!m) {
  console.error('usage: node rv2.mjs <1|2|3>');
  process.exit(2);
}

const bak = `${m.file}.rvbak`;
copyFileSync(m.file, bak);
const shaBefore = sha(m.file);

const text = readFileSync(m.file, 'utf8');
const hits = text.split(m.from).length - 1;
if (hits !== 1) {
  console.error(`❌ 期望 1 处匹配，实际 ${hits} 处 —— 拒绝执行`);
  unlinkSync(bak);
  process.exit(2);
}
writeFileSync(m.file, text.replace(m.from, m.to), 'utf8');
console.log(`▶ ${m.label}`);
console.log(`  file=${m.file}`);
console.log(`  sha_before=${shaBefore}`);
console.log(`  sha_mutated=${sha(m.file)}`);

const { out, code } = runTests();
console.log('');
console.log('=== 变异后测试输出 ===');
console.log(summarize(out));
console.log(`  exit=${code}`);
const isNoTests = NO_TESTS.test(out);
const isSyntax = HAS_SYNTAX.test(out);
console.log(`  是否 "no tests"（假红）: ${isNoTests}`);
console.log(`  是否 语法错误（假红）: ${isSyntax}`);

// 还原
copyFileSync(bak, m.file);
unlinkSync(bak);
const shaAfter = sha(m.file);
console.log('');
console.log('=== 还原 ===');
console.log(`  sha_restored=${shaAfter}`);
console.log(`  与变异前一致: ${shaAfter === shaBefore ? 'YES ✅' : 'NO ❌'}`);
console.log(`  残留 .rvbak: ${existsSync(bak) ? 'YES ❌' : 'none ✅'}`);

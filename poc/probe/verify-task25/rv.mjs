/**
 * task-25 独立复核：反向验证（RV）脚本。
 *
 * 纪律（沿用 task-23/24 的 rv.mjs）：
 *   - 备份 → 单点变异 → 跑测 → 按备份**逐字节还原** → 核 SHA256
 *   - **禁用** `git checkout` / `git stash` / `git reset`（有人因此丢过 51 个文件的改动）
 *   - 每个变异体都记：红了几条 / 红在哪一行 / vitest 是否 `no tests`（假红）/ 是否语法错误
 *
 * 用法：node poc/probe/verify-task25/rv.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const BACKUP = resolve(HERE, 'backup');

const LOGIN_OUTCOME = 'src/content/panel/login-outcome.ts';
const ENTRY = 'entrypoints/content-panel.content.ts';

const T_LOGIN_OUTCOME = 'tests/unit/content/panel-login-outcome.test.ts';
const T_ENTRY = 'tests/unit/content/panel/entry-wiring.test.ts';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const bakName = (rel) => resolve(BACKUP, rel.replace(/[\\/]/g, '__'));

function restore(rel) {
  copyFileSync(bakName(rel), resolve(ROOT, rel));
}

function runTests(files) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [resolve(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\u001b\[[0-9;]*m/g, '');
  const failLines = plain
    .split('\n')
    .filter((l) => /\bAssertionError\b|×|FAIL /.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  const atLines = plain
    .split('\n')
    .filter((l) => /❯ .*\.test\.ts:\d+/.test(l))
    .map((l) => l.trim());
  const totals = plain.match(/Tests\s+.*$/m)?.[0]?.trim() ?? '(no totals line)';
  return {
    noTests: /No test files found|no tests/i.test(plain),
    syntaxError: /Transform failed|SyntaxError|ERROR:\s+Expected|Unexpected token/i.test(plain),
    totals,
    failLines: [...new Set(failLines)].slice(0, 25),
    atLines: [...new Set(atLines)].slice(0, 20),
    rawTail: plain.split('\n').slice(-25).join('\n'),
  };
}

/** 单点精确替换；必须命中恰好 1 次，否则抛错（避免误伤别处） */
function mutate(rel, find, replaceWith) {
  const p = resolve(ROOT, rel);
  const src = readFileSync(p, 'utf8');
  const hits = src.split(find).length - 1;
  if (hits !== 1) throw new Error(`变异点命中 ${hits} 次（要求恰好 1 次）: ${rel} :: ${find}`);
  writeFileSync(p, src.replace(find, replaceWith), 'utf8');
  return hits;
}

const cases = [];

function caseRun(id, rel, find, replaceWith, testFiles) {
  const before = sha(resolve(ROOT, rel));
  const r = { id, file: rel, find, replaceWith, testFiles };
  try {
    if (before !== sha(bakName(rel)) && sha(bakName(rel)) !== before) {
      // 只记录，不阻断
    }
    mutate(rel, find, replaceWith);
    r.mutatedSha = sha(resolve(ROOT, rel));
    r.result = runTests(testFiles);
  } catch (e) {
    r.error = String(e.message ?? e);
  } finally {
    restore(rel);
    r.restored = sha(resolve(ROOT, rel)) === sha(bakName(rel));
    r.restoredSha = sha(resolve(ROOT, rel));
    r.baselineSha = sha(bakName(rel));
  }
  cases.push(r);
  return r;
}

/* ── 预检：备份是否与工作区一致 ───────────────────────────── */
const files = [LOGIN_OUTCOME, ENTRY, 'src/content/panel/panel.ts', T_ENTRY, T_LOGIN_OUTCOME];
const preflight = files.map((f) => ({
  file: f,
  worktree: sha(resolve(ROOT, f)),
  backup: existsSync(bakName(f)) ? sha(bakName(f)) : '(missing)',
}));

/* ── RV1：already-open 的 ok 改回 false（task-25 缺陷 1 复发） ── */
const rv1 = caseRun(
  'RV1: already-open 的 ok:true → false',
  LOGIN_OUTCOME,
  `    return {
      ok: true,
      shouldPoll: false,
      text: '扫码登录窗口已经开着了 —— 它就是上面那个窗口，请直接在那里操作',
    };`,
  `    return {
      ok: false,
      shouldPoll: false,
      text: '扫码登录窗口已经开着了 —— 它就是上面那个窗口，请直接在那里操作',
    };`,
  [T_LOGIN_OUTCOME],
);

/* ── RV2：调用点改回 if (!r.ok) return（engineer 说的真空洞） ── */
const rv2 = caseRun(
  'RV2: if (!r.shouldPoll) return → if (!r.ok) return',
  ENTRY,
  '      if (!r.shouldPoll) return;',
  '      if (!r.ok) return;',
  [T_ENTRY, T_LOGIN_OUTCOME],
);

/* ── RV3：注释冒充（代码写错，注释里写对）——验剥注释是否真有效 ── */
const rv3 = caseRun(
  'RV3: 代码改回 !r.ok，注释里写 !r.shouldPoll（剥离有效性）',
  ENTRY,
  '      if (!r.shouldPoll) return;',
  [
    '      /* if (!r.shouldPoll) return; <- 这一行只是注释，用来验剥离是否有效 */',
    '      if (!r.ok) return;',
  ].join('\n'),
  [T_ENTRY],
);

/* ── RV4：两行并存（shouldPoll 在、ok 也在前面） ── */
const rv4 = caseRun(
  'RV4: 两行并存（if (!r.ok) return 在前，shouldPoll 在后）',
  ENTRY,
  '      if (!r.shouldPoll) return;',
  '      if (!r.ok) return;\n      if (!r.shouldPoll) return;',
  [T_ENTRY],
);

/* ── RV5：面板 TTL 只由 ok 决定 —— 反向：把 if (ok) 改成 if (!ok) ── */
const rv5 = caseRun(
  'RV5: panel.ts 的 TTL 分支 if (ok) → if (!ok)（验 notice TTL 归谁管）',
  'src/content/panel/panel.ts',
  '    if (ok) {\n      noticeTimer = setTimeout(',
  '    if (!ok) {\n      noticeTimer = setTimeout(',
  ['tests/unit/content/panel-notice.test.ts'],
);

/* ── RV6：「注释冒充」最强形式 —— 把产品里已被测过的**旧文案**搬进注释 ──
 * `panel-login-outcome.test.ts` 里有多条 `not.toContain('已打开')` / `not.toContain('再点一次')`
 * 是对**文案常量**断言；若它读的是原始文本而不是函数返回值，往源码注释里写这些词就会假红/假绿。
 * 这里把旧文案原句写进 `login-outcome.ts` 的注释，跑测试：
 *   - 全绿 ⇒ 断言读的是函数返回值（注释无影响）⇒ 剥离与否都不影响这一组
 *   - 变红 ⇒ 断言读到了注释 ⇒ 该组存在假红/假绿风险，需报
 */
const rv6 = caseRun(
  'RV6: 源码注释里塞入被测过的旧文案（已打开 / 再点一次）',
  LOGIN_OUTCOME,
  'export function describeLoginOutcome(',
  [
    '/* 假注释：扫码窗口已打开，请用手机扫码。成功后这里会自动更新。再点一次 */',
    'export function describeLoginOutcome(',
  ].join('\n'),
  [T_LOGIN_OUTCOME],
);

/* ── RV7：条数守恒 —— 少跑测试文件/用例时是否有断言兜住 ──
 * 只跑一个文件时 totals 必然变小，`verify.mjs` 的 assertTestTotals 是唯一兜底；
 * 这里只记录「单文件 vs 双文件」的条数，供报告核对总数
 */
function counts() {
  const r = runTests([T_ENTRY, T_LOGIN_OUTCOME]);
  return r.totals;
}
const bothFilesTotals = counts();

/* ── RV8：真正删掉守卫（不是改调用点，而是删测试里的那两条）──
 * 验「守卫存在」与「守卫有效」不是一回事：删掉守卫测试后，RV2 的变异必须变绿
 */
function deleteGuardCase() {
  const rel = T_ENTRY;
  const p = resolve(ROOT, rel);
  const before = sha(p);
  let r = null;
  try {
    const src = readFileSync(p, 'utf8');
    writeFileSync(
      p,
      src.replace(
        `  it('★★★ openLogin 的早退必须判 \`!r.shouldPoll\`', () => {`,
        `  it.skip('★★★ openLogin 的早退必须判 \`!r.shouldPoll\`', () => {`,
      ).replace(
        `  it('★★★ openLogin 的早退**不许**再判 \`!r.ok\`', () => {`,
        `  it.skip('★★★ openLogin 的早退**不许**再判 \`!r.ok\`', () => {`,
      ),
      'utf8',
    );
    // 在守卫被 skip 的同时改坏调用点
    const entrySrc = readFileSync(resolve(ROOT, ENTRY), 'utf8');
    writeFileSync(resolve(ROOT, ENTRY), entrySrc.replace('      if (!r.shouldPoll) return;', '      if (!r.ok) return;'), 'utf8');
    r = runTests([T_ENTRY]);
  } catch (e) {
    r = { error: String(e.message ?? e) };
  } finally {
    restore(rel);
    restore(ENTRY);
  }
  return {
    id: 'RV8: 守卫被 skip + 调用点改坏（证明 RV2 的红来自新守卫）',
    result: r,
    restored: sha(p) === before && sha(resolve(ROOT, ENTRY)) === sha(bakName(ENTRY)),
  };
}
const rv8 = deleteGuardCase();

const out = {
  generatedAt: new Date().toISOString(),
  preflight,
  bothFilesTotals,
  cases: [rv1, rv2, rv3, rv4, rv5, rv6, rv8].filter((c, i, a) => a.indexOf(c) === i),
};
writeFileSync(resolve(HERE, 'rv-result.json'), JSON.stringify(out, null, 2), 'utf8');

/* ── 控制台摘要 ─────────────────────────────────────────── */
for (const p of preflight) {
  console.log(`[backup] ${p.worktree === p.backup ? 'OK ' : 'DIFF'} ${p.file}`);
}
for (const c of [...cases, rv6, rv8]) {
  const r = c.result ?? {};
  console.log(`\n=== ${c.id} ===`);
  if (c.error) console.log(`  ERROR: ${c.error}`);
  console.log(`  totals      : ${r.totals ?? '-'}`);
  console.log(`  no tests    : ${r.noTests}   syntaxError: ${r.syntaxError}`);
  console.log(`  restored    : ${c.restored} (${c.restoredSha === c.baselineSha ? 'SHA 一致' : 'SHA 不一致!'})`);
  for (const l of (r.failLines ?? []).slice(0, 8)) console.log(`  RED  ${l}`);
  for (const l of (r.atLines ?? []).slice(0, 6)) console.log(`  AT   ${l}`);
}
console.log(`\n[双文件基线条数] ${bothFilesTotals}`);

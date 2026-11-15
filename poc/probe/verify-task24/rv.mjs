/**
 * verifier 反向验证脚本（task-24）。
 *
 * 规则（用户明确要求）：
 *  - **禁用** `git checkout` / `git stash` / `git reset`（工作区有别人未提交的改动）
 *  - 用「读原文到内存 → 单点字符串替换 → 写回 → 跑测试 → 写回原文 → SHA256 比对」
 *  - 结果必须区分「真红（AssertionError）」和「假红（no tests / 语法错误）」
 *  - 跑完必须证明没有残留
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();

const TARGETS = {
  loginWindow: 'src/background/login-window.ts',
  mainTsx: 'entrypoints/login-window/main.tsx',
  outcome: 'src/content/panel/login-outcome.ts',
};

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
}

function runVitest(files) {
  const args = ['node_modules/vitest/vitest.mjs', 'run', ...files, '--reporter=json', '--outputFile=vitest.rv.json'];
  let code = 0;
  let stderr = '';
  try {
    execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    stderr = String(e.stderr ?? '');
  }
  let report = null;
  try {
    report = JSON.parse(readFileSync('vitest.rv.json', 'utf8'));
  } catch {
    report = null;
  }
  const failed = [];
  let total = 0;
  for (const f of report?.testResults ?? []) {
    for (const a of f.assertionResults ?? []) {
      total++;
      if (a.status === 'failed') {
        failed.push({
          title: a.fullName,
          msg: (a.failureMessages ?? []).join('\n').slice(0, 300),
        });
      }
    }
  }
  const suiteErrors = (report?.testResults ?? [])
    .flatMap((f) => (f.status === 'failed' && (f.assertionResults ?? []).length === 0 ? [f.message ?? '?'] : []))
    .map((m) => String(m).slice(0, 300));
  return { code, total, failed, suiteErrors, noTests: total === 0 };
}

const onlyAssertion = (r) => r.failed.length > 0 && r.failed.every((f) => /AssertionError|expected|toEqual|toBe/i.test(f.msg));

function classify(r) {
  if (r.noTests) return '假红（no tests / 加载失败）';
  if (r.suiteErrors.length) return '假红（套件级错误/语法错误）';
  if (r.failed.length === 0) return '未变红 ❌';
  return onlyAssertion(r) ? '真红（AssertionError）' : '变红但非断言';
}

const RESULTS = [];

function rv({ id, file, from, to, tests, label }) {
  const p = `${ROOT}/${file}`;
  const before = sha(p);
  const orig = readFileSync(p, 'utf8');
  const count = orig.split(from).length - 1;
  if (count !== 1) {
    RESULTS.push({ id, label, error: `锚点出现 ${count} 次，不唯一，跳过` });
    return;
  }
  writeFileSync(p, orig.replace(from, to), 'utf8');
  const r = runVitest(tests);
  writeFileSync(p, orig, 'utf8');
  const after = sha(p);
  RESULTS.push({
    id,
    label,
    file,
    mutatedLines: to.split('\n').length,
    total: r.total,
    failed: r.failed.map((f) => f.title),
    sampleMsg: r.failed[0]?.msg ?? r.suiteErrors[0] ?? '',
    verdict: classify(r),
    restored: before === after,
    sha: after,
  });
}

// ── RV1：把「无痕实例跳过探测」这条安全闸拆掉 ────────────────────────────
rv({
  id: 'RV1',
  label: 'isIncognitoInstance 恒返回 false（安全闸失效 → 无痕实例也探测）',
  file: TARGETS.loginWindow,
  from: `    return chrome.extension.inIncognitoContext === true;`,
  to: `    return false; // RV1 mutated`,
  tests: ['tests/unit/background/login-heartbeat-probe.test.ts'],
});

// ── RV2：把 already-open 的探测整段停用（回到 task-22 的死分支）────────────
rv({
  id: 'RV2',
  label: 'probeExistingLoginWindow 恒返回 null（回到「第二次点没反应」）',
  file: TARGETS.loginWindow,
  from: `  const beat = await probeExistingLoginWindow();`,
  to: `  const beat = null; // RV2 mutated`,
  tests: ['tests/unit/background/login-heartbeat-probe.test.ts'],
});

// ── RV3：让 assumed 重新断言「已打开」（过度断言回归）──────────────────────
rv({
  id: 'RV3',
  label: 'describeSuccess 对 assumed 不再走中性文案（回到「扫码窗口已打开」）',
  file: TARGETS.outcome,
  from: `  if (res.reason === 'assumed') {
    return '已尝试打开扫码登录窗口 —— 如果没看到新窗口，可能是被浏览器挡住了，请再点一次扫码登录';
  }`,
  to: `  // RV3 mutated: 删掉 assumed 分支`,
  tests: ['tests/unit/content/panel-login-outcome.test.ts'],
});

// ── RV4：把心跳写入端删掉（写端缺失 → 读取端永远读不到）────────────────────
rv({
  id: 'RV4',
  label: 'main.tsx 不再周期写心跳（只在注释里保留函数名，验证 stripComments 有效）',
  file: TARGETS.mainTsx,
  from: `    const timer = window.setInterval(beat, LOGIN_HEARTBEAT_INTERVAL_MS);`,
  to: `    // RV4 mutated: 写一次就够（保留 writeLoginHeartbeat 字样，验证剥注释）\n    const timer = 0;`,
  tests: ['tests/unit/background/login-heartbeat-wiring.test.ts'],
});

console.log(JSON.stringify(RESULTS, null, 2));

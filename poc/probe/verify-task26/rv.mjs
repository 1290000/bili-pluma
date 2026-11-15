/**
 * verifier 反向验证（task-27）：每组 = 备份 → 单点变异 → 跑守卫 → 还原 → SHA256 核对
 * 禁用 git checkout / stash / reset（项目里有人因此丢过 51 个文件改动）。
 *
 * ⚠️ 判定"真红"必须看**断言消息**，不能只看测试名：
 * 变异后个别用例可能因为变异体语法/类型不合而挂在更早的地方，
 * 那种红不代表判据守住了。下面每组的 expectMsg 都取自基线跑出来的真实消息。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, backup, bakLeft, cleanBak, mutate, restore, runTests, sha } from './rv-lib.mjs';

const PROBE_CFG = 'poc/probe/verify-task26/vitest.probe.config.ts';
const PANEL = 'src/content/panel/panel.ts';
const DIAG = 'src/content/panel/diagnostics.ts';
const GUARD_META = 'tests/unit/content/panel-diag-wiring.test.ts';
const GUARD_ERR = 'tests/unit/content/panel-diagnostics-export.test.ts';

const results = [];

function runProbe() {
  return runTests([`--config=${PROBE_CFG}`]);
}

function msgOf(output) {
  // 抓 AssertionError 那一行（vitest verbose）
  return [...output.matchAll(/^(?:AssertionError|Error|TypeError): (.+)$/gm)].map((m) => m[1]);
}

function record(name, expectTest, expectMsg, r) {
  const testHits = expectTest === '' ? r.redNames.slice() : r.redNames.filter((n) => n.includes(expectTest));
  const msgs = msgOf(r.output);
  const msgHits = expectMsg === '' ? msgs.slice() : msgs.filter((m) => m.includes(expectMsg));
  results.push({
    name,
    passed: r.passed,
    failed: r.failed,
    noTests: r.noTests,
    syntaxError: r.syntaxError,
    expectTest,
    expectMsg,
    matchedTest: testHits,
    matchedMsg: msgHits,
    // 三个条件缺一不可：有用例失败 + 失败的是预期的那个用例 + 失败原因里带着预期断言的措辞
    isReallyRed: r.failed > 0 && testHits.length > 0 && msgHits.length > 0 && !r.noTests && !r.syntaxError,
    allRed: r.redNames,
    allMsgs: msgs,
  });
}

const cases = [
  {
    name: 'RV1 ok 恒为 true（探针永远报"能读到"）',
    file: PANEL,
    from: '      return { ...base, ok: false, err: describeLogsError(error) };\n    }\n  };',
    to: '      return { ...base, ok: true, err: null };\n    }\n  };',
    guard: GUARD_META,
    expectTest: '孤儿态：读不到时显示读取失败',
    expectMsg: '还没有日志',
  },
  {
    name: 'RV2 ok 由 logs.length 推出（读取异常被 readDiag 吞成空数组 → 谎报"读到 0 条"）',
    file: PANEL,
    from: '        const logsMeta = { ...(await probeLogsReadability()), count: 0 };\n        const logs = await readDiag();\n        diagData = { rows, logs, logsMeta: { ...logsMeta, count: logs.length } };',
    to: '        const logs = await readDiag();\n        diagData = { rows, logs, logsMeta: { ...(await probeLogsReadability()), ok: logs.length > 0, count: logs.length } };',
    guard: '',
    expectTest: '读到 0 条但读取成功',
    expectMsg: '读到 0 条被误判成"读失败"',
  },
  {
    name: 'RV3 err fallback 回原始串（白名单失效）',
    file: DIAG,
    from: "  return 'unknown';\n}",
    to: '  return raw;\n}',
    guard: GUARD_ERR,
    expectTest: '未知错误串一律归成 unknown',
    expectMsg: 'unknown',
  },
  {
    name: 'RV5 err 白名单退回"截断长度"（旧写法：>64 字全量透传）',
    file: DIAG,
    from: "  return 'unknown';\n}",
    to: '  return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;\n}',
    guard: GUARD_ERR,
    expectTest: '端到端：`err` 带进去一个敏感串',
    expectMsg: 'abc123',
  },
  {
    name: 'RV6-A 判据 5 红点确认（第一步）：只补 .ok 防御 → 仍红，且红点后移到 reading err',
    file: DIAG,
    from: '  if (!data.logsMeta.ok) {\n    box.appendChild(el(\'p\', \'diag-section\', \'诊断日志\'));',
    to: '  if (!(data as unknown as { logsMeta?: { ok: boolean } }).logsMeta?.ok) {\n    box.appendChild(el(\'p\', \'diag-section\', \'诊断日志\'));',
    guard: '',
    expectTest: '判据 5',
    expectMsg: "reading 'err'",
  },
  {
    name: 'RV6-B 判据 5 红点确认（第二步，两处都补）→ 探针该条变绿',
    file: DIAG,
    from: '  if (!data.logsMeta.ok) {\n    box.appendChild(el(\'p\', \'diag-section\', \'诊断日志\'));',
    to: '  if (!(data as unknown as { logsMeta?: { ok: boolean; err?: string | null } }).logsMeta?.ok) {\n    box.appendChild(el(\'p\', \'diag-section\', \'诊断日志\'));',
    guard: '',
    expectTest: '',
    expectMsg: '',
    expectGreen: '判据 5',
    secondFrom: '    if (data.logsMeta.err !== null) {\n      box.appendChild(el(\'p\', \'pane-note\', `（${data.logsMeta.err}）`));',
    secondTo: '    const lmErr = (data as unknown as { logsMeta?: { err?: string | null } }).logsMeta?.err ?? null;\n    if (lmErr !== null) {\n      box.appendChild(el(\'p\', \'pane-note\', `（${lmErr}）`));',
  },
];

cleanBak();

// ── 基线：未变异时守卫必须全绿、探针只应有"判据 5"这一条红 ────────────
{
  const g = runTests([GUARD_META, GUARD_ERR]);
  const p = runProbe();
  results.push({
    name: 'BASELINE（未变异）',
    guardPassed: g.passed,
    guardFailed: g.failed,
    probePassed: p.passed,
    probeFailed: p.failed,
    probeRed: p.redNames,
    guardGreen: g.failed === 0 && !g.noTests && !g.syntaxError,
  });
}

for (const c of cases) {
  // 并发保护：变异前重新备份（task-25 的教训 5）
  const before = backup(c.file);
  let mutatedSha = '';
  try {
    mutate(c.file, c.from, c.to);
    if (c.secondFrom !== undefined) mutate(c.file, c.secondFrom, c.secondTo);
    mutatedSha = sha(resolve(ROOT, c.file));
    const r = c.guard !== '' ? runTests([c.guard]) : runProbe();
    if (c.expectGreen !== undefined) {
      const stillRed = r.redNames.filter((n) => n.includes(c.expectGreen));
      results.push({
        name: c.name,
        probeFailed: r.failed,
        expectGreen: c.expectGreen,
        stillRed,
        // 加了防御后判据 5 应该变绿 —— 这就证明"红"确实来自那一行的缺防御
        isRecoveryGreen: stillRed.length === 0 && !r.noTests && !r.syntaxError,
      });
    } else {
      record(c.name, c.expectTest, c.expectMsg, r);
    }
  } finally {
    const back = restore(c.file);
    const last = results[results.length - 1];
    last.restored = back.restored;
    last.shaAfter = back.sha;
    last.shaBefore = before;
    last.mutatedSha = mutatedSha;
    if (!back.restored) throw new Error(`还原失败：${c.file}`);
  }
}

results.push({
  name: '收工核对',
  bakLeft: bakLeft(),
  panelSha: sha(resolve(ROOT, PANEL)),
  diagSha: sha(resolve(ROOT, DIAG)),
});
cleanBak();

writeFileSync(resolve(ROOT, 'poc/probe/verify-task26/rv-result.json'), JSON.stringify(results, null, 2), 'utf8');
for (const r of results) {
  const { allMsgs, allRed, ...rest } = r;
  console.log(JSON.stringify(rest));
}

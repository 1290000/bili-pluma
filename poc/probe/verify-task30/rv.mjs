/**
 * task-31 反向验证（逐条跑，不依赖单次脚本的长结构）。
 *
 * 纪律：
 *  1. 变异前断言变异点出现次数 === 1；不是 1 次直接抛（不许"变异错了地方在别处巧合变红"）。
 *  2. "真红"= 有用例失败 + 失败消息带预期措辞（`no tests` / 整文件语法错不算）。
 *  3. 还原 = 备份文件复制 + SHA256 逐字节核对；禁用 git stash/checkout/reset。
 *
 * 用法：node poc/probe/verify-task30/rv.mjs <RV1|RV2|RV3|RV4|RV5|RV6|clean>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, backup, restore, runTests, mutate, sha, cleanBak, bakCount, writeText,
} from './rv-lib.mjs';

const PANEL = 'src/content/panel/panel.ts';
const DIAG = 'src/content/panel/diagnostics.ts';
const EXPTEST = 'tests/unit/content/panel-diagnostics-export.test.ts';
const CHAINTEST = 'tests/unit/content/panel-logsmeta-chain.test.ts';
const ALL = [PANEL, DIAG, EXPTEST, CHAINTEST];

function log(...a) {
  console.log(...a);
}

function withMutation(id, title, files, fn, tests) {
  log(`\n=== ${id} · ${title} ===`);
  const snap = backup(ALL);
  let mutated = null;
  let run = { failed: 0, passed: 0, failures: [], noTests: true };
  try {
    mutated = fn();
    run = runTests(tests);
  } catch (e) {
    mutated = { error: String(e.message ?? e) };
  } finally {
    const after = restore(ALL);
    const same = ALL.every((r) => after[r] === snap[r]);
    log(`[${id}] mutated=${JSON.stringify(mutated)}`);
    log(`[${id}] failed=${String(run.failed)} passed=${String(run.passed)} noTests=${String(run.noTests)}`);
    for (const f of run.failures) log(`   × ${f.name}\n     ${f.msg}`);
    log(`[${id}] restore 逐字节一致=${String(same)} ${ALL.map((r) => `${r.split('/').pop()}:${after[r].slice(0, 12)}`).join(' ')}`);
  }
  return { id, title, mutated, run, files };
}

const which = process.argv[2];

if (which === 'clean') {
  cleanBak();
  log(`[clean] rvbak=${String(bakCount())}`);
} else if (which === 'RV1') {
  // 导出兜底改回字面 ok:true / err:null（= task-29 的 RV3 同款）
  withMutation(
    'RV1',
    '导出兜底改回 ok:true/err:null',
    [PANEL],
    () =>
      mutate(
        PANEL,
        'logsMeta: diagData?.logsMeta ?? {\n                    ...describeLogsMetaFallback(),\n                    limit: DIAG_LIMIT,\n                    instanceId: instanceId(),\n                    readAt: now.getTime(),\n                  },',
        "logsMeta: diagData?.logsMeta ?? { ok: true, err: null, count: 0, limit: 30, instanceId: 'x', readAt: now.getTime() },",
      ),
    [EXPTEST, CHAINTEST],
  );
} else if (which === 'RV2') {
  // 观测类字段被真值覆盖：在兜底展开后再塞 ok:false/err 字面量
  withMutation(
    'RV2',
    '兜底后追加字面 ok: 覆盖观测类',
    [PANEL],
    () =>
      mutate(
        PANEL,
        '                    ...describeLogsMetaFallback(),\n                    limit: DIAG_LIMIT,',
        "                    ...describeLogsMetaFallback(),\n                    ok: true,\n                    limit: DIAG_LIMIT,",
      ),
    [EXPTEST],
  );
} else if (which === 'RV3') {
  // 静态穷举守卫：panel.ts 里插一行链式访问
  withMutation(
    'RV3',
    'panel.ts 插入 diagData.logsMeta.count（守卫必须红）',
    [PANEL],
    () => mutate(PANEL, 'logsMeta: diagData.logsMeta,', 'logsMeta: diagData.logsMeta,\n            __probe: diagData.logsMeta.count,'),
    [CHAINTEST],
  );
} else if (which === 'RV4') {
  // 自检用例改坏：样例里去掉已知违规 → 自检必须红（证明扫描器能力被守）
  withMutation(
    'RV4',
    '守卫自检用例去掉已知违规样例',
    [CHAINTEST],
    () => mutate(CHAINTEST, "      'const bad = data.logsMeta.count;',\n", ''),
    [CHAINTEST],
  );
} else if (which === 'RV5') {
  // 注释被删：先数"两个主语"出现次数
  const src = readFileSync(join(ROOT, DIAG), 'utf8');
  log(`[RV5-preflight] 「两个主语」出现 ${String(src.split('两个主语').length - 1)} 次`);
  log(`[RV5-preflight] 「主语是**日志存储**」出现 ${String(src.split('主语是**日志存储**').length - 1)} 次`);
  const kept = src
    .split('\n')
    .filter((l) => !/主语是\*\*日志存储\*\*|主语是\*\*这次读取/.test(l))
    .join('\n');
  const snap = backup(ALL);
  let mutated = null;
  let run = { failed: 0, passed: 0, failures: [], noTests: true };
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(ROOT, DIAG), kept, 'utf8');
    mutated = { removedLines: src.split('\n').length - kept.split('\n').length };
    run = runTests([EXPTEST, CHAINTEST]);
  } catch (e) {
    mutated = { error: String(e.message ?? e) };
  } finally {
    const after = restore(ALL);
    const same = ALL.every((r) => after[r] === snap[r]);
    log(`[RV5] mutated=${JSON.stringify(mutated)} failed=${String(run.failed)} passed=${String(run.passed)} restore_ok=${String(same)}`);
    for (const f of run.failures) log(`   × ${f.name}\n     ${f.msg}`);
  }
} else if (which === 'RV6') {
  // 渲染侧兜底改 ok:true（task-28 那组守卫必须红）
  withMutation(
    'RV6',
    'describeLogsMetaFallback 返回 ok:true',
    [DIAG],
    () => mutate(DIAG, "return { ok: false, err: 'unknown', count: 0, limit: 0, instanceId: 'unknown', readAt: 0 };", "return { ok: true, err: null, count: 0, limit: 0, instanceId: 'unknown', readAt: 0 };"),
    [EXPTEST, CHAINTEST],
  );
} else {
  log('用法：node rv.mjs <RV1|RV2|RV3|RV4|RV5|RV6|clean>');
  log(`当前 rvbak=${String(bakCount())}`);
}

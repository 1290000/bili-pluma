/**
 * task-29 反向验证（task-28 验收）
 *
 * RV1 去掉渲染侧 fallback → 判据 A 真红
 * RV2 兜底语义改成 ok:true（谎报）→ 判据 C 真红
 * RV3 导出侧不用共用 fallback、改回各自写一份且取值不同 → 判据 D 真红
 * RV4 产品守卫（engineer 那 3 条）自身的 RV：去掉渲染 fallback → engineer 那组也必须红
 * RV5 **静态穷举守卫自带 RV**（Lead 硬要求 ii）：插一行 `const x = data.logsMeta.count;`
 *     → 静态守卫必须真红；删掉 → 绿
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import * as L from './rv-lib.mjs';

const HERE = dirname(createRequire(import.meta.url).resolve(import.meta.filename ?? process.argv[1] ?? ''));
const DIAG = 'src/content/panel/diagnostics.ts';
const PANEL = 'src/content/panel/panel.ts';

const results = [];
const files = [DIAG, PANEL];

function record(entry) {
  results.push(entry);
  console.log(`\n=== ${String(entry.label)} ===`);
  console.log(JSON.stringify(entry, null, 2));
}

// ── 基线：未变异必须全绿 ──
{
  for (const f of files) L.backup(f);
  const base = L.runTests();
  record({ label: 'BASELINE（未变异）探针', ...L.check('BASELINE', /./, base) });
  if (base.failed !== 0) {
    console.log('[ABORT] 基线不是绿的，后面所有"红"都没意义');
    process.exit(2);
  }
}

// ── RV1 去掉渲染侧 fallback ──
{
  L.mutate(DIAG, 'const meta: LogsMeta = data.logsMeta ?? describeLogsMetaFallback();', 'const meta: LogsMeta = data.logsMeta as LogsMeta;');
  const r = L.runTests();
  record({ label: 'RV1 去掉渲染侧 fallback', ...L.check('RV1', /reading 'ok'/, r) });
  const { restored, sha } = L.restore(DIAG);
  record({ label: 'RV1 restore', restored, sha });
}

// ── RV2 兜底语义改成 ok:true（谎报）──
{
  L.backup(DIAG);
  L.mutate(DIAG, "return { ok: false, err: 'unknown', count: 0, limit: 0, instanceId: 'unknown', readAt: 0 };", "return { ok: true, err: null, count: 0, limit: 0, instanceId: 'unknown', readAt: 0 };");
  const r = L.runTests();
  record({ label: 'RV2 fallback 取 ok:true（谎报）', ...L.check('RV2', /还没|读取失败|ok/, r) });
  const { restored, sha } = L.restore(DIAG);
  record({ label: 'RV2 restore', restored, sha });
}

// ── RV3 导出侧不共用 fallback ──
{
  L.backup(PANEL);
  L.mutate(
    PANEL,
    `logsMeta: diagData?.logsMeta ?? {
                    ...describeLogsMetaFallback(),
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },`,
    `logsMeta: diagData?.logsMeta ?? {
                    ok: true,
                    err: null,
                    count: 0,
                    limit: DIAG_LIMIT,
                    instanceId: instanceId(),
                    readAt: now.getTime(),
                  },`,
  );
  // 导出侧变异要跑**产品测试**（探针不覆盖导出路径）
  const r = L.runTests({ probe: false, files: ['tests/unit/content/panel-diagnostics-export.test.ts'] });
  record({ label: 'RV3 导出侧改回各自写一份且 ok:true', ...L.check('RV3', /ok|unknown|logsMeta/, r) });
  const { restored, sha } = L.restore(PANEL);
  record({ label: 'RV3 restore', restored, sha });
}

// ── RV4 engineer 那 3 条产品守卫的 RV ──
{
  L.backup(DIAG);
  L.mutate(DIAG, 'const meta: LogsMeta = data.logsMeta ?? describeLogsMetaFallback();', 'const meta: LogsMeta = data.logsMeta as LogsMeta;');
  const r = L.runTests({ probe: false, files: ['tests/unit/content/panel-diagnostics-export.test.ts'] });
  record({ label: 'RV4 去掉 fallback → engineer 那组守卫是否真红', ...L.check('RV4', /reading 'ok'|reading 'err'/, r) });
  const { restored, sha } = L.restore(DIAG);
  record({ label: 'RV4 restore', restored, sha });
}

// ── RV5 静态穷举守卫自带 RV（Lead 硬要求 ii）──
{
  L.backup(PANEL);
  // 在 render 里插一行"新地方"的链式访问
  L.mutate(PANEL, 'logsMeta: diagData.logsMeta,', 'logsMeta: diagData.logsMeta,\n            __probeNewChainAccess: diagData.logsMeta.count,');
  const r = L.runTests();
  record({ label: 'RV5 插入新链式访问 data.logsMeta.count → 静态守卫必须红', ...L.check('RV5', /链式|logsMeta/, r) });
  const { restored, sha } = L.restore(PANEL);
  record({ label: 'RV5 restore', restored, sha });

  // 反向确认：删掉后必须变绿
  const back = L.runTests();
  record({ label: 'RV5 还原后再跑（必须全绿）', ...L.check('RV5-restored', /./, back) });
}

// ── 收工 ──
const left = L.bakLeft();
L.cleanBak();
const finalSha = Object.fromEntries(files.map((f) => [f, (() => {
  const { createHash } = createRequire(import.meta.url)('node:crypto');
  return createHash('sha256').update(readFileSync(join(L.ROOT, f))).digest('hex').toUpperCase();
})()]));

const summary = { results, bakLeft: left, finalSha };
writeFileSync(join(HERE, 'rv-result.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify({ bakLeft: left, finalSha }, null, 2));

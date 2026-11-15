// 走查脚本（task-27 RV6 的调试残留，仅作证据保留）
// 用途：探明 RV6 为什么"补上防御后判据 5 仍是红的"
//   SEQ1 = 只补第一处（.ok），SEQ2 = 两处都补
// 结果见 probe-seq1.txt / probe-seq2.txt：SEQ1 红点后移到 reading 'err'，
// 说明 transform 没读到旧代码；RV6 原写法之所以"不变绿"，是因为第二处
// `data.logsMeta.err` 同样在解引用。
import { readFileSync, writeFileSync } from 'node:fs';

const P = 'src/content/panel/diagnostics.ts';

export function step1() {
  const s = readFileSync(P, 'utf8');
  const from = '  if (!data.logsMeta.ok) {';
  if (s.split(from).length - 1 !== 1) throw new Error('变异点不唯一');
  writeFileSync(
    P,
    s.replace(
      from,
      '  if (!(data as unknown as { logsMeta?: { ok: boolean; err?: string | null } }).logsMeta?.ok) {',
    ),
    'utf8',
  );
}

export function step2() {
  const s = readFileSync(P, 'utf8');
  const from = '    if (data.logsMeta.err !== null) {';
  if (s.split(from).length - 1 !== 1) throw new Error('变异点不唯一');
  writeFileSync(
    P,
    s
      .replace(
        from,
        '    const e2 = (data as unknown as { logsMeta?: { err?: string | null } }).logsMeta?.err ?? null;\n    if (e2 !== null) {',
      )
      .replace('`（${data.logsMeta.err}）`', '`（${e2}）`'),
    'utf8',
  );
}

/**
 * F/G 判据探针：`openLogin` 里 `sendMessage` 的失败形态必须**全部**留痕。
 *
 * ## 判据 F（同步抛必须兜住）
 * `chrome.runtime.id` 正常（**守卫放行**）、`sendMessage` **同步抛**孤儿错
 * ⇒ 必须 `showOrphanHint()`。测的是 `try/catch` 包住 `await`，不是守卫。
 *
 * ## 判据 G（catch 不许静默）
 * 喂一个**非孤儿错**（`new Error('boom')`）⇒ 也必须留痕（提示或 diag）。
 * 现在的实现是 `if (isOrphanError(e)) { showOrphanHint(); return null; } return null;`
 * —— 非孤儿错落到最后一个 `return null`，**静默**。这是要判的点。
 *
 * ## 判据 H（readAccountMid 同步抛）
 * 同样形态：`readAccountMid()` 同步抛、且是孤儿错 ⇒ 必须 `showOrphanHint()`；
 * 非孤儿错是否静默 → 记录事实，供 Lead 判。
 *
 * 用法：node poc/probe/verify-task37-39/sendmessage-failure-probe.mjs
 */
import { buildProbe } from './repair-and-guard-probe.mjs';

const CASES = [
  ['F：SEND 同步抛孤儿错', { send: 'sync-throw' }],
  ['F：SEND 异步 reject 孤儿错', { send: 'async-throw' }],
  ['G：SEND 同步抛非孤儿错 boom', { send: 'sync-garbage' }],
  ['G：SEND 异步 reject 非孤儿错 boom', { send: 'async-garbage' }],
  ['H：readMid 同步抛孤儿错', { readMid: 'sync-throw', send: 'ok' }],
  ['H：readMid 同步抛非孤儿错', { readMid: 'sync-garbage', send: 'ok' }],
];

let fails = 0;
for (const [label, opts] of CASES) {
  const p = buildProbe(opts);
  await p.run();
  const c = p.calls();
  const orphanErr = !label.includes('非孤儿');
  const mustHint = orphanErr;
  const ok = mustHint ? c.hint >= 1 : undefined;
  const mark = mustHint ? (ok ? '✅' : '🔴') : '⚠️';
  if (mustHint && !ok) fails += 1;
  console.log(
    `${mark} ${label.padEnd(28)} hint=${c.hint} notice=${c.notice} sendMessage=${c.sendMessage}${c.throwOut ? ` throwOut=${c.throwOut}` : ''}`,
  );
}
console.log(`\n孤儿错必须提示：${fails === 0 ? '✅ 全部满足' : `🔴 ${fails} 条不满足`}`);
process.exit(fails === 0 ? 0 : 1);

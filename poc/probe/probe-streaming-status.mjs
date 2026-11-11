#!/usr/bin/env node
/**
 * 探针：在**真机上**对比取流身份的**两个来源**。
 *
 * ## 为什么必须走 content script 桥
 *
 * | 发送方 | 能不能 |
 * | --- | --- |
 * | 页面主世界（`bsk evaluate` 默认） | ❌ 没有 `chrome.runtime` |
 * | popup（`chrome-extension://`） | ❌ bsk 沙箱按 URL 白名单拒绝 |
 * | **background SW 自己** | ❌ Chrome 不派发给发送者自己（**预期，与本 bug 无关**） |
 * | **content script** | ✅ **唯一可达的第三方上下文** |
 *
 * 见 `docs/guides/bsk-page-bridges.md` §0。
 *
 * ## 判读矩阵（`content.ts` 的 `takeSnapshot` 里也写了同一张表）
 *
 * | fromMessage | fromStorage | 结论 |
 * | --- | --- | --- |
 * | `'extension'` | `'extension'` | ✅ 两者正常 → **问题在渲染层** |
 * | `null` | `'extension'` | 🔴 **消息坏了**（存储有值却没传出来） |
 * | `null` | `null` | 🟡 存储读取本身失败 |
 *
 * 用法：
 *   node poc/probe/probe-streaming-status.mjs <session_id> <tab_id>
 */

import { execFileSync } from 'node:child_process';

const [sid, tabId] = process.argv.slice(2);
if (!sid || !tabId) {
  console.error('用法: node poc/probe/probe-streaming-status.mjs <session_id> <tab_id>');
  process.exit(2);
}

/**
 * ⚠️ 必须 async IIFE + 内部 await（`bsk-page-bridges.md` §1）：
 * `JSON.stringify(promise)` 会在 await 之前执行，得到 `{}` 且看起来成功。
 */
const SNAPSHOT_EXPR = `(async () => {
  const t0 = Date.now();
  const r = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('snapshot-reply 超时(6s)')), 6000);
    const h = (e) => {
      if (e.data && e.data.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t);
        window.removeEventListener('message', h);
        resolve({ snap: e.data.snapshot, probe: e.data.streamingProbe });
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify({ wallMs: Date.now() - t0, ...r });
})()`;

function bsk(args) {
  return execFileSync('bsk', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

try {
  console.log('[probe] 通过 content 快照桥读 streamingProbe …\n');
  const raw = bsk(['evaluate', '--session', sid, '--tab-id', tabId, SNAPSHOT_EXPR]);
  const { wallMs, snap, probe } = JSON.parse(raw.trim());

  console.log('=== 桥墙钟耗时 ===', wallMs, 'ms');
  console.log('=== streamingProbe ===');
  console.log(JSON.stringify(probe, null, 2));

  console.log('\n=== 对照项（确认桥本身正常）===');
  console.log('proxy  :', JSON.stringify(snap?.proxy));
  console.log('page   :', JSON.stringify(snap?.page));

  console.log('\n=== 判定 ===');
  if (!probe) {
    console.log('🔴 桥没带 streamingProbe —— 产物是旧的，需要重新构建 + 重载');
    process.exit(0);
  }
  const { fromMessage, fromStorage, messageElapsedMs } = probe;

  if (fromMessage && fromStorage) {
    console.log(`✅ 两个来源都正常（${fromMessage} / ${fromStorage}，消息耗时 ${messageElapsedMs}ms）`);
    console.log('   → **消息通道没问题**，问题在渲染层（content-panel / tabs）');
  } else if (!fromMessage && fromStorage) {
    console.log(`🔴 **消息坏了**：存储有值（${fromStorage}），但 streaming/status 没传出来`);
    console.log(`   消息耗时 ${messageElapsedMs}ms`);
  } else if (!fromMessage && !fromStorage) {
    console.log('🟡 **存储读取也失败** —— 不是消息的问题，是 chrome.storage 读不到');
  } else {
    console.log(`🟡 消息有值（${fromMessage}）但存储读不到（${String(fromStorage)}）—— 反直觉，需深查`);
  }
} catch (e) {
  console.error('[probe] 失败：', e.message);
  process.exit(1);
}

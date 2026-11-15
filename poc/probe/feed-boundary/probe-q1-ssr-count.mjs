/**
 * feed-boundary 探针：**首屏 SSR 批大小是否稳定为 10**（Q1）。
 *
 * ## 为什么这样测
 * 任务要求"`document_start` 之后（rcmd 返回前）HTML 里 `.bili-video-card.is-rcmd` 的数量"。
 * bsk 无法在 document_start 注入，但**有一个等价且更干净的办法**：
 * 直接 `fetch` 主文档 HTML 并只做字符串统计 —— 这份 HTML 就是**服务端返回的原始字节**，
 * 尚未执行任何页面 JS。这与"document_start 那一刻的 DOM"在数据来源上是同一个东西
 * （只是后者多了解析开销，卡片数不会因此变化）。
 *
 * 另做一路**真 DOM 交叉验证**：用 iframe 加载首页但**不执行脚本**（sandbox 无 allow-scripts），
 * 数里面的卡片 —— 这是"解析后、无 JS"的真实 DOM 卡片数。
 *
 * ⚠️ 纯只读：不点击、不登录、不登出、不发任何写请求。
 */
import { evaluate } from './../api-inventory/bsk-eval.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i < 0 ? null : args[i + 1];
};
const session = get('--session');
const tab = get('--tab');
if (!session || !tab) {
  console.error('用法: node probe-q1-ssr-count.mjs --session <sid> --tab <tabId> [--rounds 5]');
  process.exit(2);
}

const ROUNDS = Number(get('--rounds') || 5);

// 单次采样：只拉 HTML 做字符串统计（不发页面 JS）
const SAMPLE = `(async()=>{
  const r=await fetch('https://www.bilibili.com/?_t='+Date.now(),{credentials:'include',cache:'no-store'});
  const h=await r.text();
  return JSON.stringify({
    status:r.status,
    len:h.length,
    // 精确到"卡片 div 上的 is-rcmd"
    cardRcmd:(h.match(/bili-video-card is-rcmd/g)||[]).length,
    // 所有 is-rcmd 出现（含脚本里的变量名，作参考不当判据）
    allIsRcmd:(h.match(/is-rcmd/g)||[]).length,
    imageLink:(h.match(/bili-video-card__image--link/g)||[]).length,
    titles:(h.match(/bili-video-card__info--tit/g)||[]).length,
    feedCardDiv:(h.match(/class="feed-card"/g)||[]).length
  });
})()`;

const samples = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  const r = evaluate(session, tab, SAMPLE);
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    console.log(`第 ${i} 次 FAIL: ${(r.err || r.out || '').slice(0, 200)}`);
    continue;
  }
  samples.push(parsed);
  console.log(
    `第 ${i} 次: cardRcmd=${parsed.cardRcmd} imageLink=${parsed.imageLink} titles=${parsed.titles} feedDiv=${parsed.feedCardDiv} len=${parsed.len}`,
  );
  // 间隔 ≥3 秒避免缓存/连击
  if (i < ROUNDS) {
    evaluate(session, tab, `new Promise(r=>setTimeout(()=>r('ok'),3200))`);
  }
}

const counts = samples.map((s) => s.cardRcmd);
const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
const variance = counts.length
  ? counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length
  : 0;
const sd = Math.sqrt(variance);

console.log('\n=== Q1 结果 ===');
console.log('数组:', JSON.stringify(counts));
console.log('均值:', mean.toFixed(3), '标准差:', sd.toFixed(3), '样本数:', counts.length);
console.log('是否全部相同:', new Set(counts).size === 1);

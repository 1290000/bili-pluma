/**
 * 取证脚本 H：从官方 bundle 判断写接口的 **body 编码方式**（urlencoded / FormData / JSON）。
 *
 * 纯静态分析 CDN 上的公开 JS，不碰任何账号、不发任何写请求。
 * 用法：node poc/probe/api-inventory/probe-h-body-encoding.mjs
 */
const BUNDLES = [
  'https://s1.hdslb.com/bfs/seed/jinkela/short/watchlater-pip/watchlater-pip.umd.js',
];

const KWS = [
  'archive/like',
  'coin/add',
  'fav/resource/deal',
  'v2/reply/add',
  'relation/modify',
  'click-interface/web/heartbeat',
];

const res = await fetch(BUNDLES[0]);
if (!res.ok) {
  console.error('bundle 拉取失败', res.status);
  process.exit(1);
}
const src = await res.text();
console.log(`bundle 长度: ${src.length}\n`);

for (const kw of KWS) {
  const i = src.indexOf(kw);
  console.log(`### ${kw}`);
  if (i < 0) {
    console.log('  未在该 bundle 中出现\n');
    continue;
  }
  const ctx = src.slice(Math.max(0, i - 120), i + 420);
  console.log('  ' + ctx.replace(/\s+/g, ' '));
  console.log('');
}

// 统计三种 body 形态在该 bundle 里的出现次数
const counts = {
  urlencoded: (src.match(/application\/x-www-form-urlencoded/g) || []).length,
  json: (src.match(/application\/json/g) || []).length,
  multipart: (src.match(/multipart\/form-data/g) || []).length,
  formData: (src.match(/new FormData/g) || []).length,
};
console.log('### Content-Type 出现次数', JSON.stringify(counts));

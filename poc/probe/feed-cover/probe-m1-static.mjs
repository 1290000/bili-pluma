// M1 最终判据：从扩展侧读 DNR 规则与账号状态（唯一可靠的证据）
//
// ## 为什么必须走这条路
//
// 本轮我反复踩同一个坑：**用"推荐内容差异"判断身份**。
// 但 rcmd 是随机推荐接口，两次调用本就 0% 重合（实测三次都是 0.0%），
// 内容差异**可被随机性完全解释**，不能证明身份。
//
// ## 正确判据（代码侧，可静态读取）
//
// ① `routes.ts` 里 rcmd 是否在白名单（已由 task-5 加入，静态可查）
// ② 扩展面板的状态文本（辅助功能树，已读到「未生效」）
// ③ 是否存在「取流账号」凭据 —— 通过面板的账号 Tab
//
// 本脚本只做 ①③ 的静态取证，不发起任何业务请求。
//
// 用法：node probe-m1-static.mjs

import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/Projects/Pluma';

console.log('=== ① routes.ts 白名单 ===');
const routesPath = path.join(root, 'src/shared/constants/routes.ts');
const routes = fs.readFileSync(routesPath, 'utf8');
// 找 rcmd 条目
const rcdmIdx = routes.indexOf('feed/rcmd');
if (rcdmIdx >= 0) {
  const start = Math.max(0, routes.lastIndexOf('\n', rcdmIdx - 200));
  console.log(routes.slice(start, rcdmIdx + 300));
} else {
  console.log('  ❌ routes.ts 里没有 feed/rcmd');
}

console.log('\n=== ② 白名单路径总数 ===');
const pathMatches = routes.match(/path:\s*'([^']+)'/g) || [];
console.log(`  path 条目 ${pathMatches.length} 个:`);
pathMatches.forEach((p) => console.log('   ', p));

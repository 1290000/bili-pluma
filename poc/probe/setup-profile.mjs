/**
 * 建立**独立测试 profile**，用于可复现实的实测。
 *
 * ## 为什么不能用日常 profile
 *
 * Edge 硬限制：默认 profile **不允许**开调试端口
 * （`DevTools remote debugging requires a non-default data directory`）。
 * Chrome 可以，Edge 不行。
 *
 * 所以建一个独立目录，登录一次后长期复用。
 * 它**完全独立于日常 Edge**，不影响你正常使用。
 *
 * 这个脚本只做一件事：启动浏览器，让用户手动登录，然后关掉。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export const PROFILE_DIR = join(homedir(), 'AppData', 'Local', 'pluma-probe-profile');

mkdirSync(PROFILE_DIR, { recursive: true });
console.log(`测试 profile: ${PROFILE_DIR}`);
console.log('打开 B站首页，请在窗口里扫码登录播放账号（大会员）…\n');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: EDGE,
  headless: false,
  viewport: { width: 1200, height: 860 },
  args: ['--no-first-run', '--no-default-browser-check'],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});

/**
 * 等用户登录。
 *
 * 判据：`nav` 接口返回 code 0 且 isLogin 为 true。
 * 每隔 3 秒探一次，最多等 10 分钟。
 */
let loggedIn = false;
for (let i = 0; i < 200; i += 1) {
  await page.waitForTimeout(3000);
  try {
    const r = await page.evaluate(async () => {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
      });
      const j = await res.json();
      return { code: j.code, isLogin: j.data?.isLogin, uname: j.data?.uname, vip: j.data?.vipStatus };
    });
    if (r.code === 0 && r.isLogin) {
      console.log(`\n✅ 已登录: ${r.uname}  vipStatus=${r.vip}`);
      loggedIn = true;
      break;
    }
  } catch {
    // 页面可能还在跳转，继续等
  }
}

if (!loggedIn) {
  console.log('\n⚠️ 10 分钟内未检测到登录');
}

await ctx.close();
console.log(loggedIn ? '登录态已保存在测试 profile，下次实测直接复用。' : '未登录，profile 已创建但不可用。');

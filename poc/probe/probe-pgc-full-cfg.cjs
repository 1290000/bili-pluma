// 驱动 `probe-pgc-full-cfg.js`：打开真实页面，然后现场调用它。
//
//   POC_HEADLESS=1 node poc/probe/probe-pgc-full-cfg.cjs
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss34412';
const OUT = path.join(__dirname, 'result-pgc-full-cfg.json');
/**
 * 原型脚本以 `(async () => {` 开头。**直接当表达式求值**：
 * `page.evaluate` 传入字符串时会先把它当表达式解析，所以外层不能再加 `()` ——
 * 那会变成"先求值 IIFE 的结果（一个 Promise），再把它当函数调用" → is not a function。
 */
const SCRIPT = readFileSync(path.join(__dirname, 'probe-pgc-full-cfg.js'), 'utf8');

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.POC_HEADLESS === '1',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--lang=zh-CN',
    ],
  });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  const out = { target: TARGET };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    out.before = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { dur: Math.round(v?.duration ?? 0), h: v?.videoHeight ?? 0 };
    });
    // 原型脚本本身就是 `(async () => {...})()`，直接求值即可（不要再包一层括号调用）
    out.after = await page.evaluate(SCRIPT);
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close();
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 1));
})();

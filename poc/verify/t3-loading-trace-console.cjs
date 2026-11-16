#!/usr/bin/env node
/**
 * T3 真机取证：**真实扩展的 content script 隔离世界能不能读到页面媒体请求**
 *
 * ## 为什么要单独一个脚本
 *
 * `poc/probe/pcdn-diag/probe.mjs` 用的是 CDP `Page.createIsolatedWorld` 造的隔离世界。
 * 它读到了媒体请求，但**它不是 content script 的隔离世界**：注入时机、
 * 生命周期、`performance` 缓冲的可视范围都不同。上一轮的探针只能当参考，
 * 不能当结论 —— 而整个 PCDN 诊断功能都建立在"这个读数是真的"之上。
 *
 * ## 它验什么
 *
 * 1. 装真扩展（`.output/chrome-mv3`），开一个真实视频页并播放
 * 2. 等 content script 里的临时探针打出 `[pluma-t3] <JSON>`（播放 12 秒后的快照）
 * 3. 用**页面自己的请求记录**（Playwright `request` 事件，与扩展无关）做参照系，
 *    比对快照里的 `hosts[].host` 是否与页面真实媒体请求的 host 对得上
 *
 * 判据：
 *   - `confidence === 'measured'`
 *   - `hosts` 非空
 *   - `hosts[].host` ⊆ 页面媒体请求的 host 集合（有交集即算对上，但必须交代差集）
 *
 * ## 用法
 *
 * ```bash
 * node node_modules/wxt/bin/wxt.mjs build   # 先构建
 * node poc/verify/t3-loading-trace-console.cjs
 * ```
 *
 * 会开一个可见窗口，约 40 秒。⚠️ 构建会覆盖 `.output/chrome-mv3`，
 * 也就是用户当前安装的那份扩展。
 *
 * ## ⚠️ 探针已按约定删除，重跑前要临时加回来
 *
 * 取证用的那一行在 T3 验证通过后已从 `src/content/isolated/loading-trace.ts` 删掉
 * （产品代码不打印）。要重跑本脚本，先在 `attachLoadingTraceVideo()` 挂上 `<video>`
 * 之后临时加一个 `timeupdate` 监听器，在 `currentTime >= 12` 时打一次
 * `console.info('[pluma-t3]', JSON.stringify(getLoadingSnapshot()))`，重新构建后再跑。
 */

const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');

/** 与 `dnr-disable-clears-tab-rules.cjs` 保持一致：用本机 Edge，不额外下载 Chromium */
const EDGE_PATH =
  process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const TARGET = 'https://www.bilibili.com/video/BV1GJ411x7h7/';

/** 媒体域判据（**只在本脚本里**，用于造参照系；产品代码的判据在 core/cdn/classify.ts） */
const MEDIA_HOST_RE = /(bilivideo\.(com|cn)|akamaized\.net|szbdyd\.com|mountaintoys\.cn|qrstuvwxyzab\.com|zhenidc\.cn)$/;

/**
 * 媒体**分片**的路径判据，与产品代码 `isMediaPath()` 同口径。
 *
 * ⚠️ 参照系必须同口径，否则比对没有意义：只按 host 统计时会把
 * `bvc.bilivideo.com/pbp/data`、`upos-sz-staticcos-cmask/…/*.webmask`
 * 这些同域静态资源算进来，于是产品侧"变少"看起来像漏采。
 */
const MEDIA_PATH_RE = /\.(?:m4s|mp4|flv)$/i;
const MEDIA_PATH_MARKER = '/upgcxcode/';

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 是不是媒体分片（与产品代码 `isMediaPath()` 同口径：路径判据 + host 判据） */
function isMediaSegment(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0 || !MEDIA_HOST_RE.test(host)) return null;
  if (!MEDIA_PATH_RE.test(parsed.pathname) && !parsed.pathname.includes(MEDIA_PATH_MARKER)) {
    return null;
  }
  return host;
}

function check(name, pass, detail) {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  return pass;
}

async function main() {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    console.error(`${EXT_DIR} 里没有 manifest.json，先跑 node node_modules/wxt/bin/wxt.mjs build`);
    process.exit(2);
  }
  if (!fs.existsSync(EDGE_PATH)) {
    console.error(`找不到浏览器：${EDGE_PATH}（用 EDGE_PATH 环境变量覆盖）`);
    process.exit(2);
  }

  const ctx = await chromium.launchPersistentContext('', {
    executablePath: EDGE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  let failed = 0;
  try {
    const page = await ctx.newPage();

    /** 参照系：页面自己发出的媒体**分片**请求（Playwright 侧记录，与扩展无关） */
    const pageHosts = new Map();
    /** 同域但**不是**分片的请求（用来解释"为什么产品侧少了这些 host"） */
    const nonMediaHosts = new Map();
    page.on('request', (req) => {
      const url = req.url();
      const host = isMediaSegment(url);
      if (host !== null) {
        pageHosts.set(host, (pageHosts.get(host) ?? 0) + 1);
        return;
      }
      const plainHost = hostOf(url);
      if (plainHost !== null && MEDIA_HOST_RE.test(plainHost)) {
        nonMediaHosts.set(plainHost, (nonMediaHosts.get(plainHost) ?? 0) + 1);
      }
    });

    /** 取证：content script 里的临时探针 */
    let probe = null;
    page.on('console', (msg) => {
      const text = msg.text();
      if (!text.includes('[pluma-t3]')) return;
      if (probe !== null) return;
      probe = text;
      console.log(`\n───── [pluma-t3] 原文 ─────\n${text}\n`);
    });

    console.log(`打开 ${TARGET}`);
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });

    await page.waitForSelector('video', { timeout: 60000 });
    console.log('已找到 <video>');

    /** 点播放：静音后调 play()，避免自动播放策略拦掉（那是浏览器策略，不是扩展问题） */
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return;
      v.muted = true;
      const playing = v.play();
      if (playing && typeof playing.catch === 'function') playing.catch(() => undefined);
    });

    // 等探针（探针在 currentTime >= 12s 时打一条）—— 给足 60 秒
    const startedAt = Date.now();
    while (probe === null && Date.now() - startedAt < 60000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const playback = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v === null ? null : { currentTime: v.currentTime, readyState: v.readyState, paused: v.paused };
    });
    console.log(`播放状态：${JSON.stringify(playback)}`);

    failed += check('探针有输出（content script 隔离世界里取到了快照）', probe !== null) ? 0 : 1;

    if (probe !== null) {
      const snapshot = JSON.parse(probe.slice(probe.indexOf('{')));
      failed += check(
        "confidence === 'measured'",
        snapshot.confidence === 'measured',
        String(snapshot.confidence),
      ) ? 0 : 1;
      failed += check('hosts 非空', Array.isArray(snapshot.hosts) && snapshot.hosts.length > 0,
        `${String(snapshot.hosts.length)} 个 host`) ? 0 : 1;

      const pageSet = new Set(pageHosts.keys());
      const snapshotHosts = snapshot.hosts.map((h) => h.host);
      const matched = snapshotHosts.filter((h) => pageSet.has(h));
      const snapshotOnly = snapshotHosts.filter((h) => !pageSet.has(h));

      failed += check(
        '快照里的 host 与页面媒体请求的 host 能对上',
        matched.length > 0,
        `对上 ${String(matched.length)} 个`,
      ) ? 0 : 1;

      console.log('\n───── 比对 ─────');
      console.log(`页面媒体分片 host（采样）：${JSON.stringify(Object.fromEntries(pageHosts))}`);
      console.log(
        `同域但非分片（应被产品侧排除）：${JSON.stringify(Object.fromEntries(nonMediaHosts))}`,
      );
      console.log(`快照 hosts：${JSON.stringify(snapshot.hosts)}`);
      console.log(`对上：${JSON.stringify(matched)}`);
      console.log(`只在快照里（buffered 提供的、Playwright 未捕获的早期条目）：${JSON.stringify(snapshotOnly)}`);
      console.log(`actual：${JSON.stringify(snapshot.actual)}`);
      console.log(`video：${JSON.stringify(snapshot.video)}`);
      console.log(`events=${String(snapshot.events.length)} truncated=${String(snapshot.truncated)}`);
      console.log(`events 前 6 条：${JSON.stringify(snapshot.events.slice(0, 6))}`);
    }
  } finally {
    await ctx.close();
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

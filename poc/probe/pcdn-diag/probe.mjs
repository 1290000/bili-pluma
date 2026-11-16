/**
 * PCDN 诊断方案的前置探针（2026-11-17）。
 *
 * 一次跑完三个待明确项：
 *   Q1  isolated world 能不能读到页面的 resource 条目（决定"实测档"还是"推算档"）
 *   Q8  官方取流域到底有哪些（决定分类兜底会不会说错话）
 *   Q10 `cn-*-bcache-*` ↔ 自建 CDN 的对应关系（决定普通层括号能不能写）
 *
 * Q9（播放中切 mcdn 是否重发 playurl）也一并观察，但匿名播放拿不到高码率，
 * 结论只能作参考。
 *
 * 用法：node poc/probe/pcdn-diag/probe.mjs
 * 输出：stdout 摘要 + result-pcdn-diag.json
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const MEDIA_RE = /bilivideo|mcdn|mountaintoys|szbdyd|qrstuvwxyzab|zhenidc|akamaized/;
const OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '..',
  'result-pcdn-diag.json'
);

/** 探针自己的粗分类（不等于生产分类函数，只为出清单） */
function bucket(host) {
  const h = host.split(':')[0].toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return 'pcdn';
  if (h.split('.').some((l) => l === 'mcdn' || l === 'pcdn' || l === 'gotcha')) return 'pcdn';
  if (['szbdyd.com', 'mountaintoys.cn', 'qrstuvwxyzab.com', 'zhenidc.cn'].some((d) => h === d || h.endsWith('.' + d)))
    return 'pcdn';
  if (/^cn-[a-z0-9-]+-bcache-\d+\.bilivideo\.(com|cn)$/.test(h)) return 'official:self-built';
  if (/^upos-[a-z0-9-]+\.bilivideo\.(com|cn)$/.test(h)) return 'official:partner';
  if (h === 'bilivideo.com' || h.endsWith('.bilivideo.com') || h === 'bilivideo.cn' || h.endsWith('.bilivideo.cn'))
    return 'official:unknown-flavor';
  if (h === 'akamaized.net' || h.endsWith('.akamaized.net')) return 'third-party';
  return 'other';
}

function getJson(url, referer = 'https://www.bilibili.com/') {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' }, timeout: 15000 },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(new Error(`非 JSON 响应 (${res.statusCode}): ${b.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('timeout', () => (req.destroy(), reject(new Error('timeout'))));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// Part B：候选 host 全集（Q8 / Q10）
// ══════════════════════════════════════════════════════════════
async function inventory(targetCount = 20) {
  console.log('\n=== Part B：候选 host 全集（Q8 / Q10） ===');
  const SOURCES = [
    ['ranking', 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all'],
    ['popular', 'https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1'],
  ];
  let list = [];
  for (const [name, url] of SOURCES) {
    try {
      const r = await getJson(url);
      const raw = r?.data?.list ?? [];
      console.log(`  ${name}: code=${r?.code} message=${r?.message ?? '-'} 条数=${raw.length}`);
      if (raw.length > 0) {
        list = raw.slice(0, targetCount);
        break;
      }
    } catch (e) {
      console.log(`  ${name}: 请求失败 ${e.message}`);
    }
  }
  if (list.length === 0) {
    console.log('  ⚠️ 两个来源都没拿到候选视频 —— Q8/Q10 本次无结论');
    return { videos: 0, hosts: [] };
  }
  console.log(`  取到 ${list.length} 个热门视频`);

  const hostStat = {};
  const add = (url, where) => {
    if (!url) return;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    const h = u.host;
    const b = bucket(h);
    const rec = (hostStat[h] ??= { host: h, bucket: b, count: 0, where: new Set(), v1res: 0 });
    rec.count += 1;
    rec.where.add(where);
    if (u.pathname.startsWith('/v1/resource')) rec.v1res += 1;
  };

  let ok = 0;
  for (const item of list) {
    let cid = item.cid;
    if (!cid) {
      try {
        const v = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${item.bvid}`);
        cid = v.data?.cid;
      } catch {
        /* 跳过 */
      }
    }
    if (!cid) continue;
    try {
      const p = await getJson(
        `https://api.bilibili.com/x/player/playurl?avid=${item.aid}&cid=${cid}&qn=64&fnval=4048&fourk=1`
      );
      const dash = p.data?.dash;
      if (!dash) continue;
      ok += 1;
      for (const key of ['video', 'audio']) {
        for (const s of dash[key] ?? []) {
          add(s.baseUrl || s.base_url, `${key}:base`);
          for (const b of s.backupUrl || s.backup_url || []) add(b, `${key}:backup`);
        }
      }
      for (const a of [dash.flac?.audio, ...(dash.dolby?.audio ?? [])]) if (a) add(a.baseUrl || a.base_url, 'audio:extra');
    } catch {
      /* 跳过 */
    }
    await sleep(120);
  }

  const rows = Object.values(hostStat)
    .map((r) => ({ ...r, where: [...r.where].join(',') }))
    .sort((a, b) => b.count - a.count);
  console.log(`  成功取到 ${ok} 个视频的 dash\n`);
  console.log(`  ${'host'.padEnd(48)} ${'分类'.padEnd(24)} 次数  含/v1/resource`);
  for (const r of rows) {
    console.log(`  ${r.host.padEnd(48)} ${r.bucket.padEnd(24)} ${String(r.count).padStart(4)}  ${r.v1res}`);
  }
  const byBucket = {};
  for (const r of rows) byBucket[r.bucket] = (byBucket[r.bucket] ?? 0) + 1;
  console.log('\n  分类分布（按 host 个数）：', JSON.stringify(byBucket));
  return { videos: ok, hosts: rows };
}

// ══════════════════════════════════════════════════════════════
// Part A + C：浏览器（Q1 isolated world / Q9 播放中换线）
// ══════════════════════════════════════════════════════════════
async function browserProbe() {
  console.log('\n=== Part A/C：浏览器实测 ===');
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const t0 = Date.now();
  const playurlReqs = [];
  const segHosts = []; // { at, host }
  page.on('request', (r) => {
    const u = r.url();
    if (/\/playurl/.test(u)) playurlReqs.push({ at: Date.now() - t0, url: u.split('?')[0] });
    if (MEDIA_RE.test(u)) segHosts.push({ at: Date.now() - t0, host: new URL(u).host });
  });

  await page.goto('https://www.bilibili.com/video/BV1GJ411x7h7/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('video', { timeout: 30000 });
  await page.evaluate(async () => {
    try {
      await document.querySelector('video').play();
    } catch {
      /* 静音策略兜底 */
    }
  });

  // 观察 40 秒，看播放中有没有第二次 playurl / 换线
  await page.waitForTimeout(40000);

  const played = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v
      ? { currentTime: Math.round(v.currentTime), duration: Math.round(v.duration), readyState: v.readyState, height: v.videoHeight }
      : null;
  });
  console.log('  播放状态：', JSON.stringify(played));

  const hostOrder = [];
  for (const s of segHosts) if (!hostOrder.includes(s.host)) hostOrder.push(s.host);
  console.log(`  playurl 请求次数：${playurlReqs.length}（时刻 ${playurlReqs.map((r) => r.at + 'ms').join(', ') || '—'}）`);
  console.log(`  媒体 host 出现顺序：${hostOrder.map((h) => bucket(h) + ' ' + h).join(' → ') || '—'}`);

  // ── Q1：isolated world 读 resource 条目 ──
  const client = await ctx.newCDPSession(page);
  const { frameTree } = await client.send('Page.getFrameTree');
  const { executionContextId } = await client.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'pluma-probe-isolated',
  });
  const expr = `(async () => {
    const SEL = /bilivideo|mcdn|mountaintoys|szbdyd|qrstuvwxyzab|zhenidc|akamaized/;
    const hits = () => performance.getEntriesByType('resource').filter(e => SEL.test(e.name)).length;
    const before = hits();
    const got = [];
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (SEL.test(e.name)) got.push(e.name);
    });
    try { po.observe({ type: 'resource', buffered: true }); } catch (err) { return { error: String(err) }; }
    const v = document.querySelector('video');
    if (v) v.currentTime = Math.min((v.currentTime || 0) + 20, Math.max((v.duration || 60) - 5, 5));
    await new Promise(r => setTimeout(r, 3500));
    po.disconnect();
    const sample = got.slice(0, 3).map(u => new URL(u).host);
    return { before, after: hits(), observed: got.length, sample,
             fields: (() => { const e = performance.getEntriesByType('resource').find(x => SEL.test(x.name));
               return e ? { startTime: e.startTime > 0, duration: e.duration > 0, responseEnd: e.responseEnd > 0,
                            transferSize: e.transferSize, responseStart: e.responseStart } : null; })() };
  })()`;
  const evalRes = await client.send('Runtime.evaluate', {
    contextId: executionContextId,
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  const q1 = evalRes.result?.value ?? { error: evalRes.exceptionDetails?.text ?? 'no value' };
  console.log('\n  【Q1】isolated world 结果：', JSON.stringify(q1, null, 2));

  await browser.close();

  return {
    played,
    playurlReqs,
    hostOrder: hostOrder.map((h) => ({ host: h, bucket: bucket(h) })),
    q1,
  };
}

// ══════════════════════════════════════════════════════════════
const result = { at: new Date().toISOString(), inventory: null, browser: null };
result.inventory = await inventory(20);
result.browser = await browserProbe();

fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
console.log(`\n已写出 ${OUT}`);

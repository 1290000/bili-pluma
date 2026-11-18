// PGC 同步注入探针：在 createPlayer 返回前替换 config.requestConfig.reqHttpPlayUrlInfo。
// 模式：
//   MODE=stub   记录 params 后抛错（证明是否被调用）
//   MODE=merged 自取 /pgc/player/web/playurl，按 SSR 骨架合并后返回（历史 PoC 形状）
//   MODE=raw    直接返回接口扁平 json（检验 durl 原生形状能否被接受）
// 用法：
//   MODE=stub POC_TARGET=https://www.bilibili.com/bangumi/play/ss48001 POC_HEADLESS=1 node poc/probe/pgc-sync-inject.cjs
//   MODE=merged ... ; MODE=raw ...
// 产出：poc/probe/result-pgc-sync-<mode>.json
const { chromium } = require('playwright-core');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const TARGET = process.env.POC_TARGET || 'https://www.bilibili.com/bangumi/play/ss48001';
const MODE = process.env.MODE || 'stub';
const KEEP = process.env.KEEP === '1';
const OUT = path.join(__dirname, `result-pgc-sync-${MODE}${KEEP ? '-keep' : ''}.json`);
const HEADLESS = process.env.POC_HEADLESS !== '0';

const INIT = ({ mode, keep }) => {
  const P = { mode, events: [], nano: 0, createCalls: 0, cbHits: 0, params: [], xhr: [], errors: [], playerCalls: [] };
  window.__PGC_SYNC__ = P;
  const log = (m) => P.events.push({ t: Math.round(performance.now()), m });

  const safeVal = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array(' + v.length + ')';
    if (typeof v === 'object') return 'object';
    const s = String(v);
    if (/^[0-9a-f]{24,}$/i.test(s) || s.length > 80) return '<str:' + s.length + '>';
    return s;
  };

  // 记录页面自己发的取流 XHR（PGC 正常应为 0；SPA 切集会走 /ogv/player/playview）
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try {
      const s = String(u);
      if (/playurl|playview/i.test(s)) {
        const x = new URL(s, location.href);
        P.xhr.push({ t: Math.round(performance.now()), path: x.pathname, qn: x.searchParams.get('qn'), ep: x.searchParams.get('ep_id') ? '<present>' : '' });
        log('页面 XHR ' + x.pathname);
      }
    } catch (e) {}
    return oo.apply(this, arguments);
  };

  let nanoRef;
  Object.defineProperty(window, 'nano', {
    configurable: true,
    enumerable: true,
    get() { return nanoRef; },
    set(v) {
      P.nano += 1;
      nanoRef = v;
      if (!v || typeof v.createPlayer !== 'function' || v.createPlayer.__pgcSyncWrapped) return;
      const orig = v.createPlayer;
      v.createPlayer = function (config) {
        P.createCalls += 1;
        log('createPlayer #' + P.createCalls + ' at ' + Math.round(performance.now()));
        try {
          P.configKeys = config && typeof config === 'object' ? Object.keys(config) : null;
          P.prefetchKeys = config && config.prefetch ? Object.keys(config.prefetch) : null;
          P.prefetchPlayUrl = !!(config && config.prefetch && config.prefetch.playUrl);
          P.requestConfigKeys = config && config.requestConfig ? Object.keys(config.requestConfig) : null;
          P.origCb = !!(config && config.requestConfig && typeof config.requestConfig.reqHttpPlayUrlInfo === 'function');
          log('config keys=' + (P.configKeys || []).join(',') + ' requestConfig=' + (P.requestConfigKeys || 'none') + ' origCb=' + P.origCb);
        } catch (e) { P.errors.push('shape: ' + e.message); }

        // 同步替换整个 requestConfig（不是只改一个字段）
        try {
          const rc = config.requestConfig && typeof config.requestConfig === 'object' ? config.requestConfig : {};
          const cb = async function (params) {
              P.cbHits += 1;
              const keys = Object.keys(params || {});
              P.params.push({
                n: P.cbHits,
                t: Math.round(performance.now()),
                keys,
                vals: Object.fromEntries(keys.map((k) => [k, safeVal(params[k])])),
                types: Object.fromEntries(keys.map((k) => [k, Array.isArray(params[k]) ? 'array' : typeof params[k]])),
              });
              log('★ sync cb #' + P.cbHits + ' keys=' + keys.join(','));
              if (mode === 'stub') throw new Error('PGC_SYNC_STUB_CALLED');
              try {
                const cid = params && params.cid ? params.cid : (window.__playinfo__ && window.__playinfo__.result && window.__playinfo__.result.arc && window.__playinfo__.result.arc.cid);
                const u = 'https://api.bilibili.com/pgc/player/web/playurl?cid=' + encodeURIComponent(String(cid)) + '&avid=0&qn=80&fnval=4048&fnver=0&fourk=1';
                const r = await fetch(u, { credentials: 'include' });
                const j = await r.json();
                P.fetchInfo = {
                  http: r.status, code: j && j.code,
                  keys: j && j.result ? Object.keys(j.result).slice(0, 30) : [],
                  hasDash: !!(j && j.result && j.result.dash),
                  dashHeights: j && j.result && j.result.dash ? j.result.dash.video.map((x) => x.height) : [],
                  durlGroups: j && j.result && j.result.durls ? j.result.durls.length : (j && j.result && j.result.durl ? 1 : 0),
                  timelength: j && j.result ? j.result.timelength : null,
                  quality: j && j.result ? j.result.quality : null,
                };
                log('自取流 code=' + (j && j.code) + ' dash=' + !!(j && j.result && j.result.dash) + ' durlGroups=' + P.fetchInfo.durlGroups);
                if (!j || j.code !== 0 || !j.result) throw new Error('code=' + (j && j.code));

                if (mode === 'raw') {
                  // 直接返回接口扁平 json，检验原生形状
                  return { data: j, headers: {}, status: r.status };
                }
                if (mode === 'wrapped') {
                  // 用户提议的形状：{data:{code:0,data:{durl:[...],quality,...}}}
                  const rr = j.result || {};
                  const durl = (rr.durls && rr.durls[0] && rr.durls[0].durl) || rr.durl || [];
                  return {
                    data: {
                      code: 0,
                      data: {
                        durl,
                        quality: rr.quality,
                        accept_quality: rr.accept_quality,
                        timelength: rr.timelength,
                      },
                    },
                    headers: {},
                    status: r.status,
                  };
                }

                // merged：以 SSR 为骨架合并流字段（历史 PoC）
                const ssr = window.__playinfo__;
                const base = ssr && ssr.data ? ssr : { code: 0, message: '0', ttl: 1, result: {} };
                const ssrResult = base.result || {};
                const vi = (base.result && base.result.video_info) || {};
                const api = j.result;
                const merged = {
                  ...base,
                  data: {
                    ...(base.data || {}),
                    code: 0,
                    result: {
                      ...ssrResult,
                      video_info: {
                        ...vi,
                        quality: api.quality ?? vi.quality,
                        timelength: api.timelength ?? vi.timelength,
                        format: api.format ?? vi.format,
                        dash: api.dash ?? vi.dash,
                        durl: api.durl ?? (api.durls && api.durls[0] && api.durls[0].durl) ?? vi.durl,
                        durls: api.durls ?? vi.durls,
                        accept_quality: api.accept_quality ?? vi.accept_quality,
                        accept_description: api.accept_description ?? vi.accept_description,
                        support_formats: api.support_formats ?? vi.support_formats,
                        is_preview: api.is_preview ?? false,
                      },
                      accept_quality: api.accept_quality ?? ssrResult.accept_quality,
                      accept_description: api.accept_description ?? ssrResult.accept_description,
                    },
                  },
                };
                P.mergedInfo = {
                  hasDash: !!merged.data.result.video_info.dash,
                  durlGroups: (merged.data.result.video_info.durls || []).length,
                  timelength: merged.data.result.video_info.timelength,
                };
                log('merged 骨架返回');
                return merged;
              } catch (e) {
                P.errors.push('cb: ' + e.message);
                throw e;
              }
            };
          if (keep) {
            // 只换函数字段，保留 reqHttpPlayUrlInfoScope 等其它字段
            rc.reqHttpPlayUrlInfo = cb;
            config.requestConfig = rc;
          } else {
            config.requestConfig = { reqHttpPlayUrlInfo: cb };
          }
          // 预取会短路回调，必须删
          try { delete config.prefetch.playUrl; } catch (e) {}
          P.injected = true;
          P.keptObject = keep;
          log('已同步' + (keep ? '替换函数字段（保留 scope）' : '替换整个 requestConfig') + '（mode=' + mode + '）');
        } catch (e) {
          P.errors.push('inject: ' + e.message);
        }

        const ret = orig.call(this, config);
        try {
          if (ret && typeof ret === 'object') {
            P.playerCalls.push({ getMediaInfo: typeof ret.getMediaInfo, getDuration: typeof ret.getDuration, updateRequestConfig: typeof ret.updateRequestConfig });
            window.__PGC_PLAYER__ = ret;
          }
        } catch (e) {}
        return ret;
      };
      v.createPlayer.__pgcSyncWrapped = true;
      log('createPlayer 已包装');
    },
  });
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
  });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 180)); });
  await page.addInitScript(INIT, { mode: MODE, keep: KEEP });

  const out = { mode: MODE, target: TARGET, at: new Date().toISOString() };
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; void v.play().catch(() => {}); } }).catch(() => {});
    await page.waitForTimeout(8000);
    out.probe = await page.evaluate(() => {
      const p = window.__PGC_SYNC__ || {};
      const ssr = window.__playinfo__;
      return {
        nano: p.nano, createCalls: p.createCalls, cbHits: p.cbHits, params: p.params || [],
        injected: !!p.injected, configKeys: p.configKeys, prefetchKeys: p.prefetchKeys, prefetchPlayUrl: p.prefetchPlayUrl,
        requestConfigKeys: p.requestConfigKeys, origCb: p.origCb, fetchInfo: p.fetchInfo || null, mergedInfo: p.mergedInfo || null,
        xhr: p.xhr || [], errors: p.errors || [], events: p.events || [],
        ssr: ssr && ssr.result ? {
          keys: Object.keys(ssr.result),
          videoInfoKeys: ssr.result.video_info ? Object.keys(ssr.result.video_info) : [],
          quality: ssr.result.video_info && ssr.result.video_info.quality,
          timelength: ssr.result.video_info && ssr.result.video_info.timelength,
          durlGroups: ssr.result.video_info && ssr.result.video_info.durls ? ssr.result.video_info.durls.length : (ssr.result.video_info && ssr.result.video_info.durl ? 1 : 0),
          playVideoType: ssr.result.play_video_type,
        } : null,
      };
    });
    out.state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { t: Math.round(v?.currentTime ?? 0), dur: Math.round(v?.duration ?? 0), h: v?.videoHeight ?? 0, w: v?.videoWidth ?? 0, ready: v?.readyState ?? null, paused: v?.paused ?? null, err: v?.error?.code ?? null };
    });
    out.pageErrors = pageErrors.slice(0, 12);
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ probe: out.probe, state: out.state, pageErrors: out.pageErrors, error: out.error }, null, 2).slice(0, 18000));
})();

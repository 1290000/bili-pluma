/**
 * Pluma Q2 PoC —— 测试页逻辑
 *
 * 只做三件事：发消息、渲染结果、把数字翻译成对架构的结论。
 * 真正的测试逻辑全在 background.js，这里不碰 DNR。
 */

'use strict';

const $ = (sel) => document.querySelector(sel);

const STRATEGY_META = {
  'pool-random-id': { label: 'S1 规则 ID 池 + 随机 nonce', order: 1 },
  'persistent-id': { label: 'S2 规则 ID 常驻 + nonce', order: 2 },
  'single-shared': { label: 'S3 全局单条共享规则', order: 3 },
  'no-nonce-persistent': { label: 'S4 常驻规则 · 无 nonce', order: 4 },
};

const ALL_STRATEGIES = [
  'pool-random-id',
  'persistent-id',
  'single-shared',
  'no-nonce-persistent',
];

/* ============================================================
 * 基础设施
 * ============================================================ */

let busy = false;
let clockTimer = null;
let clockStart = 0;

function log(text, kind = '') {
  const el = $('#global-log');
  const line = document.createElement('div');
  line.className = 'log-line' + (kind ? ` ${kind}` : '');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${t}] ${text}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function startClock(label) {
  clockStart = Date.now();
  const el = $('#clock');
  el.classList.add('busy');
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const s = ((Date.now() - clockStart) / 1000).toFixed(1);
    el.textContent = `${label} · ${s}s`;
  }, 100);
}

function stopClock(text = 'idle') {
  clearInterval(clockTimer);
  clockTimer = null;
  const el = $('#clock');
  el.classList.remove('busy');
  el.textContent = text;
}

function setBusy(v) {
  busy = v;
  for (const btn of document.querySelectorAll('.btn')) {
    if (btn.dataset.alwaysOn === '1') continue;
    btn.disabled = v;
  }
}

/** 包一层 sendMessage，把 lastError 和超时都变成 reject */
function send(message, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`消息超时（${timeoutMs}ms）—— service worker 可能已休眠`));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (response && response.error) return reject(new Error(response.error));
        resolve(response);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
 * 渲染：单策略结果
 * ============================================================ */

function pill(kind, text) {
  const span = document.createElement('span');
  span.className = `pill pill-${kind}`;
  span.textContent = text;
  return span;
}

/**
 * 把 judge() 出来的 stats 渲染成一行统计。
 * 关键看 mismatched —— 那才是串号。
 */
function renderRoundRow(round) {
  const { round: n, stats } = round;
  const row = document.createElement('div');
  row.className = 'round-row';

  const label = document.createElement('span');
  label.className = 'round-label';
  label.textContent = `轮 ${n}`;
  row.appendChild(label);

  row.appendChild(pill(stats.ok === stats.total ? 'ok' : 'mute', `对号 ${stats.ok}`));

  if (stats.mismatched > 0) {
    row.appendChild(pill('bad', `串号 ${stats.mismatched}`));
  }
  if (stats.missing > 0) {
    row.appendChild(pill('warn', `无回显 ${stats.missing}`));
  }
  if (stats.errored > 0) {
    row.appendChild(pill('warn', `报错 ${stats.errored}`));
  }

  const total = document.createElement('span');
  total.style.marginLeft = 'auto';
  total.style.color = 'var(--fg-dim)';
  total.style.fontFamily = 'var(--mono)';
  total.style.fontSize = '11.5px';
  total.textContent = `/ ${stats.total}`;
  row.appendChild(total);

  return row;
}

const VERDICT_TEXT = {
  PASS: ['sv-pass', '通过', '全部请求拿到了自己的 Cookie'],
  PARTIAL: ['sv-partial', '部分通过', '无串号，但存在无回显或报错的请求'],
  FAIL_MISMATCH: ['sv-fail', '失败 · 串号', '有请求拿到了别人的 Cookie —— 架构不可用'],
  FAIL_NO_EFFECT: ['sv-fail', '失败 · 未生效', 'DNR 规则没有起作用，回显里没有我们的标记'],
};

function renderStrategyResult(strategy, data) {
  const host = $(`#res-${strategy}`);
  host.textContent = '';

  if (!data || data.error) {
    const p = document.createElement('div');
    p.className = 'strategy-verdict sv-fail';
    p.textContent = `执行出错：${data?.error ?? '无返回'}`;
    host.appendChild(p);
    return;
  }

  for (const round of data.rounds ?? []) {
    host.appendChild(renderRoundRow(round));
  }

  const [cls, title, note] = VERDICT_TEXT[data.verdict] ?? ['sv-partial', data.verdict, ''];
  const box = document.createElement('div');
  box.className = `strategy-verdict ${cls}`;

  const strong = document.createElement('span');
  strong.textContent = title;
  box.appendChild(strong);

  const span = document.createElement('span');
  span.style.fontWeight = '400';
  span.style.opacity = '0.85';
  span.textContent = `— ${note}`;
  box.appendChild(span);

  host.appendChild(box);
}

/* ============================================================
 * 渲染：L1
 * ============================================================ */

function renderL1(data) {
  const box = $('#l1-box');
  box.classList.remove('hidden', 'ok', 'bad');
  box.textContent = '';

  if (!data || data.error) {
    box.classList.add('bad');
    box.innerHTML = `<h4>L1 出错</h4>`;
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = data?.error ?? '无返回';
    box.appendChild(p);
    return;
  }

  box.classList.add(data.ok ? 'ok' : 'bad');

  const h = document.createElement('h4');
  h.textContent = data.ok
    ? 'L1 通过 —— DNR 能改写 Cookie 请求头'
    : 'L1 未通过 —— 两种请求模式下回显里都没有我们的标记';
  box.appendChild(h);

  // 两种 credentials 模式的对照
  const modes = data.modes ?? {};
  const modeRows = [
    ['omit', '不带浏览器 cookie', modes.omit],
    ['include', '带浏览器 cookie', modes.include],
  ];

  const dl = document.createElement('dl');
  dl.className = 'kv';

  for (const [name, desc, r] of modeRows) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    if (!r) {
      dd.textContent = '(未测)';
    } else if (r.error) {
      dd.textContent = `请求失败：${r.error}`;
    } else {
      dd.textContent = r.ok ? '✓ 改成功' : `✗ 未改成功（回显：${r.echoed ?? '空'}）`;
      dd.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
    }
    dl.append(dt, dd);
  }
  box.appendChild(dl);

  const note = document.createElement('p');
  note.style.margin = '10px 0 0';
  note.style.fontSize = '12.5px';

  const NOTES = {
    BOTH: '两种模式都能改。Pluma 用 omit 更干净 —— 不会先带上 A 的 cookie 再被覆盖。',
    OMIT_ONLY: 'omit 能改、include 不能改（有点反常）。Pluma 正好只用 omit，可以接受，但要复测一次确认不是偶然。',
    INCLUDE_ONLY:
      '只有 include 能改 —— 说明 omit 会把整个 Cookie 头（连同 DNR 设的值）一起剥掉。' +
      '那 dnr.ts 只能用 include，并且要接受"浏览器先带上 A 的 cookie、再被 set 覆盖"这个事实。这条要写进架构文档。',
    NONE: '',
  };
  note.textContent = NOTES[data.verdict] ?? '';
  if (note.textContent) box.appendChild(note);

  if (!data.ok) {
    const hint = document.createElement('p');
    hint.style.margin = '10px 0 0';
    hint.style.fontSize = '12.5px';
    hint.textContent =
      '排查方向：① host_permissions 是否含回声服务域名 ② resourceTypes 是否漏了 xmlhttprequest ' +
      '③ 回声服务是否限流（429 时回显为空，换 postman-echo）④ 是否有更高优先级规则覆盖。';
    box.appendChild(hint);
  }
}

/* ============================================================
 * 渲染：结论
 * ============================================================ */

/**
 * 把三个策略的汇总翻译成一句"所以架构怎么办"。
 * 这是整个 PoC 的产出物，比数字本身重要。
 */
function buildVerdict(report) {
  const s = report.strategies;
  const s1 = s['pool-random-id'];
  const s2 = s['persistent-id'];
  const s3 = s['single-shared'];
  const s4 = s['no-nonce-persistent'];
  const leak = report.leakedRulesAfter?.count ?? 0;

  const ok = (x) => x?.verdict === 'PASS';
  const mismatch = (x) => x?.verdict === 'FAIL_MISMATCH';
  const noEffect = (x) => x?.verdict === 'FAIL_NO_EFFECT';

  let level, title, body;

  if (noEffect(s1) && noEffect(s4)) {
    level = 'fail';
    title = '结论：DNR 没有生效，需要先修 L1';
    body = [
      '回显里完全没有我们的标记，说明规则根本没作用到请求上。这个数字现在没有意义。',
      '先点上面的「① 先测 L1」定位问题。常见原因：host_permissions 写错、resourceTypes 漏了 xmlhttprequest、回声服务限流。',
    ];
  } else if (mismatch(s1) || mismatch(s2) || mismatch(s4)) {
    level = 'fail';
    title = '结论：DNR 并发不安全，架构要改';
    body = [
      '出现了串号 —— 某个请求拿到了别的请求的 Cookie。这是 Pluma 绝对不能接受的。',
      '可选出路：① 请求串行化；② 改用 chrome.debugger 拦截（页面上方会常驻"正在调试"提示）；③ 退回本地服务方案。',
      '无论选哪条，ADR 0002 都要重写，platform/http/dnr.ts 的设计要重做。',
    ];
  } else if (ok(s4)) {
    // 关键分支：不用 nonce 也能过，那就不该引入 nonce 的复杂度
    level = 'pass';
    title = '结论：架构成立，而且比原设计更简单 —— 用 S4';
    body = [
      'S4（一条常驻规则匹配整个路径、值固定、不带 nonce）在并发下全部对号。这说明 per-request nonce 并非必需。',
      '为什么可以：Pluma 的白名单请求全都该用同一个播放账号，规则的值在整个会话内是全局一致的 —— 不存在"这条规则该给谁"的问题。nonce 原本是为了在多个不同目标之间做区分，而我们没有多个目标。',
      '所以 dnr.ts 可以砍掉规则 ID 池、砍掉每请求的 add/remove、砍掉 S1 那一整类并发风险。只需要：按白名单路径各建一条常驻 session 规则，凭据刷新时改值，SW 启动时做一次自愈清理。',
      'S3 的结果也印证了这个方向：共享单条规则时，每轮 20 个请求里只有 1 个拿到凭据、其余 19 个什么也没拿到 —— 失败方式是"静默降级成未登录"，不是"串号"。这个失败模式比串号安全，但仍然不可接受，所以不能省到只剩一条规则。',
    ];
  } else if (ok(s2)) {
    level = 'pass';
    title = '结论：架构成立，用 S2';
    body = [
      'S4 没过但 S2（规则常驻 + nonce）过了。',
      'S2 的问题是规则数量写死、必须显式清理。如果走这条路，dnr.ts 要在启动时按最大并发预建规则，并在 SW 重启时恢复。',
    ];
  } else if (ok(s1)) {
    level = 'partial';
    title = '结论：只有 S1 过，架构成立但要接受复杂度';
    body = [
      'S1（nonce 化 urlFilter + 规则 ID 池）通过了，但它最复杂：每次请求都要 addRules / removeRuleIds，还得处理清理失败和 ID 回收。',
      'S4 没过而 S1 过了，说明这里的规则确实需要 per-request 区分 —— 但这与 Pluma 的语义不符，建议先复测 S4 排除偶然因素。',
    ];
  } else {
    level = 'partial';
    title = '结论：结果不干净，需要复测';
    body = [
      '没有出现串号，但也没有一个策略拿到全对号的结果。多半是回声服务限流或无回显导致的 missing，不是 DNR 的问题。',
      '先看明细里 verdict 为 missing / unparsable 的条目，再决定是否换 postman-echo 重跑。',
    ];
  }

  if (leak > 0) {
    body.push(`另外：清理后仍有 ${leak} 条规则残留（ID ${report.leakedRulesAfter.ids.join(', ')}）—— L3 不通过，dnr.ts 必须补 finally 清理和 SW 启动时的自愈清理。`);
  }

  return { level, title, body };
}

function renderVerdict(report) {
  const card = $('#verdict-card');
  const host = $('#verdict-body');
  card.classList.remove('hidden');
  host.textContent = '';

  const { level, title, body } = buildVerdict(report);

  const banner = document.createElement('div');
  banner.className = `verdict-banner vb-${level}`;
  banner.textContent = title;
  host.appendChild(banner);

  const h3 = document.createElement('h3');
  h3.textContent = '所以接下来怎么做';
  host.appendChild(h3);

  for (const para of body) {
    const p = document.createElement('p');
    p.textContent = para;
    host.appendChild(p);
  }

  const meta = document.createElement('p');
  meta.style.fontSize = '12px';
  meta.style.color = 'var(--fg-dim)';
  meta.style.marginTop = '14px';
  meta.textContent =
    `并发 ${report.config.concurrency} × 轮数 ${report.config.rounds}，` +
    `开始于 ${new Date(report.startedAt).toLocaleString('zh-CN')}。`;
  host.appendChild(meta);
}

/* ============================================================
 * 渲染：明细表
 * ============================================================ */

function renderDetail(report) {
  const card = $('#detail-card');
  const host = $('#detail-body');
  card.classList.remove('hidden');
  host.textContent = '';

  for (const strategy of ALL_STRATEGIES) {
    const data = report.strategies[strategy];
    if (!data) continue;

    const group = document.createElement('div');
    group.className = 'detail-group';

    const h4 = document.createElement('h4');
    h4.textContent = `${STRATEGY_META[strategy].label} — ${data.verdict}`;
    group.appendChild(h4);

    const scroll = document.createElement('div');
    scroll.className = 'detail-scroll';

    const table = document.createElement('table');
    table.className = 'detail';
    table.innerHTML =
      '<thead><tr><th>轮</th><th>#</th><th>规则</th><th>判定</th><th>回显标记</th></tr></thead>';

    const tbody = document.createElement('tbody');
    for (const round of data.rounds ?? []) {
      for (const d of round.stats.details ?? []) {
        const tr = document.createElement('tr');
        if (d.verdict === 'MISMATCH') tr.className = 'row-bad';
        else if (d.verdict !== 'ok') tr.className = 'row-miss';

        const marker = d.parsed
          ? `FAKE-${d.parsed.batch}-${d.parsed.index}-${d.parsed.rand}`
          : d.error ?? '(空)';

        for (const text of [round.round, d.index, d.ruleId, d.verdict, marker]) {
          const td = document.createElement('td');
          td.textContent = String(text);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    group.appendChild(scroll);
    host.appendChild(group);
  }
}

/* ============================================================
 * 动作
 * ============================================================ */

async function actionL1() {
  if (busy) return;
  setBusy(true);
  startClock('L1 探测');
  log('发送 L1 单请求探测…');
  try {
    const data = await send({ type: 'q2/probe-l1' }, 60_000);
    renderL1(data);
    log(data.ok ? 'L1 通过：DNR 能改写 Cookie 头' : 'L1 未通过：回显里没有标记', data.ok ? 'ok' : 'err');
    stopClock(data.ok ? 'L1 通过' : 'L1 未通过');
  } catch (e) {
    renderL1({ error: e.message });
    log(`L1 出错：${e.message}`, 'err');
    stopClock('出错');
  } finally {
    setBusy(false);
  }
}

/** 跑单个策略。full=true 时是「完整测试」流水线的一部分，不重置时钟 */
async function runStrategy(strategy, { full = false, reset = false } = {}) {
  const host = $(`#res-${strategy}`);
  host.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'round-row';
  loading.style.color = 'var(--fg-dim)';
  loading.textContent = '运行中…';
  host.appendChild(loading);

  if (!full) {
    setBusy(true);
    startClock(STRATEGY_META[strategy].label.split(' ')[0]);
  }

  log(`开始 ${STRATEGY_META[strategy].label}`);
  const t0 = Date.now();

  try {
    const resp = await send({ type: 'q2/run', strategies: [strategy], reset });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // background 返回的是整份报告，这里要取出本策略那一段
    const data = resp?.strategies?.[strategy] ?? null;
    if (!data) {
      renderStrategyResult(strategy, { error: '报告里没有这个策略的结果' });
      log(`${STRATEGY_META[strategy].label} 返回了空结果`, 'err');
      return null;
    }

    renderStrategyResult(strategy, data);
    const summary = data.summary ?? {};
    log(
      `${STRATEGY_META[strategy].label} → ${data.verdict}（对号 ${summary.totalOk}，串号 ${summary.totalMismatch}，` +
        `无回显 ${summary.totalMissing}，报错 ${summary.totalErrored}）· ${secs}s`,
      data.verdict === 'PASS' ? 'ok' : 'err',
    );
    return resp;
  } catch (e) {
    renderStrategyResult(strategy, { error: e.message });
    log(`${STRATEGY_META[strategy].label} 出错：${e.message}`, 'err');
    return null;
  } finally {
    if (!full) {
      setBusy(false);
      stopClock('idle');
    }
  }
}

async function actionRunAll() {
  if (busy) return;
  setBusy(true);
  startClock('完整测试');
  $('#verdict-card').classList.add('hidden');
  $('#detail-card').classList.add('hidden');
  $('#global-log').textContent = '';

  log('=== 完整测试开始：3 策略 × 3 轮 ===');

  const report = {
    startedAt: new Date().toISOString(),
    // 配置以 background.js 的 CFG 为准，这里只占位，第一次返回时覆盖
    config: { concurrency: '?', rounds: '?', echoHost: '?' },
    strategies: {},
    leakedRulesAfter: null,
  };

  try {
    // 先清一次，保证起始干净
    const cleared = await send({ type: 'q2/clear' });
    log(`起始清理：移除 ${cleared.cleared} 条残留规则`);

    // 逐个策略串行跑 —— 并发测并发会让结果无法解读
    for (let i = 0; i < ALL_STRATEGIES.length; i++) {
      const strategy = ALL_STRATEGIES[i];
      const resp = await runStrategy(strategy, { full: true, reset: i === 0 });
      if (resp) {
        const sub = resp.strategies?.[strategy];
        if (sub) report.strategies[strategy] = sub;
        if (resp.config) report.config = resp.config;
      }
      await sleep(300);
    }

    // L3：清理后看残留
    await send({ type: 'q2/clear' });
    await sleep(500);
    const state = await send({ type: 'q2/state' });
    report.leakedRulesAfter = { count: state.count, ids: state.ids };
    log(
      `L3 回收检查：残留 ${state.count} 条${state.count ? `（${state.ids.join(', ')}）` : ''}`,
      state.count ? 'err' : 'ok',
    );

    renderVerdict(report);
    renderDetail(report);
    log('=== 完整测试结束，结论已生成 ===');
    stopClock('完成');
  } catch (e) {
    log(`完整测试中断：${e.message}`, 'err');
    stopClock('中断');
  } finally {
    setBusy(false);
  }
}

async function actionState() {
  try {
    const s = await send({ type: 'q2/state' }, 10_000);
    log(`当前 session 规则 ${s.count} 条${s.count ? `：${s.ids.join(', ')}` : ''}`);
  } catch (e) {
    log(`查询失败：${e.message}`, 'err');
  }
}

async function actionClear() {
  try {
    const r = await send({ type: 'q2/clear' }, 10_000);
    log(`已清空 ${r.cleared} 条 session 规则`, 'ok');
    for (const s of ALL_STRATEGIES) $(`#res-${s}`).textContent = '';
    $('#verdict-card').classList.add('hidden');
    $('#detail-card').classList.add('hidden');
  } catch (e) {
    log(`清空失败：${e.message}`, 'err');
  }
}

/* ============================================================
 * 绑定
 * ============================================================ */

$('#btn-l1').addEventListener('click', actionL1);
$('#btn-all').addEventListener('click', actionRunAll);
$('#btn-state').addEventListener('click', actionState);
$('#btn-clear').addEventListener('click', actionClear);

for (const btn of document.querySelectorAll('[data-run]')) {
  btn.addEventListener('click', () => runStrategy(btn.dataset.run));
}

// 进页面先看一眼有没有残留，避免上次测试的规则干扰判断
(async () => {
  try {
    const s = await send({ type: 'q2/state' }, 10_000);
    if (s.count > 0) {
      log(`注意：启动时已有 ${s.count} 条 session 规则残留，建议先点「清空所有 session 规则」`, 'err');
    } else {
      log('就绪。建议先点「① 先测 L1」，确认 DNR 能改 Cookie 头再跑并发。');
    }
  } catch (e) {
    log(`无法连接 background：${e.message}`, 'err');
  }
})();

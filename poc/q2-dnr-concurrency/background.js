/**
 * Pluma Q2 —— DNR 并发安全验证
 *
 * 待验证命题：
 *   "用 declarativeNetRequest 的 sessionRules 临时替换 Cookie 头，
 *    在并发请求下不会让请求命中错误的规则。"
 *
 * 这是唯一可能推翻整体架构的未知数。ADR 0002。
 *
 * 三层判据：
 *   L1 功能   —— DNR 到底能不能改 Cookie 头（如果这层就不行，后面免谈）
 *   L2 隔离   —— 并发时每个请求拿到的 Cookie 是不是自己的那个
 *   L3 回收   —— 规则是否正确清理，无泄漏
 *
 * 三个策略（并发安全性依次递减，测试后择一）：
 *   S1 POOL_RANDOM_ID  —— 规则 ID 池 + 随机 nonce，请求前现加规则，响应后删
 *   S2 PERSISTENT_ID   —— 规则常驻不删（只更新 IP 白名单），靠 nonce 区分
 *   S3 SINGLE_SHARED   —— 全局只保留一条规则，每次请求前改写它（最激进，预期会失败）
 *
 * 判定标准：20 并发 × 3 轮，L2 错配数必须为 0，L3 泄漏数必须为 0。
 */

// ============================================================
// 配置
// ============================================================

const CFG = {
  ECHO_HOST: 'https://httpbin.org',
  ECHO_PATH: '/anything',
  CONCURRENCY: 20,     // 并发数
  ROUNDS: 3,           // 重复轮数（单轮通过不算，要稳定）
  POOL_SIZE: 64,       // 规则 ID 池大小（必须 > CONCURRENCY）
  REQUEST_TIMEOUT_MS: 10_000,
  SETTLE_MS: 400,      // 删规则后等待，再检查泄漏

  // 请求的 credentials 模式。
  // 'omit' —— 不带浏览器自身的 cookie，最贴近 Pluma 想要的语义（把 A 的 cookie 整个换掉）。
  // 如果 L1 探测显示只有 'include' 能改成功，把这里改成 'include' 再跑。
  CREDENTIALS: 'omit',
};

// 从 ECHO_HOST 推导出要限定作用域的域名，避免改了一处漏了另一处
const ECHO_DOMAIN = new URL(CFG.ECHO_HOST).hostname;
const ALLOWED_DOMAINS = [ECHO_DOMAIN, 'postman-echo.com'];

const STRATEGIES = {
  POOL_RANDOM_ID: 'pool-random-id',
  PERSISTENT_ID: 'persistent-id',
  SINGLE_SHARED: 'single-shared',
};

// ============================================================
// 工具
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const log = (...a) => console.log('[Q2]', ...a);

/** 生成一个可被服务端解析的假凭据：sessdata=FAKE-<批次>-<序号>-<随机> */
function fakeCookie(batch, index) {
  const rand = uuid().slice(0, 8);
  return `sessdata=FAKE-${batch}-${index}-${rand}; bili_jct=jct${index}`;
}

/** 从响应体里把回显的 Cookie 抓出来（httpbin/postman-echo 都会回显 headers） */
function extractEchoedCookie(json) {
  if (!json) return null;
  // httpbin.org/anything → json.headers.Cookie
  const h = json.headers ?? {};
  const raw =
    h.Cookie ?? h.cookie ??
    h['COOKIE'] ?? null;
  if (typeof raw === 'string') return raw;

  // postman-echo 另一套结构兜底
  if (json.headers && typeof json.headers.cookie === 'string') return json.headers.cookie;
  return null;
}

/** 从回显 Cookie 里提取我们的标记 sessdata=FAKE-b-i-rand */
function parseMarker(cookieStr) {
  if (!cookieStr) return null;
  const m = /sessdata=FAKE-(\d+)-(\d+)-([0-9a-f]{8})/.exec(cookieStr);
  if (!m) return null;
  return { batch: Number(m[1]), index: Number(m[2]), rand: m[3] };
}

/** 给 URL 追加 nonce 参数，用于让 DNR 的 urlFilter 精确命中单一请求 */
function withNonce(url, nonce) {
  const u = new URL(url);
  u.searchParams.set('pluma_nonce', nonce);
  return u.toString();
}

// ============================================================
// DNR 规则构造
// ============================================================

/**
 * 构造一条"把 Cookie 换成指定值"的 session 规则。
 *
 * 关键点：
 * - urlFilter 里带 nonce，保证这条规则只可能命中那一个请求
 * - requestDomains 限定回声服务，避免影响真实站点
 * - resourceTypes 必须含 xmlhttprequest（SW 的 fetch 属于这一类）
 */
function buildRule({ id, nonce, cookie }) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'cookie', operation: 'set', value: cookie },
      ],
    },
    condition: {
      urlFilter: `||${ECHO_DOMAIN}${CFG.ECHO_PATH}*pluma_nonce=${nonce}`,
      requestDomains: ALLOWED_DOMAINS,
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  };
}

async function getAllSessionRuleIds() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.map((r) => r.id);
}

async function clearAllSessionRules() {
  const ids = await getAllSessionRuleIds();
  if (ids.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }
  return ids.length;
}

// ============================================================
// 三个策略的实现
// ============================================================

/**
 * S1：规则 ID 池 + 随机 nonce
 * 每次请求前 addRules 一条新规则，响应后删掉。
 * 这是最"干净"的写法，也是最可能引发竞态的写法——如果 DNR 处理 add/remove 有窗口期，
 * 这里会暴露出来。
 */
async function strategyPoolRandomId(tasks) {
  const { concurrency, batch } = tasks;
  const results = [];
  const inflight = new Set();

  const runOne = async (index) => {
    // ID 按 批次×100 + 序号 分配，保证跨轮不复用。
    // 否则上一轮若漏删一条规则，本轮 addRules 会因 ID 冲突直接抛错，
    // 这个错会被误读成"并发失败"——而它其实只是泄漏的副作用。
    // 泄漏本身由 L3 单独判，不该污染 L2 的数字。
    const id = 1000 + batch * 100 + index;
    const nonce = uuid();                  // 每次唯一
    const cookie = fakeCookie(batch, index);
    inflight.add(id);

    try {
      // ① 加规则
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [buildRule({ id, nonce, cookie })],
      });

      // ② 发请求（CFG.CREDENTIALS 默认 'omit'，不附加浏览器自身的 cookie）
      const url = withNonce(`${CFG.ECHO_HOST}${CFG.ECHO_PATH}`, nonce);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);

      let echoed = null;
      let error = null;
      try {
        const res = await fetch(url, { credentials: CFG.CREDENTIALS, signal: ctrl.signal });
        const json = await res.json();
        echoed = extractEchoedCookie(json);
      } catch (e) {
        error = e.name === 'AbortError' ? 'timeout' : String(e);
      } finally {
        clearTimeout(timer);
      }

      // ③ 删规则（必须在 finally 里，否则异常会导致规则泄漏）
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
      inflight.delete(id);

      return { index, expect: cookie, echoed, parsed: parseMarker(echoed), error, ruleId: id };
    } catch (e) {
      inflight.delete(id);
      // 万一在这之前就炸了，也尝试清理
      try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch {}
      return { index, expect: cookie, echoed: null, parsed: null, error: `fatal: ${e}`, ruleId: id };
    }
  };

  const settled = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => runOne(i)),
  );
  results.push(...settled);
  return results;
}

/**
 * S2：规则 ID 常驻
 * 一次性建好 N 条规则（每个索引一条，ID 固定），之后只改 nonce 内容。
 * 这样没有"加/删"的时间窗口，理论上最安全——代价是规则数量固定，且删不掉。
 *
 * 实现上仍需 updateSessionRules 来更新内容，但它不涉及新增/删除，只涉及替换。
 */
async function strategyPersistentId(tasks) {
  const { concurrency, batch } = tasks;
  const results = [];

  const runOne = async (index) => {
    const id = 2000 + index;
    const nonce = uuid();
    const cookie = fakeCookie(batch, index);

    try {
      // 更新（如果不存在则新增）
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [buildRule({ id, nonce, cookie })],
      });

      const url = withNonce(`${CFG.ECHO_HOST}${CFG.ECHO_PATH}`, nonce);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);

      let echoed = null;
      let error = null;
      try {
        const res = await fetch(url, { credentials: CFG.CREDENTIALS, signal: ctrl.signal });
        const json = await res.json();
        echoed = extractEchoedCookie(json);
      } catch (e) {
        error = e.name === 'AbortError' ? 'timeout' : String(e);
      } finally {
        clearTimeout(timer);
      }

      return { index, expect: cookie, echoed, parsed: parseMarker(echoed), error, ruleId: id };
    } catch (e) {
      return { index, expect: cookie, echoed: null, parsed: null, error: `fatal: ${e}`, ruleId: id };
    }
  };

  const settled = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => runOne(i)),
  );
  results.push(...settled);
  // 注意 S2 故意不删规则，由外层统一清理，用来观察"常驻"是否真的安全
  return results;
}

/**
 * S3：全局单条共享规则
 * 所有请求复用同一个 ruleId，靠 nonce 区分。预期会失败——这正是要验证的：
 * B站页面上如果有多个取流请求同时发生，而实现者图省事只维护一条规则，会发生什么。
 */
async function strategySingleShared(tasks) {
  const { concurrency, batch } = tasks;
  const SHARED_ID = 3001;
  const results = [];

  const runOne = async (index) => {
    const nonce = uuid();
    const cookie = fakeCookie(batch, index);

    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SHARED_ID],
        addRules: [buildRule({ id: SHARED_ID, nonce, cookie })],
      });

      const url = withNonce(`${CFG.ECHO_HOST}${CFG.ECHO_PATH}`, nonce);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);

      let echoed = null;
      let error = null;
      try {
        const res = await fetch(url, { credentials: CFG.CREDENTIALS, signal: ctrl.signal });
        const json = await res.json();
        echoed = extractEchoedCookie(json);
      } catch (e) {
        error = e.name === 'AbortError' ? 'timeout' : String(e);
      } finally {
        clearTimeout(timer);
      }

      return { index, expect: cookie, echoed, parsed: parseMarker(echoed), error, ruleId: SHARED_ID };
    } catch (e) {
      return { index, expect: cookie, echoed: null, parsed: null, error: `fatal: ${e}`, ruleId: SHARED_ID };
    }
  };

  const settled = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => runOne(i)),
  );
  results.push(...settled);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [SHARED_ID] });
  return results;
}

const STRATEGY_IMPL = {
  [STRATEGIES.POOL_RANDOM_ID]: strategyPoolRandomId,
  [STRATEGIES.PERSISTENT_ID]: strategyPersistentId,
  [STRATEGIES.SINGLE_SHARED]: strategySingleShared,
};

// ============================================================
// 判定
// ============================================================

/**
 * 判据 L2：错配
 *   - 响应没有回显 Cookie → 记为 missing（可能是 DNR 没生效，也可能服务端没回显）
 *   - 有回显但标记不是自己的 → 记为 mismatched（这才是"串号"）
 */
function judge(results, batch) {
  const stats = { total: results.length, ok: 0, missing: 0, mismatched: 0, errored: 0, details: [] };

  for (const r of results) {
    if (r.error) {
      stats.errored++;
      stats.details.push({ ...r, verdict: 'error' });
      continue;
    }
    if (!r.echoed) {
      stats.missing++;
      stats.details.push({ ...r, verdict: 'missing' });
      continue;
    }
    const p = r.parsed;
    if (!p) {
      stats.missing++;
      stats.details.push({ ...r, verdict: 'unparsable' });
      continue;
    }
    // 批次一致 + 序号一致 = 对号；否则串号
    if (p.batch === batch && p.index === r.index) {
      stats.ok++;
      stats.details.push({ ...r, verdict: 'ok' });
    } else {
      stats.mismatched++;
      stats.details.push({ ...r, verdict: 'MISMATCH', got: { batch: p.batch, index: p.index } });
    }
  }
  return stats;
}

// ============================================================
// 主流程
// ============================================================

let running = false;

async function runAll(strategies = Object.values(STRATEGIES), { reset = false } = {}) {
  if (running) return { error: 'already running' };
  running = true;

  const report = {
    startedAt: new Date().toISOString(),
    config: { concurrency: CFG.CONCURRENCY, rounds: CFG.ROUNDS, echoHost: CFG.ECHO_HOST },
    strategies: {},
    leakedRulesAfter: null,
  };

  try {
    // 开跑前先清空，保证起始状态干净
    await clearAllSessionRules();

    for (const s of strategies) {
      const impl = STRATEGY_IMPL[s];
      if (!impl) continue;

      const rounds = [];
      for (let round = 0; round < CFG.ROUNDS; round++) {
        const batch = round + 1;
        const results = await impl({ concurrency: CFG.CONCURRENCY, batch });
        rounds.push({ round: batch, stats: judge(results, batch) });

        // S2 不主动删规则，这里显式清一次，避免影响下一轮
        if (s === STRATEGIES.PERSISTENT_ID) await clearAllSessionRules();
        await sleep(200);
      }

      const totalMismatch = rounds.reduce((a, r) => a + r.stats.mismatched, 0);
      const totalOk = rounds.reduce((a, r) => a + r.stats.ok, 0);
      const totalMissing = rounds.reduce((a, r) => a + r.stats.missing, 0);
      const totalErrored = rounds.reduce((a, r) => a + r.stats.errored, 0);

      report.strategies[s] = {
        rounds,
        summary: { totalOk, totalMismatch, totalMissing, totalErrored },
        verdict:
          totalMismatch > 0 ? 'FAIL_MISMATCH'
          : totalOk === 0 ? 'FAIL_NO_EFFECT'
          : totalMissing + totalErrored > 0 ? 'PARTIAL'
          : 'PASS',
      };
    }

    // 判据 L3：清理后是否还有残留
    await sleep(CFG.SETTLE_MS);
    const leaked = await getAllSessionRuleIds();
    report.leakedRulesAfter = { count: leaked.length, ids: leaked };
  } finally {
    running = false;
    report.finishedAt = new Date().toISOString();
    await persistReport(report, { reset });
  }

  return report;
}

/**
 * 把本次结果合并进 lastReport 再存。
 *
 * 页面是逐策略发消息的（并发测并发会让结果无法解读），所以一次完整测试会
 * 连续产生三份只含单个策略的报告。直接 set 会把前两次冲掉，必须合并。
 *
 * reset=true 表示这是一次全新测试的第一段 —— 丢掉旧会话，从零开始。
 */
async function persistReport(report, { reset = false } = {}) {
  const { lastReport: prev } = await chrome.storage.local.get('lastReport');
  const base = reset ? {} : (prev?.strategies ?? {});

  const merged = {
    ...report,
    strategies: { ...base, ...report.strategies },
    // L3 只在本次真的测了之后才覆盖
    leakedRulesAfter: report.leakedRulesAfter ?? (reset ? null : prev?.leakedRulesAfter) ?? null,
  };

  // 三个策略都到齐了，才算一次完整会话
  merged.complete = Object.values(STRATEGIES).every((k) => k in merged.strategies);

  await chrome.storage.local.set({ lastReport: merged });
}

/**
 * 单独测 L1：DNR 到底能不能改 Cookie 头。
 *
 * 测两种 credentials 模式，因为这两件事会得出同一个现象、但原因完全不同：
 *   - omit    —— 浏览器本来的 cookie 不带上（Pluma 真实场景就想要这个：
 *                B站页面的请求自带 A 的 cookie，我们要把它整个换掉）
 *   - include —— 浏览器照常带 cookie，DNR 在其后覆写
 *
 * 如果 omit 失败而 include 成功，说明"omit 会把整个 Cookie 头连同 DNR 的设置一起剥掉"，
 * 那 Pluma 就不能用 omit，只能靠 set 覆盖 —— 这是一个必须在架构里写清的事实。
 */
async function probeL1() {
  const id = 9001;

  const once = async (credentials) => {
    const nonce = uuid();
    const cookie = fakeCookie(99, 0);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [buildRule({ id, nonce, cookie })],
    });
    const url = withNonce(`${CFG.ECHO_HOST}${CFG.ECHO_PATH}`, nonce);
    try {
      const res = await fetch(url, { credentials });
      const json = await res.json();
      const echoed = extractEchoedCookie(json);
      return { ok: !!echoed && echoed.includes('FAKE-99-0'), echoed };
    } catch (e) {
      return { ok: false, echoed: null, error: String(e) };
    }
  };

  try {
    await clearAllSessionRules();
    const omit = await once('omit');
    const include = await once('include');
    return {
      // 只要有一种模式能改成功，L1 就算通过 —— 功能本身成立
      ok: omit.ok || include.ok,
      modes: { omit, include },
      expected: fakeCookie(99, 0),
      // 兼容旧字段，页面仍能显示一条
      echoed: omit.echoed ?? include.echoed ?? null,
      verdict:
        omit.ok && include.ok ? 'BOTH'
        : omit.ok ? 'OMIT_ONLY'
        : include.ok ? 'INCLUDE_ONLY'
        : 'NONE',
    };
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  }
}

// ============================================================
// 消息入口（页面通过 runtime.sendMessage 触发）
// ============================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'q2/run') {
    runAll(msg.strategies, { reset: !!msg.reset })
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // 异步响应
  }
  if (msg?.type === 'q2/probe-l1') {
    probeL1().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'q2/clear') {
    clearAllSessionRules()
      .then((n) => sendResponse({ cleared: n }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'q2/state') {
    getAllSessionRuleIds()
      .then((ids) => sendResponse({ count: ids.length, ids }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'q2/open-lab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('lab.html') }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 点击图标直接打开测试页
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('lab.html') }).catch(() => {});
});

log('background ready', { concurrency: CFG.CONCURRENCY, rounds: CFG.ROUNDS });

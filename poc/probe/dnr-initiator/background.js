// DNR initiator 探针 —— 后台脚本
//
// 职责：
//   1. 按指令安装/清空 session 规则
//   2. 从 top（扩展 SW，initiator 为空）和 content script（页面，initiator 为页面源）
//      两个发起方去打同一个 URL，对比服务端实际看到的 Cookie
//   3. 收集 declarativeNetRequestFeedback 事件，看规则是否 match

const RULE_BASE = 90000;
const CAPTURED = [];

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  CAPTURED.push({
    at: Date.now(),
    ruleId: info.rule.ruleId,
    url: info.request.url,
    type: info.request.type,
    tabId: info.request.tabId,
    initiator: info.request.initiator ?? null,
    documentId: info.request.documentId ?? null,
  });
  if (CAPTURED.length > 2000) CAPTURED.splice(0, 1000);
});

function cookieValue(label) {
  // 值里不含空格，便于解析；带一个唯一 marker 方便断言
  return { name: 'pluma_probe', value: label };
}

function buildRule({ id, urlFilter, requestDomains, cookie, resourceTypes, tabIds, initiatorDomains, excludedInitiatorDomains, excludedRequestDomains, priority }) {
  const condition = { urlFilter };
  if (requestDomains) condition.requestDomains = requestDomains;
  if (resourceTypes) condition.resourceTypes = resourceTypes;
  if (tabIds) condition.tabIds = tabIds;
  if (initiatorDomains) condition.initiatorDomains = initiatorDomains;
  if (excludedInitiatorDomains) condition.excludedInitiatorDomains = excludedInitiatorDomains;
  if (excludedRequestDomains) condition.excludedRequestDomains = excludedRequestDomains;

  // ⚠️ modifyHeaders 的每个条目**必须带 value**，否则整条规则被拒：
  //   "Rule with id N must provide a value for a header to be appended/set."
  // 2026-11-11 实测踩到过一次（写成 { header, operation } 忘了 value）。
  return {
    id,
    priority: priority ?? 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'x-pluma-probe', operation: 'set', value: cookie }],
    },
    condition,
  };
}

async function clearRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter((r) => r.id >= RULE_BASE && r.id < RULE_BASE + 1000).map((r) => r.id);
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  return ids.length;
}

/**
 * 装规则。返回 { ok, error, rules }
 * 关键点：updateSessionRules 对非法 condition 字段会 reject，
 * 所以"字段可用性"本身就是可测的 —— 能装进去 = Chromium 接受这个条件。
 */
async function installRules(specs) {
  await clearRules();
  const rules = specs.map((s, i) => buildRule({ id: RULE_BASE + i, ...s }));
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), rules };
  }
  const persisted = await chrome.declarativeNetRequest.getSessionRules();
  return {
    ok: true,
    rules,
    persisted: persisted
      .filter((r) => r.id >= RULE_BASE && r.id < RULE_BASE + 1000)
      .map((r) => ({ id: r.id, priority: r.priority, condition: r.condition })),
  };
}

/** 从 SW 发起 fetch（initiator 应为空 = 扩展自身） */
async function fetchFromSW(url) {
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const text = await res.text();
    return { ok: true, status: res.status, body: text.slice(0, 1200) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 让指定标签页里的 content script 发起 fetch（initiator = 该页面源） */
async function fetchFromTab(tabId, url, opts = {}) {
  try {
    // topOnly === false 时只让 iframe 里的那份 content script 响应
    const frames = opts.iframeOnly
      ? (await chrome.webNavigation?.getAllFrames?.({ tabId }).catch(() => null)) ?? null
      : null;

    if (frames && frames.length > 1) {
      // 定向发给非顶层 frame
      const results = [];
      for (const f of frames) {
        if (f.frameId === 0) continue;
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'probe-fetch', url, topOnly: false }, { frameId: f.frameId });
          results.push({ frameId: f.frameId, url: f.url, result: r });
        } catch (e) {
          results.push({ frameId: f.frameId, url: f.url, error: String(e && e.message ? e.message : e) });
        }
      }
      if (results.length) return { ok: true, iframeResults: results };
    }

    const r = await chrome.tabs.sendMessage(tabId, { type: 'probe-fetch', url, ...(opts.iframeOnly ? {} : {}) });
    return r ?? { ok: false, error: 'no response from content script' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 读指定 storeId 的 cookie（Q2 用） */
async function readCookies(query) {
  try {
    const list = await chrome.cookies.getAll(query);
    return { ok: true, cookies: list.map((c) => ({ name: c.name, domain: c.domain, storeId: c.storeId, value: c.value.slice(0, 12) + '…' })) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function setCookie(details) {
  try {
    const c = await chrome.cookies.set(details);
    return { ok: true, cookie: c ? { name: c.name, storeId: c.storeId, value: c.value } : null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 规则规模上限探测（Q3）。
 *
 * Chromium 的 MV3 上限（官方文档，当前实现）：
 *   - 静态规则      ≥ 30,000（按 ruleset 计）
 *   - 动态规则      30,000（MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES = 30000，两者**共享**）
 *   - session 规则  同上，共享 30,000
 *
 * 注意：MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES 是**合计**上限，
 * 动态 + session 加起来不能超过 30,000。
 * 这里不靠文档，直接压测真实上限。
 */
async function probeRuleLimits() {
  const out = {};
  // ① 全量读取真实常量（若 API 暴露）
  out.constants = {
    MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES:
      chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES ?? null,
    MAX_NUMBER_OF_DYNAMIC_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? null,
    MAX_NUMBER_OF_SESSION_RULES: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES ?? null,
    MAX_NUMBER_OF_STATIC_RULESETS: chrome.declarativeNetRequest.MAX_NUMBER_OF_STATIC_RULESETS ?? null,
    GUARANTEED_MINIMUM_STATIC_RULES: chrome.declarativeNetRequest.GUARANTEED_MINIMUM_STATIC_RULES ?? null,
    // 可用上限也可能通过 getAvailableStaticRuleCount 反映（仅静态）
    hasGetAvailableStaticRuleCount:
      typeof chrome.declarativeNetRequest.getAvailableStaticRuleCount === 'function',
  };

  // ② 压测 session 规则真实上限（分批添加，找到第一次失败的位置）
  await clearRules();
  const CHUNK = 1000;
  const MAX_ROWS = 40000;
  const before = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  let added = 0;
  let failAt = null;
  let failMsg = null;
  try {
    for (let start = 0; start < MAX_ROWS; start += CHUNK) {
      const addRules = [];
      for (let i = start; i < start + CHUNK && i < MAX_ROWS; i++) {
        addRules.push({
          id: RULE_BASE + i,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-pluma-probe', operation: 'set', value: 'bulk' }],
          },
          // 每条规则 urlFilter 不同，避免被判定重复
          condition: { urlFilter: `bulk-${i}-endpoint`, requestDomains: ['httpbin.org'] },
        });
      }
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ addRules });
        added += addRules.length;
      } catch (e) {
        failAt = added;
        failMsg = String(e && e.message ? e.message : e);
        break;
      }
    }
  } finally {
    const after = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
    await clearRules();
    out.sessionRuleCeiling = {
      addedBeforeFail: added,
      failedAt: failAt,
      error: failMsg,
      sessionRulesAfterAdd: after.length,
      sessionRulesBeforeTest: before.length,
    };
  }
  return out;
}
function cookiesApiSurface() {
  return {
    keys: Object.keys(chrome.cookies).sort(),
    hasGetAll: typeof chrome.cookies.getAll === 'function',
    hasSet: typeof chrome.cookies.set === 'function',
    hasGetAllCookieStores: typeof chrome.cookies.getAllCookieStores === 'function',
  };
}

async function cookieStores() {
  try {
    return { ok: true, stores: await chrome.cookies.getAllCookieStores() };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

const handlers = {
  'install-rules': (msg) => installRules(msg.specs),
  'clear-rules': async () => ({ ok: true, removed: await clearRules() }),
  'list-rules': async () => ({
    ok: true,
    rules: await chrome.declarativeNetRequest.getSessionRules(),
  }),
  'fetch-sw': (msg) => fetchFromSW(msg.url),
  'fetch-tab': (msg) => fetchFromTab(msg.tabId, msg.url, { iframeOnly: !!msg.iframeOnly }),
  'captured': async (msg) => {
    const out = CAPTURED.slice(msg?.since ?? 0);
    return { ok: true, captured: out, total: CAPTURED.length };
  },
  'clear-captured': async () => {
    CAPTURED.length = 0;
    return { ok: true };
  },
  'cookies-surface': async () => ({ ok: true, ...cookiesApiSurface() }),
  'cookie-stores': cookieStores,
  'rule-limits': probeRuleLimits,
  'read-cookies': (msg) => readCookies(msg.query),
  'set-cookie': (msg) => setCookie(msg.details),
  'ping': async () => ({ ok: true, pong: true }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) {
    sendResponse({ ok: false, error: 'unknown type: ' + msg?.type });
    return false;
  }
  Promise.resolve(fn(msg, sender))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async
});

// DNR initiator 探针 —— 完整版运行器
//
// 用法：node poc/probe/dnr-initiator/run.cjs [--browser=edge|edge156] [--headless]
//
// 覆盖：
//   A  基线（无规则）                      —— 两个发起方各自的请求头
//   B-1 condition 字段可用性                —— initiatorDomains / excludedInitiatorDomains / tabIds …
//   B-2 未知字段对照组                      —— 证明 B-1 的"接受"不是瞎接受
//   C  initiatorDomains 真的能区分发起方      —— 关键实测（含反向对照）
//   D  反向对照：去掉 initiatorDomains        —— 两条规则互相命中 → 证明 C 有覆盖力
//   E  tabIds 对 iframe / 子资源 是否也按 tab 算
//   F  chrome.cookies 的 storeId 能力面
//
// 判据全部落在服务端回显（httpbin /anything）上，不看扩展自己的状态。

const { chromium } = require('playwright-core');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXT = __dirname;
const OUT = path.join(__dirname, 'result.json');
const USER_DATA = path.join(os.tmpdir(), 'pluma-dnr-initiator-' + Date.now());

const argBrowser = (process.argv.find((a) => a.startsWith('--browser=')) || '--browser=edge').split('=')[1];
const headless = process.argv.includes('--headless');

/**
 * ⚠️ 2026-11-11 实测：Chrome 157 + Playwright 1.64.1 用 --load-extension 加载扩展**失败**
 * （`chrome://extensions` 空列表、`Preferences.extensions.settings` 为空、
 * serviceWorkers() 恒空）；**Edge 157 / Edge 156 均成功**。
 * 探针默认走 Edge；DNR condition 语义在 Chromium 内核是同一份实现，结论可迁移。
 */
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE156 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\156.0.4314.50\\msedge.exe';

const results = {
  meta: { startedAt: new Date().toISOString(), browserArg: argBrowser, extPath: EXT, userData: USER_DATA },
  steps: [],
};

function rec(step, data) {
  results.steps.push({ step, at: new Date().toISOString(), ...data });
  console.log(`\n===== ${step} =====`);
  console.log(JSON.stringify(data, null, 1).slice(0, 6000));
}

function parseAnything(body) {
  try {
    const j = JSON.parse(body);
    return { headers: j.headers || {}, probe: (j.headers || {})['X-Pluma-Probe'] ?? null, url: j.url };
  } catch {
    return { raw: body.slice(0, 400) };
  }
}

const ECHO = 'https://httpbin.org/anything';

(async () => {
  const exePath = argBrowser === 'edge156' ? EDGE156 : EDGE;
  results.meta.executablePath = exePath;

  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    executablePath: exePath,
    headless,
    viewport: { width: 1200, height: 900 },
    // ⚠️ Playwright 默认注入 `--disable-extensions`，会把 --load-extension 顶掉。
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 25000 });
    const extId = new URL(sw.url()).host;
    results.meta.extId = extId;
    results.meta.browserVersion = ctx.browser()?.version?.() ?? null;

    const extPage = await ctx.newPage();
    await extPage.goto(`chrome-extension://${extId}/probe.html`, { waitUntil: 'domcontentloaded' });

    const send = (msg) =>
      extPage.evaluate(
        (m) =>
          new Promise((resolve) => {
            chrome.runtime.sendMessage(m, (r) => {
              if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
              else resolve(r);
            });
          }),
        msg,
      );

    // 三个发起方页面：不同「域」，用来验证 initiatorDomains 区分
    const pageA = await ctx.newPage(); // https://httpbin.org      → 域 A
    const pageB = await ctx.newPage(); // https://postman-echo.com  → 域 B
    await pageA.goto('https://httpbin.org/html', { waitUntil: 'domcontentloaded' });
    await pageB.goto('https://postman-echo.com/get?x=1', { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(800);
    await pageB.waitForTimeout(800);

    const tabs = await extPage.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.tabs.query({}, (list) => resolve(list.map((t) => ({ id: t.id, url: t.url }))));
        }),
    );
    const idA = tabs.find((t) => (t.url || '').includes('httpbin.org/html'))?.id;
    const idB = tabs.find((t) => (t.url || '').includes('postman-echo.com/get'))?.id;
    rec('A0-tabs', { tabs, idA, idB });

    // ── A. 基线 ──
    await send({ type: 'clear-rules' });
    await send({ type: 'clear-captured' });
    const base = {
      sw: parseAnything((await send({ type: 'fetch-sw', url: ECHO })).body || ''),
      a: parseAnything((await send({ type: 'fetch-tab', tabId: idA, url: ECHO })).body || ''),
      b: parseAnything((await send({ type: 'fetch-tab', tabId: idB, url: ECHO })).body || ''),
    };
    rec('A1-baseline', base);

    // ── B-1. condition 字段可用性 ──
    const fieldProbe = {};
    const tryField = async (name, extra) => {
      const r = await send({
        type: 'install-rules',
        specs: [
          {
            urlFilter: 'anything',
            requestDomains: ['httpbin.org'],
            cookie: 'probe-' + name,
            ...extra,
          },
        ],
      });
      fieldProbe[name] = {
        accepted: r.ok,
        error: r.error ?? null,
        persistedCondition: r.persisted?.[0]?.condition ?? null,
      };
    };
    await tryField('initiatorDomains', { initiatorDomains: ['httpbin.org'] });
    await tryField('excludedInitiatorDomains', { excludedInitiatorDomains: ['postman-echo.com'] });
    await tryField('requestDomains', {});
    await tryField('excludedRequestDomains', { excludedRequestDomains: ['postman-echo.com'] });
    await tryField('tabIds', { tabIds: [idA] });
    await tryField('initiatorDomains+tabIds', { initiatorDomains: ['httpbin.org'], tabIds: [idA] });
    rec('B1-field-acceptance', fieldProbe);

    // ── B-2. 对照组：证明 updateSessionRules 的校验确实会拒东西 ──
    // ⚠️ 第一次写的是「未知字段 initiatorDomainz」——**对照组失败**：
    //    实测 accepted:true，Chrome 对未知 condition 字段是**静默忽略**（不报错也不生效）。
    //    所以「字段被接受」不能靠"它没报错"来证明，必须再给一个"真的会报错"的对照。
    //    下面的用例故意制造非法状态，验证校验链是活的。
    const controls = {};
    // ① 已知必错：值缺失（本次实测撞到过的报错）
    controls.missingValue = await send({
      type: 'install-rules',
      specs: [{ urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: undefined }],
    }).then((r) => ({ accepted: r.ok, error: r.error ?? null }));
    // ② 已知必错：优先级越界
    controls.badPriority = await send({
      type: 'install-rules',
      specs: [{ urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: 'x', priority: 0 }],
    }).then((r) => ({ accepted: r.ok, error: r.error ?? null }));
    // ③ 未知字段（对照组失败的那个，如实保留）
    controls.unknownField = await send({
      type: 'install-rules',
      specs: [
        {
          urlFilter: 'anything',
          requestDomains: ['httpbin.org'],
          cookie: 'bogus',
          initiatorDomainz: ['httpbin.org'],
        },
      ],
    }).then((r) => ({ accepted: r.ok, error: r.error ?? null }));
    rec('B2-validation-controls', controls);

    // ── C. initiatorDomains 能否区分两个发起方（关键实测）──
    // 两条规则同 urlFilter / 同 requestDomains，仅 initiatorDomains 不同。
    // 预期：A 页面 → A_COOKIE；B 页面 → B_COOKIE。
    const ex = await send({
      type: 'install-rules',
      specs: [
        { urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: 'FROM_A', initiatorDomains: ['httpbin.org'] },
        {
          urlFilter: 'anything',
          requestDomains: ['httpbin.org'],
          cookie: 'FROM_B',
          initiatorDomains: ['postman-echo.com'],
        },
      ],
    });
    await send({ type: 'clear-captured' });
    const cA = parseAnything((await send({ type: 'fetch-tab', tabId: idA, url: ECHO })).body || '');
    const cB = parseAnything((await send({ type: 'fetch-tab', tabId: idB, url: ECHO })).body || '');
    rec('C1-initiatorDomains-discriminates', {
      install: { accepted: ex.ok, error: ex.error ?? null, persisted: ex.persisted ?? null },
      a: { probe: cA.probe, referer: cA.headers?.Referer ?? null },
      b: { probe: cB.probe, referer: cB.headers?.Referer ?? null },
      verdict: {
        aGotA: cA.probe === 'FROM_A',
        bGotB: cB.probe === 'FROM_B',
      },
    });

    // ── D. 反向对照：去掉 initiatorDomains → 两条规则互相争抢 ──
    // 用来证明 C 的结论不是"随便装两条规则都能各带各的"。
    // 预期：两条规则都命中同一请求，浏览器按 priority + 规则顺序取一条 → A/B 得到同一个值。
    const ex2 = await send({
      type: 'install-rules',
      specs: [
        { urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: 'FROM_A', priority: 1 },
        { urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: 'FROM_B', priority: 2 },
      ],
    });
    const dA = parseAnything((await send({ type: 'fetch-tab', tabId: idA, url: ECHO })).body || '');
    const dB = parseAnything((await send({ type: 'fetch-tab', tabId: idB, url: ECHO })).body || '');
    rec('D1-negative-control-no-initiator', {
      install: { accepted: ex2.ok, error: ex2.error ?? null },
      a: { probe: dA.probe },
      b: { probe: dB.probe },
      verdict: {
        bothSame: dA.probe === dB.probe,
        explanation: '两条规则无条件重叠 → 两者都拿到同一个值，证明区分只能来自 initiatorDomains',
      },
    });

    // ── E. tabIds 是否覆盖 iframe / 子资源 ──
    // 用 initiatorDomains 做不到"同域两 tab"，改用 tabIds 对照：
    // 两个 tab 都是 httpbin.org（同域），只有 tabIds 能区分。
    // 这里先验证 tabIds 在同域两 tab 下是否真的按 tab 区分。
    const pageA2 = await ctx.newPage();
    await pageA2.goto('https://httpbin.org/uuid', { waitUntil: 'domcontentloaded' });
    await pageA2.waitForTimeout(600);
    const tabs2 = await extPage.evaluate(
      () => new Promise((r) => chrome.tabs.query({}, (l) => r(l.map((t) => ({ id: t.id, url: t.url }))))),
    );
    const idA2 = tabs2.find((t) => (t.url || '').includes('httpbin.org/uuid'))?.id;

    const ex3 = await send({
      type: 'install-rules',
      specs: [
        { urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: 'TAB_A', tabIds: [idA] },
        { urlFilter: 'anything', requestDomains: ['httpbin.org'], cookie: 'TAB_A2', tabIds: [idA2] },
      ],
    });
    const eA = parseAnything((await send({ type: 'fetch-tab', tabId: idA, url: ECHO })).body || '');
    const eA2 = parseAnything((await send({ type: 'fetch-tab', tabId: idA2, url: ECHO })).body || '');
    rec('E1-tabIds-same-domain-two-tabs', {
      idA,
      idA2,
      install: { accepted: ex3.ok, error: ex3.error ?? null },
      a: { probe: eA.probe },
      a2: { probe: eA2.probe },
      verdict: { aGotTabA: eA.probe === 'TAB_A', a2GotTabA2: eA2.probe === 'TAB_A2' },
    });

    // ── F. chrome.cookies 的 storeId 能力面 ──
    const surface = await send({ type: 'cookies-surface' });
    const stores = await send({ type: 'cookie-stores' });
    rec('F1-cookies-api', { surface, stores });

    // ── G. Q1 追问：initiator 取"直接发起方"还是"顶层页面" ──
    //
    // 构造：顶层页 = httpbin.org；在其中插入 iframe，iframe 的 src 指向
    // **httpbin 的 /anything**，但由 **postman-echo.com 页面** 发起的场景无法跨域构造，
    // 所以这里用两个可直接观测的对照：
    //   G-1 顶层页（httpbin.org）自己 fetch        → 命中的 initiator 应为 httpbin.org
    //   G-2 独立 postman-echo 标签页自己 fetch     → 命中的 initiator 应为 postman-echo.com
    //   G-3 iframe（src=postman-echo.com）**导航请求** 被 DNR 看到时，initiator 字段填谁
    // G-3 是本段的核心：它直接说明"iframe 的子请求算谁的 initiator"。
    const tabG = await ctx.newPage();
    await tabG.goto('https://httpbin.org/html', { waitUntil: 'domcontentloaded' });
    await tabG.waitForTimeout(500);

    // 重装 C 组规则（前面的测试已清空），并**额外覆盖 sub_frame**，
    // 这样 iframe 的导航请求也会被 DNR 看到
    await send({
      type: 'install-rules',
      specs: [
        {
          urlFilter: 'anything',
          requestDomains: ['httpbin.org'],
          cookie: 'FROM_A',
          initiatorDomains: ['httpbin.org'],
          resourceTypes: ['xmlhttprequest', 'sub_frame'],
        },
        {
          urlFilter: 'anything',
          requestDomains: ['httpbin.org'],
          cookie: 'FROM_B',
          initiatorDomains: ['postman-echo.com'],
          resourceTypes: ['xmlhttprequest', 'sub_frame'],
        },
      ],
    });

    const tabsG = await extPage.evaluate(
      () => new Promise((r) => chrome.tabs.query({}, (l) => r(l.map((t) => ({ id: t.id, url: t.url }))))),
    );
    const idG = tabsG.find((t) => (t.url || '').includes('httpbin.org/html'))?.id;
    const tabIdPostman = tabsG.find((t) => (t.url || '').includes('postman-echo.com/get?x=1'))?.id;

    await send({ type: 'clear-captured' });
    const gTop = parseAnything((await send({ type: 'fetch-tab', tabId: idG, url: ECHO })).body || '');
    const gB = parseAnything((await send({ type: 'fetch-tab', tabId: tabIdPostman, url: ECHO })).body || '');

    // G-3：在 httpbin 顶层页里插一个 postman-echo 的 iframe，
    // 让 iframe 内部的文档再请求一次 httpbin/anything（用 iframe 的 src 触发 sub_frame）
    const iframeInfo = await tabG.evaluate(async () => {
      const f = document.createElement('iframe');
      // iframe 的源是 postman-echo.com，它内部会去请求 httpbin —— 但我们无法跨域控制它内部。
      // 退一步：iframe 的 **导航请求本身** 由 httpbin 顶层页发起，判据同样有效。
      f.src = 'https://httpbin.org/anything?via=iframe-from-httpbin-top';
      f.width = '600';
      f.height = '200';
      document.body.appendChild(f);
      await new Promise((r) => setTimeout(r, 3000));
      return { iframeSrc: f.src, topOrigin: location.origin };
    });

    await tabG.waitForTimeout(800);
    const gCaptured = await send({ type: 'captured', since: 0 });

    rec('G1-initiator-scope', {
      tabIdTop: idG,
      tabIdPostman,
      iframeInfo,
      topFetchProbe: gTop.probe,
      separatePostmanTabProbe: gB.probe,
      matchedRows: (gCaptured.captured || []).slice(0, 30),
      note:
        '判据：matchedRows 里每条 request.initiator 与 type 的组合。' +
        'XMLHttpRequest 的 initiator 已验证=直接发起方（C 组）；' +
        '这里补看 sub_frame（iframe 导航）算谁的。',
    });

    // ── H. Q3 规则规模上限（真实压测，不查文档）──
    const limits = await send({ type: 'rule-limits' });
    rec('H1-rule-limits', limits);

    fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  } catch (e) {
    results.error = String((e && e.stack) || e);
    console.error(results.error);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
    await ctx.close().catch(() => {});
    process.exit(results.error ? 1 : 0);
  }
})();

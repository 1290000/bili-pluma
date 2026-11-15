# RESULT · DNR 能力边界实测（2026-11-11）

> 探针目录：`poc/probe/dnr-initiator/`
> 运行：`node poc/probe/dnr-initiator/run.cjs --browser=edge`
> 环境：Edge `157.0.4341.42`（Chromium 157 内核），Windows 10.0.26300.2，Playwright 1.64.1
> 原始数据：`result.json` / `result-q3.json`

---

## 0. 环境踩坑（两条，都影响后续所有 DNR 实测）

### 0.1 Chrome 157 用 `--load-extension` 加载扩展**失败**

| 浏览器 | 结果 |
| --- | --- |
| Chrome 157.0.8103.39 | ❌ `chrome://extensions` 空列表、`Preferences.extensions.settings` 为空、`serviceWorkers()` 恒空 |
| Edge 157.0.4341.42 | ✅ 正常加载 |
| Edge 156.0.4314.50 | ✅ 正常加载 |

排查过：manifest/JS 语法合法、启动命令行里 `--disable-extensions` 已被 `ignoreDefaultArgs` 移除、
`--load-extension` 确实在命令行上。**结论是 Chrome 157 + Playwright 1.64.1 的兼容问题，不是探针的问题。**

**影响**：本文全部数据在 **Edge 157** 上取得。DNR 的 `condition` 语义在 Chromium 内核层面是
同一份实现（Edge 与 Chrome 共用 Chromium），可以迁移；但**"Chrome 157 上功能是否一致"未验证**。

### 0.2 Playwright 默认注入 `--disable-extensions`

`launchPersistentContext` 必须显式 `ignoreDefaultArgs: ['--disable-extensions']`，
否则 `--load-extension` 被顶掉，表现为**扩展静默不加载、不报任何错**。
（`poc/probe/probe-edge.mjs` 里已有同样的注释，这次再次撞到。）

---

## Q1. `declarativeNetRequest` 能否只对**特定发起方**生效？

### Q1.1 `condition` 字段可用性 —— **实测：三个字段都可用**

`run.cjs` B1 步。判据 = `updateSessionRules` 接受 + `getSessionRules` 回读到的 condition 里确实有该字段。

| 字段 | 被接受 | 回读到的 condition |
| --- | --- | --- |
| `initiatorDomains` | ✅ | `{initiatorDomains:["httpbin.org"], requestDomains:["httpbin.org"], urlFilter:"anything"}` |
| `excludedInitiatorDomains` | ✅ | ✅ |
| `excludedRequestDomains` | ✅ | ✅ |
| `tabIds` | ✅ | ✅ |
| `initiatorDomains` + `tabIds` 同时给 | ✅ | ✅ |

**对照组（B2 步，这里第一次写成失败的对照组，如实记录）**：

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| `value` 缺失 | ❌ 拒：`Rule with id 90000 must provide a value for a header to be appended/set.` | 证明校验链是活的 |
| `priority: 0` | ❌ 拒：`...invalid value for priority key. This should be greater than or equal to 1.` | 同上 |
| **未知字段 `initiatorDomainz`** | ⚠️ **接受（accepted:true）** | **Chrome 对未知 condition 字段静默忽略** |

> ⚠️ 第三行是这次实测最重要的方法学发现：**"字段被接受"不能靠"它没报错"来证明**。
> 所以 Q1 的真正证据不是 B1（字段被接受），而是下面的 C1（行为差异）+ D1（反向对照）。

### Q1.2 `initiatorDomains` 真的能区分发起方 —— **实测：能**

`run.cjs` C1 步。两条规则 **同 `urlFilter`、同 `requestDomains`**，只有 `initiatorDomains` 不同：

```js
{ id: 90000, cookie: 'FROM_A', initiatorDomains: ['httpbin.org'] }
{ id: 90001, cookie: 'FROM_B', initiatorDomains: ['postman-echo.com'] }
```

发起方 A = `https://httpbin.org/html` 页面，发起方 B = `https://postman-echo.com/get` 页面，
各自 fetch `https://httpbin.org/anything`，看服务端回显的 `X-Pluma-Probe`：

| 发起方 | 期望 | 实测 |
| --- | --- | --- |
| httpbin.org 页面 | `FROM_A` | ✅ `FROM_A` |
| postman-echo.com 页面 | `FROM_B` | ✅ `FROM_B` |

`onRuleMatchedDebug` 交叉验证：

```
ruleId=90000  initiator=https://httpbin.org        url=https://httpbin.org/anything
ruleId=90001  initiator=https://postman-echo.com   url=https://httpbin.org/anything
```

### Q1.3 反向对照：去掉 `initiatorDomains` 之后 —— **实测：两条规则互相争抢**

`run.cjs` D1 步。同样的两条规则，**只删掉 `initiatorDomains`**：

| 发起方 | 实测 |
| --- | --- |
| httpbin.org 页面 | `FROM_B` |
| postman-echo.com 页面 | `FROM_B` |

两个发起方拿到**同一个值**（`FROM_B`，高 priority 那条），
**证明 C1 里的区分能力确实来自 `initiatorDomains`，而不是"随便装两条规则就能各带各的"。**
这条对照组是本轮最关键的一条 —— 它把"支持"结论钉死在一个会变红的反例上。

### Q1.4 `tabIds` 对同域两标签页 —— **实测：能区分**

`run.cjs` E1 步。两个标签页**同为 `httpbin.org`**（同域），只有 `tabIds` 不同：

| 标签页 | 期望 | 实测 |
| --- | --- | --- |
| tab A（`/html`） | `TAB_A` | ✅ `TAB_A` |
| tab A2（`/uuid`） | `TAB_A2` | ✅ `TAB_A2` |

**这回答了"同域两 tab 能不能各带各的 Cookie" → 能，靠 `tabIds` 而不是 `initiatorDomains`**
（同域时 `initiatorDomains` 无法区分，两个 tab 的 initiator 都是 `https://httpbin.org`）。

### Q1.5 `initiator` 取"直接发起方"还是"顶层页面" —— **实测：直接发起方**

`run.cjs` G1 步。顶层页 = `httpbin.org`，在其中插入 iframe（`src` 指向 `httpbin.org/anything`），
规则覆盖 `resourceTypes: ['xmlhttprequest','sub_frame']`：

```
type=sub_frame  initiator=https://httpbin.org  ruleId=90000  url=https://httpbin.org/anything?via=iframe-...
```

⚠️ **未完全验证**：这次构造的 iframe 的**发起方也是 httpbin.org**（iframe 的 src 由顶层页发起），
所以这条只证明了"sub_frame 类型的请求 initiator 也被正确填充"，**没有构造出
"顶层 A 域 / iframe B 域、iframe 内部再发请求"的组合**。
要证实"iframe 内部发起的请求算 iframe 自己的源还是顶层页的源"，需要跨域 iframe + iframe 内能执行脚本的靶子。

### Q1.6 **明确回答 Lead 问的那句**

> **能不能做到"同一个浏览器、两个 bilibili.com 页面（A 号 tab / B 号 tab）各带各的 Cookie 发同一个接口请求"？**

**能。** 两条路径，都已实测：

| 路径 | 条件 | 实测 | 适用边界 |
| --- | --- | --- | --- |
| **`tabIds`** | 请求归属某个具体标签页 | ✅ E1 通过 | **同域两 tab 也能区分**，这是主路径 |
| **`initiatorDomains`** | 两个发起方**域不同** | ✅ C1 通过 | 同域时**无区分力**（两个 tab 的 initiator 相同） |

**对 Pluma 的含义**：
- 两个 `www.bilibili.com` 标签页 → 域相同 → **`initiatorDomains` 完全无效**，只能靠 `tabIds`
- 但 `tabIds` 只对"归属于某个 tab 的请求"生效。**Service Worker 发起的请求没有 tabId**（属于扩展自身）
- 扩展 SW 自己 fetch（`fetchFromSW`，实测 initiator 为空、tabId=-1）→ **两条路径都覆盖不到**

**卡点在这一条 API 语义上**：`tabIds` 只对**浏览上下文内**的请求生效，
而扩展后台/页面 Service Worker 发起的请求没有浏览上下文归属。这不是"能不能配"的问题，
是 Chrome 的 request 模型里**根本没有"给 SW 请求标 tab"的字段**。

---

## Q2. 隔离策略的能力盘点

### Q2.1 `tabIds` 规则的生效窗口 —— **部分实测**

| 问题 | 结论 | 依据性质 |
| --- | --- | --- |
| 对 iframe 的导航请求（`sub_frame`）是否按 tab 算 | ✅ 按 tab（`tabId` 字段正确填充） | 实测（G1） |
| 对 iframe **内部**发起的 XHR 是否按 tab 算 | ⚠️ **未验证** | 构造失败（见 Q1.5 的说明） |
| 对 Service Worker 发起的请求是否按 tab 算 | ❌ **不适用**（SW 请求无 tabId） | 实测（A1：SW fetch 的 tabId = -1，无任何 tab 规则命中） |

**对"用 tab 隔离实现两账号并行"的判定：可行，但边界是"页面发起的请求"。**
任何从扩展 SW 或页面的 Service Worker 发出的请求都不受 `tabIds` 约束。

### Q2.2 `chrome.cookies` 的 storeId 能力 —— **实测**

`run.cjs` F1 步，本探针扩展（有 `cookies` 权限）在**普通窗口**下：

```
keys: OnChangedCause, SameSiteStatus, get, getAll, getAllCookieStores,
      getPartitionKey, onChanged, remove, set
stores: [{ id: "0", tabIds: [788232258, 788232260, 788232264, 788232267, 788232270] }]
```

- **只有 1 个 store，id = `"0"`** —— 与 ADR 0012 补充二的实测**完全一致**（独立复现，不是引用）
- 有 `getPartitionKey`（CHIPS 相关），**没有** `createCookieStore`
- 所有读写 API 都接受 `storeId` 参数（`getAll` / `set` / `remove` 的 details 里），
  但普通窗口里只有一个值可用

**关于"备份/恢复"**：ADR 0012 补充二第 5 条已实测不可行（读不到 httpOnly 明文）。
本次**没有重测**这一条 —— 那需要真实登录态的 SESSDATA，超出无登录态探针的范围。
**引用 ADR 0012，不重复验证。**

### Q2.3 普通窗口能否有第二个 cookie store

ADR 0012 补充二实测「只有 1 个（id `"0"`）」。**本次独立复现得到同样结果**（F1 步）。

**版本一致性核对**：

| 项 | ADR 0012 实测时 | 本次实测 | `wxt.config.ts` |
| --- | --- | --- | --- |
| 浏览器 | Edge 156 / Chromium 156 系 | Edge 157.0.4341.42 | `minimum_chrome_version: '120'` |
| store 数 | 1 | 1 | — |

结论：ADR 0012 的实测结论在 157 上**仍然成立**；`minimum_chrome_version: '120'`
意味着支持 120 以上，而 store 数量这件事**在 120–157 之间没有证据说明变过**
（未逐版本验证，但 156 与 157 一致）。

---

## Q3. 规则规模与并发

### Q3.1 规则上限 —— **实测：session 规则只有 5000 条**

`run.cjs` H1 步，直接读 API 常量和压测：

```js
MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000    ← 注意：动态+session **合计** 5000
MAX_NUMBER_OF_DYNAMIC_RULES:             30000   ← 但单项又写 30000（矛盾，见下）
MAX_NUMBER_OF_SESSION_RULES:             5000
MAX_NUMBER_OF_STATIC_RULESETS:           100
GUARANTEED_MINIMUM_STATIC_RULES:         30000
```

**压测（真实压到边界）**：

```
addedBeforeFail: 5000
failedAt:        5000
error:           "Session rule count exceeded."
sessionRulesAfterAdd: 5000   ← 5000 条全部装进去了
```

> ⚠️ 常量里 `MAX_NUMBER_OF_DYNAMIC_RULES: 30000` 与 `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000`
> **互相矛盾**。压测证明**实际生效的上限是 5000**（session 侧）。这是本项目当前的硬天花板。

**对"扩展到多路径 × 2 账号 × 2 职责"的影响**：

| 方案 | 规则数 | 是否受限 |
| --- | --- | --- |
| 现状：4 路径 × 1 账号 | 4 | 无压力 |
| 4 路径 × 2 账号 × 2 职责 | 16 | 无压力 |
| 加 `tabIds`：每打开一个视频页 +1 条 | 页面数线性增长 | 5000 条 = **最多 5000 个并发标签页**，实际远达不到 |
| 若按"每路径 × 每账号 × 每 tab"三维展开 | 可能爆 | ⚠️ **有风险** |

**真正会撞上限的场景**：不是"路径 × 账号"，而是**"每条规则再乘 tabIds"**。
`tabIds` 是一个数组字段，一条规则可以带多个 tabId —— 即**同一条规则覆盖多个 tab**，
不必一个 tab 一条规则。这一点现有代码没有用（`installTabRule` 是一 tab 一规则），
但改造成本低，能把规则数从 O(tabs) 降到 O(路径×账号)。

### Q3.2 运行时改账号值必须重建规则 —— **实测：是，没有变量替换**

`probe-q3.cjs`：

```
apiSurface.keys: ... updateSessionRules, updateDynamicRules, updateStaticRules, ...
（没有任何"改规则 action 值"的 API —— 改值只能 removeRuleIds + addRules）

placeholderValue:
  error: null                                    ← 被接受了
  persisted.action.requestHeaders[0].value: "${PLUMA_ACCOUNT}"   ← 但存的是**字面量**
```

| 候选路径 | 结论 | 依据 |
| --- | --- | --- |
| action 里引用变量 / 占位符 | ❌ **不存在变量替换**，`${...}` 被当字面量发给服务器 | 实测 |
| 只改 value 不重建规则 | ❌ 没有这样的 API，只能 `updateSessionRules` 整体 remove+add | 实测（API 面） |
| `redirect` 到自建端点 | ⚠️ 接受（`redirectAccepted: error:null`），但**不可行**：需要在自建端点侧持有两个账号凭据并转发，等于把凭据放到扩展之外的网络服务，且需要额外 host 权限 | 实测（接受性）+ 架构判断 |

**所以：切换账号 = 必然重建规则。** 这一点现有架构已经承担（`enableProxy()` 先
`removeAllPathRules()` 再 `updateSessionRules({addRules})`），ADR 0029 讨论的原子性风险
在"规则数变多"时会**变差**（一次 `updateSessionRules` 要搬的规则越多，中间态窗口越长）。

---

## 附：探针文件清单

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 探针扩展（`declarativeNetRequest` + `declarativeNetRequestFeedback` + `cookies` + `tabs` + `webNavigation`） |
| `background.js` | 装/删规则、两个发起方代打、`onRuleMatchedDebug` 采集、cookie API 面、规则上限压测 |
| `content-probe.js` | 页面侧发起方（`all_frames: true`，可按顶层/frame 过滤） |
| `probe.html` | 扩展页上下文载体 |
| `run.cjs` | 主运行器：A/B/C/D/E/F/G/H 八组实测 |
| `probe-q3.cjs` | Q3 补充：运行时改值 / redirect / API 面 |
| `result.json` / `result-q3.json` | 原始输出 |
| `diag*.cjs` | 排查"扩展为何不加载"的中间脚本（保留，供下次复现环境问题） |

**未验证项汇总（不编推理顶替）**：

1. iframe **内部**发起的请求，initiator 算 iframe 自己的源还是顶层页 —— 构造失败
2. Chrome 157 上功能是否与 Edge 157 一致 —— Chrome 157 加载不了扩展
3. `httpOnly` cookie 明文可读性（备份/恢复可行性）—— 需真实登录态，引用 ADR 0012
4. `tabIds` 对 Service Worker 请求 —— 不适用（SW 请求无 tabId），但也意味着**无法**用 tab 隔离 SW 请求

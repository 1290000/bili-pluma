# Q2 PoC —— DNR 并发安全验证

> 一个**独立的一次性扩展**，不属于主项目构建产物，不依赖 WXT，不引入任何依赖。
> 目的只有一个：回答一个问题。

---

## 1. 要回答的问题

> **用 `declarativeNetRequest` 的 sessionRules 临时替换 Cookie 请求头，在并发请求下会不会让某个请求命中别人的规则？**

这是 Pluma 唯一可能被推翻的架构前提（见 `docs/decisions/0002-dnr-to-replace-cookie-header.md`）。

整个方案的地基是这句话：

> 浏览器全程保持主账号 A 的登录态，只对白名单取流接口用 B 的凭据重发。

实现手段是：请求前加一条 DNR 规则把 `Cookie` 头 `set` 成 B 的值，请求后删掉。**如果 DNR 在并发下会把规则错配给别的请求**，那么 A 的请求可能带着 B 的凭据发出去（或反过来），整个方案立刻不可用。

必须在这里证明它不会。

---

## 2. 三层判据

| 层 | 判什么 | 通过标准 |
| --- | --- | --- |
| **L1 功能** | DNR 到底能不能改 `Cookie` 请求头 | 回声服务的响应里出现我们设的标记 |
| **L2 隔离** | 并发时每个请求拿到的 Cookie 是不是自己的 | **串号数 = 0** |
| **L3 回收** | 规则是否正确清理 | **残留数 = 0** |

L1 不过，L2 的数字没有意义 —— 先测 L1。

---

## 3. 四个策略，为什么要测四个

同一件事有四种写法，并发安全性不同。测完才知道 `dnr.ts` 该用哪种。

| 策略 | 写法 | 预期 |
| --- | --- | --- |
| **S1** `pool-random-id` | 每次请求前 `addRules` 一条新规则（唯一 ID + 唯一 nonce），响应后立刻删 | 通过。最复杂，原设计想用它 |
| **S2** `persistent-id` | 规则 ID 常驻 + nonce，只替换内容不新增删除 | 通过 |
| **S3** `single-shared` | 全局只保留一条规则，每次请求前改写它 | **失败**。对照组 |
| **S4** `no-nonce-persistent` | 一条常驻规则匹配整个路径，**不带 nonce**，值固定 | 通过。**实测后采用的就是它** |

S3 是**对照组**。没有它，"S1 通过"只能说明"S1 能用"，不能说明"为什么不能用更简单的写法"。

S4 是**关键实验**。它的假设是：Pluma 的白名单请求全都该用同一个播放账号，规则的值在整个会话内全局一致，所以不存在"这条规则该给谁"的问题 —— 那就不需要 per-request nonce。

### 两种 urlFilter 的区别

带 nonce（S1/S2/S3）：

```js
condition: {
  urlFilter: `||httpbin.org/anything*pluma_nonce=${nonce}`,  // 每次唯一
  requestDomains: ['httpbin.org'],
  resourceTypes: ['xmlhttprequest', 'other'],
}
```

不带 nonce（S4）：

```js
condition: {
  urlFilter: `||httpbin.org/anything`,   // 匹配整个路径
  requestDomains: ['httpbin.org'],
  resourceTypes: ['xmlhttprequest', 'other'],
}
```

nonce 的作用是**把规则锁定到单个请求**。它解决的是"多个目标之间如何区分"。如果只有一个目标（所有请求都用同一个播放账号），这个区分就没有意义 —— 实测也证明了这一点。

---

## 3.1 实测结果（2026-10-25，Edge，20 并发 × 3 轮）

| 策略 | 对号 | 串号 | 无回显 | 判定 |
| --- | --- | --- | --- | --- |
| L1 功能探测（`omit` / `include`） | — | — | — | ✅ 两种模式都能改 |
| S1 `pool-random-id` | 60/60 | 0 | 0 | ✅ PASS |
| S2 `persistent-id` | 60/60 | 0 | 0 | ✅ PASS |
| S3 `single-shared` | 3/60 | **0** | 57 | ⚠️ 每轮仅 1 个请求拿到凭据 |
| **S4 `no-nonce-persistent`** | **60/60** | **0** | **0** | ✅ **PASS** |
| L3 回收 | — | — | — | ✅ 0 条残留 |

**结论：不需要 per-request nonce。** 见 [`docs/decisions/0006-no-per-request-nonce.md`](../../docs/decisions/0006-no-per-request-nonce.md)。

S3 的失败方式值得记住：nonce 被并发覆盖后规则对不上任何请求，于是 19/20 的请求**什么凭据都没拿到**，而不是拿错。**nonce 让"串号"结构上不可能发生，代价是规则被覆盖时静默降级成未登录。** 这个失败模式比串号安全，但仍然不可接受。

### 这个 PoC 没有证明的事

- **没测页面发起的请求** —— 所有 fetch 都来自 Service Worker。DNR 的匹配条件是 URL + resourceType，与发起方无关，理论上等价，但没实测。
- **没测真实 B站 接口**（无登录态、无 WBI、无 POST）。
- **没测"值在请求飞行途中被改"** —— S4 的值在一轮内固定。凭据刷新时改值会不会影响在途请求，没测。

---

## 4. 怎么跑

```bash
# 1. 打开扩展管理页
#    Chrome: chrome://extensions
#    Edge:   edge://extensions

# 2. 打开「开发者模式」

# 3. 「加载已解压的扩展程序」→ 选本目录 poc/q2-dnr-concurrency/

# 4. 点工具栏上的 Pluma Q2 图标 → 自动打开 lab.html
```

在测试页上：

1. 点 **「① 先测 L1（单请求）」** —— 只发一个请求，确认 DNR 生效
2. L1 通过后，点 **「② 跑完整测试（4 策略 × 3 轮）」** —— 240 个请求，约 1-2 分钟
3. 页面会自动生成结论和明细表

也可以点单个策略的按钮分开跑，方便排查。

### 网络依赖

用的是 `httpbin.org` 的 `/anything`（会把请求头原样回显）。**国内直连可能不稳**，如果 L1 一直不过：

- 先换 `postman-echo.com`（改 `background.js` 的 `CFG.ECHO_HOST`，`ALLOWED_DOMAINS` 会自动跟着变）
- 或者自己在本地起一个回声服务，改 `CFG.ECHO_HOST` + `manifest.json` 的 `host_permissions`

httpbin 有速率限制（429）。连续跑多轮容易撞上，撞上了会记为 `missing` 而不是 `mismatched` —— **两者要分清**：`missing` 是没拿到回显（服务端问题），`mismatched` 是拿到了别人的标记（DNR 问题）。

---

## 5. 怎么读结果

页面上每条策略会显示每轮的对号 / 串号 / 无回显 / 报错数，最后给一个总判定：

| 判定 | 含义 | 该怎么办 |
| --- | --- | --- |
| `PASS` | 全部请求拿到自己的 Cookie | 这个策略可用 |
| `PARTIAL` | 无串号，但有 missing / errored | 大概率是网络问题，换回声服务复测 |
| `FAIL_MISMATCH` | **有请求拿到别人的 Cookie** | 架构不可用，见下 |
| `FAIL_NO_EFFECT` | 回显里没有标记，规则没生效 | 先修 L1，别下并发结论 |

### L1 会测两种 credentials 模式

这一点容易误判，所以单独说。测试页的 L1 结果会分别显示 `omit` 和 `include`：

| 结果 | 含义 | 对 Pluma 的影响 |
| --- | --- | --- |
| `BOTH` | 两种都能改 | 最理想。用 `omit`，语义最干净 |
| `OMIT_ONLY` | 只有 omit 能改 | 正好是我们要的模式，但反常，复测一次 |
| `INCLUDE_ONLY` | 只有 include 能改 | **omit 会把整个 Cookie 头连同 DNR 设的值一起剥掉**。`dnr.ts` 只能用 include，并接受"浏览器先带 A 的 cookie、再被 `set` 覆盖"。这条要写进架构文档 |
| `NONE` | 都不行 | 先修 L1，别往下测 |

如果 L1 显示 `INCLUDE_ONLY`，把 `background.js` 里 `CFG.CREDENTIALS` 改成 `'include'` 再跑并发测试 —— 否则四个策略都会显示 `FAIL_NO_EFFECT`，那个结论是假的。

### 如果 S1 是 FAIL_MISMATCH

这是最坏的结果，但也是最有价值的结果 —— 它必须在写业务代码之前被发现。

三条出路：

1. **请求串行化**：全局只允许一个代理请求在飞。简单，但页面同时请求多路流时会明显变慢，且需要一把跨上下文的锁（MV3 里 SW 可能休眠，锁不能放内存）。
2. **`chrome.debugger`**：能拦响应体，能力更强。代价是页面顶部常驻"正在调试此浏览器"提示，且同一 tab 只能被一个 debugger 占用。
3. **本地服务**：退回"扩展 + 本地进程"形态。这是最初被撤回的三进程方案，代价是安装门槛。

无论走哪条，`docs/decisions/0002` 要重写，`docs/01-architecture.md` 的 §2 要重写。

### 如果 L3 残留 > 0

说明有规则的清理路径漏了。`dnr.ts` 必须：

- 清理放在 `finally` 里，不放在 `then` 里
- SW 启动时做一次自愈清理（`getSessionRules()` 全删），因为 SW 随时可能被杀死，`finally` 不一定执行得到
- 规则 ID 按批次分段，避免复用 ID 导致 `addRules` 冲突（这个 PoC 的 S1 已经这么做了）

---

## 6. 记录结果

跑完把结论写进 `docs/03-open-questions.md` 的 Q2 条目，包含：

- 日期、浏览器版本（`chrome://version`）
- 四个策略的判定（尤其 S4 —— 它决定了 `dnr.ts` 要不要 nonce）
- 如果有串号：串号数 / 总数、复现轮次
- 结论对架构的影响（成立 / 需改哪一条 ADR）

完整 JSON 报告在 `chrome.storage.local.lastReport`，测试页 DevTools Console 里：

```js
chrome.storage.local.get('lastReport').then(r => console.log(JSON.stringify(r.lastReport, null, 2)))
```

---

## 7. 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3，只要 `declarativeNetRequest` + `declarativeNetRequestFeedback` + `storage` |
| `background.js` | 全部测试逻辑：规则构造、三策略、判定、消息入口 |
| `lab.html` | 测试页骨架 |
| `lab.js` | 测试页逻辑：发消息、渲染、把数字翻译成结论 |
| `lab.css` | 样式，跟随系统深浅色 |

### 为什么 `minimum_chrome_version` 是 120

用到的 API 里门槛最高的是 `condition.requestDomains`（Chrome 101）和 `updateSessionRules`（Chrome 90）。120 是一个保守下限，不是精确需求 —— 主项目不继承这个数字。

### 为什么这个目录不用 WXT / TypeScript

`dnr.ts` 是本项目唯一无法用 Vitest 测试的模块（它必须有真实的 `chrome.declarativeNetRequest`）。所以它的回归验证只能靠这个独立扩展。刻意写成裸 JS + 零依赖：**任何人在任何机器上 `加载已解压的扩展程序` 就能跑**，不需要装 node、不需要构建。这是它唯一的价值。

主项目构建失败、依赖升级、WXT 换版本，都不影响这个 PoC 还能跑。

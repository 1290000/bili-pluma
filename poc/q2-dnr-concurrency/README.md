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

## 3.2 2026-10-29 重跑：发现 PoC 自身的假阳性并修掉

> 这一节记的是**测试工具的缺陷**，不是 `dnr.ts` 的缺陷。放在这里是因为
> 不写的话，下一个人重跑会看到一片红，然后要么误判方案有问题、要么直接忽略红。

### 症状

准备 1.0.0 时重跑（改动前的基线），连续两次得到同一形状：

| 策略 | 第 1 次 | 第 2 次 |
| --- | --- | --- |
| S4 `no-nonce-persistent` | 20 / **17** / **11** | 20 / **15** / **13** |
| S2 `persistent-id` | 20 / 20 / **16** | 20 / 20 / **14** |
| S1 `pool-random-id` | 20 / 20 / 20 | 20 / 20 / 20 |
| S3 `single-shared` | 1 / 0 / 0 | 1 / 0 / 1 |

- **串号两次都是 0**，**残留两次都是 0**
- `missing` 的形状是 `echoed: null` + `error: null` —— 请求发出去了，没拿到回显

### 为什么不能归因成「httpbin 抖动」

历史记录（`MEMORY` 里那句「`无回显` 4/13/59/10 是 httpbin 网络抖动」）**方向不对**：

1. 直连 httpbin 自测 200 / 962ms，正常
2. 如果是外网抖动，**S1 也该受影响**，但 S1 两次都是满的
3. S4 的 missing **随轮次递增**（0 → 3 → 9），抖动不该是这种形状

### 真正的机理

S4/S2 是「**同一规则 ID 重写内容**」型：每轮开头
`updateSessionRules({ removeRuleIds: [4001], addRules: [...] })`，
然后**立刻** `Promise.all` 发 20 个并发请求。

`updateSessionRules` 是**异步生效**的。规则表重建期间到达的请求
**匹配不到任何规则** → 请求照发、Cookie 没被改 → 回显为空。

验证这个判断的决定性事实：**S1 每请求用新 ID、响应后立刻删，从来不需要"重建一条已有规则"，
所以它永远是满的。** 差别只在这里。

### 为什么它不代表方案有问题

**真实运行里没有"装完立刻并发"这个时序**：

- `dnr.ts` 的 `enableProxy()` 只在总开关切换时装一次，之后规则**常驻不动**
- `installTabRule()` 专门先比对 cookie 与 urlFilter，**相同就跳过重建**
  （源码注释原话：「反复重建规则是"恢复标签页时卡一下"的直接来源之一」）

所以原实现在测一个真实场景中**不存在**的时序。

### 修法

装完规则后用**单发探测请求**确认已生效（最多 10 次 × 120ms），
命中才发并发批次；始终不命中则给整批结果打 `rule-never-settled`，
**不伪装成大面积 missing**。

不用固定 `sleep(N)`：N 小了照样漏、N 大了拖慢整体，且最优值随机器负载变化。
**用探测的返回值当判据才是确定性的。**

### 修后结果（2026-10-29 16:36）

| 策略 | 三轮 | 判定 |
| --- | --- | --- |
| S1 `pool-random-id` | 20 / 20 / 20 | ✅ PASS |
| S2 `persistent-id` | 20 / 20 / 20 | ✅ PASS |
| S3 `single-shared` | 1 / 1 / 1 | 对照组，符合「每轮只剩 1 个」的预期 |
| **S4 `no-nonce-persistent`** | **20 / 20 / 20** | ✅ **PASS** |
| 串号 | **0** | — |
| L3 残留 | **0 条** | — |

**ADR 0006 的结论不变**：不需要 per-request nonce。

> ⚠️ S3 从「1/0/0」变成「1/1/1」也是同一个修复的副作用：原来 r2/r3 的 0
> 里混着「装完立刻发」导致的假失败，现在每轮都稳定地只有 1 个请求拿到凭据 ——
> 这才是 nonce 被覆盖的真实语义。

### 3.3 S1 的 r3 缺失：已查清（2026-10-30）

**结论：这是 PoC 自身的假阳性，不是 DNR 问题。**

2026-10-30 基线重跑（修完 S4/S2 后）S1 的形态变成 r1/r2 满、r3 缺失 2 个
（idx 15/17），**位置随机**，不是历史记录的固定 16–19 —— 说明它本来就不是确定位置缺陷。

根因与 §3.2 的 S4 同源：`updateSessionRules` 的 resolve 只表示变更被受理，
**不表示规则已进入可匹配状态**。S1 每个请求都 add 一条新规则，并发下靠后的 add
可能还没生效，fetch 已经发出 → 回显为空（`echoed: null`、`error: null`）。

修法（**只改 PoC，不改 `dnr.ts`**）：一次不中，等 120ms 再试一次；仍无回显标
`rule-never-settled`，不再伪装成 missing。

修后结果（2026-10-30，Edge，20 并发 × 3 轮）：

| 策略 | 三轮 | 判定 |
| --- | --- | --- |
| S1 `pool-random-id` | 20/20/20 | ✅ PASS |
| S2 `persistent-id` | 20/20/20 | ✅ PASS |
| S4 `no-nonce-persistent` | 20/20/20 | ✅ PASS |
| S3 `single-shared` | 1/1/0 | 对照组，符合预期 |
| 串号 | **0** | — |
| 残留 | **0** | — |

**对 `dnr.ts` 的意义：无。** `dnr.ts` 用常驻规则（按路径建一次、SW 启动自愈重建），
从不在请求前 add/remove —— 正好避开了这个窗口。ADR 0006 的结论不变。

### 教训

**测试工具自己也会产生假阳性，而假阳性会把真结论淹掉。**
判据必须能区分「被测对象坏了」和「测试工具让被测对象看起来坏了」。
这次的判据是**对照组 S1** —— 它证明网络正常、并发正常，
于是 S4 的问题只能在 S4 自己的写法里。

**第二条教训（2026-10-29 补）**：修掉一个假阳性后要**整轮重看**，
不要只看自己改的那一项。S2 的假阳性是在修完 S4 之后才暴露的 ——
同一个原因、同一个文件、两处都要改。



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

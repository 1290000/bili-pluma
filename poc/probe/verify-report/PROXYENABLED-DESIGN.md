# `proxyEnabled` 缺陷分析与修法设计

> 起因：verifier 发现 `page` 模式下 `content.ts:1841` 把 `proxyEnabled` 算成 `true`，
> 导致主世界认为"扩展在工作"并可能改写 `__playinfo__`，而实际 DNR 一条规则都没装。
> Lead 判为**本轮最有价值的发现**，要求：① 追加真机（另派）② 先按"它一定错"设计修法
> ③ 全仓扫同类"否定式白名单"。

---

## 1. 缺陷精确定位

### 1.1 出问题的写法

`entrypoints/content.ts:1841`：

```ts
const proxyEnabled = !(res.activated === false && res.reason === 'disabled');
proxyEnabledKnown = proxyEnabled;
tellMainWorld(proxyEnabled, res.activated === true);
```

### 1.2 它是 **fail-open**（默认认为"在工作"）

真值表（**这是核心，不是推测**）：

| `activated` | `reason` | `proxyEnabled` | 主世界认为 | 实际 | 对不对 |
| --- | --- | --- | --- | --- | --- |
| `true` | `'ok'` | **true** | 在工作 | 在工作 | ✅ |
| `false` | `'disabled'` | **false** | 没工作 | 没工作 | ✅ |
| `false` | `'not-configured'` | **true** | 在工作 | **没工作**（没凭据） | ❌ |
| `false` | `'self'` | **true** | 在工作 | **不需要**（同号空操作） | ❌ |
| **`false`** | **`'page-identity'`** | **true** | **在工作** | **不参与**（用户选了页面身份） | ❌ |
| `false` | `'error'` | **true** | 在工作 | **失败了** | ❌ |

**6 行里只有 2 行是对的。**

### 1.3 为什么"每加一个新 reason 都自动落进'在工作'"

判据是 `!(…)` 的**否定式**：**默认 `true`，只有被明确排除的才 `false`**。
所以新增 `'page-identity'` 时**不需要任何人改这行**，它就自动被当成"在工作"——
**这是一个不会报错、不会失败、只会静默变错的写法**。

### 1.4 与同仓另一处的**方向相反**

`src/core/ui/streaming-pill.ts:110`：

```ts
const currentlyProxying = lastActivateReason === 'ok';   // ← fail-CLOSED，正向白名单
```

**同一个 `reason` 枚举，`streaming-pill` 用正向白名单（只有 `'ok'` 才算在代理），
`content.ts` 用否定式排除（只有 `'disabled'` 才算没代理）。**

这两处对 `'self'` / `'page-identity'` / `'not-configured'` / `'error'` 的答案**全部相反**：

| reason | `streaming-pill` 说"在代理" | `content.ts` 说"扩展在工作" | 一致？ |
| --- | --- | --- | --- |
| `ok` | ✅ 是 | ✅ 是 | ✅ |
| `disabled` | ❌ 否 | ❌ 否 | ✅ |
| `self` | ❌ 否 | ✅ **是** | ❌ |
| `page-identity` | ❌ 否 | ✅ **是** | ❌ |
| `not-configured` | ❌ 否 | ✅ **是** | ❌ |
| `error` | ❌ 否 | ✅ **是** | ❌ |

**∴ 4/6 不一致。这不是环境问题，是逻辑缺陷。**

---

## 2. 全仓"否定式白名单"扫描结果

### 2.1 扫描的 4 类模式

| # | 模式 | 命中 | 判定 |
| --- | --- | --- | --- |
| 1 | `!(x === false && ...)` | **1 处**：`content.ts:1841` | 🔴 **真缺陷**，本报告对象 |
| 2 | `!== 'disabled'` / `!== 'error'` 等排除式 | 4 处 | ✅ **全是 `outcome.kind !== 'ok'` / 注释**，与 reason 判据无关，不是同类 |
| 3 | `reason === 'ok'` / `activated ===` 正向判 | 5 处 | 见下表，**3 处 fail-closed（对）**、1 处 fail-open（本缺陷）、1 处注释 |
| 4 | 默认 `true` / `?? true` / `|| true` | 40 处 | 逐项看过：**39 处是状态赋值**（`done = true`、`midSettled = true`），不是开关判据 |

### 2.2 模式 3 的 5 处明细

| 位置 | 写法 | 方向 | 判定 |
| --- | --- | --- | --- |
| `streaming-pill.ts:110` | `lastActivateReason === 'ok'` | **fail-closed** | ✅ 正确，可作为标准写法 |
| `content.ts:1784` | `badgeState.proxying = res.activated === true` | **fail-closed** | ✅ 正确 |
| `content.ts:1843` | `tellMainWorld(..., res.activated === true)` | **fail-closed** | ✅ 第二参数正确 |
| **`content.ts:1841`** | `!(res.activated === false && res.reason === 'disabled')` | **fail-open** | 🔴 **本缺陷** |
| `messages.ts:246` | 注释里的反例 | — | — |

### 2.3 一处"可疑但**刻意**的 fail-open"（不是缺陷）

`src/content/isolated/hello-timing.ts:103`：

```ts
let offMark: boolean | null = null;
try { offMark = deps.readProxyOffSync(); } catch { offMark = null; }
const firstValue = offMark !== true;   // ← fail-open：判不了就放行
```

**它与 `content.ts:1841` 看似同类，但性质不同**：

| 维度 | `content.ts:1841` | `hello-timing.ts:103` |
| --- | --- | --- |
| 默认值的方向 | "在工作" | "放行" |
| 判不了时 | 主世界**改写** `__playinfo__`（有副作用） | 主世界正常跑（**不额外产生副作用**） |
| 最坏后果 | **界面陈述错误事实**（说基线不可用但实际没有第二身份） | 多取一次流（画质可能短暂回落） |
| 是否刻意 | ❌ **不是**，是写法的副作用 | ✅ **是**，文件里有长注释解释（`:92-116`） |
| 可接受吗 | ❌ 不可 | ✅ 可（"判不了就放行"是正确的默认向） |

> **判据**：fail-open 只有在"放行 = 不产生新副作用、且回退到最保守的既有行为"时才可以接受。
> `content.ts:1841` 的放行会让主世界**多做一件事**（改写响应体），所以必须 fail-closed。

**∴ 全仓「决定是否产生副作用的 fail-open 布尔」= 1 处（`content.ts:1841`）。
另有 1 处刻意 fail-open（`hello-timing.ts:103`），方向正确，不动。**

---

## 3. 修法设计（三个候选，推荐 B）

### 候选 A：`proxyEnabled` 拆成两个具名布尔

```ts
/** 用户的总开关（与"扩展是否参与"无关） */
const switchOn = res.reason !== 'disabled';
/** 扩展是否**参与**这次取流（决定主世界要不要改写 __playinfo__） */
const extensionEngaged = res.reason === 'ok';
tellMainWorld(extensionEngaged, res.activated === true);
writeProxyOffMark(!switchOn);
```

| 维度 | 评价 |
| --- | --- |
| 正误方向 | ✅ 两者都 fail-closed |
| 可读性 | ✅ 名字即语义，`extensionEngaged` 不会再被误用 |
| 改动面 | `content.ts:1841-1843` + 下游 `writeProxyOffMark` 那行 |
| 风险 | ⚠️ **`tellMainWorld` 的第一个参数语义变了**：原来是"总开关"，现在变成"扩展是否参与"。`main-world.js` 的 `cfgEnabled` 内部按"总开关"用，**改语义会动裸 JS 的行为**（AGENTS.md §4.3：这类改动要真机日志） |

**问题**：`main-world.js` 的 `cfgEnabled` 现在**同时承担两件事**——"总开关"和"要不要改写"。
候选 A 只改了传值，**没解决 `main-world.js` 内部把两件事混成一件**。

### 候选 B（推荐）：`tellMainWorld` 增加第三个参数，显式传"是否改写"

```ts
/**
 * @param enabled      用户总开关（沿用现有语义，`main-world.js` 的 `cfgEnabled` 继续用它）
 * @param pgcActive    PGC 是否接管播放器
 * @param rewriteGate  是否允许改写响应体（`__playinfo__` / playurl）。
 *                     **fail-closed**：只有 reason === 'ok' 才为 true。
 */
function tellMainWorld(enabled: boolean, pgcActive?: boolean, rewriteGate = false): void
```

传值：

```ts
const switchOn = res.reason !== 'disabled';       // 总开关：只有明确 disabled 才算关（现有语义不变）
const extensionEngaged = res.reason === 'ok';     // 扩展是否参与：正向前缀白名单
tellMainWorld(switchOn, res.activated === true, extensionEngaged);
```

`main-world.js` 侧：`cfgEnabled` 保持"总开关"语义不变，**新增 `rewriteGate`**，
所有改写入口（`pgcPatchPlayinfo` / `PATCH_PATHS` 那几处）加一个检查：

```js
if (cfgRewriteGate !== true) return originalResponse;   // fail-closed：默认不改
```

| 维度 | 评价 |
| --- | --- |
| 正误方向 | ✅ 两者都 fail-closed |
| 语义分离 | ✅ **把"总开关"与"允许改写"拆开**，这正是缺陷的根因 |
| 改动面 | `content.ts`（1 处调用 + 函数签名）+ `main-world.js`（3-4 处改写入口）+ `messages.ts`（`page/activate:ok` 无需改，这是 content→MAIN 的内部消息） |
| 风险 | 🔴 **要改 `main-world.js`** —— 近 3000 行裸 JS，`tsc`/`eslint`/`prettier` 全不管（AGENTS.md §4.3），只能靠行为测试 + **真机日志** |
| 好处 | ✅ 从根本上消除"加 reason 就自动放行"的可能 |

### 候选 C：把 `proxyEnabled` 改成三态

```ts
type EngagementGate = 'engaged' | 'not-participating' | 'off';
```

- 表达力最强，但 `main-world.js` 是裸 JS，传三态字符串进去要额外解析
- **且三态并不能阻止"新 reason 默认落进某态"** —— 除非配合 fail-closed 的 `switch` 强制表态

**评价**：概念上正确，但 `main-world.js` 侧的落地成本与候选 B 相同，收益不多 → **不选**。

---

## 4. 推荐：**候选 B**，理由三条

1. **根因是"两件事被一个布尔混在一起"**，候选 B 把它拆开（`switchOn` vs `rewriteGate`），
   候选 A 只是改了传值、没拆概念，`main-world.js` 里仍然混着。
2. **fail-closed 落在"允许改写"这个真正有副作用的判断上**，而不是落在"总开关"上——
   总开关的语义（`!== 'disabled'`）**可以保持 fail-open，因为放行它不产生新副作用**
   （开关的开/关由 storage 真相源决定，这里的判断只是"顺路带话"）。
3. **改动面最小且可控**：`main-world.js` 只加"检查一个布尔"的守卫，不改已有逻辑分支。

### 配套：修完后必须加的测试

| # | 断言 | 归防护 |
| --- | --- | --- |
| T1 | `reason='page-identity'` → `rewriteGate === false` | 本缺陷 |
| T2 | `reason='self'` → `rewriteGate === false` | 同类 |
| T3 | `reason='not-configured'` → `rewriteGate === false` | 同类 |
| T4 | `reason='error'` → `rewriteGate === false` | 同类 |
| T5 | `reason='ok'` → `rewriteGate === true` | 正向 |
| T6 | `reason='disabled'` → `rewriteGate === false` | 正向 |
| **T7** | **新增一个假 reason 值 → `rewriteGate === false`**（用 `as never` 构造） | **防"下次加值又 fail-open"** |

> T7 是**关键**：它保证"下次有人加 reason 却忘了表态"时，测试**变红**而不是静默放行。
> 这是把 fail-closed 从"写法约定"变成"可验证的不变量"。

---

## 5. 需要真机验证的那一条（Lead 已另派）

**唯一需要真机的**：`page` 模式下 `primaryReason` 实际是什么值。

| 结果 | 含义 | 修法是否足够 |
| --- | --- | --- |
| `client-written` | 主世界**确实**改写了 → 界面**正在说假话** | 候选 B 修好后应变成 `ssr` 或 `absent` |
| `ssr` / `absent` | 主世界**没有**改写（门控另有拦截） | **缺陷仍然是逻辑缺陷**（真值表 4/6 行错），只是还没暴露 |

⚠️ **无论真机结果如何，`proxyEnabled` 的语义都是错的** —— 这一点不需要真机确认，
它是真值表推出来的。真机只用来**验证修法够不够**，不决定"要不要修"。

---

## 5.1 ✅ 静态链路已**完整闭合**（无需真机即可确认因果）

我在写本报告时补做了最后一段读码，**这条链现在从 `content.ts` 一直通到 `main-world.js` 的行为分支，
中间没有断点**：

```
content.ts:1841   proxyEnabled = true（page-identity 时）
        ↓
content.ts:1843   tellMainWorld(proxyEnabled, false)
        ↓            postMessage({ type:'cfg', enabled: true, pgcActive: false })
main-world.js:3680 if (!!d.enabled !== enabled) { enabled = !!d.enabled; syncHooks(); }
        ↓
main-world.js:3681 enabled = true
        ↓
main-world.js:1385 if (enabled) startSsPatch();
main-world.js:2302 if (enabled) { … }
        ↓
        → **SSR 改写 / 会员态轮询被启动**
```

**关键三处证据**：

| 位置 | 原文 | 含义 |
| --- | --- | --- |
| `main-world.js:47` | `var enabled = false;` | 主世界行为开关**初值 `false`（fail-closed，正确）** |
| `main-world.js:149-151` | "`enabled`（第 47 行）是主世界自己的**行为开关**，初值 `false`，决定要不要藏 `__playinfo__` / 轮询会员状态" | **明确：`enabled` 就是"要不要改写"的总闸** |
| `main-world.js:3681` | `enabled = !!d.enabled;`（`d.enabled` 即 `content.ts:1841` 的 `proxyEnabled`） | **链路闭合：`proxyEnabled` 一个值同时决定了"总开关"和"要不要改写"** |

### 因此结论升级：不需要真机就能确认缺陷

**`main-world.js:47` 的初值 `false` 是对的（fail-closed）——问题出在 `content.ts:1841`
把一个 fail-open 的值传了进来，把它覆盖成了 `true`。**

| 层 | 默认向 | 对不对 |
| --- | --- | --- |
| `main-world.js:47` `var enabled = false` | fail-closed | ✅ 对 |
| `main-world.js:3681` `enabled = !!d.enabled` | 跟随上游 | ✅ 对（信任上游） |
| **`content.ts:1841` `proxyEnabled = !(…)`** | **fail-open** | 🔴 **错源** |

**真机的价值因此变了**：不再是"确认因果"，而是**确认可见后果的具体文案**
（`page` 模式下画质区到底显示「基线不可用（数据来源是取流账号）」还是别的）。
**因果已经由静态链路确认。**

### 补充：`pgcActive` 那条路**不受影响**

`main-world.js:3692` `if (typeof d.pgcActive === 'boolean') pgcActive = d.pgcActive;`
—— 第二个参数传的是 `res.activated === true`（**已经是 fail-closed**），
且注释明确 "`true` / 未收到 → 允许注入"。所以 **PGC 分支的注入门控是对的**，
受影响的是 `enabled` 这条（`startSsPatch` / `:2302` 那两处）。

---

## 6. 方法论判据（Lead 要求写进 methodology）

> **规则 8：决定"是否产生副作用"的布尔，必须用正向白名单（fail-closed），
> 不能用否定式排除（fail-open）。**
>
> **判据**：写下这个布尔的判断时问一句——
> **"如果将来加了一个我没见过的新值，默认落进哪一边？"**
> - 默认落进"**做**"（fail-open）→ **必须改成正向白名单**
> - 默认落进"**不做**"（fail-closed）→ 可以接受
>
> **为什么**：fail-open 的写法**不会报错、不会失败、只会静默变错**，
> 而且新加值时**不需要任何人改这行**，所以永远不会有人来修它。
>
> **反例判据**：`hello-timing.ts:103` 的 `offMark !== true` 也是 fail-open，
> 但它"放行 = 回退到既有行为、不产生新副作用"，所以可接受。
> **区别在于"放行"会不会让系统多做一件事。**

---

## 7. 结论与建议顺序

| 步 | 动作 | 依赖 |
| --- | --- | --- |
| 1 | 追加真机（Lead 已派），拿 `page` 模式下 `primaryReason` 实际值 | 无 |
| 2 | 按候选 B 改 `content.ts`（`switchOn` / `extensionEngaged` 分离 + 第三参数） | 无，可与 1 并行 |
| 3 | 按候选 B 改 `main-world.js`（加 `rewriteGate` 守卫）+ `node --check` | 步 2 |
| 4 | **补 T1–T7 七条测试**（T7 是防回归的关键） | 步 2 |
| 5 | 真机复验：`page` 模式下画质区**不再说**「基线不可用（数据来源是取流账号）」 | 步 1+3 |

⚠️ 步 3 改 `main-world.js` 属于 AGENTS.md §4.3 触发项：**须 `node --check` + 向用户要一次真机日志**。

# ADR 0012. 播放账号通过隔离窗口登录，凭据脱离浏览器登录态

日期：2026-10-25
状态：已采纳（推翻 [ADR 0011](./0011-playback-login-overwrites-primary.md) 的"待决策"）

## 背景

[ADR 0011](./0011-playback-login-overwrites-primary.md) 记录了阻塞性问题：登录播放账号会覆盖主账号的浏览器登录态。

参考了两个同类项目后，明确了三条已知路线的本质差异：

| 项目 | B 凭据来源 | A 会被覆盖吗 | 为什么 |
| --- | --- | --- | --- |
| **Bili Dual Account Helper**（油猴） | 用户手动粘贴 | ❌ 不会 | GM 沙箱有 `anonymous: true`，请求可完全不带浏览器 cookie |
| **bilipai**（原生 App） | App 内登录 | ❌ 不会 | 播放账号用独立 OkHttp 客户端（`CookieJar.NO_COOKIES`） |
| **Pluma**（原设计） | 浏览器扫码 | ✅ **会** | MV3 扩展没有私有 cookie jar |

**结论：它们能行，靠的都是"独立存储"，而不是"解决冲突"。** 而手动粘贴被明确否决（用户不接受操作成本，且同类脚本评分 2.0/5）。

### 为什么 MV3 里没有第二条路（穷举验证）

逐个测了所有可能的通道（原始 JSON 未入库，见 `.gitignore`）：

| 通道 | 结果 | 原因 |
| --- | --- | --- |
| `chrome.cookies` 建新 store | ❌ `canCreate: false` | API 只有 `get` / `getAll` / `getAllCookieStores` / `getPartitionKey` / `remove` / `set`，**没有创建能力** |
| partitioned cookie（CHIPS） | ❌ set 直接失败 | 只用于跨站 iframe，B站主 frame 请求不读它 |
| offscreen document | ❌ | 共享扩展的 cookie 存储，`Set-Cookie` 仍落主 profile |
| SW 里 `fetch` 读 `Set-Cookie` | ❌ `canReadSetCookie: false` | **forbidden response header**，JS 永远读不到 |
| 无痕分区 | ✅ 已实测 | 唯一可行 |

**关键不是 `createCookieStore` 缺失，而是 `Set-Cookie` 读不到。**

B站的凭据只通过 `Set-Cookie` 下发，而 JS 读不到这个响应头（Web 平台硬限制）。
所以**必须让浏览器真正执行这个响应**，凭据才会落进某个 cookie 存储。

这解释了三者的差异：

| 项目 | 为什么能绕开 |
| --- | --- |
| bilipai | 原生 App，HTTP 客户端**能读 `Set-Cookie` 原始响应头** |
| Bili Dual | 不绕，直接让用户粘贴现成的 cookie 字符串 |
| Pluma | 读不到 `Set-Cookie`，只能靠浏览器落地 → 必须选一个隔离分区 |

**注意归因**：这不是"MV3 太弱"，是 **Web 平台限制**。
换任何 WebExtension 写法都一样；要突破只能用原生程序（违背 [ADR 0001](./0001-use-mv3-pure-extension.md)）。

## 验证

当时的无痕探针输出（原始 JSON 未入库，见 `.gitignore`）：

```
主账号（普通窗口）       mid={{主账号mid}}  uname={{主账号昵称}}            vip=0
播放账号（隔离 context） mid={{播放账号mid}}  uname={{播放账号昵称}}  vip=1

登录播放账号后，主账号仍是 mid={{主账号mid}}
isolationWorked:          true      ← 未被覆盖
accountsDiffer:           true      ← 确实是两个号
isolatedCookies.hasSessdata/hasJct/hasDedeUserId:  全部 true
cookieMidMatchesPlayback: true      ← 读到的确实是播放账号
```

**四个判据全部成立。**

## 决策

**播放账号的登录在隔离窗口（InPrivate / 独立 profile）里完成，读完凭据立刻关闭窗口。**

```
普通窗口（主账号）        全程不动
  ↓ 点「配置播放账号」
隔离窗口（InPrivate）      登录播放账号
  ↓ 读三个 cookie
vault（chrome.storage.local）  加密保存凭据
  ↓ 关闭隔离窗口（cookie 随窗口销毁）
普通窗口继续用主账号浏览
  ↓ 视频页
DNR 在 tabIds 限定的规则里注入播放账号凭据
```

**主账号的登录态从头到尾没有被读写。**

## 实现要点

### 1. manifest 需要 `incognito: "split"`

`split` 让扩展在无痕窗口里有**独立的 background 实例**，且不与普通窗口共享。
（`spanning` 会让同一个 background 同时管理两种窗口，cookie 读取容易串。）

### 2. 用户必须手动勾选「在 InPrivate 中允许」

这是无法绕过的一步：扩展默认不在无痕窗口运行，需要用户在 `edge://extensions` 详情页勾选。

**实测的坑（`poc/verify/e2e-login.cjs` 的输出，原始 JSON 未入库）**：

```
incognitoAllowed: false
createResult: { ok: true, id: null }        ← 不抛错
pages: ["about:blank", "chrome-error://"]   ← 但留了个白屏错误窗口
```

未获准时 `chrome.windows.create({ incognito: true })` **既不抛错也不建窗口，只返回 `id: null`，
同时留下一个白屏错误页**。所以必须：

1. 调用前先 `chrome.extension.isAllowedIncognitoAccess()` 检查
2. 调用后若 `id == null`，关掉这次操作新冒出来的残留窗口
3. 未获准时打开一个说明页（`entrypoints/need-incognito/`），而不是静默失败

**这是一次性配置**，比"每次复制 cookie"轻得多，但仍需在引导里明确说明。
如果用户拒绝，降级到「手动粘贴」路径（保留但默认隐藏）。

### 3. 不能用 `chrome.windows.get(id)` 复查隔离是否生效

**这是踩了三次才定位对的。**

`incognito: "split"` 下分区隔离是**双向**的：

| 现象 | 说明 |
| --- | --- |
| 普通实例 `getAllCookieStores()` | 看不到无痕分区 |
| 普通实例创建无痕窗口后 `windows.get(id)` | **也看不到自己刚创建的无痕窗口** |

所以"先创建、再查询验证"这条路必然失败，表现就是
**InPrivate 窗口明明弹出来了，说明页也弹了**（前者成功，后者误判成失败）。

✅ 正确做法：**信任 `windows.create()` 的返回值**。它是创建请求的回执，
自带 `incognito` 字段，不受可见性影响：

```ts
const created = await chrome.windows.create({ ..., incognito: true });
if (created?.id == null) return { ok: false, reason: 'incognito-disabled' };
if (created.incognito !== true) { /* 隔离未生效，关掉 */ }
```

### 4. 两个 background 实例都会收到图标点击，必须用共享存储去重

split 模式下普通/无痕 background 是**两个独立实例**，都会收到 `action.onClicked`。

去重不能用内存变量（不共享），**也不能用 `windows.getAll()`**（看不到对方分区）。

✅ 唯一可靠：用 **`chrome.storage.local`** 做抢占锁——它跨分区共享，
3 秒内只有一个实例能抢到开窗权。

### 5. 读 cookie 不传 storeId

登录窗口的页面发消息会被路由到**它自己分区的 background 实例**，
在那个实例里 `chrome.cookies.get` 默认读的就是无痕分区。

```
普通 background  ← 主账号分区
无痕 background  ← 播放账号分区（独立实例）
      ↑ 登录窗口的消息路由到这里，读 cookie 天然正确
```

### 4. 三个字段必须同源

`SESSDATA` / `bili_jct` / `DedeUserID` 必须来自同一个 storeId、同一个账号。
已有 `readPlaybackCredential` 从同一个 storeId 读三个值，天然保证同源。

## 已知限制

| 限制 | 影响 | 缓解 |
| --- | --- | --- |
| 需用户勾选"在 InPrivate 中允许" | 首次配置多一步 | 引导文案写清楚，配一次就好 |
| 企业策略可能禁用无痕 | 部分环境不可用 | 降级到手动粘贴（保留但默认隐藏） |
| 用户可能关掉隔离窗口前忘记 | 凭据已存 vault，不影响 | 读完即存，不依赖窗口存活 |
| 播放账号在别处登出 | 凭据失效 | 取流失败时提示"重新配置" |

## 对既有文档的影响

- **`AGENTS.md` §3 决策 2**「不切 cookie」仍然成立——切的是**隔离分区**里的 cookie，主账号分区未被触碰。但需要补一句说明隔离机制。
- **根 `README.md`** 首屏「浏览器全程保持主账号登录」现在**重新成立**（前提是走隔离登录）。
- **ADR 0004** 的"请求级身份代理"前提恢复：浏览器是 A，取流用 B，且 B 的凭据与 A 的登录态物理隔离。

## 相关

- 前一版：[ADR 0011](./0011-playback-login-overwrites-primary.md)
- 验证数据：无痕探针输出（原始 JSON 未入库，见 `.gitignore`）
- 参考实现：
  - Bili Dual Account Helper（油猴）：`GM_xmlhttpRequest` + `anonymous: true`
  - bilipai：`CookieJar.NO_COOKIES` + 拦截器绑定会话

---

## 补充：**播放时不跳窗口**（2026-10-28 明确记录）

隔离窗口只用于**登录**（让播放账号的 `Set-Cookie` 落地），**不用于播放**。

### 曾经认真考虑过的备选：看会员集时新开无痕窗口播放

| 维度 | 无痕窗口播放 | 当前方案（同窗口请求级代理） |
| --- | --- | --- |
| 用户操作 | 会员集自动跳到另一个窗口 | 当前窗口直接播，无感 |
| **收藏 / 点赞 / 评论 / 投币** | ❌ **全记到播放账号** | ✅ 全归主账号 |
| **历史 / 播放进度** | ❌ 播放账号的 | ✅ 主账号的 |
| 弹幕 | ❌ 播放账号的（设置、发送记录都变） | ✅ 主账号的 |
| 实现复杂度 | 低 | 高（DNR + 主世界注入 + 缓存编排） |
| 已投入 | 0 | 已完成并真机验证 |

### 决定：不做

**决定性理由是"数据归属"。** 用户在浏览器里的一切行为都应该是主账号的 ——
这正是本项目的定位（见根 `README.md` 首屏："浏览器全程用主账号"）。
无痕窗口方案技术上简单得多，但会让用户在不知情的情况下把点赞、评论、
历史都记到另一个号上，这是**比画质更严重的体验问题**，而且很难向用户解释清楚。

复杂度高不是问题的反面：正因为要同时做到"主账号身份"和"大会员画质"，
才需要请求级代理这套机制。这是产品定位决定的，不是实现走了弯路。

### 判定"没做"≠"还没做"

如果有人（包括未来的我）看到"P3 = 无痕窗口播放"这种说法，**要当成已否决的备选**，
不是待办。真正的待办清单在 `.workbuddy-ai/analysis/PGC-STATUS.md` 和
`docs/03-open-questions.md` §0。

---

## 补充二：能不能**不要无痕窗口**？—— 2026-11-10 完整实测，结论「不能」

用户提出一个很自然的疑问：

> 「必须无痕窗口吗？能不能就在原来的浏览器窗口弹个窗扫码，登录拿到的凭据
> 直接存进扩展里，不让它覆盖浏览器上原本登录好的账号？」

这个疑问每半年都会有人问一次，所以这里把实测摆出来，**以后不必重新验证**。

### 结论

| # | 问题 | 结论 | 依据性质 |
| --- | --- | --- | --- |
| 1 | 未获「在 InPrivate 中允许」的扩展，能开无痕窗口吗 | ❌ **不能** | **实测**：`windows.create({incognito:true})` 返回 `null`，11 次采样窗口增量恒 0 |
| 2 | 普通窗口有几个 cookie store | **1 个**（id `"0"`） | **实测**：`getAllCookieStores()`，实验时确认无任何无痕窗口 |
| 3 | `chrome.cookies` 有创建 store 的能力吗 | ❌ **没有** | **实测**：有 `cookies` 权限时全部 9 个 key，只有 6 个真方法，无 `createCookieStore` |
| 4 | CHIPS（partitioned cookie）能当第二套吗 | ❌ **不能** | **实测**：`set()` 直接报错 |
| 5 | 能否先备份主账号 → 扫码 → 再恢复 | ❌ **不可行** | 上游读不到 httpOnly 明文（实测 `hasSessdata:false`）；下游 `cookies.set()` 虽能写回 httpOnly（实测可行），但**没有明文可备份** |

### 为什么"拦截凭据"这个动作根本不存在

用户设想的「弹窗扫码 → 拦截凭据 → 存进扩展」里，**第二步是个不存在的动作**。

`Set-Cookie` 是 **forbidden response header**，JS 永远读不到（Web 平台硬限制，
`fetch` / XHR / DNR `modifyHeaders` 都不行）。所以时间顺序是：

```
浏览器执行 Set-Cookie → 落进 cookie store → 扩展才能用 chrome.cookies.get() 读到
                        ↑ 到这一步，主账号已经被覆盖了
```

**「扩展能读到凭据」和「主账号已被覆盖」是同一时刻的事**，不可能只要前者。

### 闭合证明：普通窗口里必然覆盖（不是"可能"）

```
前提 1（实测）：普通窗口只有 1 个 cookie store，id = "0"
前提 2（实测）：未获无痕权限 → 开不出无痕窗口 → 不会有第二个 store
前提 3（已有机制）：Cookie 按 (domain, path, name) 唯一，同一 store 内不能并存两套 SESSDATA
∴ 普通窗口里任何登录都写进 store "0" 的 .bilibili.com
∴ 主账号的 SESSDATA 必然被替换
```

⚠️ **口径**：这是**闭合推出**，不是"真的覆盖了一次"。做一次真实覆盖需要用户掉登录且无法恢复
（因为读不到 httpOnly 明文，先备份都做不到），不值得也不应该做这个实验。

### 「在 InPrivate 中允许」：去不掉，但可以做得更顺

`incognito: "split"` 因此是**硬性前提**，不是"麻烦的一步"。

能优化的是**引导流程**（`entrypoints/need-incognito/`），不是去掉这一步：

| 优化 | 解决什么 |
| --- | --- |
| 一键直达扩展详情页 | 用户找不到了解页在哪、扩展在哪、开关在哪 |
| 「为什么」从折叠提到主体 | 用户不知道为什么，就不愿做 |
| 勾选后自动检测放行 | 用户勾完不知道生效没有，要自己回来重试 |

### 对本文 §验证 的两处口径修正（2026-11-10 复测）

| 判据 | 原文写法 | 复测实际 | 影响 |
| --- | --- | --- | --- |
| `windows.create()` 返回值 | `{ ok: true, id: null }` | **整个返回值是 `null`** | 无。`login-window.ts` 用 `created?.id == null`，两者都判对。原文那个 `{ok:true}` 应是当时脚本自己的包装 |
| 残留白屏错误页 | 有 `chrome-error://` | **复现不了**（3 秒内 11 次采样无新窗口） | 无。倾向认为当前 Edge 在 `id==null` 时不再建临时窗口 |

> 这两条都**不影响结论**，但要更正描述，避免后来人以错的口径写判定。

---

## 补充三：`ruleCount` 从 3 变成 0 —— 2026-11-10 查清，**不是缺陷**

排查起因：真机实验中途观测到 `proxy.enabled = true` 但 `ruleCount` 从 3 变成 0，全程无写操作。
一度被当成「DNR 规则丢失」立案（任务卡标题就叫这个）。

**结论：没有规则丢失。这是本实例内存快照与全局状态的正常差异。**

### 三条依据（每条都独立成立）

**① `ruleCount` 只被同实例消费，从来不是全局口径**

所有消费方（面板画质区 `panel-data.ts`、诊断浮层 `collect.ts`）都是 content script 发
`proxy/status` → 消息只递给**它所在分区**的 SW。`popup` 根本不发这条消息。
普通窗口的面板永远够不到无痕实例，反之亦然。

**② `ruleCount = 0` 且开关为 true，用户 2026-10-29 已明确否决报警**

原话在 `src/core/ui/popup-state.ts:295-315`：

> 「番剧页从别的页面切回来 popup 里面就会显示开关开着但规则没装上，请关闭再开启一次，
> **可问题是播放已经成功的被接管了，不用再重新开关一次**」

两种正常情况会让计数读到 0：
- 切回标签页的瞬间，标签页规则随 `page/activate` 异步重建
- `countPathRules()` 只数 `kind === 'path'`，而**番剧页生效的是标签页规则（`tabIds`）**

「取流成功了」这个事实比规则计数硬得多。让用户去修一个没坏的东西，是最糟糕的提示形态。

**③ 两个数据源本来就不同源**

| 值 | 存储 | 跨分区？ |
| --- | --- | --- |
| `enabled` | `chrome.storage.local` | **共享**（所以两实例读到同一个 true） |
| `sessionRules` | 实例内存（Chrome 规格：backed in memory） | **按实例独立** |

加上本文 §85 的 `incognito: "split"` —— **两个 SW 互不可见**。
所以「A 实例数到 3、B 实例数到 0」是机制上的必然，不是故障。

### ⚠️ 一句话结论（请记住这句，省得下次重查）

> **`ruleCount` 是本实例的内存快照，不是全局真相。判代理是否生效，看真实取流高度，不要看这个数。**

### 排查中被实测推翻的三个假设（记录下来避免重走）

| 假设 | 提出 | 实测 |
| --- | --- | --- |
| 自愈函数没接到 SW 生命周期 | 排查者 | ❌ `background.ts:123` 早已接上；WXT 的 `main()` 每次 SW 启动都跑，无 `onInstalled` 门控 |
| 自愈有并发缺陷（清空→重建之间无锁） | 排查者 | ❌ 并发 2/3 次、与 `enableProxy()` 交错，最终都是 3 条 |
| 凭据读失败会留下 `enabled:true + ruleCount:0` | 排查者 | ❌ `dnr.ts:277` 必定写 `enabled=false`，产生不了那个组合 |

**如果当初照着"修 bug"的标题去改代码，最可能的两种"修复"（加锁 / 补 `onStartup`）实测都是空转。**

### 遗留待办

`src/platform/diagnostics/collect.ts:429` 的 `consistent` 判定**仍是老口径** ——
诊断页会标红「⚠️ 不一致」，与画质区的「已接管」冲突。
**它不在任何人的写域内，本轮未修**，已在 `proxy.handler.ts` 的注释里显式标注：
**不要照它写新逻辑**，等专门处理。



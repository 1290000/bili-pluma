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

`poc/verify/result-channel-probe.json` 逐个测了所有可能的通道：

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

`poc/verify/result-incognito-probe.json`：

```
主账号（普通窗口）       mid={{primary_mid}}  uname={{primary_name}}            vip=0
播放账号（隔离 context） mid={{playback_mid}}  uname={{playback_name}}  vip=1

登录播放账号后，主账号仍是 mid={{primary_mid}}
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

**实测的坑（`poc/verify/result-login-flow.json`）**：

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

- **`AGENTS.md` §2 第 2 条**「不切 cookie」仍然成立——切的是**隔离分区**里的 cookie，主账号分区未被触碰。但需要补一句说明隔离机制。
- **根 `README.md`** 首屏「浏览器全程保持主账号登录」现在**重新成立**（前提是走隔离登录）。
- **ADR 0004** 的"请求级身份代理"前提恢复：浏览器是 A，取流用 B，且 B 的凭据与 A 的登录态物理隔离。

## 相关

- 前一版：[ADR 0011](./0011-playback-login-overwrites-primary.md)
- 验证数据：`poc/verify/result-incognito-probe.json`
- 参考实现：
  - Bili Dual Account Helper（油猴）：`GM_xmlhttpRequest` + `anonymous: true`
  - bilipai：`CookieJar.NO_COOKIES` + 拦截器绑定会话

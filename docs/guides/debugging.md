# 调试指南

> 针对 Pluma 的三个高频调试场景：DNR 规则、页面取流、凭据状态。

---

## 0. 加载与重载

```
1. chrome://extensions/ → 开启右上角"开发者模式"
2. "加载已解压的扩展程序" → 选择 dist/（见 scripts/build.ts 的输出目录）
3. 每次改完代码：点扩展卡片上的刷新按钮
4. 改了 content script 后：必须刷新 B站页面（content script 不会热重载）
5. 改了 manifest 后：必须重新加载扩展，且已打开的页面要刷新
```

> 构建产物在 `.output/chrome-mv3/`（WXT 默认），不是 `dist/`。

### 三个会让人排查很久的坑（2026-10-25 实测）

**1. `chrome.action.onClicked` 不触发 → 检查 manifest 有没有 `action` 字段**

WXT 不会因为你在代码里写了 `action.onClicked` 就自动加 `action` 到 manifest。没有这个字段，工具栏图标不绑定任何行为，**点了毫无反应也不报错**。

必须在 `wxt.config.ts` 显式声明：

```ts
manifest: { action: { default_title: 'Pluma' } }
```

**2. 消息永远 pending → 先排除 Service Worker 冷启动**

`chrome.runtime.sendMessage` 在 SW 冷启动时需要等待唤醒。如果页面侧设 3 秒超时，而 SW 首次启动要更久，消息会表现为"永远不回来"，且**没有任何报错**。

排查顺序：
1. 在 SW 里直接调 `fetch` → 排除网络
2. 在 SW 里直接调 `chrome.storage.session` → 排除权限
3. 在 SW 里**临时注册一个探针监听器**，从页面发消息，看 `hits` 是否增加 → 判断是投递问题还是处理问题
4. 把超时拉到 20 秒再试 → 若通过即是冷启动

**3. Edge 156 有自己的 `browser` 命名空间，别用它**

Edge 156 提供 `globalThis.browser`，但它**既不是 `chrome` 的别名**（`browser !== chrome`），**也不是 webextension-polyfill**（无 polyfill 标记），而是一个带 `onRestartRequired` / `onUserScriptMessage` / `dynamicId` 等 Edge 专有 API 的独立命名空间。

WXT 的产物里有这样一行：

```js
var t = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome
```

所以在 Edge 上会**优先用这个 `browser`**。它的 `onMessage` 行为与标准 `chrome` 不一致，会导致 `sendResponse` + `return true` 失效。

**项目约定：全项目统一用 `chrome.*`，不 import `wxt/browser` 的 `browser`。** 需要类型时装 `@types/chrome`。

### 自动化测试的限制

- **Chrome 155+ 已完全禁用 `--load-extension`**，加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效，SW 不会启动
- **Edge 156 可以加载**，但在 Playwright 下扩展消息路由不稳定
- 因此**端到端验证（扫码、真实取流）必须手动加载扩展**，不要试图全自动化

#### 自动化拿不到「登录态 + 调试端口」（2026-10-26 实测，不要再试）

| 想做的事 | 能否做到 |
| --- | --- |
| 连**运行中**的浏览器（`--extension`） | ❌ playwright-cli 0.1.22 无此参数 |
| 用**默认 profile** 开调试端口 | ❌ Chromium 一律拒绝：`requires a non-default data directory`。**Chrome / Edge 都是**（按路径字符串比对，传内建默认路径等于没传） |
| **复制 profile** 到别的路径再开端口 | ⚠️ 端口能开，但 **cookie 解密密钥绑定原路径 → 登录态全丢** |
| 父进程退出后浏览器继续活着 | ❌ 沙箱会回收子进程。必须把「启动 → 等端口 → 实测 → 收尾」写在**同一个脚本**里 |
| Node 连 `127.0.0.1:9222` | ⚠️ 环境有 `HTTP_PROXY`，会被拦成 502。必须清空 `*_PROXY` 并设 `NO_PROXY=*` |

**结论：自动化无法同时拿到「用户登录态」和「调试端口」。**

需要用户真实 HDR 环境的数据时，**不要试图自动化** —— 用扩展自己的诊断日志
（`entrypoints/content.ts` 的 `[角标输入]` 行），让用户在正常浏览器里看一次视频即可。

### 二维码渲染必须整数倍缩放

canvas 内部尺寸与 CSS 显示尺寸若不是整数倍关系，浏览器会插值，模块边缘发虚，手机扫不出来。

做法：按可用空间算出整数 `scale`，再反推 canvas 尺寸，并**显式设置 `canvas.style.width/height` 等于内部尺寸**，同时 `ctx.imageSmoothingEnabled = false`。

**常见坑**：改了 `content/main-world/inject.ts` 却没刷新页面，以为没生效。MAIN world 脚本是页面加载时注入的，不刷新就不会更新。

---

## 1. 调 DNR 规则（最重要）

DNR 是整个项目最黑盒的部分。**出了问题基本只能靠"看规则列表"来定位。**

### 看当前生效的 session 规则

在 **Service Worker 的控制台**（`chrome://extensions/` → 点扩展的 "Service Worker" 链接）里执行：

```js
// 列出所有 session 规则（我们用的就是这个）
await chrome.declarativeNetRequest.getSessionRules();

// 列出动态规则
await chrome.declarativeNetRequest.getDynamicRules();

// 列出静态规则集
await chrome.declarativeNetRequest.getEnabledRulesets();
```

**预期状态：正常情况下 `getSessionRules()` 应该返回空数组或少量规则。**

如果返回了一堆残留规则 → **说明有规则泄漏**，这是最危险的 bug（残留规则会让后续请求用错凭据）。

### 定位规则泄漏

```js
// 检查规则数量和内容
const rules = await chrome.declarativeNetRequest.getSessionRules();
console.table(rules.map(r => ({
  id: r.id,
  filter: r.condition.urlFilter,
  cookieLen: r.action.requestHeaders?.[0]?.value?.length,
  valueHead: r.action.requestHeaders?.[0]?.value?.slice(0, 30),
})));
```

**判断标准**：如果某条规则的 `cookie` 值里出现了不属于当前请求的账号标识，且这条规则存在超过几秒，就是泄漏。

**泄漏的常见原因**：
1. `fetch` 抛异常，没走 `finally`
2. 请求被 browser 取消（用户关页面），Promise 永久 pending
3. SW 在请求中途被休眠

### 观察规则是否命中

```js
// 需要 manifest 里加 declarativeNetRequestFeedback 权限（仅开发版）
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  console.log('[DNR matched]', info.rule.ruleId, info.request.url);
});
```

**注意**：`declarativeNetRequestFeedback` 权限在发布版应移除（仅调试用，且会触发额外权限提示）。

### 手动清空所有 session 规则

```js
const rules = await chrome.declarativeNetRequest.getSessionRules();
await chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: rules.map(r => r.id),
});
console.log('cleared', rules.length);
```

卡在"所有请求都用错账号"时，先执行这个，再重新加载扩展。

### Q2 实测结论（2026-10-25）

用 [`poc/q2-dnr-concurrency/`](../../poc/q2-dnr-concurrency/) 连跑 3 轮：

| 项 | 结果 |
| --- | --- |
| DNR 是否作用于 background 自己发的 fetch | ✅ **是**（这是整个方案的支点） |
| 串行 10 次 / 并发 20 次 / 并发 40 次 | 全部 100% 对号 |
| 规则生效延迟（100 次「加规则→立刻请求」） | **100/100 命中，无窗口期** |
| 异常后规则泄漏 | 规则数 0 → 0，后续请求不受污染 |
| 单轮耗时 | 806 / 848 / 973 ms |

**三条由此确定的实现约束**：

1. **规则池 32 够用，但必须实现排队**。40 并发时后 8 个排队，实测行为正常。
2. **不需要"规则生效确认"逻辑**。100/100 命中，说明 `updateSessionRules` 后立刻 fetch 是安全的。
3. **`try/finally` 是硬要求**。不清理会污染后续请求，这是实测过的。

**没覆盖的**：Service Worker 被系统杀掉导致规则残留。正式版要在启动时执行一次"清空所有 session 规则"兜底。

**怎么重跑**：起 `node poc/q2-dnr-concurrency/echo-server.cjs`，加载该目录为扩展，打开「选项」，点按钮。

---

## 2. 抓包看 playurl 调用（对应 Q3 / Q9）

**这一步极其重要**：Q9 的 `fnval` 正确取值**只能**从官方前端抓包得到，因为 bilibili-API-collect 已关停。

### 抓官方前端发的参数

```
1. 打开任意视频页（最好是有 4K/杜比/Hi-Res 的，问 UP 主或搜索）
2. F12 → Network → 过滤框输入 playurl
3. 点开任意一条请求 → Payload / 查询字符串
4. 记录：fnval、qn、fourk、fnver、wbi 相关参数
```

**关键观察项**：
- `fnval` 的实际值 → 这是最权威的答案
- 是否有 `qn`（有些请求不带，靠 fnval 表达）
- 请求是 XHR 还是 fetch（影响 hook 方式）

### 观察调用时机（Q3）

挂着 Network 面板，**不要关**，做以下操作，每次都记下 playurl 被调了几次：

| 操作 | 观察点 |
| --- | --- |
| 页面首次加载 | 通常是 1 次 |
| 手动切画质 | 大概率 1 次 |
| 拖动进度条 | 0 次（流地址还在有效期内） |
| 暂停 5 分钟再播放 | 可能 1 次（地址过期重取） |
| 多P视频切 P | 1 次（cid 变了） |
| 番剧自动连播下一集 | 1 次（ep_id 变了） |
| 长时间挂机（30 分钟） | 记录总量，判断是否需要"地址提前刷新" |

### 对比主/副账号的画质差异（Q4 与诊断表数据源）

```js
// 在 B站页面的控制台里（未登录状态下，或换账号状态下）
// 这一步只是验证用，正式实现要走扩展的 proxy
const r = await fetch('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV...&cid=...&fnval=4304&qn=120&fourk=1', {
  credentials: 'include',
});
const j = await r.json();
console.log('可用画质:', j.data?.accept_quality);
console.log('可用描述:', j.data?.accept_description);
console.log('是否有 dolby:', !!j.data?.dash?.dolby?.audio?.length);
console.log('是否有 flac:', !!j.data?.dash?.flac?.audio);
console.log('视频轨编码:', j.data?.dash?.video?.map(v => ({ id: v.id, codecid: v.codecid, w: v.width, h: v.height, fps: v.frame_rate })));
```

`accept_quality` 直接告诉你"这个账号对这个视频能拿哪些清晰度"，是判断权限边界的最佳信号。

---

## 3. 看凭据状态

**不要在控制台里 print cookie。** 即使是调试，也可能被截图/日志带走。

只查健康状态：

```js
// SW 控制台
const { status } = await chrome.storage.local.get('status');
console.log(status);   // { accounts: [{ mid, uname, healthy, checkedAt }], degraded }
```

想看脱敏后的凭据摘要：

```js
const { vault } = await chrome.storage.local.get('vault');
console.log({
  entries: vault?.map(v => ({
    mid: v.mid,
    hasSessdata: !!v.cipher,
    updatedAt: v.updatedAt,
  })),
});
```

---

## 4. 看 content script 的日志

content script 的 console 输出在**页面自己的控制台**里（F12 → Console），不在 SW 控制台。

但注意：**MAIN world 和 ISOLATED world 的 console 在同一个 Console 面板里混在一起**，无法区分来源。

**解决办法**：给两边的日志加前缀：

```ts
// MAIN world
const log = (...a) => console.log('%c[MAIN]', 'color:#378ADD', ...a);

// ISOLATED world
const log = (...a) => console.log('%c[ISO]', 'color:#1D9E75', ...a);
```

用颜色区分，扫一眼就知道是哪个环境输出的。

---

## 5. 网络请求失败的分层排查

请求挂了，按这个顺序查：

```
请求失败
├─ 1. content script 完全没日志？
│     → 检查页面是否匹配 manifest 的 matches
│     → 检查 content script 是否注入（F12 → Sources → Content scripts）
│
├─ 2. 有 [MAIN] 日志但没 [ISO] 日志？
│     → postMessage 通道断了（channelToken 不匹配？protocol 版本不符？）
│
├─ 3. 有 [ISO] 日志但没到 SW？
│     → chrome.runtime.sendMessage 抛错（SW 休眠？看 messaging.ts 的重试）
│
├─ 4. SW 收到请求但 DNR 没生效？
│     → getSessionRules() 看规则是否存在
│     → 检查 urlFilter 的 nonce 是否和实际请求 URL 一致
│     → 检查 resourceTypes 是否包含 xmlhttprequest
│
├─ 5. DNR 生效但返回 403 / -412？
│     → 凭据失效（Q6 保活逻辑）
│     → 设备 Cookie 没补齐（buvid3/buvid4）
│     → 缺少 Referer / UA
│
└─ 6. 全部正常但画质没变？
      → 播放器可能缓存了旧的 playinfo
      → 强制刷新页面重试
      → 检查是否命中白名单（路径写错？多了尾斜杠？）
```

---

## 6. 快速自检清单

遇到"没效果"，按顺序过一遍：

- [ ] 扩展已加载且未报错（`chrome://extensions/` 看是否有红色错误）
- [ ] 页面已刷新（改过 content script 后必须刷）
- [ ] `getSessionRules()` 无残留规则
- [ ] 播放账号状态健康（popup 显示"已接管"）
- [ ] 当前页面是视频页（不是首页/动态页）
- [ ] 网络面板里 playurl 请求确实发出了
- [ ] 该视频本身支持高画质（源限制，不是插件问题）

---

## 7. 视频页挂后台后回来白屏 / 播放器无响应（2026-10-25 已修）

### 症状

视频详情页在后台放一段时间（几十分钟），切回去时：白屏、卡顿、播放器不响应点击。
用同类工具（Bili Dual Account Helper）不会出现，所以是本扩展引入的。

### 三个根因，都已修掉

| # | 根因 | 为什么只在"后台挂久"后暴露 | 修法 |
| --- | --- | --- | --- |
| 1 | `setInterval(patchSsUser, 100)` 永不停止 | 前台时用户感觉不到；后台时它变成唯一持续消耗 CPU 的东西，且每次都在动 `__INITIAL_STATE__` 这棵被播放器依赖的大对象树 | 改成 `Object.defineProperty(window, '__INITIAL_STATE__')` 的 setter 拦截，**赋值那一刻改一次**，之后零开销 |
| 2 | 设备 Cookie 缺失 | `document_start` 时 `document.cookie` 是空的，规则里没有 `buvid3` → 风控 `-412`。首次打开靠 `DOMContentLoaded` 补报能救回来，后台恢复/被丢弃后重新加载只走 `document_start`，就救不回来 | 新增 `platform/storage/device-cookies-store.ts`：页面没带 buvid 就回退到缓存 |
| 3 | 规则被反复重建 | `installTabRule` 每次无条件 `updateSessionRules`。`document_start`、`DOMContentLoaded`、后台恢复各一次 → 规则表重算 + 所有 B站标签页重评估 | 加幂等判断：Cookie 值一致就直接 return |

### 怎么确认修好了

```bash
pnpm test -- tests/unit/content/main-world-real.test.ts
```

那里有 9 个用例直接对 `public/main-world.js` 的真源码断言，其中最关键的是
**"启用后也不建 setInterval"**。

⚠️ **验证测试本身有效的方法**（踩过）：把 `setInterval(patchSsUser, 100)` 临时加回
`syncHooks()`，测试必须变红。如果还是绿的，说明 spy 打在了 `globalThis` 而不是
jsdom 的 `window` 上——脚本在 jsdom 里解析的是 `window.setInterval`，
spy 打错地方等于没测。

真机上还要手测一遍：开一个视频页 → 切到别的标签 → 等 30 分钟 → 切回来。

---

## 相关

- DNR 决策与风险：[decisions/0002](../decisions/0002-dnr-to-replace-cookie-header.md)
- 待确认问题 Q2 / Q3 / Q9：[03-open-questions.md](../03-open-questions.md)
- 目录结构：[04-project-structure.md](../04-project-structure.md)

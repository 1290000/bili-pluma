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

## 相关

- DNR 决策与风险：[decisions/0002](../decisions/0002-dnr-to-replace-cookie-header.md)
- 待确认问题 Q2 / Q3 / Q9：[03-open-questions.md](../03-open-questions.md)
- 目录结构：[04-project-structure.md](../04-project-structure.md)

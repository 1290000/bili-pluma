# M1 双向实测报告

> **日期**：2026-11-11
> **任务**：task-13 M1（双向：`extension` / `page`）
> **环境**：bsk 0.3.3 / Edge 157（用户日常实例 PID 25564，无 `--user-data-dir`）
> **纪律**：只读。不点视频、不发写请求、不登录登出、不打印凭据。

---

## 0. 结论先行

| 项 | 结果 |
| --- | --- |
| **两个账号** | ✅ 确认存在 |
| **`streamingIdentity` 当前值** | ❌ **读不到**（面板胶囊不渲染，`streaming/status` 无应答） |
| **M1-a（extension 身份）** | ❌ **未验证** —— 切不了，见 §3 |
| **M1-b（page 身份）** | ⚠️ **部分验证** —— 当前 `rcmd.data.mid` = 页面账号，但**无法确认当前配置就是 `page`** |
| **顺路小测 1：`feed/rcmd` 是 fetch 还是 XHR** | ✅ **`fetch`** |
| **顺路小测 2：Vue store 里有推荐 mid 吗** | ❌ **读不到** |

### 一句话

> **M1 双向验证卡在"切不动取流身份"上。** 面板的身份胶囊不渲染
> （因为 `streaming/status` 无应答 → `streamingIdentity === null` → `tabs.ts:557` 不渲染），
> 而 `streaming/set` 只能从扩展 context（content script 的 ISOLATED world）发，
> `bsk evaluate` 在页面 main world，**拿不到 `chrome.runtime`**。

---

## 1. 两个账号确认存在 ✅

面板「账号」Tab 的辅助功能树（`bsk snapshot`，可穿透 closed Shadow DOM）：

```
StaticText "主"     StaticText "{{主账号昵称}}"
                    StaticText "收藏 · 点赞 · 评论 · 历史"
                    StaticText "LV6"
StaticText "播"     StaticText "{{取流账号昵称}}"
                    StaticText "仅取流 · 6 个月后到期"
                    StaticText "20 小时前校验"
                    StaticText "年度大会员"
button "重新登录"
button "退出取流账号"
```

| 角色 | uname | mid | 备注 |
| --- | --- | --- | --- |
| **浏览器账号（主）** | `{{主账号昵称}}` | **{{主账号mid}}** | LV6，`vipStatus:0` |
| **取流账号（播）** | `{{取流账号昵称}}` | **未读到** | 年度大会员 |

⚠️ **取流账号的 mid 我没拿到** —— 面板只显示 uname。
`account/summary` 消息在扩展 context，页面拿不到。

---

## 2. 已测到的数据（当前未知配置下）

### 2.1 `/nav` 与 `feed/rcmd` 的 mid

```json
{
  "nav":  { "code": 0, "mid": {{主账号mid}}, "uname": "{{主账号昵称}}", "vip": 0 },
  "rcmd": { "code": 0, "dataMid": {{主账号mid}}, "n": 12,
            "keys": ["item","business_card","floor_info","user_feature",
                     "preload_expose_pct","preload_floor_expose_pct","mid"] }
}
```

**`rcmd.data.mid` === `nav.mid` === {{主账号mid}}（页面账号）。**

### 2.2 点「换一换」后的 rcmd（拦截器实测）

```
via=fetch  code=0  data.mid={{主账号mid}}  login_mid=null  n=10
data keys: ["item","business_card","floor_info","user_feature",
            "preload_expose_pct","preload_floor_expose_pct","mid"]
```

**同样 = {{主账号mid}}。**

### 2.3 但这条数据有两种解释，无法区分

| 解释 | 含义 | 对 M1 的意义 |
| --- | --- | --- |
| **A** 取流身份 = `page` | 用户选了"浏览器账号取流" | → 这就是 **M1-b 通过** ✅ |
| **B** 取流身份 = `extension`，但首页 rcmd 规则没生效 | 规则没装 / 没重建 | → **M1 未成立**，但原因是"规则没装"而不是"配置对" |

**当前证据无法排除 B。** 理由：
- 面板显示「未生效」，但 `popup-state.ts:313` 明确「未生效」= **"有取流账号、开关开着，但当前页不是视频页"**
- 首页本来就不是视频页 → 这个状态**不携带"首页 DNR 是否接管"的信息**

---

## 3. 为什么切不动（技术上卡在哪）

### 3.1 页面 main world 没有 chrome.* API

实测（`probe-chrome-api.mjs`）：

```json
{ "chromeExists": true, "storageExists": false,
  "runtimeExists": false, "runtimeId": null }
```

`chrome` 对象存在但**没有 `storage` / `runtime`** —— 这是 content script 运行在 ISOLATED world 的正常表现：
页面 main world 拿不到扩展 API。

### 3.2 `streaming/set` 只能从 ISOLATED world 发

`entrypoints/content-panel.content.ts:251`：

```ts
.sendMessage({ type: 'streaming/set', identity: next })
```

这在 **content script** 里，不在页面 main world。

### 3.3 `bsk evaluate` 跑在 main world → 发不出消息

`bsk evaluate` 等价于 DevTools console，即 main world。
**结论：`bsk` 0.3.3 无法从外部触发 `streaming/set`。**

### 3.4 UI 路径也断了：身份胶囊不渲染

`src/content/panel/tabs.ts:557`：

```ts
if (actions.streamingIdentity !== null) {
  // 渲染胶囊
}
```

`entrypoints/content-panel.content.ts:282-287`：

```ts
const readStreamingIdentity = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'streaming/status' }).catch(() => null);
  return res?.type === 'streaming/status:ok' && res.identity ? res.identity : null;
};
```

面板实际渲染结果（辅助功能树，四个 Tab 全查过）：

```
画质 Tab：StaticText "未生效"  +  自动接管取流 checkbox[checked]
账号 Tab：主 {{主账号昵称}} / 播 {{取流账号昵称}} / 重新登录 / 退出取流账号
        ← 没有胶囊
显示 Tab：（面板收起）
净化 Tab：（未展开）
```

**胶囊在三个 Tab 里都不存在** → `streamingIdentity` 是 `null`
→ **`streaming/status` 没有返回 `streaming/status:ok`**。

---

## 4. 🔴 顺带发现一个真 bug（Lead 点名要记的）

> **取流身份胶囊在本机完全不渲染 —— task-9 交付的这个功能，用户看不到 = 等于没做。**

### 现象
面板「账号」Tab 里，取流账号卡（`{{取流账号昵称}}`）**没有 `describeStreamingIdentity()` 产出的二态胶囊**。

### 代码路径
| 位置 | 逻辑 |
| --- | --- |
| `content-panel.content.ts:362` | `streamingIdentityCache = await readStreamingIdentity()` |
| `:286` | 只有 `res?.type === 'streaming/status:ok'` 才返回真值，否则 `null` |
| `:395` | `streamingIdentity: streamingIdentityCache ?? null` |
| `tabs.ts:557` | `if (actions.streamingIdentity !== null)` → **null 就不渲染** |

### 两种可能（**我没能区分**）
1. **`streaming/status` 消息真的失败了**（后台没应答 / 超时 / 类型不匹配）
2. **消息成功了但 `identity` 字段为空** —— `:286` 的 `res.identity ?` 会把它变成 `null`

### 需要什么才能定位
- background SW 的 console（超出 bsk 边界）
- 或给面板加一条诊断输出（需要改代码，我做不了）

### 影响
**用户目前完全看不到"取流：扩展账号 / 取流：浏览器账号"这个二态胶囊，
也就无法在界面上切换取流身份。** 这是 task-9 的核心交付物。

---

## 5. 顺路两个小测（engineer-a 需要）

### 小测 1 ✅ `feed/rcmd` 是 `fetch`

拦截器在 `window.fetch` 上捕获到 → `via=fetch`。
（`XMLHttpRequest.prototype.open` 那条路径一次都没命中）

### 小测 2 ❌ Vue store 读不到

```json
{ "found": false, "reason": "no pinia state" }
```

细节：
- `window.__INITIAL_STATE__` → **`undefined`**
- `window.__pinia` → **`object`**，但 `window.__pinia.state` 是 **`null`**
- `document.querySelector('#app').__vue_app__` → **`object`**（Vue app 存在）

按 Lead 要求**"读不到就写读不到，不要硬挖 B 站内部状态"**，到此为止。

---

## 6. 未验证项

| 项 | 卡在哪 | 需要什么 |
| --- | --- | --- |
| **M1-a**（extension → 换一换是取流账号的） | 切不到 `extension` | ① 修好身份胶囊（见 §4）；或 ② 从 background SW console 发 `streaming/set` |
| **M1-b 的确证** | 不知道当前配置是不是 `page` | 同上的读配置能力 |
| **取流账号的 mid** | 面板只显示 uname | `account/summary` 消息（扩展 context） |

---

## 7. 复现

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;" + $env:PATH
bsk session start --no-focus --json
bsk navigate --session <sid> "https://www.bilibili.com/"

# 读面板（穿透 closed shadow）
bsk click --session <sid> --tab-id <tab> --selector "#pluma-panel-host"
bsk snapshot --session <sid> --tab-id <tab> --json > s.json   # 注意 UTF-16LE

# rcmd 的 data.mid
node poc/probe/feed-cover/probe-dnr-identity.mjs --session <sid> --tab <tab>

# 换一换 + via
node poc/probe/feed-cover/probe-m1-bidir.mjs --session <sid> --tab <tab> --phase baseline
```

⚠️ 我创建的所有文件都在 `poc/probe/feed-cover/`，**没有修改任何用户设置**（本来也没切成）。

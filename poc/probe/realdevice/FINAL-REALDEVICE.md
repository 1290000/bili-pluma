# 真机验证报告 · FINAL-REALDEVICE

> 验证者：**verifier**（独立执行，**不采信 engineer-a 的既有结果**）
> 时间：2026-11-11 19:38–20:00 · 环境：Edge 157 / bsk 0.3.3 / 用户日常 profile
> 页面：`www.bilibili.com` 首页 + `/video/BV1t5WV6CEVL` + `/bangumi/play/ep3854818`

---

## §0 结论先行

| 项 | 结果 |
|---|---|
| ① 跑的是新代码 | ✅ **实测**（替代判据，见 §1） |
| ② 面板开关 | ✅ **实测**：存在、可点、与胶囊分开 |
| ③ 打开后四项 | ✅ **实测**：`visibleA=0` / `visibleB=11` / `top=255` / **零留白** |
| ④ 关闭后恢复 | ✅ **实测**：`visibleA=6`，hideStyle 移除 |
| ⑤ **`data.mid`** | ✅ **实测：`{{取流账号mid}}` = 取流账号** ← **功能实质成立** |
| M2 `page` 模式画质区 | ✅ **实测**：「无需代理」+ 正确归因 |
| M3 番剧完整集 | ✅ **实测**：`duration=1167`、`3840×2160`、无 `skip-no-rewrite-gate` |
| 恢复原值 | ✅ 开关关闭、取流身份回 `extension` |

**这个功能实质成立。** 详见 §4 的决定性证据。

---

## §1 ① 先确认跑的是新代码

### 1.1 `pluma:build-proof` 读不到 —— **原因已独立核实**

| 项 | `bsk evaluate` 直读 | 结论 |
|---|---|---|
| `pluma:build-proof` 经 content 桥读取 | **两次 15s 超时** | 读不到 |

**根因（我独立核实，不是采信 engineer-a 的说法）**：

1. 产物 `.output/chrome-mv3` 时间 **19:27:52**，`content.js` **确实含** `pluma:build-proof` 字符串
2. 但 **`snapshot` 桥定义在 `entrypoints/content.ts`**，而该文件的 `matches` 只有
   `*://*.bilibili.com/video/*` 与 `*://*.bilibili.com/bangumi/play/*`
   —— **首页根本不注入 content.ts**
3. **∴ 桥在首页永远超时，与 build-proof 无关，是设计使然**

> ⚠️ **这修正了 Lead 传达的一个说法**。engineer-a 说"两次 15s 超时因为 19:11 那份没有读取
> build-proof 的代码"——**证据不全**。即使有那行代码，**首页也调不到桥**，因为
> `content.ts` 不在首页注入。**真正原因至少有两个，他只说了一个。**
>
> **验证**：在**视频页**同一段桥代码 **133ms 就通了**（§4 M2），**证明桥本身是好的**。

### 1.2 替代判据（实测生效）

面板的 hint 文本 = **19:11 构建独有的字符串**：

```
首页推荐流使用取流账号 打开后，首页推荐流（含首屏）全部换成取流账号的推荐：
首屏那批会被隐藏，滚动加载的改用取流账号。与上面的取流身份是两个独立设置
```

- ✅ 含「**含首屏**」——那是 19:11 修正版才有的措辞（旧版写「首屏仍是当前账号」）
- ✅ 产物 `content-panel.js` 含「含首屏」；**不含**「首屏仍是当前账号」（我独立 grep 验证）
- ✅ 面板无障碍树里**实际渲染**出了这段文字

**∴ 浏览器跑的是新代码。用替代判据 + 原因已记录。**

---

## §2 ② 面板开关（实测）

来源：`bsk snapshot` 无障碍树，账号 Tab

| 检查 | 结果 |
|---|---|
| 开关存在 | ✅ `checkbox "首页推荐流使用取流账号…"` |
| 可点性 | ✅ `[unchecked]` 且无 `disabled` |
| 与胶囊分开 | ✅ 顺序为：账号卡（`主 {{主账号昵称}} … LV6`）→ 胶囊 `button "取流：扩展账号"` → 分隔线 → 推荐流开关 |
| hint 完整 | ✅ 含「含首屏」「首屏那批会被隐藏」「两个独立设置」 |

**实测点击**：`click ok target=@e135`，状态从 `[unchecked]` → `[checked]`。

---

## §3 ③ 打开开关 → 四项核心指标（实测）

**注意口径**：量的是 `visible`（`getBoundingClientRect` 且 `height>0 && width>0 && 在视口内`），
**不是 `dom` 数量**。`domA` 恒为 10（元素还在，只是 `display:none`）。

| 指标 | **基线（开关关）** | **开关开** | 期望 | 判定 |
|---|---|---|---|---|
| `domA` | 10 | 10 | — | 元素仍在（预期） |
| **`visibleA`** | **6** | **0** | 0 | ✅ **一张不剩** |
| **`visibleB`** | 11 | **11** | 补满 | ✅ |
| **第一张可见卡 `top`** | 255 | **255** | 255 | ✅ **零留白** |
| `bannerTop` | — | **255** | 未塌 | ✅ |
| `hideStylePresent` | false | **true** | — | ✅ |

注入的 CSS 实测为：`.feed-card { display: none !important; }`

> **`top=255` 是最关键的一项**：它说明 B 批（取流账号的卡）**顶到了顶栏正下方**，
> **没有留下任何空白**。这是用户最在意的那条。

---

## §4 ⭐⑤ 决定性证据：`data.mid` = 取流账号

### 4.1 方法（与 Lead 指定的一致）

1. 打开开关（已确认 `visibleA=0`）
2. Hook `window.fetch`（XHR 零命中，只挂 fetch）
3. 点「换一换」（无障碍树 `button "换一换"`）
4. 读 `feed/rcmd` 响应的 `data.mid`

### 4.2 原始捕获（未经修饰）

```json
{
  "url": "//api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&y_num=4&fresh_type=3&feed_version=V8&fre...",
  "mid": {{取流账号mid}},
  "code": 0
}
```

### 4.3 判定

| 值 | |
|---|---|
| 捕获的 `data.mid` | **`{{取流账号mid}}`** |
| 取流账号 mid（Lead 给定） | **`{{取流账号mid}}`** |
| **一致？** | ✅ **完全一致** |

**∴ `feed/rcmd` 这条请求确实带着取流账号的 Cookie 发出去了，返回的推荐确实是取流账号的。**

**这排除了最危险的那个替代解释**：如果只是"藏掉自己的 A、露出自己的 B"，
那么 `feed/rcmd` 的 `data.mid` 会等于**页面账号**的 mid。**实测它等于取流账号 —— 功能实质成立。**

---

## §5 ④ 反向：关闭开关 → 恢复（实测）

| 指标 | 关闭后 | 与基线一致？ |
|---|---|---|
| `visibleA` | **6** | ✅（基线 6） |
| `visibleB` | 11 | ✅ |
| `firstVisibleTop` | 255 | ✅ |
| `hideStylePresent` | **false** | ✅ 样式已移除 |

**完全恢复原样。**

---

## §6 M2：`page` 模式下画质区（实测）

**步骤**：点胶囊 `取流：扩展账号` → `取流：浏览器账号` → 打开视频页 `/video/BV1t5WV6CEVL/`

**桥返回**（133ms）：

```json
{ "streamingProbe": { "fromMessage": "page", "fromStorage": "page",
  "messageElapsedMs": 1, "rawShape": "{\"type\":\"streaming/status:ok\",\"identity\":\"page\"}" } }
```

**画质 Tab 无障碍树**：

```
StaticText "无需代理"
StaticText "取流身份与页面身份相同，无对比基线"
[ctx: 无需代理 当前用浏览器账号取流，未使用取流账号 无法对比 取流身份与页面身份相同，无对比基线 1080P ...]
```

| 检查 | 期望 | 结果 |
|---|---|---|
| pill | 「无需代理」**不是**「已接管」 | ✅ **通过** |
| 归因 | 「当前用浏览器账号取流，未使用取流账号」 | ✅ **准确** |
| 消息通道 | `fromMessage === fromStorage` | ✅ 都是 `page` |

### ⚠️ 但发现一处**文案不自洽**（🟡，非本轮引入）

`page` 模式下画质区同时出现：

- pill：**「无需代理」** ← 这是 `page-identity` 的话术
- 对比行：**「取流身份与页面身份相同，无对比基线」** ← **这是 `same` 的话术**

**「当前用浏览器账号取流」和「取流身份与页面身份相同」是两件不同的事**：
前者是用户**选择**，后者是**事实**（两个 mid 恰好相同）。

用户看到这两句并存会困惑：**"我是自己选的浏览器账号，为什么说身份相同？"**

**根因**（读码）：`summary-view.ts:202` 的判据是
`if (view.primary.reason === 'same-identity') return '取流身份与页面身份相同，无对比基线'`，
而 `page-state.ts` 的 `SAME_IDENTITY_REASONS = ['self', 'page-identity']` —— 
**两个 reason 都会产出 `same-identity`**，于是共用同一句话术。

> 这正是我在上一轮终验里报的 `self` vs `page-identity`「成因不同」的**界面落点遗漏**：
> 数据和状态判断都对了（清缓存相反也做对了），**但对比行的话术没有分支**。

**建议**：`page-identity` 时用「当前用浏览器账号取流，无对比基线」，
与 pill 的「无需代理」语义连贯。**不影响功能，属文案精度问题。**

---

## §7 M3：番剧页完整集（实测）

**页面**：`/bangumi/play/ep3854818`（取流身份已恢复 `extension`）

```json
{
  "mainWorldStage": "cfg-with-cache",
  "orchestrateExit": "cache-hadsync-no-reload",
  "duration": 1167,
  "videoW": 3840, "videoH": 2160,
  "streamingProbe": { "fromMessage": "extension", "fromStorage": "extension" }
}
```

| 检查 | 期望 | 结果 |
|---|---|---|
| `duration` | 完整集（非 180 秒试看） | ✅ **1167 秒** |
| 分辨率 | 4K | ✅ **3840×2160** |
| `mainWorldStage` | **不含** `skip-no-rewrite-gate` | ✅ `cfg-with-cache` |
| 取流身份 | `extension` | ✅ |

**这是删掉第零道 PGC 门控后的直接验证**：`mainWorldStage` 没有出现
`skip-no-rewrite-gate`，注入正常发生，`duration=1167` 证明**没有退回试看**。

---

## §8 恢复原值（实测）

| 项 | 操作前 | 操作后 | 一致？ |
|---|---|---|---|
| 推荐流开关 | 关（`unchecked`） | **关**（`hideStylePresent:false`） | ✅ |
| 取流身份 | `extension` | **`extension`**（胶囊 `取流：扩展账号`） | ✅ |

---

## §9 我发现的三处问题（都不阻塞，但都要记录）

### 🟡-1 `page` 模式画质区话术不自洽（§6）

「无需代理」+「取流身份与页面身份相同，无对比基线」并存，两句说的是不同的成因。
**建议**：`page-identity` 单独话术。**非本轮引入**（`SAME_IDENTITY_REASONS` 合并是 task-10 的产物）。

### 🟡-2 `snapshot` 桥在首页不可用（§1.1）

**不是 bug，是设计**（`content.ts` 不在首页注入）。但**这意味着所有"首页状态"都只能靠
面板/无障碍树读，不能靠桥**。engineer-a 把首页桥超时归因为"旧代码没读 build-proof"，
**证据不全**——即使代码里有，首页也调不到。**建议在 `docs/guides/bsk-page-bridges.md` 记一句。**

### 🟢-3 一个好消息

**桥在视频页 133ms 就通**，且 `streamingProbe` 显示 `fromMessage === fromStorage`。
说明**上一轮那个「`streaming/status` 运行时收到 `undefined`」的问题（6 行表第 6 条）确实修好了** ——
这是独立于 engineer 自报的实测证据。

---

## §10 未能验证 / 边界说明

| 项 | 状态 | 原因 |
|---|---|---|
| `pluma:build-proof` | **未读到** | 首页无 content.ts 桥（§1.1），已用替代判据 |
| 首屏 SSR 批大小在游客态 | 未测 | 需清 cookie，硬红线 |
| 换一换后的曝光上报 | 未测 | ADR 0035 已标"未预测" |
| 移动端 / 窄视口 | 未测 | 仅桌面 1130×1080 |

---

## §11 一句话

**功能实质成立，可以交付。** 决定性证据是 `feed/rcmd` 的 `data.mid = {{取流账号mid}}`
—— 与取流账号完全一致，证明换来的推荐**真的是取流账号的**，不是"藏自己的、露自己的"。

两处 🟡（画质区话术、桥的可用范围）都是文案/文档精度问题，不影响功能。

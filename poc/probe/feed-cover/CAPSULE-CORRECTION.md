# 重大更正：胶囊**一直在渲染**，只是文案是「取流身份：未知」

> **日期**：2026-11-11
> **触发**：Lead 指出项目已有 `postMessage` 桥（`docs/guides/bsk-page-bridges.md` + `poc/probe/popup-inspect.mjs`），
> 用它从 content script 侧取到了真实数据。**我之前的 "missing control" 分类是错的。**

---

## 0. 更正

| 项 | 我之前说 | 实际 |
| --- | --- | --- |
| 分类 | **missing control**（控件不在任何 Tab） | ❌ **错**。控件**在**，只是文案是 `取流身份：未知` |
| 检测字符串 | 只搜 `取流：扩展账号` / `取流：浏览器账号` | ❌ **漏了第三种状态** `取流身份：未知` |
| 结论 | "task-9 的核心交付物等于没做" | ❌ **错**。交付了，且**未知态渲染正是步骤 4 的设计** |

### 我错在哪

`tabs.ts:551-559` 的表格写得很清楚：

```
| 值           | 胶囊              | 可点 |
| 'extension'  | 「取流：扩展账号」 | ✅  |
| 'page'       | 「取流：浏览器账号」| ✅  |
| null         | 「取流身份：未知」  | ❌  |
```

**我只盯着前两行搜字符串**，第三行的文案是 `取流身份：未知`（**没有"："在"取流"后面**），
所以我的 `/取流：/` 正则**结构性漏检**。

而且 `tabs.ts:536-547` 的注释里明确写了这个设计：
> 「不渲染任何默认值」是**内容**规则 —— 但它**不是**删掉入口的许可。
> **控件消失不是安全默认值，而是隐形 bug。**

**这正是我上一轮当作"教科书案例"引用的话 —— 而它已经被实现了。我引用了注释，却没验证注释描述的行为是否已生效。**

---

## 1. 实测证据（postMessage 桥，纯自动化，无人工）

### 1.1 方法

照 `docs/guides/bsk-page-bridges.md` §2 的 `snapshot` 桥，**async IIFE + 内部 await 再 stringify**：

```js
(async () => {
  const snap = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('snapshot-reply 超时')), 5000);
    const h = (e) => {
      if (e.data?.__ns === '__PLUMA__' && e.data.type === 'snapshot-reply') {
        clearTimeout(t); window.removeEventListener('message', h);
        resolve({ snapshot: e.data.snapshot });
      }
    };
    window.addEventListener('message', h);
    window.postMessage({ __ns: '__PLUMA__', type: 'snapshot' }, '*');
  });
  return JSON.stringify({ ok: true, ...snap });
})()
```

⚠️ **前提**：`snapshot` 桥在 `entrypoints/content.ts`，其 `matches` 只有
`*/video/*` 和 `*/bangumi/play/*` → **首页没有这条桥，只有视频页有**。
（我第一次在首页跑，`snapshot-reply 超时`，就是这个原因。）

### 1.2 视频页的桥返回（原始 JSON）

```json
{
  "view": {"state":"active","pill":"已接管","tone":"good","needsLogin":false},
  "primary": {"uname":"{{主账号昵称}}","level":6,"loggedIn":"yes","source":"live"},
  "playbackAccount": {
    "uname":"{{取流账号昵称}}",
    "mid":{{取流账号mid}},
    "vipLabel":"annual",
    "expireAt":1811520000000,
    "healthy":true
  },
  "unlock": {"title":"已解锁","badges":["杜比视界","4K","60fps","Hi-Res"],"anchor":"主账号仅可用 1080P"},
  "page": {"kind":"play","pageKey":"BV1jt421t7XH","p":1},
  "proxy": {"enabled":true,"hasCredential":true,"ruleCount":3}
}
```

### 1.3 视频页账号 Tab 的辅助功能树（原文）

```
StaticText "Pluma"
  button "收起面板"
  navigation
    tab "画质"  tab "净化"  tab "显示"  tab "账号"
StaticText "主"
StaticText "{{主账号昵称}}"
StaticText "收藏 · 点赞 · 评论 · 历史"
StaticText "LV6"
StaticText "播"
StaticText "{{取流账号昵称}}"
StaticText "仅取流 · 6 个月后到期"
StaticText "21 小时前校验"
StaticText "年度大会员"
StaticText "取流身份：未知"        ← ★ 胶囊在这里
button "重新登录"
button "退出取流账号"
```

**`取流身份：未知` 就是那个胶囊。**

---

## 2. 现在能确定的事

### 2.1 控件存在，但处于未知态 → **真正的分类是 missing data**

按 skill 的分类表：

| Class | 判据 | 本次 |
| --- | --- | --- |
| wrong label | 控件在，文案与健康数据不符 | ⚠️ 接近，但 `未知` 是**合法的未知态** |
| missing control | 控件不在任何 Tab | ❌ **不成立**（控件在） |
| missing input | 控件在但点不动 | ❌ 未知态**设计上**就不可点（`tabs.ts:557`） |
| **missing data** | **有状态显示但派生值全空** | ✅ **成立**：`streamingIdentity` 恒为 `null` |

### 2.2 background 侧**是好的**（这是关键新证据）

`snapshot` 桥拿到的 `proxy.enabled: true` / `ruleCount: 3` / `playbackAccount.healthy: true`
**全部来自 background 的 `proxy/status` 与 `account/summary`**，且视频页上 `pill: 已接管`。

→ **content script ↔ background 的消息通道整体健康**。
→ **DNR 规则装着 3 条**，代理正在生效。
→ **取流账号 mid = {{取流账号mid}}**（之前一直没拿到，现在有了）。

### 2.3 所以问题精确定位在：`streaming/status` 这一条消息，或它的首读时机

这是本轮**第一个真正收敛的结论**：

```
background 通道正常（proxy/status ✓、account/summary ✓）
                ↓
只有 streaming/status 的返回值让 streamingIdentityCache = null
                ↓
tabs.ts:563  known = false → 渲染「取流身份：未知」
```

---

## 3. 下一步（给 engineer-a 的精确靶子）

原来怀疑的"控件没渲染"**不成立**。真正要查的是 `streamingIdentityCache` 为什么是 `null`。

最小验证（我可以做，不需要人）：

**在同一个视频页，用 `snapshot` 桥的同一机制，看能否触发一次 `streaming/status`。**
但 `snapshot` 桥只应答 `page/snapshot:get`，**不含 `streaming/status`**。

所以要么：
- **A**：让 engineer-a 给 `content-panel.content.ts:361-362` 加一行 `console.log`，重新构建后我在 `bsk console` 读
  —— 但 ISOLATED console 不进页面 console，**这条路 bsk 读不到**
- **B**：让 engineer-a 把 `streamingIdentity` 加进 `page/snapshot:ok` 快照（一行字段），我就能用现有桥读到
  —— **推荐**：不新增通道，复用已有的桥，且对生产零影响（`page-snapshot.ts` 已有 `streamingIdentity` 字段可选）
- **C**：我直接对比**首页 vs 视频页**的面板状态 —— 若视频页也显示「取流身份：未知」，说明与页面类型无关

**我先做 C（不需要改代码）。**

---

## 4. 我要记的教训（这次是我自己的错）

| # | 错误 | 具体 |
| --- | --- | --- |
| 1 | **只搜两种字符串，漏了第三种状态** | 搜 `取流：扩展账号` / `取流：浏览器账号`，漏了 `取流身份：未知` |
| 2 | **引用了注释，没验证注释描述的行为** | 把 `tabs.ts:536-547` 那段"控件消失是隐形 bug"当成"未实现的教训"，实际它已实现 |
| 3 | **没先查 `docs/guides/` 和 `poc/probe/`** | 项目早有 `popup-inspect.mjs` + `bsk-page-bridges.md`，我却说"bsk 进不去，只能人工" |
| 4 | **把活推给用户** | 让用户开 DevTools console —— 那是我们的活 |

**共同点**：**在"我以为的限制"上停住了，而不是先确认那个限制是否真的存在。**
（这与 Lead 记的"拿机制的名字推断运行时语义"是同一类。）

---

## 附：脚本

| 文件 | 内容 |
| --- | --- |
| `probe-bridge.mjs` | 照 `bsk-page-bridges.md` 的 postMessage 桥读快照 |
| `probe-capsule-videopage.mjs` | 视频页面板的辅助功能树 + 胶囊检测 |

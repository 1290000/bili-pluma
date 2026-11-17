# 搜索页无 Pluma 贴边条 —— 只读实测报告

- 调查人：probe-sidebar-search
- 环境：本机 bsk 0.5.0（`/c/Users/i1290/.local/bin/bsk`，未升级） + 已连接 Edge 157（session `mylo`，Agent Window `1673242201`）
- 边界：未改 `src/`、未改测试、未改守卫、未 commit；仅在 `poc/probe/sidebar-search/` 留报告与证据图
- 取证方式：首页真实搜索框输入 `Pluma侧栏探针` → 点击搜索按钮；另直接访问 `www.bilibili.com/search?keyword=...`；对照页为 `https://www.bilibili.com/`
- 截图（同目录）：`search-page.png`（无贴边条）、`home-page.png`（有贴边条）

---

## 一句话根因

**搜索页最终落在 `search.bilibili.com`，而 `entrypoints/content-panel.content.ts:157` 的 `matches` 与构建产物 manifest 都只有 `www.bilibili.com` / `live.bilibili.com`，Chrome 根本没把 content-panel 注入这个文档，`paint() → ensurePanelHost() → mountSidebar()` 从未执行，所以宿主 `#pluma-panel-host` 不存在（不是被盖住、不是定位到屏幕外、也不是 SPA 时序）。**

---

## 1. 搜索页实际 URL 是什么？

**实测：是 `search.bilibili.com/all`，不是 `www.bilibili.com/search`。两条入口路径最终都落到 search 子域。**

路径 A —— 首页搜索框真实操作：

1. 在 `https://www.bilibili.com/` 的 `#nav-searchform input.nav-search-input` 填入 `Pluma侧栏探针`，点击 `#nav-searchform .nav-search-btn`。
2. 提交**没有在原 tab（1673242202）导航**，而是在 Agent Window 新开了 tab：`1673242203` / `1673242204`。tab 列表实测：

   ```
   tab 1673242202  https://www.bilibili.com/                         scope=agent  (原页未变)
   tab 1673242204  https://search.bilibili.com/all?keyword=Pluma侧栏探针&from_source=web_search&spm_id_from=333.1007&search_source=5  scope=agent
   ```

3. 在 tab `1673242204` 上 `location.href` / `location.hostname` 实测：

   ```json
   {
     "href": "https://search.bilibili.com/all?keyword=Pluma%E4%BE%A7%E6%A0%8F%E6%8E%A2%E9%92%88&from_source=web_search&spm_id_from=333.1007&search_source=5",
     "hostname": "search.bilibili.com",
     "referrer": "https://www.bilibili.com/"
   }
   ```

路径 B —— 直接访问 `www.bilibili.com/search?keyword=...`（新 tab `1673242207`）实测最终地址：

```json
{
  "href": "https://search.bilibili.com/all?keyword=Pluma%E4%BE%A7%E6%A0%8F%E6%8E%A2%E9%92%88",
  "hostname": "search.bilibili.com"
}
```

即用户描述的两种写法，最终文档**都是 `search.bilibili.com` 域**。本机另一条用户 tab 也印证：`https://search.bilibili.com/all?vt=...&keyword=年年对对&...`（`from_source=webhistory_search`）。

---

## 2. content script 有没有注入？

**实测：没有注入。`#pluma-panel-host` 不存在，且 Pluma 的 body 标记也不存在。**

### 2.1 宿主 id

`src/content/panel/host.ts:34` → `const HOST_ID = 'pluma-panel-host'`。

搜索页 tab `1673242204` 实测：

```json
{ "hostPresent": false, "hostname": "search.bilibili.com", "readyState": "complete", "hasBody": true }
```

### 2.2 `__PLUMA_*` 全局（此项不具判别力，如实记录）

搜索页 `Object.keys(window).filter(k => /pluma/i.test(k))` → `[]`。
**但首页（贴边条正常显示）同样是 `[]`**。原因：content script 跑在 isolated world，主世界看不到它的 `window` 属性；源码里的 `__PLUMA__` 是 `panel-data.ts:658` 的 `postMessage` 命名空间，不是挂到 `window` 的全局。所以这项不能单独证明"未注入"，只能证明"主世界没有可见全局"。

### 2.3 有判别力的注入证据：body 类名

`src/content/site-clean/body-classes.ts:42` 定义 `modeHide: 'pluma-clean-mode-hide'`，由 `applyBodyClasses()`（content script）写入 `<body>`。实测：

| 页面 | `document.body.className` | 结论 |
| --- | --- | --- |
| 首页 `www.bilibili.com/`（tab 1673242202） | `"pluma-clean-mode-hide win"` | Pluma content script **跑过** |
| 搜索页 `search.bilibili.com/all`（tab 1673242204） | `"win"` | Pluma content script **没跑** |
| `www/search` 跳转后的搜索页（tab 1673242207） | 宿主同样不存在 | 同上 |

### 2.4 manifest 静态证据

构建产物 `dist/smoke-1.3.0/manifest.json` 的 `content_scripts` 实测：

```json
[
  {"js":["content-scripts/content-feed-order.js"],"matches":["*://www.bilibili.com/*"]},
  {"js":["content-scripts/content-home.js"],     "matches":["*://www.bilibili.com/*"]},
  {"js":["content-scripts/content-live.js"],     "matches":["*://live.bilibili.com/*"]},
  {"js":["content-scripts/content-panel.js"],    "matches":["*://live.bilibili.com/*","*://www.bilibili.com/*"],"run_at":"document_idle"},
  {"js":["content-scripts/content.js"],          "matches":["*://*.bilibili.com/bangumi/play/*","*://*.bilibili.com/video/*"]},
  {"js":["content-scripts/main-hook.js"],        "matches":["*://*.bilibili.com/bangumi/play/*","*://*.bilibili.com/video/*"],"world":"MAIN"}
]
```

源码 `entrypoints/content-panel.content.ts:157` 与产物一致，**没有任何 `search.bilibili.com` 模式**。chat 里提到的 `host_permissions: ['*://*.bilibili.com/*']` 覆盖 search 域，但那是 fetch/cookie 权限，**不等于 content script 注入权限**。

### 2.5 控制台

搜索页 `bsk console`（tab 1673242204，limit 100）全部 6 条：

- `[GD Media] attribution started in frame ...` ×2，来源 `chrome-extension://ffdegaeaoghhddelmdbhhipcmpnaodlk/content-script.js` —— 这是 bsk 伴侣扩展的日志；仓库内 grep `GD Media` / `attribution started` 无命中，**不是 Pluma**，首页同样有。
- `bili-fe-mirror v2.1.0`、`白屏检测是否正常`、`Images loaded lazily...`（Edge 自身）、`Deprecated API for given entry type.`（B站脚本）。
- **没有任何 Pluma 报错，也没有 `ensurePanelHost` 的 tokens 空值抛错**——因为代码根本没执行。

---

## 3. 宿主的几何 / 计算样式 / 命中栈（搜索页 N/A；对照组正常）

搜索页宿主不存在，`getBoundingClientRect()` / `getComputedStyle()` / `elementFromPoint` 无从取。对照组首页（tab 1673242202）实测：

```json
{
  "hostPresent": true,
  "parentTag": "BODY",
  "rect": {"x": 0, "y": 503.55, "w": 8.90625, "h": 73.80681610107422},
  "style": {
    "position": "fixed", "left": "0px", "top": "540.455px",
    "transform": "matrix(1, 0, 0, 1, 0, -36.9034)",
    "zIndex": "2147483647", "display": "block",
    "visibility": "visible", "pointerEvents": "none"
  },
  "hit": {"at": {"x":4,"y":541}, "tag":"DIV", "id":"pluma-panel-host", "isHost": true},
  "stackTop3": ["#pluma-panel-host", "main.bili-feed4-layout", "div.bili-feed4"]
}
```

`hasShadow:false` / `childNodes:0` 是因为 `attachShadow({mode:'closed'})`，主世界看不到，属预期。

**结论：在正常页上宿主位于视口内、命中栈最顶层，没有被页面元素盖住，也没有跑出屏幕。搜索页的问题是宿主压根没被创建，因此"被盖住 / 定位到屏幕外 / z-index 太低"全部排除。**

视觉对照：`search-page.png` 左边缘中段空白；`home-page.png` 左边缘中段可见那条 8px 贴边条。

---

## 4. `paint()` 相关：开关初值与调用是否抛错

这一层在 isolated world，主世界无法直接读闭包变量，以下是**源码 + 可观测 DOM/控制台的交叉推断**，不是直接观测，明确标注：

- 源码初值：`entrypoints/content-panel.content.ts:164` → `let enabled = true`；`:992` → `enabled = await readPanelEntryEnabled()`；`src/platform/storage/ui-prefs-store.ts:53-57` → `await chrome.storage.local.get(...)` 后 `bag[key] !== false`，即默认开。
- 源码调用链：`:1013 paint()` → `ensurePanelHost(...)`（`:881`）→ build 回调里 `mountSidebar(...)`（`:953`）。
- 首页实测宿主存在，说明这条链在 `www` 页上完整跑通、`enabled` 解析为 `true`、`ensurePanelHost` 被调用、没有抛错（控制台无 Pluma error）。
- 搜索页实测宿主不存在 + body 无 Pluma 类名 + 无 Pluma 控制台条目 ⇒ **不是 `enabled=false` 把它摘了，也不是 `mountSidebar` 抛错后残留半宿主**，而是 `main()` 整体没启动。
- 排除"开关被用户关掉"：若是开关关了，首页同样不会有宿主；但同一会话首页宿主在。

---

## 5. 导航形态：iframe / SPA 时序是否导致错过？

**实测：不是。** 三条证据：

1. **是跨文档、跨子域的真实导航，不是 www 域内 SPA。** 搜索页 `performance.getEntriesByType('navigation')` → `[{type:'navigate', redirectCount:0, duration:1827}]`，`document.referrer = https://www.bilibili.com/`。搜索按钮还**新开 tab**，原 tab URL 保持不动（见 §1）。
2. **iframe 与搜索结果无关。** 搜索页 `<iframe>` 共 3 个，src 分别为：
   - `https://message.bilibili.com/pages/nav/header_sync`（顶栏消息组件）
   - `https://s1.hdslb.com/bfs/seed/jinkela/short/leader-election/iframe.html?leaderID=watchlaterpipwindow`
   - `https://s1.hdslb.com/bfs/seed/jinkela/short/cols/iframe.html`

   没有承载搜索结果的 iframe；主文档自己就是搜索结果（截图中结果卡片都在主文档）。
3. **`www.bilibili.com/search?keyword=...` 也在文档级跳到 search 子域**（§1 路径 B），`readyState=complete` 时 hostname 已是 `search.bilibili.com`。Chrome 的 content script 按文档注入；即使过渡文档短暂匹配过 `www`，也不会跟着跨文档导航活到最终页 —— 而本例连最终页的匹配规则都没有。

所以不存在"时机错过但 DOM 后来才出来"的情形：页面早就 `complete`，宿主不在是**注入规则缺域**，不是注入后没赶上。

---

## 最小修复方向（仅方向，未改代码）

1. **主改一处**：`entrypoints/content-panel.content.ts:157` 的 `matches` 字面量数组增加一项 `'*://search.bilibili.com/*'`。必须继续写字面量（WXT 静态分析要求，见该文件注释），不要用常量。
2. **必须同步一处守卫**：`scripts/check-page-gate.mjs` 的 `NON_PLAY_PAGE_ENTRIES` 中 `entrypoints/content-panel.content.ts` 的 `requires` 目前登记为 `['*://www.bilibili.com/*', '*://live.bilibili.com/*']`。规则 2c-2 会把任何"未登记的域"判为注入面扩大并报错；新增 search 域后须把该域补进 `requires` 并写明理由（例如"面板要在搜索页也能唤起"），否则 `pnpm check:page-gate` 会红。注意 `onlyMatch:false` 已经允许多项，不需改。
3. **无需改 host 权限**：`wxt.config.ts` 的 `host_permissions` 已含 `'*://*.bilibili.com/*'`，覆盖 `search.bilibili.com`。
4. **重打包并重新加载扩展**：`dist/smoke-1.3.0/manifest.json` 等产物需重新生成；用户侧必须重载扩展后新页面才注入（已打开的搜索页不会回溯注入）。
5. **验收判据**：在 `search.bilibili.com/all?keyword=...` 上 `document.getElementById('pluma-panel-host')` 非空，且 `document.elementFromPoint(4, innerHeight/2).id === 'pluma-panel-host'`；同时首页 / 直播页回归不退化。

备选（不推荐）：把 `matches` 改成 `*://*.bilibili.com/*` 一次性覆盖所有子域 —— 守卫会按"未登记域"拦截，且把面板注入面扩大到 space / message / api 等无关子域，不符合当前"精确登记每个域"的治理口径。

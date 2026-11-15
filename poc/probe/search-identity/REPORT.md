# 搜索结果的账号归属 —— 真机取证（2026-11-11）

> **用户问题**：如果开启了「首页推荐流使用取流账号」，在搜索框内输入内容搜索后，
> 搜索出来的结果视频卡片是用的哪个账号的？
>
> **结论：浏览器账号（页面身份）。推荐流开关对搜索结果没有任何影响。**
>
> 环境：Edge 157 · bsk 0.3.3 · 真实登录态 · 2026-11-11 22:5x
> 取证方式：`bsk evaluate` 在真实页面上下文只读探测（包装脚本 `bsk-eval.mjs`）。

---

## 结论速览

| 问题 | 答案 | 依据等级 |
| --- | --- | --- |
| **Q1** 搜索请求的身份 | **浏览器账号**（页面自身 cookie，DNR 不介入） | **实测**（白名单不覆盖，见 §2） |
| **Q2** 搜索页有无推荐块 | **无**。一次搜索会话里 12 个 API，**0 个** feed/rcmd/recommend | **实测**（§3） |
| **Q3** 开关开/关是否影响搜索 | **不影响** | **实测 + 代码证明**（§2/§4） |

---

## 1. 搜索走哪个接口（实测抓到的）

`XMLHttpRequest.open` + `fetch` 双 hook，触发一次真实搜索后：

```
GET https://api.bilibili.com/x/web-interface/wbi/search/all/v2?__refresh__=true&...&page=1&page_size=42&...
GET https://api.bilibili.com/x/relation/relations?fids=385279051&...    ← 关注状态（不在白名单）
```

**主搜索接口：`/x/web-interface/wbi/search/all/v2`**

搜索页整轮加载（含首屏 + 一次翻页触发）一共 12 个 `api.bilibili.com` 请求：

```
/x/kv-frontend/namespace/data
/x/web-interface/nav
/x/web-interface/suggest
/x/web-interface/wbi/search/default
/x/web-interface/dynamic/entrance
/x/vip/ads/materials
/x/web-show/wbi/res/locs
/x/web-interface/wbi/search/all/v2
```

**没有任何 `feed` / `rcmd` / `recommend` / `guess` 类接口。**（见 §3）

---

## 2. 白名单不覆盖搜索 —— **代码证明，不是推理**

`src/shared/constants/routes.ts` 当前 `enabled: true` 的路径（`ROUTES_REVISION = 4`）：

```json
[
  "/x/player/wbi/playurl",
  "/x/player/playurl",
  "/pgc/player/web/playurl",
  "/x/web-interface/wbi/index/top/feed/rcmd"
]
```

用 `isProxyPath()` 的**同一个判据**（`===` 或 `startsWith(path + '/')`）逐条测：

| 路径 | 命中白名单？ |
| --- | --- |
| `/x/web-interface/wbi/search/all/v2` | **不命中** |
| `/x/web-interface/wbi/search/type` | **不命中** |
| `/x/web-interface/wbi/search/default` | **不命中** |
| `/x/web-interface/wbi/search/suggest` | **不命中** |
| `/x/web-interface/search/all/v2`（旧版） | **不命中** |
| `/x/web-interface/wbi/index/top/feed/rcmd` | 命中（对照组，证明判据本身是活的） |
| `/x/player/wbi/playurl` | 命中（对照组） |

> **两个对照组是关键**：如果全部"不命中"，可能是判据写死了。
> 有命中项在，说明这条判据确实在区分路径 —— 所以"搜索不命中"是真结论。

**推论**：DNR 规则只对白名单路径 `set cookie`，搜索请求**不在其中** → 走浏览器自己的 cookie → **浏览器账号**。

---

## 3. 搜索响应里**没有**身份字段（实测）

直接 `fetch` 搜索接口，看响应顶层结构：

```json
{
  "code": 0,
  "topKeys": ["seid","page","pagesize","next","numResults","numPages",
              "suggest_keyword","rqt_type","exp_list","is_hit_web_inf","egg_hit","pageinfo"],
  "hasMid": false
}
```

**顶层没有 `mid`** —— 搜索结果是**公开数据**，不像 `feed/rcmd` 那样回显请求者身份。

> 所以「卡片属于哪个账号」**不能**靠响应里的 `mid` 判断（那个字段不存在）。
> 但这不是缺陷：搜索结果本身**与账号无关**，谁搜都一样（见 §4）。

---

## 4. Q3：开关开 / 关 — **搜索不受影响**

### 为什么不用"开/关各搜一次对比"作为主要判据

`pluma:feed-account-enabled` 的开关**只影响 `feed/rcmd` 这一个路径的 DNR 规则**，
而搜索路径根本不在白名单里（§2 实测）。**两者在规则层面不相交** ——
所以"开/关各搜一次结果相同"是**结构性保证**，不是需要采样的巧合。

### 已有的实测支撑

- 搜索页 12 个 API 请求里 **0 个** feed/rcmd（§1）
- 搜索接口不在白名单（§2）
- 搜索页**没有** Pluma 的任何宿主节点（只在 `www` / `live` 注入，`search.bilibili.com` 不在 `matches` 里）

### 仍然做了结果基线采样

```
搜索「猫」→ 页面内 a[href] 里含 BV 的共 84 个，去重 41 个
first8: BV1gfxpzaE9V, BV1k1421U7mh, BVWQBXKQBbQB, BV1gr4t6AEm9, ...
```

> ⚠️ **这一项只做了单次采样，没有做"拨开关后再搜"的对照** —— 见 §5「未验证」。

---

## 5. 未验证项（**不许写成"已验证"**）

| 项 | 状态 | 为什么没做 |
| --- | --- | --- |
| **拨开关前后各搜一次的 BV 对比** | ⚠️ **未做** | 开关在**面板（closed Shadow DOM）**里，`bsk evaluate` 读不到；`pluma:feed-account-enabled` 没有暴露页面桥。要拨只能人工点面板 |
| 搜索结果页的「相关推荐 / 猜你喜欢」卡片 | ⚠️ **未逐一确认** | §3 证明**没有 feed 类接口**被调用；若真有推荐块，其数据只能来自搜索结果本身（同一响应），仍不受开关影响 |
| 换账号（不同于当前登录的号）后搜索 | 未测 | 需双账号，本机只有一个 |

> **§5 第 1 条不影响结论**：结论的依据是"搜索路径不在白名单"（§2 代码证明 +
> §1 实测接口名），这是**结构性**的，不依赖开关的实际状态。

---

## 6. 给用户的回答（可直接转述）

> **搜索结果用的是你浏览器当前登录的账号，和「首页推荐流使用取流账号」这个开关无关。**
>
> 原因：那个开关只对**首页推荐流**（`/x/web-interface/wbi/index/top/feed/rcmd`）这一条接口生效，
> 而**搜索走的是另一条接口**（`/x/web-interface/wbi/search/all/v2`），它不在扩展的代理白名单里。
> 扩展没有动过那条请求，所以它就是浏览器自己的身份。
>
> 另外，搜索结果本身是**公开数据** —— 换不换账号，搜出来的内容是一样的。

---

## 7. 复现方式

```bash
# 1) 起 daemon（bsk 0.3.3）
bsk daemon start --foreground          # 后台任务

# 2) 起 session 并打开搜索页
bsk session start --no-focus --json    # → session_id
bsk navigate --session <sid> "https://search.bilibili.com/all?keyword=%E7%8C%AB"

# 3) 用 Node 包装脚本传表达式（**绕开 PowerShell 引号剥离**）
node poc/probe/bsk-eval.mjs <sid> <tabId> <expr.js>
```

**为什么必须用 Node 包装**：pwsh 直接写
`bsk evaluate ... "(async () => { ... })()"` 时，表达式里的括号/引号会被
PowerShell 参数解析吃掉，报 `unexpected argument '.map(a' found` 或
`SyntaxError: missing )`。`execFileSync('bsk', [..., expr])` 把表达式作为单元素 argv 传下去，
不经过 shell。**这是本项目第一个这类包装，后续真机探针都该用它。**

---

## 附：探针文件

| 文件 | 作用 |
| --- | --- |
| `bsk-eval.mjs` | `bsk evaluate` 的 Node 包装（绕开 pwsh 引号剥离） |

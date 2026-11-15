# M1 实测报告 · 换 Cookie 后「换一换」是否真变目标账号

> **日期**：2026-11-11
> **任务**：task-13 M1
> **环境**：bsk 0.3.3 / Edge 157 / 单账号 mid={{主账号mid}}（vip=0，非大会员）
> **纪律**：只读。不点视频、不发写请求、不登录登出、不打印凭据。

---

## 0. 结论先行

| 项 | 结果 | 证据等级 |
| --- | --- | --- |
| **本机是否存在第二个账号（取流账号）** | ❌ **没有找到**：Pluma 面板显示「**未生效**」，账号 Tab 无任何已配置账号 | **实测**（辅助功能树） |
| **M1 能否执行** | ❌ **不能**：M1 需要"浏览器 A + 扩展 B"两个账号，本机只有 1 个 | **实测** |
| **「换一换」本身是否有效** | ✅ 有效，但**只替换前 8–9 张**，后 15 张完全不动 | **实测** |

### 一句话

> **M1 无法验证 —— 本机没有第二个账号。** 面板明确显示「未生效」，说明取流代理当前没有接管任何请求。
> 但我在执行过程中**测到了「换一换」的真实行为**（只换前 8–9 张），这对 task-5 的分界线方案有直接价值。

---

## 1. 为什么无法做 M1（证据链）

### 1.1 Pluma 扩展在运行

DOM 实测存在：
```
pluma-panel-host / pluma-ad-clean / pluma-home-clean
body.className = "pluma-clean-preserve-event-banner pluma-clean-mode-hide win"
```

### 1.2 但面板状态是「未生效」

点开面板后，从**辅助功能树**（`bsk snapshot`，能穿透 closed Shadow DOM）读到：

```
StaticText "Pluma"
  button "收起面板"
  navigation
    tab "画质"   tab "净化"   tab "显示"   tab "账号"
StaticText "未生效"
LabelText "自动接管取流 只替换取流接口的身份，收藏 / 点赞 / 历史不受影响"
  button "自动接管取流 ..." [ctx: 未生效 ...]
  checkbox "自动接管取流 ..." [ctx: 未生效 ...] [checked] ="on"
```

- 开关是**开着的**（`checked`)
- 但状态是「**未生效**」
- 计数显示 **0**

**这与 ADR 0012 补充三的结论一致**：`ruleCount` 是本实例内存快照，但「未生效」不是 ruleCount 问题 ——
它是 `enabled: false` 或没有凭据的直接体现。

### 1.3 代码侧佐证：白名单里有 rcmd

```ts
// src/shared/constants/routes.ts
export const ROUTES_REVISION = 4;
// 4 → 2026-11-11 新增 /x/web-interface/wbi/index/top/feed/rcmd（首页推荐，ADR 0035）
```

白名单 8 条路径里包含 `/x/web-interface/wbi/index/top/feed/rcmd`。
**所以规则层面是支持的，问题在"没有第二个账号可供替换"。**

### 1.4 只有一个账号

```
/nav → {"code":0, "isLogin":true, "mid":{{主账号mid}}, "vip":0}
```

多次采样，`mid` 恒为 {{主账号mid}}。

---

## 2. 「换一换」的真实行为 —— 本轮意外测到的有用数据

### 2.1 实验方法

- 真实鼠标点击 `button.roll-btn`（**注意：不是外层 `div.feed-roll-btn`**，点那个无效 —— v1 踩过）
- 每次点击后等 5 秒
- 每次记录 DOM 里全部卡的 BV 序列
- 自装 fetch 拦截器统计 rcmd 请求次数

### 2.2 结果

| 轮次 | BV 数 | rcmd 请求累计 | 与上一轮共同 BV | 重合率 |
| --- | --- | --- | --- | --- |
| [0] 初始 | 23 | 0 | — | — |
| [1] 换一换 | 23 | 1 | 15 | 65.2% |
| [2] 换一换 | 24 | 2 | 15 | 63.8% |
| [3] 换一换 | 24 | 3 | 15 | 62.5% |

### 2.3 关键发现：**只换前 8–9 张，后面完全不动**

原始序列逐条比对（`[0]` → `[1]`）：

```
[0] BV11yWt6JEfL, BV1uWx16yENF, BV1AVJq6ZEni, BV15hxd6SEvW, BV1dUxC6UEf2,
    BV13MH56SEuG, BV1cyxi6gEDN, BV1TwnF6eEGt,
    BV1mdxq6SEcL, BV13XHN6ZEkn, BV1SCJt6LEM7, BV1EUx16tEcD, BV1x7xq62EmP, ...  (后 15 张)
[1] BV1VPxz6PEch, BV136nf6kE1H, BV1Kbnd6WEXi, BV1w34A62Eq2, BV1qxaP69Eha,
    BV1k44w62EPo, BV1z6pw6AEBD, BV1K2WT6tEU8,
    BV1mdxq6SEcL, BV13XHN6ZEkn, BV1SCJt6LEM7, BV1EUx16tEcD, BV1x7xq62EmP, ...  (后 15 张，完全一致)
```

**前 8 张全部换新，从第 9 张开始完全没变。**

一致性验证：`[1]`→`[2]`、`[2]`→`[3]` 都是同样模式（8 张换新 + 15 张不变，共同=15）。

### 2.4 这对 task-5 有直接影响

> **「换一换」只重刷首屏那 8 张，不动已加载的后续卡。**

结合 engineer-api 补测出的 DOM 类名分界（见 `RESULT.md` 附录 A）：

| 类名 | 数量 | 来源 |
| --- | --- | --- |
| `.feed-card` | 10 | 首屏 SSR 批（页面身份） |
| `.bili-feed-card` | 18+ | rcmd 加载的卡（取流账号身份） |

而 task-5 的分界线标的是「第 10 个 `.is-rcmd` 之后」。

⚠️ **如果用户在分界线附近点「换一换」，只有分界线**以上**的 8 张会变，
分界线以下的卡不动** —— 这可能导致分界线的语义变得不准：
- 换一换后，前 8 张变成"新的那批"
- 但分界线位置（第 10 个 is-rcmd）没动
- 若新的 8 张是扩展账号取的 → 分界线以下的反而是旧数据 → **分界线两侧的来源关系被打破**

**证据等级：推理，未实测**（需要在两个账号下才能验证"换一换用的是谁的 Cookie"）。

> ✅ **补充（Lead 2026-11-11 判断）**：这也解释了最初那个现象 ——
> 为什么首屏 10 张和 rcmd 的数据总对不上：**「换一换」刷新的是"翻页入口那一段"，不是整页**。

---

## 3. 我作废的实验（继续记录失败路径）

| 版本 | 做法 | 为什么无效 |
| --- | --- | --- |
| M1-v1 | `el.click()` 点外层 `div.feed-roll-btn` | **点错了元素**，Vue 监听在 `button.roll-btn` 上。重合率 100%（完全没变） |
| M1-evidence | 比「DOM 的 BV」vs「rcmd 带 Cookie 的 BV」vs「rcmd 无 Cookie 的 BV」 | **三组两两重合率全是 0.0%** —— 与 Q0 学到的同一个坑：**随机推荐接口，重合率不能当判据** |

**教训（与 Q0 同源，本轮第二次踩）**：
> **任何涉及推荐流的"差异"，都不能用"内容重合度"当证据 —— 必须先问"这个差异能不能被随机性解释"。**

---

## 4. 未验证项

| 项 | 卡在哪 | 需要什么 |
| --- | --- | --- |
| **M1 主问题**（换 Cookie 后换一换是否变目标账号） | 本机无第二个账号 | 浏览器登录 A + 扩展配置 B |
| 换一换用的 Cookie 是谁的 | 同上 | 同上 |
| 分界线在「换一换」后是否仍准确 | 需双账号 + 分界线已实现 | 同上 |

---

## 5. 复现

```powershell
$env:BSK_HOME = "C:\Users\i1290\.bsk"; $env:BSK_AUTO_START = "0"
$env:PATH = "C:\Users\i1290\.local\bin;" + $env:PATH
bsk session start --no-focus --json
bsk navigate --session <sid> "https://www.bilibili.com/"

# 点开面板 → 读状态（穿透 closed shadow）
bsk click --session <sid> --tab-id <tab> --selector "#pluma-panel-host"
bsk snapshot --session <sid> --tab-id <tab> --json > snap.json

# 换一换行为（真实鼠标点击）
node poc/probe/feed-cover/probe-m1-v2.mjs --session <sid> --tab <tab> --rounds 3
```

⚠️ `bsk snapshot` 的输出是 UTF-16LE，读的时候要判断 BOM。
**closed Shadow DOM 的内容只能通过辅助功能树读取**（`bsk snapshot`），`evaluate` 读不到。

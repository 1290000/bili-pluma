# PCDN 诊断方案 · 前置探针报告（2026-11-17）

脚本：`poc/probe/pcdn-diag/probe.mjs`　原始数据：`poc/probe/result-pcdn-diag.json`（已 gitignore）

一次跑完 Q1 / Q8 / Q9 / Q10。**下面每条结论都带证据，不是推断。**

---

## Q1 · isolated world 能不能读到页面的 resource 条目 → **能，实测通过**

**方法**：Edge + playwright-core 打开真实视频页并播放，然后用 CDP `Page.createIsolatedWorld`
造一个隔离世界，在里面注册 `PerformanceObserver({ type: 'resource', buffered: true })`，
再 seek 一次逼出新分片，等 3.5 秒收集。

**结果（两次独立运行一致）**：

| 项 | 第一次 | 第二次 |
| --- | --- | --- |
| `getEntriesByType` 命中数（seek 前） | 38 | 75 |
| seek 后 | 38 | **80** |
| observer 实际收到 | **38** | **80** |
| 采样 host | `cn-cq-gd-bcache-20/19/17` | `cn-jsnt-ct-01-06/01` |

**结论**：
1. 隔离世界**能**读到页面自己的媒体请求，`entry.name` 带完整 host → 「实际在用哪条线路」可行。
2. `buffered: true` **是必须的** —— 第一次运行时 observer 一次性收到了**已经发生过的全部 38 条**，
   不开就全丢。这条从猜测变成了实测。
3. 字段可用性同时确认（第二次样本）：`startTime` ✓ `duration` ✓ `responseEnd` ✓，
   `transferSize = 0`、`responseStart = 0` → 与先前结论一致，**画不出 TTFB / DNS / 字节数**。

⇒ 方案里的 `confidence` 默认档定为 **`measured`**。

---

## Q8 · 官方取流域到底有哪些 → 出现了一个没预料到的命名族

**方法**：抓 20 个热门视频的 playurl（匿名），展开每条流的 baseUrl + backupUrl，按 host 去重统计。

**结果**：20/20 视频成功，**84 个不同 host**，按出现次数：

| 分类 | 次数 | host 数 |
| --- | --- | --- |
| PCDN（mcdn / mountaintoys） | **339** | 68 |
| 官方 · `upos-*` | 192 | 8 |
| 官方 · 其它 | 9 | 8 |

**PCDN 占候选出现次数的 ~63%** —— 这个比例本身说明需求成立：B站 分给客户端的大多数线路是 PCDN。

**新发现的域名族（原方案漏了）**：

```
cn-cq-gd-bcache-19.bilivideo.com     ← 原先只测到这种
cn-sccd-ct-02-13.bilivideo.com       ← 四川成都·电信，**没有 bcache**
cn-jsnt-ct-01-06.bilivideo.com       ← 江苏南通·电信，**没有 bcache**
bvc.bilivideo.com                    ← 既非 cn- 也非 upos-
```

⇒ 官方自建的命名是 **`cn-<地区>-<运营商>-<节点>`**，`bcache` 只是一种节点类型。
原规则 `^cn-[a-z0-9-]+-bcache-\d+` 会把 `cn-sccd-*` / `cn-jsnt-*` 判成"认不出机型"，
**用户要的「（自建 CDN）」括号会大面积不显示**。正则已改（见 §影响）。

---

## Q9 · 播放中换到 mcdn 是"又发了一次 playurl"吗 → **不是**

**方法**：播放 40 秒，记录全部请求；单独统计 `/playurl` 与媒体 host 的首现顺序。

**结果**：

```
/playurl 请求次数：1（1440ms）
媒体 host 顺序：
  cn-jsnt-ct-01-06（官方）
  → cn-jsnt-ct-01-01（官方）
  → xy116x196x140x19xy.mcdn.bilivideo.cn:8082（PCDN）  ← 播放中途出现
  → bvc.bilivideo.com
```

**结论（这条改变了 §12.5 的判断）**：

播放器**在播放中途切到了 PCDN，但整个过程只发过一次 playurl**。
它用的只能是**手里已有的候选**（首次 playurl 下发的那份 baseUrl + backupUrl）。

⇒ **候选过滤能够覆盖中途切换** —— 因为被删掉的那条 PCDN URL 就不会存在它手里了。
原先担心的"播放器内部硬编码切换、我们管不到"，在本次实测里**没有发生**。

⚠️ 但引出一个**新的必须处理点**：既然第一次 playurl 之后就没有再请求，播放器手里的候选
也可能来自 **SSR 的 `__playinfo__`**（整页加载时写进 HTML 的那份，ADR 0014 已确认它存在）。
所以候选过滤**必须同时作用于 `__playinfo__` 与 playurl 响应两条来源**，只改 XHR 响应可能漏。

**局限**：本次是匿名 360p。高码率下 PCDN 分配比例更高（用户实测反馈），
所以"1 次 playurl"这个次数结论在 4K 场景**仍需真机复核**（登录态 + 4K）。

---

## Q10 · `cn-*` ↔ 自建 CDN 的对应 → **成立，但不是靠 `bcache` 认出来的**

20 个视频里出现的 `cn-*` host，前缀结构一致：`cn-<地区缩写>-<运营商>-<节点序号>`：

| 样本 | 解读 |
| --- | --- |
| `cn-cq-gd-bcache-19` | 重庆（cq）· 广东？/ 节点类型 bcache |
| `cn-sccd-ct-02-13` | 四川成都（sccd）· 电信（ct） |
| `cn-jsnt-ct-01-06` | 江苏南通（jsnt）· 电信（ct） |

⇒ `cn-` 前缀即可判定自建，**不需要识别节点类型**。

`bvc.bilivideo.com` 归到 `official` + `flavor: null`（认不出机型就不加括号）—— 这是正确行为。

---

## 对方案的影响（已同步到 `docs/plans/2026-11-17-pcdn-diag-plan.md`）

| # | 变更 |
| --- | --- |
| 1 | §3.2 第 6 条正则改为 `^cn-[a-z0-9-]+\.bilivideo\.(com\|cn)$`（去掉 `-bcache-`） |
| 2 | Q1 关闭：`confidence` 默认 `measured` |
| 3 | Q10 关闭：`cn-` 前缀即可判自建 |
| 4 | Q9 部分关闭并改写 §12.5：中途切换**能被候选过滤覆盖**，但**必须同时改 `__playinfo__`** |
| 5 | 新增回归基线：84 个 host 的清单应固化进 `docs/guides/`，作为分类函数的验收对照 |

---

## 复现方式

```
node poc/probe/pcdn-diag/probe.mjs
```

约 2 分钟。Part B 走 `ranking/v2`，失败自动回退 `popular`；Part A/C 需要本机 Edge。

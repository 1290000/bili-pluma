# ADR 0042：把 `os=mcdn` 判据的**命中来源**结构化输出，让面板不再把已切官方镜像的线路标成 P2P

- 日期：2026-11-18
- 状态：**已采纳**（用户 2026-11-18 明确选择方案 A，并要求覆盖全部取流场景）
- 相关：[ADR 0038](./0038-filter-pcdn-candidates.md)（候选过滤授权）、[ADR 0039](./0039-rewrite-pcdn-authority.md)（换 authority）、[ADR 0040](./0040-festival-page-injection.md)（活动页注入）、[ADR 0041](./0041-pgc-callback-takeover.md)（PGC 回调接管）
- 影响面：`src/core/cdn/classify.ts`（新增导出，**不改既有返回契约**）、`src/content/isolated/loading-trace.ts`、`src/content/panel/*`
- **不改变任何过滤行为**：本次只让"判据说得出理由"，不改"判不判 PCDN"

---

## 一、要解决的问题：开关开着，时间轴却仍画橙色 P2P 节点

用户报「P2P 绕过屏蔽 PCDN 开关」。定位到一条**自相矛盾**的链路，它不是取流 bug，是**判定与显示** bug：

1. 候选过滤（ADR 0039）把 PCDN 候选的 authority 换成官方镜像
   （`x5zy69j.edge.mountaintoys.cn` → `upos-sz-mirrorhw.bilivideo.com`），
   **`pathname` / `search` / `hash` 一字不动**（边界 1）。
2. 原 URL 的 query 里带着 `os=mcdn`。它**必须留着** —— 签名参数 `uparams` 含 `os`
   （实测 `uparams=e,os`），改了会 403。
3. 于是改写后的 URL 是「**官方镜像 + `os=mcdn`**」。而 `classifyCdn()` 第 5 条
   「query 里 `os=mcdn` 即判 PCDN」**对任何 host 生效** → 改写后仍判 `pcdn`。
4. 采集器 `resolveMediaHost()` 拿**实际请求的 host** 去 classify，于是把这条
   已经切到官方镜像的线路判成 PCDN，时间轴画橙点、结论卡说「其中 N 条是 P2P 线路」。

**实测量化**（`poc/probe/pcdn-diag/`，2026-11-18）：

| 断言 | 数值 |
| --- | --- |
| 改写前是 PCDN 的候选，改写后 `classifyCdn()` 仍判 `pcdn` | **19 / 20** |
| 改写后 host | 全部 `upos-sz-mirrorhw.bilivideo.com`（官方服务商镜像） |
| 同一条 URL 换 host 后首块 1KB 的指纹 | `4f64a092e5dc26c9`，与真官方基线**完全相同** |

首块字节相同 ⇒ 镜像拿到的就是同一份文件，**流量确实不走 PCDN**（ADR 0039 的前提成立）。
所以面板那句「P2P」是**显示错误**，不是取流错误。

## 二、为什么不能靠"改 query 去掉 `os=mcdn`"绕过

`uparams` 逐条列出被签名覆盖的参数名。实测两条真实样本：

```
…&upsig=7baa0aee…&uparams=e,os      ← os 在签名内
…&upsig=e1e4d2f6…&uparams=e,oi      ← os 不在签名内
```

前者的 `os` 被签名绑定：改写实测 **403**（`2c-mirror-os-stripped` 探针，11ms 就回 403）。
机制是 `upsig` 覆盖 `uparams` 列出的键，与服务端对不上就直接拒。所以
「把 `os=mcdn` 抹掉让 classify 认不出」这条路**在签名侧就被堵死**。

## 三、关键实测：「`os=mcdn` 单独起作用」在真实数据里**一次都没发生**

把 `poc/probe/pcdn-diag/` 三份实测数据（`remaining-candidates.json` /
`mcdn-candidates.json` / `rewrite-4k-candidates.json`）里所有 URL 收集起来，
按「最先命中的判据」归类，只看带 `os=mcdn` 的那批：

| 最先命中的判据 | 条数 | distinct host | 样例 |
| --- | --- | --- | --- |
| 第 4 条（供应商域 `mountaintoys.cn`） | 34 | 19 | `x5zy69j.edge.mountaintoys.cn` |
| 第 3 条（`mcdn` 标签） | 13 | 8 | `xy180x129x222x41xy.mcdn.bilivideo.cn` |
| **第 5 条（`os=mcdn`，前面都不命中）** | **0** | **0** | —— |
| 合计 | 47 | 27 | —— |

再把范围放大到各场景的 PCDN host 全集（UGC 侧 `remaining-candidates.rows`）：

| 形态 | 数量 |
| --- | --- |
| `mcdn` 独立标签 | 22 |
| `mountaintoys.cn` 域 | 19 |
| 两种都不是（即只有第 5 条能抓） | **0** |

**结论**：第 5 条判据在**原始数据**上是一个**从未单独生效的保险丝**；
但它在**改写后的数据**上是**100% 命中**。也就是说：它挡不住任何真实的 PCDN 漏判，
却把自己产出的官方镜像全部误判回 PCDN。

这不是"判据写错了"，而是**同一条判据同时承担了两件相反的事**：
「识别 PCDN 主机」与「识别 PCDN 资源内容」。改写把两者解耦之后，它只剩副作用。

## 四、决定：**不改判据语义，只把命中来源说出来**

考虑过的两条路：

| 方案 | 做法 | 否决 / 采纳理由 |
| --- | --- | --- |
| B：把第 5 条收窄到「非官方域」 | `hasOsMcdn && !official` 才判 pcdn | **否决**。`rewriteOne()` 靠 `cls === 'pcdn'` 决定要不要改写；收窄后若真存在「官方镜像代理 mcdn 源」的候选，我们就不改写了 —— 那正是 `classify.ts` 文件头最怕的**静默失败**（开关开着却在走 PCDN）。实测 0 例不代表永不存在，而失败的代价是单向的 |
| **A：保留判据，输出命中来源** | 新增 `explainCdn()` 返回 `rule`，`classifyCdn()` 委托它、**返回形状不变** | **采纳**。过滤行为一个字不变（零回归风险）；显示侧拿到「为什么判 pcdn」，就能把「主机是官方镜像、只因资源标记是 mcdn」如实说出来 |

**为什么 A 能同时覆盖全部场景**：

`loading-trace.ts` 的采集器只读 `performance` 的 resource 条目，
**按 URL 判据工作，不认识页面类型**（`resolveMediaHost()` → `isMediaPath()` + `classifyCdn()`）。
它已经被 `content.ts` 在 `/video/*`、`/bangumi/play/*`、`/festival/*` 三个注入面装上
（`content.ts:2656-2660`），国创走 `/bangumi/play/`。所以：

- UGC `/video/`（`/x/player/playurl` 响应时刻过滤）
- 番剧（`/pgc/player/web/playurl/v2`，setter 注入 + 回调接管 + 写缓存侧过滤）
- 国创（同番剧，`/bangumi/play/` 路径）
- 活动页 `/festival/*`（nano 钩子接管）

**四条路径共用同一个采集器与同一份判据**。修在 `classify.ts` + `resolveMediaHost()`，
四场景**一次性**全部生效，不需要在每个注入点各改一遍。

## 五、接口设计

### 5.1 新增导出（不改既有契约）

```ts
/** 判据命中的**来源**——只是"哪一条先命中"，不参与过滤决策 */
export type CdnRule =
  | 'ip'          // 第 2 条：裸 IP / IPv6 字面量
  | 'label'       // 第 3 条：任一标签等于 mcdn / pcdn / gotcha
  | 'domain'      // 第 4 条：供应商自有域（mountaintoys.cn 等）
  | 'os-mcdn'     // 第 5 条：query 里整段 os=mcdn
  | 'self-built'  // 第 6 条
  | 'partner'     // 第 7 条
  | 'official'    // 第 8 条：官方域兜底
  | 'third-party' // 第 9 条
  | 'unknown';    // 第 1 / 10 条

export interface CdnExplanation extends CdnClass {
  rule: CdnRule;
}

export function explainCdn(host: string, search?: string): CdnExplanation;
```

`classifyCdn(host, search)` **实现改为委托** `explainCdn()` 并只取 `{ cls, flavor }`。

> **为什么不直接给 `CdnClass` 加字段**：仓库里有 **30 处** `toEqual({ cls, flavor })`
> 精确深比较（`classify.test.ts` / `baseline.test.ts` / `pcdn-filter-wiring.test.ts` 等）。
> 加字段会让它们全部转红，而这些断言钉的是**分类语义**、不是返回形状的完整性。
> 委托式新函数既保住既有断言，又不出现"两份判据实现"。

### 5.2 采集侧多带两个字段（`MediaHost`）

```ts
export interface MediaHost {
  host: string;
  cls: CdnKind;
  flavor: OfficialFlavor;
  /** 第 5 条之外的判据把 host 单独判成什么（传 undefined 当 search，即"只看主机"） */
  hostCls: CdnKind;
}
```

**关键点：`hostCls` 由 `classifyCdn(host)`（不传 search）算出，仍在 `classify.ts` 里定义语义。**
面板**不需要也不许**自己写一份官方域表 —— 那是 `classify.ts` 第 2 条纪律
（「不另写域名表，否则必然漂移」）明确禁止的。这里只多问一次同一个纯函数。

推导：`hostCls === 'official' && cls === 'pcdn'` ⇒
「主机本身就是官方镜像，是因为资源标记 `os=mcdn` 才判成 pcdn」——
这正是我们改写后的产物，也正是要如实显示的事实。

### 5.3 面板显示

| 条件 | 现状 | 改后 |
| --- | --- | --- |
| `cls === 'pcdn'` 且 `hostCls !== 'official'` | 「P2P 线路」橙色菱形 | **不变**（真实 PCDN 主机） |
| `cls === 'pcdn'` 且 `hostCls === 'official'` | 「P2P 线路」橙色菱形（**错**） | 「官方镜像」+ 附注「资源标记为 mcdn」 |
| 时间轴节点同上 | 橙色 P2P 节点 | 官方节点 + 附注 |

文案必须**同时说两件事**，不许只说一半：

- 走的是**官方镜像**（host 事实）——所以流量不走 PCDN；
- 资源的**源标记**是 `mcdn`（query 事实）——所以不是"完全干净的官方资源"。

**不许**写成「已回退」或「已修复」：我们没有"源站到底是谁"的观测，
只有「改写了 authority」与「首块字节与官方基线相同」这两条证据。

### 5.4 `describePcdnCaveat()` 的口径

`loading-pane.ts:381` 现在按 `snapshot.hosts.filter(h => h.cls === 'pcdn')` 计数。
改后这个计数要**排除** `hostCls === 'official'` 的那批 —— 否则结论卡会说
「其中 N 条是 P2P 线路，未占主导」，但那些线路其实都在官方镜像上，
与同一张卡上「官方 CDN」的大字结论打架（这正是该函数头部注释记的那次真机矛盾）。

## 六、边界（不能越的线）

1. **`classifyCdn()` 的返回形状与语义一个字不改** —— 只是实现委托给 `explainCdn()`。
2. **`rewriteOne()` / 过滤链路一个字节不改** —— 判据仍是 `cls === 'pcdn'`。
3. **不许新增域名表** —— 面板与采集器都只能问 `classify.ts`。
4. **第 5 条判据的「对任何 host 生效」不许收窄**（见第四节对方案 B 的否决）。
5. **`search` 不进快照**（`loading-trace.ts` 边界 1）：`hostCls` 是个枚举，不是 query。
6. **不动 `content.ts` 的注入面与 `PATCH_PATHS`**；不加权限、不加依赖。
7. ADR 0030 的 `pluma:pgc-reload:` 护栏不许碰。

## 七、验收

- `classifyCdn()` 的 30 处既有精确断言**零改动即通过**（证明契约没变）。
- 新用例：`explainCdn()` 对 141 条实测 URL 的 `rule` 分布 = 第 4 条 34 / 第 3 条 13 / **第 5 条 0**；
  并钉住「改写后的 19 条全部 `rule==='os-mcdn'` 且 `hostCls==='official'`」。
- 采集侧：`resolveMediaHost('https://upos-sz-mirrorhw.bilivideo.com/x.m4s?os=mcdn')`
  → `cls:'pcdn'`、`hostCls:'official'`（**改写后的真实形态**）。
- 面板：上表三行各一条用例；`describePcdnCaveat` 对「只有官方镜像+os=mcdn」返回 `null`
  （不再说"其中 N 条是 P2P"）。
- `npm run test` / `npm run verify` 全绿；四场景（`/video/` `/bangumi/play/` `/festival/`）
  共用同一采集器这一点由既有注入面断言兜住。
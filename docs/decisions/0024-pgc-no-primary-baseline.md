# ADR 0024：PGC 页不做主账号基线对比，只陈述事实

- 状态：**已采纳**（2026-10-29 决定）
- 相关：ADR 0014（画质对比只用页面数据，不重新请求）、ADR 0019（PGC 主世界注入）、
  ADR 0020（P2 缓存 + `__playinfo__` setter 注入）、ADR 0023（SPA 切集换流）
- 影响文件：`src/core/playinfo/summary-view.ts`、`src/content/isolated/page-state.ts`、
  `src/core/playinfo/parse.ts`、`entrypoints/content.ts`、`entrypoints/popup/main.tsx`

---

## 背景：番剧页的 §2.3 从来就没工作过

2026-10-29 用户报「番剧、国创、电影页的 popup 看不到主账号信息，也看不到解锁画质，
只有『取流已由播放账号接管』和『正在读取本页取流数据…』」。

排查后发现**不是一个 bug，是三处断点叠在一起**，每一处单独都足以让 §2.3 全空：

| # | 断点 | 后果 |
| --- | --- | --- |
| 1 | `content.ts` 的 `report()` 里写的是 `if (info.kind === 'video') pageState.setPage(...)` | PGC 页**从不登记**，`view()` 第一行 `if (!bvid) return null` → 恒为 `null` |
| 2 | 播放账号侧数据来自 `playurl-raw` 上报，闸门是 `isPlayurlPath()`（只认 `/x/player/…`） | PGC 请求是 `fetchPgcPlayurl` 自己发的，**从未回流** `pageState` |
| 3 | PGC 响应是 `{code, result}`，`result` 即 video_info；`parsePlayurl` 的 `pickData` 只认 `{data}` | 解析返回 `null`，**不报错**，一路静默传成"没有能力" |

第 1 条的原始理由（代码注释原话）是「§2.3 的对比依赖 `document_start` 那刻的
`__playinfo__` 是主账号基线，而 PGC 页的 SSR 数据会被主世界改写成播放账号的流，
那份基线不再可信」。

**这个理由只对「能力基线」成立，对「主账号显示信息」不成立。**
`primary.user`（uname / level）与 `primary.loggedIn`/`mid` 跟取流身份毫无关系，
它们是页面的账号信息，被一个"流不可信"的判断连坐否决了。
代价是番剧页的 **A 卡片也写「打开视频页后可见」**、options 账号页同样拿不到昵称。

---

## 决定

**分三层，各管各的：**

| 数据 | 来源 | PGC 页有没有 |
| --- | --- | --- |
| 主账号显示信息（uname / level / loggedIn / mid） | 页面 `__INITIAL_STATE__.user` + `document.cookie` | **有**（与取流身份无关） |
| 播放账号实际能力（徽章） | `/pgc/player/web/playurl` 的响应 | **有**（`fetchPgcPlayurl` 的结果回流 `applyPlayback`） |
| 主账号能力基线（对比锚点） | 需要用主账号身份再取一次流 | **没有，且不做** |

所以 PGC 页的 §2.3 是：

```
番剧页 · ep3854821
┌──────────────────────────────────────────────────┐
│ 已取得 4K                    播放账号提供 · 此处不做主账号对比 │
│ [4K] [60fps] [Hi-Res]                            │
└──────────────────────────────────────────────────┘
```

**标题是「已取得 X」，不是「已解锁」。**
「已解锁」是能力声明，语义是"因为这些画质才有的"；没有对比就没有这个证据。
「已取得」只陈述"播放账号这次确实拿到了 X"，与 `unlockedBadges()` 的输出一致。

**锚点写「播放账号提供 · 此处不做主账号对比」，不写「无法对比」。**
后者只说明"数据缺"，读起来像还在加载；而这里是**设计上就不做**。

---

## 为什么不用主账号再取一次基线

这条路技术上可行，被明确否决，理由按轻重排：

1. **需要在请求期间摘掉该标签页的 DNR 规则。** `Cookie` 是 forbidden request header，
   脚本设不了，只能靠浏览器带 Cookie，而"带哪个身份的 Cookie"由 DNR 按**标签页**决定。
   要让同一个标签页发出主账号身份的请求，只能"删规则 → 发请求 → 装回去"，
   中间存在窗口期，窗口内页面发起的任何 playurl 都是主账号身份。
   这与 [ADR 0006](./0006-no-per-request-nonce.md)「常驻规则、不每请求增删」直接冲突。

2. **它是一次以主账号身份对"需要权益的内容"取流。** 哪怕只读响应、不播放，
   在项目已经收到律师函的阶段，这个动作会让 README 里「不绕过付费墙」的措辞
   需要加脚注——而那正是最容易被断章取义的地方。

3. **收益与代价不匹配。** 换来的是"用户更确信插件有价值"，
   付出的是规则窗口期 + 一次越界取流 + 一句要打补丁的合规措辞。
   而用户此刻已经能确认"播放账号正在供流、拿到的是 4K"，这本身是实质信息。

**被放弃的第三条路**：从 PGC 的 SSR `video_info` 反推主账号能拿到几档。
技术上不成立——实测 PGC 的 SSR 是纯 `durl`/`durls`、`type: 3`，**没有 `dash`**，
`durl` 里没有 `height`，反推不出档位。

---

## 对既有代码的影响

| 位置 | 变化 |
| --- | --- |
| `PageState.setPage(bvid, p)` | → `setPageKey(key, p)`，接受 `BV…` 与 `ep:` / `ss:` |
| `PageTracksView.bvid` | → `pageKey`（类型层就让"装得下 PGC"成立，而不是靠命名暗示） |
| `entrypoints/content.ts` 的 `report()` | 去掉 `kind === 'video'` 闸门，两类页面都登记 |
| `parse.ts` 的 `pickData()` | 增加 `result` 分支（判据：`result` 上有 `dash`/`durl`/`timelength`） |
| `content.ts` 的 `prepareFullStream()` | 取流成功后 `pageState.applyPlayback({code, result})` |
| `summary-view.ts` | 新增 `isVideoPage()` / `PGC_ANCHOR` / `pgcTitle()`，PGC 分支排在所有对比判断之前 |

**`PageState` 的基线判定逻辑一处没改。** PGC 页上 `primary.usable` 仍然是 `false`
（`reason` 通常是 `client-written`），因为那份 `__playinfo__` 确实已被换成播放账号的流。
改的只是"基线不可用"不再连坐"整份 view 产不出来"。

---

## 验证

- `tests/unit/content/page-state.test.ts`：PGC 页 `view()` 非 null、基线不可用时
  昵称/等级/登录态仍可读、切集会清空上一集数据（3 条）
- `tests/unit/core/playinfo/parse.test.ts`：`{code,result}` 两种嵌套
  + **空壳 `result` 仍返回 null**（3 条，防把空壳当能力）
- `tests/unit/core/playinfo/summary-view.test.ts`：PGC 标题/锚点/徽章
  + **普通视频页不受影响**（6 条）

**反向验证做过**：把 `pickData` 的 `result` 分支关掉 → 2 条红；
把 PGC 分支关掉 → 2 条红。两处都已恢复并全绿。

⚠️ **真机未验证**。上述全是单测与形状推演。用户报的现象（番剧页 popup 全空）
与三处断点一致，但"修好之后真机上看到的是 4K 徽章"这一步**没有实测过**——
需要 `bsk` 在真实登录态下打开一集番剧确认。这条不要当成已完成。

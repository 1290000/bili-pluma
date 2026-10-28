# ADR 0019. 支持番剧 / 国创 / 电影：hook 播放器的异步取流回调

日期：2026-10-27
状态：**部分取代**（2026-10-28）

> ## ⚠️ 先读这段：本 ADR 的标题与主路线已被推翻
>
> | 本文写的 | 实测结论（2026-10-28） | 现状 |
> | --- | --- | --- |
> | hook `requestConfig.reqHttpPlayUrlInfo` 回调喂流 | **回调从未被调用**（`cbCalled: 0`） | ❌ 已废弃 |
> | — | 改为在 `__playinfo__` 的 setter 里**同步**注入 | ✅ P2 缓存链路，见 `PGC-STATUS.md` |
> | （本文未涉及 SPA 切集） | 切集时 `__playinfo__` **完全不赋值**，setter 不触发 | ✅ 走响应层拦 `playview`，见 [ADR 0023](./0023-intercept-playview-durl-swap.md) |
>
> **仍然有效的部分**：R1 / R2（接口有效、只要 `cid` 就能调通）、
> “durl 是无权益形态而非番剧形态”的纠正、以及“PGC 页必须主动取流”这个前提。
>
> **不要再照着本文去改切集逻辑** —— 那会重走一遍已排除的路。
> 现状与待办见 `.workbuddy-ai/analysis/PGC-STATUS.md`。

取代：[ADR 0007](./0007-v1-video-only-bangumi-deferred.md) 的「v1 不支持番剧」部分
不推翻：[ADR 0004](./0004-request-level-identity-proxy.md)（请求级身份代理）、
[ADR 0013](./0013-patch-player-info-response.md)（响应体改写边界）

## 背景

用户的实际诉求不是"番剧画质不够"，而是**登录主账号时无法观看大会员专享的番剧 / 国创 / 电影**。
这是"能不能看"（权益）问题，请求级身份代理从根上不适用：

- `bilibili.com` 的 cookie 按域名唯一 → 同一标签页只能有一个身份
- PGC 页面是**服务端按身份渲染**的（`playurlSSRData` 写进 HTML），主账号请求回来的
  就是 `is_preview: true` + 每个画质 3–6 分钟试看

ADR 0007 当时（2026-10-25）的结论是"页面零请求，代理碰不到"。这个结论**事实正确但推论过强**。

### 2026-10-27 实测（四条，全部可复跑）

| # | 结论 | 方法 |
| --- | --- | --- |
| R1 | `/pgc/player/web/playurl` **接口有效** | 无 cookie 直连：HTTP 200 / `code:0`；番剧返 `dash`、电影返 `durl` |
| R2 | **只要 `cid`** 就能调通，不需要 `ep_id`、不需要 WBI | `?cid=<cid>&avid=0&qn=80&fnval=4048&fnver=0&fourk=1` |
| R3 | **删掉 `config.prefetch.playUrl` 后，播放器会回退调用 `requestConfig.reqHttpPlayUrlInfo`** | `poc/verify/poc-pgc-reqplayurl.cjs`：保留 → `hits=0`；删除 → `hits=1` 且**仍能播** |
| R4 | 异步回调喂数据能让播放器正常起播 | `poc/verify/poc-pgc-inject.cjs`：番剧 2939s（完整集）、电影 360s，均正常播放 |

补充事实：**"番剧只有 durl 没有 dash"是误读**。durl 是"无权益"的形态，不是"番剧"的形态
—— `ss47836`（番剧免费集）返回 `whole` + dash；`ss48001`（电影试看）返回 `preview` + 4×6min durl。

## 决策

**PGC 页走一条新的支路：主世界 hook `window.nano`，替换播放器的异步取流回调。**

```
hook window.nano setter → 包住 createPlayer(config)
  ├─ 只有 play_video_type === 'preview' 才接管（免费集原样放行）
  ├─ 删掉 config.prefetch.playUrl                （逼播放器走异步回调，R3）
  └─ 替换 requestConfig.reqHttpPlayUrlInfo
        → 页面内 fetch /pgc/player/web/playurl（DNR 换成播放账号 Cookie）
        → **以 SSR 为骨架合并**流字段后返回
        → 失败 / 超时 → 调原来的回调（降级 = 现状的试看）
```

### 五条必须遵守的细节（每条都是实测踩出来的）

1. **PGC 页绝不藏 `__playinfo__`。** `/video` 页藏它是为了逼播放器发请求；PGC 页的播放器
   只吃 SSR 数据，藏了就是黑屏。`syncHooks` 里必须写成 `enabled && !IS_PGC`。
2. **响应必须合并到 SSR 骨架，不能直接替换。** 接口的 `result` 是扁平的
   （`dash` / `durls` / `timelength`），播放器读的是 SSR 嵌套形状（`video_info.*`）。
   直接替换的实测结果：`video.readyState = 0`、`src` 都没设、**黑屏且不报错**。
3. **只在 `preview` 时接管。** 免费集接管没有收益，只会把观看进度写成播放账号的
   （`PROGRESS_PATCH_PATHS` 只覆盖 `/x/player/*`，不覆盖 PGC）。
4. **进度回填。** 反正要加工响应，顺手把 SSR 的 `result.watch_progress.current_progress`
   抄回去 —— 与 ADR 0017 同一个意图，但改的是我们自己手里的 JSON，**不需要扩 `PATCH_PATHS`**。
5. **主世界脚本要由 MAIN world 内容脚本注入，不能用 `<script src>`，也不能用内联 `<script>`。**
   （2026-10-27/28 真机踩了三次，见下方「注入方式的三次修正」）

#### 注入方式的三次修正（同一条教训的三个回合）

| 尝试 | 结果 | 为什么不行 |
| --- | --- | --- |
| `<script src=chrome-extension://…/main-world.js>` | 脚本执行了，但 hook 没装上 | 它**异步加载**（`async=false` 只管动态脚本之间的顺序，不阻塞解析）。而 PGC 页的 `window.nano` 赋值与 `createPlayer` 全在**内联脚本**里 |
| `script.text = 源码`（内联） | **扩展装不上** | MV3 的 `extension_pages` **拒绝** `script-src 'unsafe-inline'`（Edge 156 报 `Insecure CSP value`；换 `minimum_chrome_version: 132` 也无效）。平台封死 |
| **`world: 'MAIN'` 内容脚本**（现行） | ✅ 生效 | 浏览器在 `document_start` 直接注入主世界，不受 CSP 限制，也不需要 `web_accessible_resources` |

现行实现：`entrypoints/main-hook.content.ts` 里 `import '@/src/content/main-world.js'` +
`defineContentScript({ world: 'MAIN', runAt: 'document_start' })`。
**两个入口（MAIN / ISOLATED）的 `matches` 必须一致**，只改一边会出现"有 hook 没报到"或反之。

> 这条同时解释了 `/video` 页的一个老疑问：`ssrFirstSeen` 一直是 `'set'` 而不是 `'initial'`
> （ADR 0014 里"两份 `__playinfo__`"的谜题）—— 不是"两个值"，是**注入晚于第一次赋值**。

## 前提与约束（2026-10-28 补，两条独立的实测结论）

**① 光"提供一个完整流的回调"是不够的。**

- SSR 给的 `durls[0].durl` **只有 1 段、360 082 ms** —— 它是一个 360 秒的独立文件，
  不是完整集的前 6 分钟。直接播它：`duration=360`、`seekable.end=360`、设 `currentTime=600` 被**夹回 360**。
- 把 `is_preview` / `play_check` / `play_video_type` 三个标记全改成"完整"，
  `video.duration` **仍是 360** —— 播放器不按字段截断，是流本身就短。

所以 `prefetch.playUrl` 是**唯一入口**：不删它，播放器直接用 SSR 的短流，我们的回调根本不会被调用
（R3 里"保留 → `hits=0`"就是这个）。删了它 + 提供回调，才有机会换成 1440 秒的 dash。

**② `createPlayer` 只调一次，而且极早。**

```
407 ms  window.nano 被赋值
409 ms  __playinfo__ 被赋值（preview，durl 360082 ms）
409 ms  createPlayer 被调用（prefetch.playUrl 存在、reqHttpPlayUrlInfo 存在）
636 ms  DOMContentLoaded
```

（`poc/probe/probe-pgc-timing.cjs`，用 Playwright `addInitScript` 抢在页面任何脚本之前测量）

**含义**：hook 必须抢在那一次调用**之前**装好，没有第二次机会。
"失败重试 / 多次接管"在本页上没有意义，`PGC_MAX_TAKEOVER` 只是保险丝。

### 权益确认（2026-10-27 21:45，ss34412，主账号已登录）

| 项 | 值 |
| --- | --- |
| 接口 `has_paid` / `is_preview` | **true / 0**（不是试看） |
| 接口返回形态 | **dash 16 条轨**，heights `[1080, 720, 480, 360]`，3 条音轨，`dolby: true` |
| `timelength` | 1 440 083 ms（完整集） |
| 首条 dash 流用 `<video>` 直接播 | **`ok: true` / `duration: 1440` / `height: 1080`** |

→ 权益问题（A1）已关闭：完整 24 分钟能播。
→ 有权益时接口返回 **dash**（不是 durl），所以 `pgcMerge` 的 dash 分支是主路径；
durl 分支只在"电影 + 无权益"等场景才会走到。

## 不做什么

| 不做 | 理由 |
| --- | --- |
| 在当前标签页代理 `main_frame` 换身份 | 整页变播放账号（头像/评论/历史/收藏），违背 ADR 0004 |
| 伪造会员状态让播放器"以为有权益" | 属于伪造权益显示；失败模式是"用户以为自己的主账号变成会员" |
| 改写 `play_check` / `play_video_type` / `is_preview` | **已实测证伪**：三个标记全改成"完整"后 `video.duration` 仍是 360。播放器不按字段截断，改它没有意义（`poc/probe/probe-pgc-is-preview.cjs`） |
| 扩 `PATCH_PATHS` 加 PGC 接口 | 加路径 = 扩大越权，`check-patch-scope.mjs` 会红 |
| ~~预取 SSR / 隐藏标签页 / 二次加载~~ | ~~R3 已让这条路完全没必要~~ **2026-10-28 修正：如果 hook 抢不到那唯一一次 `createPlayer`，这就是唯一保底方案**（见 `.workbuddy-ai/analysis/2026-10-28-pgc-implementation-plan-v2.md` Step 3） |

## 后果

- `routes.ts`：`/pgc/player/web/playurl` → `enabled: true`，`ROUTES_REVISION` → 2；
  `/pgc/player/web/v2/playurl` 保持 false（实测是空壳：200 + code 0 但无 dash 无 durl）
- `content.ts` 的 `matches` 增加 `/bangumi/play/*`；`page/activate` 载荷改为 `kind + pageKey`
- `dnr.ts` 的 `installTabRule` 按 `kind` 选 `urlFilter`
- `main-world.js` 新增 PGC 分支，与 `/video` 分支**互斥**
- 新增测试 `tests/unit/content/main-world-pgc.test.ts`（含"改回去必须变红"的反向验证）
- **README 与打包说明必须改**：现在只写"不支持番剧 / 直播"，漏了国创和电影
- 新增已知限制：无权益的内容（没买的单片、地区限制）照样看不了；免费集不会因此变高清

### ⚠️ 落地状态（2026-10-28，**功能尚未生效**）

代码已全部落地并通过 `node scripts/verify.mjs`（11 项），但**真机功能验证未通过**：

| 观测（真机 ss34412） | 值 | 说明 |
| --- | --- | --- |
| `window.__PLUMA_MAIN__` | true | 主世界脚本跑起来了 |
| `__playinfo__` 的访问器 | 是我们装的 | 确实第一个定义 |
| `nano.__plumaPgcWrapped` | true | `createPlayer` 包装装上了 |
| **`[PGC] takeover` 日志** | **没有** | 包装没被页面那次真实调用触发 |
| `video.duration` | **360** | 仍是试看 |

诊断方法（未实施）：在 `main-world.js` 加 `boot` / `wrap` / `call` 三个时刻埋点，
与本文「时序约束」测到的 409 ms 对齐，即可区分"注入太晚"还是"页面读了缓存的 nano 引用"。

**下一步**：`2026-10-28-pgc-implementation-plan-v2.md` 的 Step 1。

## 相关

- 实施方案 v2（现行）：`.workbuddy-ai/analysis/2026-10-28-pgc-implementation-plan-v2.md`
- 实施方案 v1（已被 v2 的 §1 / Step 5 取代）：`.workbuddy-ai/analysis/2026-10-27-pgc-implementation-plan.md`
- 可复跑脚本：
  - `poc/verify/poc-pgc-reqplayurl.cjs` —— 删 `prefetch.playUrl` 后播放器会回退调回调
  - `poc/verify/poc-pgc-inject.cjs` —— 端到端注入机制（游客态可跑）
  - `poc/probe/probe-pgc-timing.cjs` —— **原生时序**（createPlayer 何时被调）
  - `poc/probe/probe-pgc-is-preview.cjs` —— 改 `is_preview` 无效的对照实验
- 真机观察：`ss28747`（国创）/ `ss34412`（番剧）—— 主账号 `hasPlayer=true`、`preview`、
  durl 4×180160ms / 4×360082ms，播放器**正常创建**（这是整条路线的前提）

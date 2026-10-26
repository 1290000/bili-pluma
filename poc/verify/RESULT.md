# Q1 / Q3 / Q4 / Q5 验证报告

> 日期：2026-10-25
> 方法：Playwright + 系统 Chrome 独立 profile。未登录态用全新 context；登录态用**注入 cookie**（不读用户 profile、不读 cookie 数据库）。
> 被测对象：
> - 视频 `BV1beNcz2ECq` P4（cid `36532588493`，标题含"8K SDR 杜比全景声"）
> - 番剧 `ep3854821`（凡人修仙传第 197 集）
> 原始数据：`result-public.json`（未登录）/ `result-b.json`（播放账号）/ `result-q3*.json`（交互）/ `bg-ssr.json`（番剧 SSR）

---

## 结论速览

| # | 结论 | 等级 |
| --- | --- | --- |
| Q1 | 播放账号能拿 4K；**身份决定 dash 内容**，确认 | ✅ 已验证 |
| Q3 | playurl **只在页面加载和切P 时调用**，切画质/拖进度不触发 | ✅ 已验证 |
| Q4 | 番剧走 **SSR 注入，零网络请求**，代理架构**碰不到** | ✅ 已验证（坏消息） |
| Q5 | **不需要 `cookies` 权限** | ✅ 已验证 |
| — | `accept_quality` 不能作为画质判据 | ⚠️ 推翻文档 |
| — | 游客模式拿不到高画质 | ✅ 已验证 |

---

## 一、Q1：身份决定 dash —— 对比数据

同一个视频、同一个 `fnval=4048`，只换 cookie：

| 身份 | dash 最高轨道 | 1080P60 | FLAC | 杜比音频 | 实际播放 |
| --- | --- | --- | --- | --- | --- |
| 未登录 | **480P**（852×480） | ✗ | ✗ | ✗ | 360P |
| 播放账号（大会员） | **2160P**（3840×2160，120fps） | ✓ | ✓ | ✓ | 3840×2160 |

播放账号拿到的完整轨道（第一次请求）：

```
126  2160p  AV1   120fps  17.5 Mbps
120  2160p  H.264 120fps  15.3 Mbps
120  2160p  AV1   120fps   5.9 Mbps
120  2160p  HEVC  120fps   4.7 Mbps
116  1080p  H.264  60fps   2.9 Mbps
 80  1080p  H.264  30fps   1.6 Mbps
 64   720p  ...
 32   480p  ...
 16   360p  ...
flac: true    dolby.audio: true    dolby.vision: false
```

**结论**：Q1 的核心假设成立。代理只要成功换掉 Cookie，返回的 dash 就是大会员的全量轨道。

**附带发现**：

1. **`qn` 参数不影响返回的轨道列表**。三次请求都是 `qn=32`（480P），返回的却是全量 19 条轨道（含 2160P）。`qn` 只决定播放器默认选中哪一档。所以扩展**不需要为了拿 4K 而改 qn**，`fnval=4048` 足够。
2. 普通视频页的 `window.__playinfo__` 是**客户端请求后写入**的（不是 SSR）。加载完成后它包含 `4320P`（8K）轨道，但 playurl 响应里最高只有 2160P——**8K 来自另一条未捕获的请求**，来源待确认。v1 不需要 8K，可延后。

   > ⚠️ **2026-10-26 更正：这条结论只对"加载完成之后"成立，对 `document_start` 不成立。**
   >
   > 实测（BV1jt421t7XH P1，真实双账号，见 [ADR 0014](../../docs/decisions/0014-quality-compare-from-page-data.md)）：
   > `document_start` 那一刻的 `__playinfo__` **确实是 SSR 的、且是主账号身份**（最高 1080p），
   > 之后才被页面覆写成含 8K 的版本。同一个变量、两个时刻、两个值。
   >
   > 所以 ADR 0010（"SSR 注入，播放器直接读"）与本条**不矛盾**。
   > 但推论很重要：**只有第一份能当主账号基线**，拿加载完成后的那份会得到播放账号身份（静默谎报）。
3. 播放账号的 `CURRENT_QUALITY=126`、`topQn=127`，与埋点日志里的 `qn:120`、`topQn:127` 互相印证。

---

## 二、Q3：playurl 调用频次 —— 远低于文档预期

| 场景 | 新增 playurl 请求 |
| --- | --- |
| 首次加载 | **1 次** |
| 静置 30 秒 | **0 次** |
| 切画质（480P → 360P → 480P） | **0 次** |
| 拖进度到 60% | **0 次** |
| 切 P（P4 → P5） | **1 次** |

**结论**：playurl 只在**页面加载**和**切 P** 时调用。画质切换、进度拖动、长时间播放都不重新请求。

**影响**：

1. `dnr.ts` 的并发压力**远低于** `03-open-questions.md` §2 担心的"5 个视频页 + 预加载 + 评论 + 推荐"。实际并发上限 ≈ 同时加载的标签页数。
2. 但代理**只有一次机会**：页面加载时那一次 playurl 若没被成功替换，整个页面就锁死在主账号的画质上——用户之后切 4K 也切不动，因为本地 dash 里没有那条轨道。**单次成功率比并发安全更关键**。
3. 70 秒视频内流地址未过期。**长视频（2 小时）是否中途刷新未验证**，需在 P1 补测。

---

## 三、Q4：番剧走 SSR，代理完全无效 —— 架构级影响

### 证据 1：大会员打开番剧页，零请求

```
reqs: []        ← 没有任何 playurl / playview / getRoomPlayInfo 请求
pageState: {
  playinfoType: "whole",
  playinfoVideoInfoQuality: 125,        ← HDR 真彩
  userStatus: { is_login: true, vip_info: { type: 2, status: 1 } },
  videoEl: { h: 2160, w: 3840 }         ← 实际播的是 4K
}
```

**大会员能播 4K，但一次取流请求都没发。**

### 证据 2：HTML 里写死了取流结果

```js
const playurlSSRData = {"status":200,"data":{"code":0,...,"result":{...}}}   // 22984 字节
window.__PLAYINFO__ = playurlSSRData.data
const nanoPlayer = window.nano.createPlayer(Object.assign(config, {
  requestConfig: {
    reqHttpPlayUrlInfo: function () { return Promise.resolve(playurlSSRData) },  // ← 永不发请求
  }
}))
```

播放器的取流回调直接返回 SSR 数据，**不存在任何可被 DNR 拦截的网络请求**。

### 证据 3：身份差异体现在 SSR 内容，不在请求

| 身份 | `play_video_type` | `video_info.quality` | 实际播放 |
| --- | --- | --- | --- |
| 未登录 | `"preview"` | 32（480P） | 试看 |
| 大会员 | `"whole"` | 125（HDR 真彩） | 3840×2160 |

流地址格式也不同：番剧的 `video_info` 里**没有 dash**，只有 `durl`（MP4 分段）。

### 影响

| 受影响项 | 结论 |
| --- | --- |
| `01-architecture.md` §4.1 的 3 个番剧路径 | `/pgc/player/web/v2/playurl`、`/pgc/player/web/playurl`、`/ogv/player/playview` 在当前版本**全部无效** |
| `01-architecture.md` §4.4「番剧 OGV POST + WBI 重签」 | 整节可删，前提不成立 |
| `01-architecture.md` §9 P2「番剧 OGV 的 POST + WBI 重签」 | 同上 |
| `core/wbi/signer.ts` | **仍需要**（普通视频的 `/x/player/wbi/playurl` 也要签名） |

### 番剧 SSR 的真实内容（补充实测）

未登录时 `video_info.durls` 有 **4 个画质组**：

| quality | 画质 | 时长 | 大小 |
| --- | --- | --- | --- |
| 80 | 1080P | **180160 ms（3 分钟）** | 83.5 MB |
| 64 | 720P | 3 分钟 | 41.7 MB |
| 32 | 480P | 3 分钟 | 23.9 MB |
| 16 | 360P | 3 分钟 | 14.5 MB |

完整剧集 `timelength = 1274858`（21 分钟）。`is_preview: true`、`play_check: PLAY_PREVIEW`。

**所以番剧不是"只能 480P"，而是"4 个画质各给 3 分钟试看"。改字段绕不过时长限制，必须拿播放账号的完整流。**

### 补救路：注入点已验证可行

| 方案 | 可行性 | 代价 |
| --- | --- | --- |
| 代理番剧页 `main_frame` 换 cookie | 可行 | 整页变成 B 的身份（头像/评论/历史/收藏），**违背 ADR 0004** |
| ~~替换 `reqHttpPlayUrlInfo`~~ | ❌ **无效** | PoC 实测：播放器**从不调用**该回调（hits=0），直接吃 `prefetch.playUrl` |
| **hook `window.__playinfo__` setter + 原地改对象** | ✅ **已验证** | 播放器确实用了改后的 `durl` 地址；但需数据**同步可用** → 必须预取缓存 |
| v1 不支持番剧 | — | 功能缺口 |

**PoC 证据**（`poc-hook-playinfo.cjs`）：

```
"defineProperty(window.__playinfo__) 成功"
"__playinfo__ 被赋值, top keys=code,message,ttl,result"
"  ★ 已改 durl[0].url / durls[4].durl[0].url"
state.currentDurl: "http://127.0.0.1:8799/pluma-fake.m4s"
state.video.src:   "https://127.0.0.1:8799/pluma-fake.m4s"
```

### 若要做番剧：方案 B2 的完整链路

```
1. 后台用 DNR 代理请求番剧页 HTML（带 B 的 cookie）→ 解析 playurlSSRData
2. 写入页面可同步读取的 localStorage（key 含 ep_id + 过期时间）
3. MAIN world 在 document_start 同步读缓存
4. hook __playinfo__ setter → 同步把 video_info/durl/durls 换成 B 的
5. 播放器直接用 B 的完整流
```

**四个代价**：

| # | 代价 | 说明 |
| --- | --- | --- |
| 1 | 需要二次加载 | 数据要同步，首次无缓存只能先播试看，预取完成后 reload |
| 2 | 依赖 `__playinfo__` 的赋值方式 | B站改成 `var` 或 `Object.defineProperty` 就拦不到 |
| 3 | 每集多一个 76KB HTML 请求 | 番剧页 HTML 约 76KB，需解析出 22KB JSON |
| 4 | 流地址时效 | 缓存需带过期时间，过期后回退试看 |

**结论**：技术可行，但复杂度是普通视频方案的 3–5 倍，且脆弱。建议 v1 不做，留作 v1.5 实验性功能。

---

## 四、`accept_quality` 不可信 —— 推翻文档 Q9 与 P1 验收标准

未登录请求 playurl：

```
accept_quality: [127, 120, 116, 80, 64, 32, 16]
accept_description: ["超高清 8K","超清 4K","高清 1080P60","高清 1080P","高清 720P","清晰 480P","流畅 360P"]
dash.video 实际只有: 480P × 3 + 360P × 3
```

**它表达"这个视频本身有哪些画质"，不是"你这个身份能拿到哪些"。**

文档里两处因此错误：

| 位置 | 原文 | 应改为 |
| --- | --- | --- |
| `03-open-questions.md` Q9 | "看 `accept_quality` 数组，它直接告诉你这个账号对这个视频能拿哪些清晰度" | 判据是 `dash.video[].height` 的最大值 |
| `01-architecture.md` §9 P1 验收 | "代理请求返回的 `accept_quality` 包含主账号拿不到的档位" | "`dash.video` 里出现 `height >= 2160` 的轨道" |

按原验收标准，**未登录就已经通过了**——因为它返回了 8K。

---

## 五、Q5：不需要 `cookies` 权限

`document.cookie` 可见的 key（未登录状态）：

```
buvid3, b_nut, _uuid, CURRENT_FNVAL, CURRENT_QUALITY, bili_ticket,
bili_ticket_expires, bmg_af_switch, bmg_src_def_domain, bmg_af_sc,
buvid_fp, buvid4, sid, rpdid, user_site, b_lsid
```

| Cookie | httpOnly |
| --- | --- |
| `buvid3` | **false** |
| `buvid4` | **false** |
| `bili_ticket` | **false** |

设备 Cookie 全部可从 `document.cookie` 借，**不需要申请 `cookies` 权限**。

（`SESSDATA` 是 httpOnly，读不到——但我们本来就不需要读主账号的 SESSDATA，浏览器会自动带；播放账号的凭据由扩展自己加密存储。）

---

## 六、游客模式：不成立

| 子问题 | 结果 |
| --- | --- |
| 游客是否有 `buvid3` | ✅ 有，且非 httpOnly |
| 游客能否发 playurl | ✅ 能，code=0 |
| 游客拿到的实际画质 | ❌ **只有 480P / 360P** |
| 页面是否弹登录遮罩 | 普通视频页不弹；画质菜单标注"登录即享 / 大会员" |

**"零配置解锁高画质"这个卖点不成立**，必须要求浏览器登录主账号。

### 补充实测 B：游客 **+ 播放账号凭据**（2026-10-26 20:41，InPrivate 窗口）

A 只测了"游客不带凭据"。B 测的是本扩展的实际做法：游客会话 + 用播放账号凭据重发 playurl。

| 观测 | 结果 |
| --- | --- |
| 无痕实例能否读到凭据 | ✅ 已配置 —— **`storage.local` 确实跨分区共享** |
| 页面 playurl 响应 | ✅ **2160p · 19 条视频轨 · Hi-Res** |
| 主账号基线（SSR `__playinfo__`） | ❌ **页面没有** —— 游客页不注入 |
| 播放器实际播放 | ❌ **360p** |

**两层结论相反，这才是重点：**

1. **网络层：代理成功。** 服务端按 Cookie 认人，返回了大会员的全量轨道。
   "身份由 Cookie 决定"这句话在这里得到印证。
2. **播放器层：不买账。** 播放器按**本地登录态**决定能不能选高清，
   游客态下它只给 360p —— 尽管手里已经有 2160p 的轨道。

**所以对用户来说 B 不成立**：游客拿不到高清。但**失败点不在 DNR，在播放器决策层**。
这也解释了先前"360P"不是页面崩溃的症状，而是真实结果。

> 附带事实：**游客页不 SSR `__playinfo__`**。这意味着 §2.3 的主账号基线
> 在游客态恒为"不存在"，对比结论恒为"无法比较" —— UI 必须说「未登录主账号」
> 而不是「无法对比」（见 `docs/02-ui-spec.md` §2.3）。

---

## 七、仍未验证

| 项 | 原因 | 何时补 |
| --- | --- | --- |
| 长视频（>30 分钟）是否中途刷新 playurl | 被测视频仅 70 秒 | P1 |
| 8K（4320P）来自哪条请求 | 未捕获 | 不需要，v1 不做 8K |
| 番剧切集是否仍是 SSR | 切集是页面跳转，大概率是 | P2 前 |
| 主账号 A 的实际身份（是否大会员） | 未提供 | 影响 Q4 的复现条件，不影响结论 |

---

## 八、对文档的修改清单

事实性修正（可直接执行）：

1. `03-open-questions.md` Q9：判据从 `accept_quality` 改为 `dash.video[].height`
2. `01-architecture.md` §9 P1 验收：同上
3. `01-architecture.md` §4.1：番剧 4 个路径标注"当前版本已确认无效"
4. `01-architecture.md` §4.4：标注"前提不成立，待重新评估"
5. `03-open-questions.md` §0：Q1 / Q3 / Q5 → 已验证；Q4 → 已验证（走 SSR）
6. `docs/README.md` §当前状态：更新状态表

需要用户决策（不能擅自改）：

7. **v1 是否支持番剧** → 影响 README 定位、P2 范围、`core/wbi/signer.ts` 是否保留

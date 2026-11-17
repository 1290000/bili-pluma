# 「屏蔽 PCDN」开关 · 剩余候选数实测（2026-11-17）

脚本：`poc/probe/pcdn-diag/remaining-candidates.mjs`（`npx tsx … --hook`，约 2 分钟）
原始数据：`poc/probe/pcdn-diag/remaining-candidates.json`（gitignored，含带签名的 CDN 直链，不入库）

**回答的问题**：ADR 0038 说"某条轨的候选全是 PCDN 就整条保留"。那么 **4K（2160p）轨
剔除 PCDN 之后还剩几条官方候选**？剩 0 就等于开关在 4K 上白开。

---

## 1. 条件（先说清楚数据是在什么前提下拿的）

| 项 | 实测值 |
| --- | --- |
| 登录态 | 日常 Edge profile，`nav` 返回 `isLogin: true`、`vipType: 2`（年度大会员） |
| 4K 权限 | 热门榜预筛 8 条 → playurl 全部 `accept_quality` 含 **120**，8/8 真有 2160p 轨 |
| 取数方式 | `bsk`（不是 CDP 新 profile）—— 页面内 `fetch(..., {credentials:'include'})` |
| Pluma 影响 | 扩展处于「已接管」。其 playurl 改写只碰**播放进度**字段（`PROGRESS_PATCH_PATHS` 分支），不增删 dash 候选 ⇒ 候选集是 B站原样的 |

## 2. UGC 视频：逐轨剩余官方候选（8 个视频，口径 `officialAfterFilter`）

每个视频 18 条视频轨（6 档画质 × 3 编码：`codecid` 7=AVC / 12=HEVC / 13=AV1），每轨候选恒为 **3 条**（base + 2 backup）。

```
BV1oFsW6oEs5  2160p  AVC 3/3   HEVC 1/3   AV1 2/3
BV1avsP6wE8H  2160p  AVC 3/3   HEVC 1/3   AV1 1/3
BV1Z7sp6xEUn  2160p  AVC 3/3   HEVC 1/3   AV1 1/3
BV1wZWX6mEr9  2160p  AVC 3/3   HEVC 1/3   AV1 1/3
BV1PisN6nEF2  2160p  AVC 2/3   HEVC 1/3   AV1 1/3
BV1UcsP6sEzD  2160p  AVC 3/3   HEVC 2/3   AV1 1/3
BV1wasc6qEjc  2160p  AVC 3/3   HEVC 1/3   AV1 1/3
BV1jisJ62ERd  2160p  AVC 1/3   HEVC 1/3   AV1 1/3
```

| 画质 | 轨数 | `official = 0` 的轨 | 剩余官方候选（按条） | 按 host 去重 | 官方/PCDN 候选占比 |
| --- | --- | --- | --- | --- | --- |
| **2160p** | 24 | **0** | 1→15、2→3、3→6 | 1→16、2→2、3→6 | 39 / 33（46% PCDN） |
| 1080p | 48 | 0 | 1→40、2→8 | 1→41、2→7 | 56 / 88（61% PCDN） |
| 720p | 24 | 0 | 1→21、2→3 | 1→23、2→1 | 27 / 45（62% PCDN） |
| 音频（3 种） | 24 | 0 | 见 JSON | — | 30 / 42 |

## 3. 番剧（PGC）：`/pgc/player/web/playurl` 必须用 `ep_id`

| 番剧 | 2160p 三轨 |
| --- | --- |
| 黑色四叶草（ep 114966） | AV1 2/3（去重 2）、AVC 2/3（去重 2）、HEVC 2/3（**去重 1**） |
| 银魂（ep 393434） | AV1 2/3、AVC 2/3、HEVC 2/3（去重均 2） |

⚠️ 番剧的 baseUrl 与 backupUrl **会指向同一个 host** ⇒ 按条数数会高估冗余，`REPORT` 里两个数都给。

## 4. 两条没人预料到的实测

1. **`/x/player/playurl` 与 `/x/player/wbi/playurl` 都直接返回 code 0**，同一视频 18 条轨一模一样
   ⇒ 只要 Cookie（`DNR` 换账号）在，**不需要 WBI 签名**也能拿到 4K。改写规则两条路径都得覆盖。
2. **换画质不会重发 playurl**：一次 playurl 就把全部画质都带回来了（18 轨）。
   想抓播放器自己那次请求，只能让播放器重连 —— 实测 `connect()`、`disconnect()` 单独叫都**不发**，
   `disconnect() → connect()` 才发（`hook.steps` 里逐步有账）。
3. **`classifyCdn` 的第二个参数（`search`）本次一次都没改变判定**：484 条候选里
   不传 `search` 与传 `search` 都是 325 条判 pcdn，**0 次翻转**。
   原因是真实 PCDN 主机（`*.mcdn.bilivideo.cn` / `*.edge.mountaintoys.cn`）本身就有
   `mcdn`/供应商域特征，域名判据已经拦住；`os=mcdn` 是"官方镜像代理 mcdn 资源"那条
   补充判据 —— 本次样本没碰上。⇒ **这不能当作"不用传 search"的依据**，只是"这条判据本次没被触发"。

## 5. 播放器自己那次请求的形态

```
xhr  //api.bilibili.com/x/player/wbi/playurl
     responseType = ""            ← 默认文本（responseText 可读）
     status 200 · content-type: application/json; charset=utf-8 · 106,097 字符
```

- 走 **XHR**，不是 fetch（本次全程没见到 fetch 版 playurl）；
- `responseType` 是**空串**（默认），不是 `arraybuffer` —— 主世界改写可以直接读 `responseText`；
  但 `arraybuffer`/`blob` 的分支仍要兜（`main-world.js` 里已有同类处理）；
- URL 是**协议相对**形式（`//api.bilibili.com/...`）⇒ 匹配不要只写 `https://`。

## 6. 结论

**开关在 2160p 上有效，但它砍掉的是"冗余"而不是"流量占比"**：24 条 4K 轨里**没有一条是纯 PCDN**，
所以 ADR 0038 的"整条保留"兜底在本次样本里**一次都没触发**；但 15/24 条轨剔完只剩 **1 条官方候选**
（去重后 16/24）—— 宁可掉到 1 条也不黑屏，代价是这条轨**再没有可切换的备份**。

⇒ 建议：开关对 4K **不需要**"关了也没用"的提示；要提示的是"只剩 1 条线路，弱网可能更卡"。

## 复现

```bash
npx tsx poc/probe/pcdn-diag/remaining-candidates.mjs          # 只要剩余候选数
npx tsx poc/probe/pcdn-diag/remaining-candidates.mjs --hook    # 额外抓播放器自身请求的 responseType
```

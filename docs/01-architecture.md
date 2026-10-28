# Pluma 技术方案（B站双账号画质助手）

> 项目名：**Pluma**　仓库名：`bili-pluma`　副标题：B站双账号画质助手
> 原名 BiliSplitter（v0.1/v0.2 期间使用），已于命名决策后统一更名
> 版本：**v0.4** — 命名定稿 + 全部决策落定 + 实施路线对齐 WXT 形态
> 形态：**纯 MV3 浏览器扩展**（Chrome / Edge），主账号负责社交行为，播放账号（大会员）仅提供取流权益
>
> **本文是"为什么"**。要查"代码放哪"请看 [04-project-structure.md](./04-project-structure.md)；
> 要查"还差什么"请看 [03-open-questions.md](./03-open-questions.md)；决策的完整理由见 [decisions/](./decisions/)。

---

## 命名说明

| 层 | 名称 | 职责 |
|---|---|---|
| 项目名 | **Pluma** | 记忆与传播。西语"羽毛"，兼具笔尖意象——"改动一行请求，整件事就变了" |
| 仓库名 | `bili-pluma` | 可发现性。`pluma`/`plume` 纯词在 GitHub 已被占用，此为当前最干净的组合 |
| 副标题 | B站双账号画质助手 | 承担全部解释成本。名字不必自解释，描述已经在做这件事 |

**不直接使用明日方舟角色名 `La Pluma`**：那是鹰角网络的知识产权，且会带来严重的搜索污染（搜 `La Pluma` 全是游戏内容）。`Pluma` 是西语通用词，可以拿到同样的联想，不必承担风险。

---

## 已定决策（摘要，完整理由见 [decisions/](./decisions/) 与 [03-open-questions.md](./03-open-questions.md)）

| # | 决策 | 结论 |
|---|---|---|
| Q6 | 凭据加密密钥 | **单一模式**：随机密钥 + AES-GCM，密钥同存本地。口令模式与自动锁定已砍（[ADR 0009](./decisions/0009-drop-passphrase-mode.md)）；README **诚实描述威胁模型**，不宣称"军事级加密" |
| Q7 | 主账号定义 | **不管理主账号**。主账号 = 浏览器当前登录态，扩展不存储、不读取其凭据 |
| Q10 | 合规表述 | 定位为"双账号管理工具 / 画质助手"，README 明确声明与 B 站无关联、可能违反用户协议、v1 不做商业化 |
| Q11 | 浏览器范围 | v1 仅 **Chrome + Edge**（同源，零额外成本）；Firefox 放 v1.5 |
| Q12 | 伪装会员标识 | **v1 不做**，连开关都不放。收益远小于风险与伦理成本 |
| Q13 | 开源协议 | **GPL-3.0-only + 第 7 条附加条款**（防商业化、防改名冒充官方） |
| Q15 | 远程配置 | **不做**。只做本地版本号 + 升级提示 |
| Q16 | 分发方式 | **不上架商店、不发 crx**；可发 zip，但必须同时提供带源码版本（[ADR 0018](./decisions/0018-ship-built-artifacts.md)）；准备 archived 预案 |
| — | 技术选型 | **WXT + TS `^5.9` + Preact（仅 UI）+ 原生 CSS 变量 + Vitest + pnpm**。详见 [04-project-structure.md](./04-project-structure.md) §〇 |

### ⚠️ 关于项目存续的现实提醒

B站已对同类项目实际发出律师函并导致关停：

- **PiliPala**（2025-07，Flutter 第三方客户端）——停止更新
- **bilibili-API-collect**（2026-01，2 万+ star 接口文档）——永久关停并删除内容
- **downkyi**（2026-07，下载工具）——仓库永久关停

**许可证选哪个都挡不住律师函。** 真正的风险控制在于分发方式（不上架商店、不发 crx、zip 必带源码版，见 [ADR 0018](./decisions/0018-ship-built-artifacts.md)），以及守住"不绕过付费墙"这条能力边界（见 Q4）。

请把这个项目当作**技术实践**而非长期运营的产品来投入。


---

## 修订说明（v0.1 → v0.2）

v0.1 有三处判断错误，本稿全部推翻重写。**其中第三条带来的架构简化，比前两条加起来更重要。**

| # | v0.1 的错误判断 | 事实 | 影响 |
|---|---|---|---|
| 1 | "杜比全景声/Hi-Res 在浏览器内基本播不出来，建议定位成下载后本地播放" | **错。B站官方网页端就原生支持 Hi-Res 和杜比全景声**。Hi-Res 走标准 FLAC in fMP4，Chrome/Edge 原生解码；杜比（EC-3）需装 Microsoft 的 EC-3 解码扩展 + 开 `media foundation playback` 相关 flag，官方前端本来就在走这条路 | §4.4 整节重写。**网页内播放是主路径，不再降级为下载**。本方案的"音质"卖点从"做不到"变成"可完整交付" |
| 2 | "bilipai 是单账号模型，完全没有多身份路由，必须自己写" | **错。bilipai 已有成熟的多账号设计**：可配置哪个账号为"播放账号"专门解锁高画质，且做了请求与账号的强绑定、"高画质使用当前播放账号的 Web 登录态，不再强制追加授权"。它的 CHANGELOG 里甚至记录了"正式版（双账号）比 dev（单账号）更卡"的性能优化 | **参考价值从"接口文档"升级为"可直接照搬的设计蓝本"**。§5.1 整节重写 |
| 3 | 把 Dual Account Helper 当成"cookie 切换式、会串号的劣质实现" | **错，而且错得很关键**。它是**共享浏览器、请求级代理**的架构：浏览器全程保持主账号 A 登录态，只对 7 个白名单取流接口用 `anonymous:true` 排除 A 的 cookie，用 B 的 cookie 独立重发。**不切换、不写入浏览器 cookie jar、不串号** | **原 §6.2 的"劫持 + 重放 + 伪装响应"整段删除**，降级为"已有人验证过的成熟模式"。架构风险大幅下降，PoC 周期可显著缩短 |

**最重要的架构性结论**：第 3 条意味着——**这个项目不需要本地常驻服务也能跑起来。** 下一步要做的不是"发明架构"，而是"把 Dual Account Helper 的请求级代理模式，从油猴沙箱搬到 MV3 扩展，再补上扫码登录和凭据加密"。工作量比 v0.1 预估的小一半。

---

## 0. 结论先行

| 问题 | v0.4 结论 | 把握度 |
|---|---|---|
| 能否不依赖油猴脚本实现？ | **能，且已被证明可行**。Dual Account Helper 的请求级代理模式本质上是"在 JS 层用 A 的会话同时发 B 的请求"，MV3 完全能复刻（`fetch`/XHR hook 在 MAIN world content script 即可） | **很高**（有可运行参照实现） |
| 能否复用 bilipai 的代码？ | **代码仍不能搬**（Kotlin + GPLv3），**但设计可以直接抄**：多账号配置、播放账号绑定、请求/账号强绑定、"高画质用播放账号登录态"这几条是现成的正确答案 | 高 |
| 能否复用 Dual Account Helper 的代码？ | **逻辑可以重写，代码谨慎**。它无明确 LICENSE（Greasyfork 默认保留权利），且 `GM_xmlhttpRequest` 需替换为扩展 API。**7 个代理路径的白名单是极有价值的资产**，重写一遍即可；伪装路径已按 Q12 决策弃用 | 高 |
| 扫码登录能解决核心痛点吗？ | 能解决"副账号无法播会员内容"；**"另一浏览器登录后反复粘 cookie"仍是理论边界**（见 §5.4），但 Dual Account Helper 已经用 `buvid3/buvid4/bili_ticket` 设备 Cookie 补齐解决了 90% 的 `-412` 报错 | 高 |
| 需要 Rust + Flutter 桌面端吗？ | **不需要。已决策不做**，见 [ADR 0001](./decisions/0001-use-mv3-pure-extension.md)。原三进程方案是过度设计；桌面端若将来要用，属于 v2 增强项（跨设备同步/批量下载），不影响 v1 | 高（已定稿） |

**技术本质（修订）**：不是"破解鉴权"，也不是"切换身份"，而是**请求级身份路由 + 会话虚拟化**——浏览器始终是主账号 A，扩展在 JS 层为**特定路径的请求**换上一套凭据重发，并把结果伪装成正常响应交还给播放器。A 的会话从头到尾没被动过。

---

## 1. 需求拆解与难度分级（修订版）

| # | 能力 | 本质 | 难度 | 状态 |
|---|---|---|---|---|
| A | 副账号扫码登录、长期保活 | passport 扫码链路 | ★★ | 增量工作 |
| B | 用副账号身份取流（1080P60/4K/HDR/Dolby/Hi-Res） | playurl 带副账号 SESSDATA + 正确 fnval | ★★ | **有现成参数表可抄** |
| C | 播放器实际渲染高画质 | 请求级代理，播放器无感知 | ★★★ | **Dual Account Helper 已证明可行** |
| D | 主账号社交行为不受影响 | 因为根本不切 cookie，天然不串号 | ★（原 ★★） | **免费获得** |
| E | 播放历史归主账号 | 浏览器全程是 A，历史天然归 A | ★（原 ★★★） | **免费获得** |
| F | 大会员专享番剧/影视可播 | pgc/ogv 接口代理（含 POST + csrf 重签） | ★★★ | 有参照实现 |
| G | 副账号 cookie 跨浏览器自动同步 | 浏览器安全模型限制 | ★★★★★ | 仍无解（但见 §5.4 的缓解链） |
| H | 音质：Hi-Res / 杜比全景声 | FLAC in fMP4 / EC-3 + 系统解码扩展 | ★★（原 ★★★） | **官方网页端已支持** |

**修订要点**：**D 和 E 从"难点"变成"零成本"**。这是请求级代理架构最漂亮的地方——因为浏览器从头到尾都是主账号 A，所有写操作、历史、进度上报、消息轮询，全是 A 的天然行为，不需要任何劫持或重放。

v0.1 花了大篇幅设计的"劫持 heartbeat + 主账号重放 + 伪造 200"，在 v0.2 里**整段删除**——完全不需要。

---

## 2. 整体架构（修订）

### 2.1 v1 主张：纯 MV3 扩展

v0.1 的三进程模型（扩展 + Rust Core + Flutter）在这个需求上**过度设计**了。既然请求级代理能在 JS 层完成全部取流，那么 v1 就应该是：

```
┌────────────────────────────────────────────────────────────────────┐
│                      浏览器 (Chrome / Edge)                         │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  MAIN world (页面 JS 上下文)                                  │  │
│  │  ├─ net-hook.js   : Hook window.fetch / XHR                  │  │
│  │  │                  命中白名单 → 转 ISOLATED world            │  │
│  │  └─ inject.js     : __playinfo__ / __INITIAL_STATE__ 兜底注入 │  │
│  └──────────────────────┬───────────────────────────────────────┘  │
│                         │ window.postMessage（带随机 channelToken）│
│  ┌──────────────────────▼───────────────────────────────────────┐  │
│  │  ISOLATED world (content script)                             │  │
│  │  ├─ router.js   : 路径白名单 + 方法校验（防御性复检）          │  │
│  │  └─ proxy.js    : 按策略用 B 凭据发请求 + 补齐设备 Cookie      │  │
│  └──────────────────────┬───────────────────────────────────────┘  │
│                         │ chrome.runtime.sendMessage              │
│  ┌──────────────────────▼───────────────────────────────────────┐  │
│  │  Background (Service Worker, MV3)                            │  │
│  │  ├─ vault.ts    : B 凭据加密存储（AES-GCM + chrome.storage）   │  │
│  │  ├─ qr.ts       : 扫码登录（生成二维码 / 轮询 / 落地凭据）     │  │
│  │  ├─ session.ts  : 保活、失效探测、VIP 到期提醒                 │  │
│  │  ├─ wbi.ts      : WBI 签名（番剧 playview 需重签 w_rid）       │  │
│  │  └─ stats.ts    : 代理成功率、自动策略探测缓存                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Popup: 账号状态 / 扫码登录 / 画质体检 / 代理开关 / 诊断           │
└────────────────────────────────────────────────────────────────────┘
                              │（可选，v2）
                              ▼
        Pluma Companion（Rust/Flutter 或 C#）——
        承担：凭据跨设备同步、批量取流、下载+本地播放、诊断日志聚合
```

**与 v0.1 的核心差异**：
- B 凭据不再"只存在 Core 进程"，而是**加密存在扩展的 `chrome.storage.local`**（AES-GCM，密钥与密文同存本地，**没有主密码**，见 §3.2）。
- 不再需要 WebSocket、配对、端口文件、独立进程。**安全模型从"本地端口防护"降级为"扩展存储加密"**——这是纯扩展形态的**唯一代价**，必须正视（见 §3.3）。
- 桌面软件从"必需组件"变为"v2 增强项"，专门做扩展做不了的事：跨设备同步、批量下载、杜比/Hi-Res 的本地播放。

### 2.2 为什么这个架构能"天然不串号"

这是整份方案最值得理解的一个点，用一张时序图说清：

```
主账号 A：浏览器 cookie jar 里唯一的身份，全程不变
副账号 B：只存在于扩展的加密存储里，从不写入 cookie jar

用户打开 BV 视频页
  ├─ 页面请求 /x/web-interface/nav        → 正常携带 A cookie → 返回 A 的头像/未读数 ✅
  ├─ 页面请求 /x/player/wbi/playurl       → 被 hook 命中白名单
  │     └→ proxy.js 用 anonymous:true 排除 A cookie，改用 B 的 cookie 重发
  │        （同时从 document.cookie 借 buvid3/buvid4/bili_ticket 补齐设备标识，防 -412）
  │     └→ 返回 4K/HDR/Hi-Res 的 DASH 列表 → 交还给播放器 ✅
  ├─ 用户点赞  /x/web-interface/archive/like  → 不在白名单 → 正常用 A cookie ✅（记到 A）
  ├─ 播放器上报进度 /x/click-interface/web/heartbeat → 不在白名单 → 用 A cookie ✅（历史记到 A）
  │     └→ ⚠️ 但**读回**进度是另一回事：playurl 响应里的 `last_play_time` / `last_play_cid`
  │        是 B 的（0），播放器据此判定"没看过" → 从 0 开始。修复见 ADR 0017
  └─ 用户评论  /x/v2/reply/add            → 不在白名单 → A cookie ✅（评论发在 A）
```

**关键洞察：白名单是"最小暴露面"设计。** 只有 7 个取流路径用 B，其余几千个接口全用 A。串号的概率等于"白名单写错"的概率，而不是"竞态条件"的概率。这是它比 cookie 切换方案优越的根本原因——**切换方案的失败模式是"时间窗口内所有请求都可能串号"，代理方案的失败模式是"白名单里多写了一个路径"。后者可控、可测、可审计。**

---

## 3. 账号与凭据管理

### 3.1 账号模型

```ts
interface Account {
  id: string;                    // uuid
  role: 'primary' | 'playback';  // 主账号 / 播放账号（对齐 bilipai 的措辞）
  mid: number;
  uname: string;
  face: string;
  vip: { status: 0 | 1; label: string; expireAt: number };
  credential: {
    sessdata: string;
    biliJct: string;             // CSRF，番剧 playview 必填
    dedeUserId: string;
    acTimeValue: string;         // cookie refresh 用
  };
  health: { lastVerifiedAt: number; cookieAgeDays: number };
}
```

**措辞对齐 bilipai**：用户说的"播放账号"是更好的命名——它准确描述了职责（只用于播放），且不带"副/次"的贬义暗示。

**这个对象不直接落盘。** `credential` 那四个字段会被 AES-GCM 加密后存进一个 `VaultRecord`，加密密钥的来路、记录结构、密钥生命周期都在 [03-open-questions.md](./03-open-questions.md) 的 **Q6** 里（那是唯一权威位置，别在这里维护第二份）。

### 3.2 凭据存储：为什么只有一档

**当前实现：随机密钥 + AES-GCM，密钥与密文同存 `chrome.storage.local`。没有主密码。**

v0.2 曾设计"三档"（主密码派生 / `storage.session` / Native Messaging），
其中"档 1 = Argon2id(用户主密码)"在实装时被推翻：口令模式**防不住本机程序**
（能读扩展存储的人同样能读 cookie 库和 DPAPI），却制造了"我加密了"的安全外观。
有安全外观、无安全实质的机制比没有更糟（[ADR 0009](./decisions/0009-drop-passphrase-mode.md)）。

威胁模型（写进 README，不许夸大）：

| | 结论 |
| --- | --- |
| ✅ 能防 | 其他网页脚本、其他扩展读不到明文 |
| ❌ 不能防 | 本机程序（同时拿得到密文与密钥） |

**不要宣称"军事级加密"。** 这是很多开源项目的通病，也是招致攻击的靶标。
未来若引入系统级保护（DPAPI / Native Messaging），属于 v2 范围，见附录 A.3。

### 3.3 身份隔离的三条铁律

**铁律 1：B 凭据绝不写入浏览器 cookie jar。**
`chrome.cookies.set()` 一律禁止用于 B 的 SESSDATA。写了就会把 A 挤下线（同设备重复登录互踢）。这条在代码 review 时要设置 lint 规则。

**铁律 2：`(sessdata, bili_jct)` 必须同源配对。**
代理层发起请求前做一次断言：这两个字段属于同一条 Account 记录。跨账号混搭会导致 `-111`（csrf 校验失败）。

**铁律 3：设备 Cookie 必须"借"而非"带"。**
`buvid3`/`buvid4`/`bili_ticket`/`_uuid`/`buvid_fp` 是**设备级**标识，B 凭据里通常没有（用户是从别处复制的 cookie）。Dual Account Helper 的做法是从当前页面 `document.cookie` 借过来补进去，这是防 `-412` 的关键。**这一条很容易漏，漏了整个方案就是"频繁 412"的体验。**

---

## 4. 取流链路（修订）

### 4.1 代理路径白名单

**唯一真相源是 `src/shared/constants/routes.ts`**。本节只记结论，**不抄清单**——抄一次就漂移一次。

v1 只有两条路径 `enabled: true`：

| 路径 | 方法 | 依据 |
|---|---|---|
| `/x/player/wbi/playurl` | GET | 普通视频 / 多 P / 互动视频都走这条（Q8 实测） |
| `/x/player/playurl` | GET | 旧版兜底，本次未观测到，保留 |
| `/pgc/player/web/playurl` | GET | 番剧 / 国创 / 电影。页面**不调用**它，由主世界主动调（[ADR 0019](./decisions/0019-pgc-async-playurl-injection.md)） |

`/pgc/player/web/v2/playurl` 与直播 2 条**仍 `enabled: false`**：
v2 实测是空壳（200 + code 0 但既无 dash 也无 durl）；直播是 v1 不做。**别顺手改 true。**

### 4.1b 响应体改写：决策 5 的两个例外

决策 5 说"不做伪装会员标识"，但**有两类精确到字段的例外**，各带一个 ADR 与路径常量，
**不许合并、不许互相顶替**：

| 常量 | 路径 | 改什么 | 授权 |
| --- | --- | --- | --- |
| `PATCH_PATHS` | `/x/web-interface/nav`、`/x/player/wbi/v2`、`/x/player/v2` | 只改 vip 的 `status` / `type` / `due_date`；**禁改 `mid` / `rights`** | [ADR 0013](./decisions/0013-patch-player-info-response.md) |
| `PROGRESS_PATCH_PATHS` | `/x/player/wbi/playurl`、`/x/player/playurl` | 只改 `last_play_time` / `last_play_cid`，把被换成"播放账号的 0"的进度还原成主账号自己的 | [ADR 0017](./decisions/0017-restore-primary-progress-in-playurl.md) |

改前者是为了让画质菜单不弹充值页；改后者是为了修"看到一半重新打开从 0 开始"。
**加路径或主机 = 扩大越权，先改 ADR 再改代码**，`scripts/check-patch-scope.mjs` 会卡死。

> 曾经这里写"Dual Account Helper 的 7 个伪装路径 v1 全部不做"——那是在 ADR 0013 之前。
> 现在的边界是**只做上表这些**，其余（如 `/pgc/view/web/season`）仍不做。

### 4.1c PGC 页：不靠 DNR，靠替换播放器的取流回调

这是 ADR 0019 引入的**第二条链路**，与 §4.1 的 DNR 是并列关系，不是替代：

| | 普通视频 `/video/*` | PGC `/bangumi/play/*` |
| --- | --- | --- |
| 取流由谁发起 | 页面自己（XHR） | 页面**不发**，SSR 写死在 HTML |
| DNR 怎么用 | 改页面的 playurl 请求头 | 改**主世界自己发起**的 PGC 请求 |
| 主世界做什么 | **藏** `__playinfo__`，逼播放器走 API | **保留** `__playinfo__`，替换 `createPlayer` 的取流回调 |
| 何时接管 | 总是 | 只在 `play_video_type === 'preview'`（免费集不接管，否则进度会记到播放账号） |

三条硬约束（每条都是实测踩出来的，见 ADR 0019）：
1. PGC 页**绝不能**藏 `__playinfo__`（藏了就是黑屏）
2. 接口响应必须**合并到 SSR 骨架**（直接替换 → `readyState=0`、黑屏且不报错）
3. 失败必须降级回原 SSR 数据，并落诊断日志（否则用户只看到"又变回试看"）

### 4.2 为什么是 DNR 换 Cookie

**架构支点**：`cookie` 在 DNR `modifyHeaders` 的白名单内，`set` / `remove` 都支持。
这是 v1 成立的前提——v0.1 曾断言"改不了"，实测推翻。

被否决的两条路：

| 方式 | 为什么不行 |
|---|---|
| SW 里 `fetch(url, { credentials: 'omit' })` + 手写 `Cookie` 头 | `Cookie` 是 forbidden header，SW 的 `fetch` 不允许设置 |
| `chrome.debugger` + CDP `Fetch.continueRequest` | 会弹"正在调试"提示条，商店政策受限，且违背决策 3 |

规则形态（一路径一条常驻规则、不带 nonce、priority 1）与实现细节见
[ADR 0006](./decisions/0006-no-per-request-nonce.md) 与 `src/platform/http/dnr.ts`。
**本文不抄代码**——`dnr.ts` 是唯一实现点，抄一份必然漂移。

**两条硬性要求**（不满足就不算实现完）：

1. **总开关**：规则常驻意味着凭据失效时所有白名单路径一起变未登录。popup 必须能一键停用，
   且**必须同时删掉全局路径规则与标签页规则两类**（只删一类会出现"界面说停了、实际还在代理"）。
2. **SW 启动自愈**：`sessionRules` 在浏览器重启后清空，SW 每次启动都要检查并重建。

> ⚠️ 原稿的"三种发送策略自动探测"（`STRATEGIES` 数组）是油猴 `GM_xmlhttpRequest` 的产物。
> 扩展用 DNR 后**不存在这个问题**——那套策略解决的是"怎么让请求不带 A 的 cookie"，
> DNR 直接 `set` 覆盖即可。整节已删除，不要照着实现。

规则**常驻不删**，只在三种时机变动：凭据变化（改值）、路径白名单变化（增删规则）、用户停用（全删）。
因此没有"加规则 → 请求 → 删规则"的生命周期，也就没有规则泄漏和并发撞车。

### 4.3 音质与画质：v0.1 判断错误的更正

**Hi-Res（FLAC in fMP4）**
- 事实：B站官方网页端**原生支持** Hi-Res 播放，走 DASH 里的 FLAC 音轨。
- 技术要求：视频须由 UP 主投 24bit / ≥48kHz 的音频；播放器侧 Chrome/Edge 原生支持 FLAC 解码。
- **结论：零额外工作**。只要 playurl 用播放账号拿到 `dash.flac.audio`，网页播放器就能播。
- 唯一注意：`fnval` 必须包含 Hi-Res 位（`+256`），v0.2 建议默认用 `4048 | 256 = 4304` 或直接 `fnval=4304`（若回退再降级）。

**杜比全景声（E-AC-3 / EC-3）**
- 事实：B站网页端**能播**，但需要两个前置条件（这是"环境问题"不是"能力问题"）：
  1. 安装 Microsoft 的 **EC-3 编码扩展**（Store 包 ID `9nvjqjbdkn97`）；Windows 10/11 通常预装。
  2. 启用 Chromium 的 **media foundation playback** 相关特性（`chrome://flags/#enable-media-foundation-clear` 等；注意新版本 Chrome 对该 flag 有调整，131+ 行为变化需实测）。
- 硬件链路：Windows 需在"声音设置"里把输出格式设为"杜比全景声家庭影院"或至少 E-AC-3 直通，且耳机/功放支持空间音频。
- **结论：扩展不需要做解码**，只需保证 playurl 的 `fnval` 含 Dolby 位（`+2048`），让播放器拿到 `dash.dolby.audio`。剩下的是用户环境配置。
- **产品动作**：做一个"音质环境自检"面板，检测系统是否有 EC-3 解码器（可查 `navigator.mediaCapabilities` 或尝试短音频播放）、并给出一键跳转安装链接。这比"假装支持"有用得多。

**修订后的 fnval 组合建议**：

| 目标 | fnval | 说明 |
|---|---|---|
| 最全（含 HDR/Dolby/Hi-Res/8K/AV1） | `4304`（= 4096+256+... 按位查表拼） | 推荐默认；若服务器拒绝再降 |
| 保守（DASH + 4K + Dolby） | `4048` | v0.1 用的值，不含 Hi-Res 位 |
| 纯 DASH | `16` | 兜底 |

> ⚠️ **不要依赖第三方文档核对位表**：`bilibili-API-collect` 已于 2026-01-28 因律师函永久关停、仓库 archived 且内容清空。实现时**必须从官方前端抓包拿真实 `fnval` 值**，再用二分法探测各位的效果。详见待确认清单 Q9。

### 4.4 番剧 OGV —— ❌ 原方案作废，改走 §4.1c 的异步取流注入

原判断：番剧新播放器走 `/ogv/player/playview`，是 **POST + 表单 + csrf + wbi 签名**三重要求，
需要按 B 的身份重算 `w_rid` 与 `csrf`。

**实测结论：这条请求根本不存在。** 番剧页零网络请求，取流结果由服务端写进 HTML，
播放器的 `reqHttpPlayUrlInfo` 直接返回 SSR 数据（证据见
[`poc/verify/RESULT.md`](../poc/verify/RESULT.md) §三）。没有可拦截的请求，重签也就无从下手。

原 WBI 重签方案**不要照着实现**；`core/wbi/signer.ts` 只服务于普通视频的 playurl。

**但这不代表 PGC 无法支持。** 2026-10-27 实测发现播放器的异步取流回调可以被替换
（删掉 `prefetch.playUrl` 后它会回退去调 `reqHttpPlayUrlInfo`），于是走
[ADR 0019](./decisions/0019-pgc-async-playurl-injection.md) 的链路，见 §4.1c。
[ADR 0007](./decisions/0007-v1-video-only-bangumi-deferred.md) 的"不支持番剧"部分已被取代。

---

## 5. 开源代码复用的可行性与风险（全部重写）

### 5.1 bilipai：从"不能复用"改判为"设计可直接照搬"

**事实更正**（来自其 v0.5.5 CHANGELOG）：
- 存在"**独立播放账号**"概念，可配置"哪个账号解锁高画质"。
- 做了"**登录完整 Cookie 按账号会话加密保存**，请求与响应固定绑定同一账号"。
- 明确写了"**高画质使用当前播放账号的 Web 登录态，不再强制追加授权**"——这句话说明它踩过"强行追加授权反而失效"的坑，值得警惕。
- 甚至有一个真实教训："**正式版（双账号）比 dev（单账号）明显更卡**"，原因是每次都重复解密解析账号配置。修复方式是"按密文记忆化"。

**能直接照搬的设计（这是 v0.2 最大的收获）**：

| bilipai 的做法 | 移植到扩展 |
|---|---|
| 多账号档案（profiles），每个账号独立凭据 | `chrome.storage.local` 里 `accounts: Account[]` + `playbackAccountId` |
| 请求与响应绑定同一账号（请求发出时锁定 accountId，响应回来时校验） | proxy.js 里带 `requestAccountId`，响应处理前断言一致（防"用户在请求飞行中切了播放账号"） |
| 凭据按账号加密、静默替换整组（扫码/密码/导入统一覆盖，避免残留旧 token） | vault.ts 的 `replaceCredential(accountId, fullSet)` 而非逐字段更新 |
| 配置解析结果**记忆化**（按密文 hash 做 key） | `Map<cipherHash, ParsedAccount>`，避免每次请求都跑 AES |
| "高画质用播放账号的 Web 登录态，不额外追加授权" | **不要**自己往 playurl 里塞 `access_key` 或额外授权参数，就用 B 的 cookie 原样发 |

**为什么记忆化对这个项目特别重要**：每个视频页的每次取流都要走一遍代理，如果每次都解密凭据会明显卡顿。
所以凭据解密后缓存在 SW 全局变量里（SW 休眠后重新解密即可）。

> ⚠️ **上表是 bilipai 的设计全貌，v1 只落地单账号那部分。**
> 多 profile（`accounts: Account[]` + `playbackAccountId`）推迟到 v1.5 ——
> v1 的 `Credential` 是单数、`vault-storage.ts` 只存一个 blob（见 [04-project-structure.md](./04-project-structure.md) §6）。
> **不要照 `replaceCredential(accountId, ...)` 这种多账号签名去实现**。
> 另外**不要用 `alarms` 保活**——SW 休眠后重新解密即可（[ADR 0015](./decisions/0015-lazy-health-check-no-alarms.md)）。

**仍然不能搬的**：代码（Kotlin + GPLv3）。以及它的播放器实现（ExoPlayer，与 Web 无关）。

### 5.2 Dual Account Helper：架构比我原判的更成熟

**更正**：它不是"切 cookie 会串号"的劣质方案，而是**共享浏览器 + 请求级代理**，与我 v0.2 设计的方向完全一致，且已经跑了很久。

它的几个值得学的细节：

| 细节 | 价值 |
|---|---|
| `anonymous: true` 排除 A cookie | 核心机制。扩展里要用 DNR 替代（见 §4.2） |
| `DEVICE_COOKIES` 列表 + 从 `document.cookie` 补齐 | **解决 -412 的关键**，非常容易漏 |
| 三种发送策略 + 实测后缓存可用策略 | 应对 B 站接口在不同客户端行为差异的务实做法 |
| 精确路径白名单（`pathname === x`，非正则） | 避免误伤。比 `*playurl*` 这种模糊匹配安全得多 |
| 主机白名单（`api.bilibili.com` / `api.live.bilibili.com`） | 防止凭据被发到第三方域名 |
| `channelToken` + 沙箱侧**二次复检** | 防止 MAIN world 被页面脚本伪造消息，让扩展用 B 的凭据请求任意 URL。**这一条是安全设计亮点**，必须学 |
| 失败即回退 A（`res.error` → 走原始请求） | 保证"扩展坏了也不影响看视频"，体验底线 |
| 伪装路径只改 VIP 显示字段 | 让 UI 一致——**但 v1 已决策不做（Q12）**，见 §4.1 |

**许可证风险（必须说清）**：
- Greasyfork 上的脚本**默认没有开源许可证**（除非作者明确写了）。按伯尔尼公约，默认是"保留所有权利"。
- 因此：**不能 fork、不能直接复制代码到你的仓库**。
- **可以做**：读它的实现理解机制、自己重写、在 README 里致谢并注明"架构思路参考"。这在法律上是安全的（思想/方法不受版权保护，具体表达受保护）。
- **建议动作**：给作者发个 issue 或邮件，问能否在 GPLv3 兼容的许可下授权代码使用。很多作者很乐意。如果拿到授权，移植成本会低很多；**但注意：本项目采用 GPLv3，若对方授权 MIT/Apache，二者兼容（可并入 GPLv3 作品），若对方坚持其他许可需重新评估**。

### 5.3 复用清单总结

| 来源 | 可复用 | 不可复用 | 许可证动作 |
|---|---|---|---|
| **bilipai** | 多账号设计、请求/账号绑定、记忆化、凭据整组替换 | 全部 Kotlin 代码、ExoPlayer 播放链 | 无需（只借鉴设计） |
| **Dual Account Helper** | 7+7 路径白名单、设备 Cookie 列表、三策略探测、channelToken 双检、失败回退 | 全部 JS 代码（无许可证） | **建议联系作者要授权** |
| **Ghost-Downloader** | 若做 v2 桌面端：WebSocket 桥、配对、离线队列、状态机 | 全部 Python 代码（GPLv3） | 不需要（v1 用不上） |
| **bilibili-API-collect** | ~~接口文档、fnval 位表、WBI 算法~~ | **已关停（2026-01-28 律师函），不可用也不建议致谢** | — |

### 5.4 跨浏览器同步 cookie：仍然无解，但缓解链更完整

v0.1 的判断不变：浏览器隔离模型下，读不到另一个浏览器的 cookie（Chrome 127+ App-Bound Encryption 进一步封堵）。

但 v0.2 要说清一件事：**这个痛点在你的场景里可能本来就不该存在。**

Dual Account Helper 的用户为什么需要"反复复制粘贴"？因为它只有油猴，没地方存凭据、没法扫码。而我们的扩展**有 background、有 storage、能发请求**，所以：

| 方案 | 可靠性 | 用户动作 |
|---|---|---|
| **① 扩展内扫码登录一次 + 长期保活**（v1 主推） | 高 | **一次扫码，之后永不操心** |
| ② 手机 B 站 App 扫码（换设备时） | 高 | 扫一下 |
| ③ 导出一份加密凭据包，另一台机器导入 | 中 | 手动搬文件 |
| ④ 直接粘 Cookie 字符串（应急） | 中 | 复制粘贴（但有了①②，基本用不到） |
| ⑤ 读浏览器 cookie 数据库 | 低 | — （且属逆向，不做） |

**关键**：把 ① 做成一等公民，④ 降级为"高级/应急"。**痛点不是靠"同步"解决，是靠"让同步变得不必要"解决。** 这一条 v0.1 说对了，v0.2 保持不变。

**保活策略（已定，见 [ADR 0015](./decisions/0015-lazy-health-check-no-alarms.md)）**：
**惰性检查，不做定时任务，也不做 `cookie/refresh`。** 只在 popup 打开（`checkedAt` 超 6 小时）、
`page/activate` 的真实取流结果、用户点"重新检查"三个时机触发。

> 本节曾写着一套 `chrome.alarms` 每 12 小时探活 + 每 6 小时 `cookie/refresh` 原子刷新的方案。
> 它与 [04-project-structure.md](./04-project-structure.md) §6「惰性，不用 alarms」长期矛盾，
> 且代码从未按它实现（`wxt.config.ts` 里没有 `alarms` 权限）。2026-10-26 由 ADR 0015 终结，此处只留结论。

---

## 6. 桌面端与跨进程通信 —— **已撤回，v1 不涉及**

**结论：v1 是纯 MV3 扩展，没有本地进程、没有跨进程通信、没有配对、没有端口。**

原 v0.2 曾用整节篇幅设计"扩展 + Rust Core + Flutter"三进程模型（WebSocket 桥、6 位配对码、离线队列、Connection State 状态机）。该方案已被 [ADR 0001](./decisions/0001-use-mv3-pure-extension.md) 撤回，理由：请求级代理在 JS 层就能完成全部取流，引入独立进程只增加维护成本。

**如果将来做 v2 桌面端**（用于跨设备凭据同步、批量下载、杜比/Hi-Res 本地播放），通信设计可参考 Ghost-Downloader 的成熟做法（WebSocket + 配对授权 + 离线队列，而非 Native Messaging）。但那属于另一个项目边界，不在本文档范围。

---

## 7. 技术选型 —— 见 [04-project-structure.md](./04-project-structure.md) §〇

**本节原内容（Rust + Flutter 选型表、flutter_rust_bridge、SQLCipher + DPAPI 等）已归档到 [附录 A](#附录-a已撤回的方案归档)，仅供参考。**

v1 的实际技术选型（WXT / TypeScript / Preact / 原生 CSS 变量 / Vitest / pnpm）在 [04-project-structure.md](./04-project-structure.md) §〇 统一维护，**不在本文档重复**——避免两处不一致。

一句话结论：**v1 用不着 Rust，也用不着 Flutter。**

---

## 8. 关键难点与限制（修订）

### 8.1 技术难点（重排优先级）

| 难点 | 严重度 | 缓解 |
|---|---|---|
| **DNR 规则的并发安全**（同时多个视频页取流） | **已消除（Q2 实测通过）** | 改为按路径的常驻规则，无 per-request 状态 → 不存在并发撞车。见 [ADR 0006](./decisions/0006-no-per-request-nonce.md) |
| ~~番剧 `/ogv/player/playview` 的 csrf + WBI 重签~~ | ~~中高~~ **已消除（Q4 实测：不存在这条请求）** | 番剧页走 SSR 注入，**playurl 一次都不发**，所以代理与重签都无从下手。v1 不支持番剧（[ADR 0007](./decisions/0007-v1-video-only-bangumi-deferred.md)），这条不再是待实现项 |
| `__playinfo__` 注入依赖前端变量名 | 中（降级为兜底手段） | 主路径已改为代理，注入只是"代理失败时的备用" |
| 设备 Cookie 补齐（防 -412） | 中 | 照搬 `DEVICE_COOKIES` 列表，从 `document.cookie` 借 |
| ~~`cookie/refresh` 原子性~~ | ~~中~~ **已取消** | 不做定时刷新，改为惰性检查（[ADR 0015](./decisions/0015-lazy-health-check-no-alarms.md)）。本节下方 §8.2 有说明 |
| 同 IP 双账号并发触发风控 | 中 | 错峰、避免 1 秒内交替；**不要默认给 B 走代理**（会引入更大问题） |
| ~~MV3 SW 休眠导致长任务中断~~ | ~~中~~ **已消除** | 没有长任务：扫码走独立窗口，取流由页面自己发起。**不要为此申请 `alarms`**（[ADR 0015](./decisions/0015-lazy-health-check-no-alarms.md)） |
| ~~主账号切换时状态同步~~ | ~~中~~ **不做** | 决策 4：主账号不归扩展管理，**不监听 `cookies.onChanged`**。主账号换号后刷新页面即可 |
| 扩展存储安全性弱于 DPAPI | 中 | 明写威胁模型（README 已落）。**只有一档**——口令模式与 `storage.session` 方案已砍（[ADR 0009](./decisions/0009-drop-passphrase-mode.md)） |

### 8.2 合规与法律限制（v0.2 增补）

1. **本质仍是绕过平台会员鉴权边界**。用户用自己合法购买的会员账号，道德上站得住，但用户协议通常禁止"非官方工具访问"和"规避技术措施"。
2. **商店下架风险高**。开源仓库 + 手动加载 zip 更现实。
3. **不伪造服务端权益**（Q12）。唯一的例外是 [ADR 0013](./decisions/0013-patch-player-info-response.md) 授权的
   vip 字段改写（只骗播放器界面，避免切画质弹充值页）；其余伪装路径仍不做，见 §4.1b。
4. **无许可证的油猴脚本不能抄代码**。只读、重写、致谢。建议联系作者要授权。
5. **凭据保管责任**：一旦泄露，用户账号可能被盗。不要在日志里打印 cookie，不要上传诊断数据（除非用户显式同意且脱敏）。
6. **不要做账号共享/出租功能**，那会把项目从灰色推向违法。

### 8.3 产品体验限制

- 浏览器需开"开发者模式"加载 zip（不上架商店，见 [ADR 0018](./decisions/0018-ship-built-artifacts.md)）。
- B站前端改版可能导致白名单路径变化 → 已有"路径失效检测 + 白名单版本号 + 升级提示"（**不做远程配置**，见 Q15）。
- 杜比/Hi-Res 需要用户环境配合（EC-3 解码扩展 + 系统音频设置），诊断页有折叠块引导（独立自检页已砍，见 [ADR 0016](./decisions/0016-drop-quality-report-page.md)）。

---

## 9. 实施路线

> **路线与目录落地的细节以 [04-project-structure.md](./04-project-structure.md) §6 为准。** 本节只说"做什么、验收什么"。

### P0：Q2 并发验证 —— ✅ **已完成（2026-10-25）**

**目标只验证一件事：DNR 临时规则在并发下会不会用错账号凭据。**

| 项 | 说明 |
|---|---|
| 做法 | 四策略对比（唯一 nonce / 常驻 + nonce / 全局单条共享 / 常驻无 nonce），20 并发 × 3 轮，用 `httpbin.org/anything` 回声服务检查 Cookie 标记是否一一对应 |
| 判据 | L1 功能 → L2 隔离（串号数=0）→ L3 回收（残留数=0），**三层都要过**。只测 L1 会漏掉"规则没删干净"这类隐患 |

> 位置、产物形态、逐轮数字见 [04-project-structure.md](./04-project-structure.md) §6「P0」。

**Go / No-Go 结果：Go。** 结论比预期更好 —— **不需要 per-request nonce**，`dnr.ts` 因此可以砍掉规则 ID 池和每请求的 add/remove，见 [ADR 0006](./decisions/0006-no-per-request-nonce.md)。串号从未出现，退路方案（串行化 / `chrome.debugger` / 本地服务）不需要启用。

> ⚠️ 与原 v0.2 的差异：原计划 P0 是"手动拿 cookie 写 MV3 扩展 hook fetch 验证画质"。现在**不做 hook**（直接用 DNR 测并发）、**不用 WXT**、**目标从"验证画质"改成"验证并发安全"**。因为画质可行性已有 Dual Account Helper 佐证，而并发安全没有任何先例可循。

### P1：骨架（3–4 天）

打通一条最小链路：**扫码登录 → 凭据加密存储 → 代理取流**。

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | WXT 初始化，`entrypoints/` + `src/` 分层落地 | ✅ |
| 2 | 扫码登录（隔离窗口 + 生成二维码 / 轮询 / 落地凭据） | ✅ |
| 3 | 凭据加密存储（AES-GCM + `chrome.storage.local`，单一模式） | ✅ |
| 4 | `platform/http/dnr.ts`（按路径常驻规则 + 总开关 + SW 启动自愈） | ✅ |
| 4b | `core/wbi/signer.ts`（`w_rid` 签名，playurl 必需） | ✅ |
| 5 | `core/identity/router.ts` + 对应单测 | ✅ TDD 编写，36 个测试，4 种变异全被抓住 |
| 6 | 单条 playurl 走通，能拿到 4K 流列表 | ✅ |
| 7 | 页面代理接到真实视频页（tabIds 限定，[ADR 0010](./decisions/0010-page-proxy-via-tab-ids.md)） | ✅ |
| 8 | 主世界脚本：藏 `__playinfo__` + 伪装本地会员状态 | ✅ 见 [ADR 0010](./decisions/0010-page-proxy-via-tab-ids.md) |

**验收**：在真实双账号环境下，主账号（无大会员）能看到并播放会员画质。

> **2026-10-25 实测（真实双账号）**：
>
> | 项 | 结果 |
> | --- | --- |
> | 主账号登录态 | **未被覆盖**（头像仍是主账号 mid={{主账号mid}}） |
> | 播放账号隔离 | ✅ 无痕分区，mid={{播放账号mid}} |
> | DNR 换 Cookie | ✅ `playurl 请求出现` → `页面实际播放 4320p` |
> | SSR 拦截 | ✅ `playinfo=hidden-or-empty`，播放器改走 API |
> | 会员状态伪装 | ✅ `已改写 /x/player/wbi/v2`，切换画质不弹框 |
> | **8K** | ✅ **7680×4320 真实播放** |
> | **HDR** | ✅ **肉眼确认生效**（高光更亮、暗部有细节） |
> | Hi-Res (FLAC) | ✅ `音轨装载成功: flac`，与杜比视界可共存 |
> | 杜比全景声 | ⚠️ 未验证——测试视频无杜比音轨，且本机缺 EC-3 解码器 |

> ⚠️ **不要用 `accept_quality` 判断。** 未登录时它就返回含 8K/4K 的假数组。
> 判据必须是 `dash.video[].height` 与 `<video>.videoHeight`。
>
> ⚠️ **`video-dynamic-range` 媒体查询不可靠。** 实测 HDR 生效时它仍返回 `standard`。
> 判断 HDR 只能靠肉眼对比与 `edge://gpu` 的 HEVC 解码项。
>
> ⚠️ **必须双账号环境。** 主账号（普通用户）登录浏览器，播放账号仅存于 vault。
> 两者相同的话，代理等于自己换自己，无法验证。

### P2：可用（约 1 周）

- **总开关 UI**（能力已在 P1 就位：`enableProxy` / `disableProxy` / `proxy/set` 消息）
- Popup 七种状态（见 [02-ui-spec.md](./02-ui-spec.md)）
- 页内角标（原生 DOM + Shadow DOM）
- 失败回退主账号 + 日志脱敏
- 设备 Cookie 补齐（防 `-412`）

> 原计划的「完整 7 个代理路径」「三种发送策略自动探测」「番剧 OGV 的 POST + WBI 重签」
> **已作废**：
> - P1 实测确认**只有 `/x/player/wbi/playurl` 一条有效**，其余 6 条在 `routes.ts` 里标 `enabled: false`
> - 「三种发送策略」是油猴 `GM_xmlhttpRequest` 的产物，扩展用 DNR 后不存在这个问题
> - 番剧 v1 不做（[ADR 0007](./decisions/0007-v1-video-only-bangumi-deferred.md)）

**验收**：装到全新浏览器，扫码一次后，任意视频页画质提升；点赞/历史仍归主账号。

**验收结果（2026-10-26，用户真机）**：

| 验收项 | 结果 |
| --- | --- |
| 任意视频页画质提升 | ✅ 4K / 8K / HDR / Hi-Res(FLAC) 均实测生效 |
| **点赞 / 历史仍归主账号** | ✅ **已验收**——代理只作用于白名单里的取流路径，社交行为全部走浏览器原生 cookie |
| 页内角标不谎报 | ✅ 单测锁住三条规则（见 [02-ui-spec.md](./02-ui-spec.md) §5） |

> **两条硬验收都过了，P2 的"可用"目标达成。** 当时界面还不完整（§2.3 未做、双账号卡片是简化版），
> 那四项已在 P3 全部补齐（见下方 P3 一节）。

> ⚠️ **杜比全景声仍未端到端验证**：测试视频没有杜比音轨。
> 这属于环境缺项，不是代码缺陷。设置页诊断分区现在会报「EC-3 解码器在不在」
> （实测 `MediaSource.isTypeSupported` 可查），但**空间音频输出链路仍只能靠用户自查**。

> **P2 曾有四项顺延到 P3**（§2.3 解锁画质、§2.4 双账号卡片、§2.6 底部按钮、角标开关），
> 全部依赖 P3 的 options 页或 `core/playinfo` 解析模块。
> **2026-10-26 已全部补齐**，清单与理由见 [04-project-structure.md](./04-project-structure.md) §6。

### P3：完善 —— ✅ **已完成（2026-10-27，六条验收全部通过）**

> 验收结果与逐条证据见 [guides/v1-acceptance-checklist.md](./guides/v1-acceptance-checklist.md)。
> **判据 5 曾不通过**：关总开关后标签页规则没被删，画质不回落（界面说停了、事实在继续）。
> 根因与修法记在那份清单里 —— 那是本次最有价值的一条。

- Options **三页**：账号 / 诊断 / 显示（原五页，2026-10-26 砍掉体检表与音质自检独立页，
  见 [ADR 0016](./decisions/0016-drop-quality-report-page.md)）
- 诊断页：自检信息 + 诊断日志 + 导出（音质自检降级为其中一个折叠块）
- 成功率条形图（✅ 2026-10-26）
- 路径失效检测（✅ 2026-10-26：白名单修订号 + 核对日期，**按失败证据报警、不按时间**；不做远程配置）
- 承接 P2 顺延的四项（§2.3 解锁画质 / §2.4 双账号卡片 / §2.6 底部两按钮 / 角标开关）

> ~~cookie 保活 / 失效恢复 / 原子刷新~~ **已移出 P3**：只做惰性检查，不做定时任务与 `cookie/refresh`，
> 理由见 [ADR 0015](./decisions/0015-lazy-health-check-no-alarms.md)。

**验收**：装到全新浏览器、扫码一次后，下面六条**同时**成立才算 P3 完成。
**2026-10-27：全部通过。** 逐条证据见 [guides/v1-acceptance-checklist.md](./guides/v1-acceptance-checklist.md)。

| # | 判据 | 怎么验（不许靠"看起来对"） |
| --- | --- | --- |
| 1 ✅ | popup §2.3 两行都有值：`已解锁 [4K][1080P60][Hi-Res]` + `主账号仅可用 1080P` | 主账号那行必须**低于**播放账号那行；两行都取自真实响应 |
| 2 ✅ | 双账号卡片并存，副标题分别是「收藏·点赞·评论·历史」与「仅取流·到期日」 | 截图核对，不是看代码 |
| 3a ✅ | options **三个分区**都能进，且**每页没有「本页尚未实现」的残留** | 直接防空壳，比"能进"硬。`Pending` 组件已删 |
| 3b ✅ | 诊断页的自检信息与迁移前的自检页**逐行一致**（16 行全同）；InPrivate 未授权时标红 | 迁移最容易漏行 |
| 3c ✅ | 音质折叠块**不显示"通过"**，只报解码器在不在 + 引导自查 | ⚠️ **原判据被实测推翻**：EC-3 **能**测（`isTypeSupported` 返回 true）。现在是三行分报，见清单 |
| 3d ✅ | 导出的 JSON 里 `grep -i sessdata` 结果为空 | 已从人工 grep 升级为**自动化测试**（4 条，含反例验证） |
| 4 ✅ | 角标可在设置里关闭，关掉后**刷新页面**不再出现 | 关开关 → 刷新 → 确认 DOM 里没有 shadow host |
| 5 ✅ | 总开关关掉 → popup 显示「已停用」；刷新后画质回落 | ⚠️ **曾不通过**：标签页规则没被删，画质不回落。判据必须看 **playurl 响应本身**，不能只看界面文案 |
| 6 ✅ | `node scripts/verify.mjs` 全绿；动过 `dnr.ts` 则 `run-q2-auto.cjs` + `dnr-disable-clears-tab-rules.cjs` 都已重跑 | — |

> **每条"通过"都要附一条能复现旧 bug 的反例验证**（AGENTS.md §1.5）：
> 把关键判据改回去，测试或现象必须变红，否则那条验收等于没验。
>
> ⚠️ **判据 5 的教训**：原来的写法只检查"popup 显示已停用"，那是**界面文案**。
> 真正的判据是"代理是否还在生效"，只能看 playurl 响应的画质上限。
> **凡是"关掉某功能"的验收，都要验副作用是否消失，不能只验开关状态。**

### v1.5+（按需，不承诺）

- Firefox 适配（DNR 行为差异需重新验证）
- 桌面端增强（跨设备同步、批量下载）
- ⏳ **单集 > 116 分钟的流地址刷新**（机制上应正常，未实测，见 `03-open-questions.md` §3a）

---

## 10. 最终建议

1. **架构上**：v1 做**纯 MV3 扩展**，采用"共享浏览器 + 请求级代理"（Dual Account Helper 已验证的模式）。v0.1 的三进程方案是过度设计，撤回。

2. **技术上**：MV3 下用 **DNR 动态规则 `set` Cookie 请求头** 来替代油猴的 `anonymous:true`。这是本次调研最重要的技术结论——DNR **能**改 Cookie 头，v0.1 判断错误。

3. **音质上**：Hi-Res 和杜比浏览器**都能播**，官方网页端已支持。扩展只需保证 `fnval` 含对应位；杜比还需用户装 EC-3 解码扩展 + 开系统空间音频。**做一个环境自检面板**，别自己实现解码。

4. **复用上**：
   - Dual Account Helper 的**路径白名单和工程细节是高价值资产**，但**代码无许可证不能抄**，只重写；建议联系作者要授权。
   - bilipai 的**多账号设计可以直接照搬**（播放账号、请求/账号绑定、凭据记忆化、整组替换），代码不能抄（GPLv3 + Kotlin）。

5. **痛点上**："跨浏览器同步 cookie"仍无解，但**扫码登录 + 长期保活让这个痛点变得不必要**。这是正确的产品解法。

6. **桌面端**：**不做**（ADR 0001）。原 v0.1 的三进程方案是过度设计。若将来真需要，Windows 单平台选 C#+WPF 比 Rust+Flutter 更省事；选 Rust 的理由应该是跨平台诉求。

7. **先做 P0 的 Q2 验证（半天）**，且**完全独立于主项目、不用 WXT**。目标不是"验证能不能拿到高画质"（那已有先例），而是"验证 DNR 在并发下会不会串号"（那没有任何先例）。**这是唯一可能推翻架构的未知数。**

8. **协议与分发**：**GPL-3.0-only + 第 7 条附加条款**（防商业化、防改名冒充官方）。**不上架商店、不发 crx；可发 zip，但必须同时提供带源码版本**（[ADR 0018](./decisions/0018-ship-built-artifacts.md)）。但别指望协议能保护你——B站已对 PiliPala、bilibili-API-collect、downkyi 实际发函并导致关停。真正的风控是**守住"不绕过付费墙"的能力边界**（Q4）和**降低分发暴露面**（Q16）。

9. **心态上**：把 Pluma 当作技术实践项目，而不是要长期运营的产品。它的生命周期可能很短，这是品类属性而非个人能力问题。

---

## 附：v0.1 错误清单（供 code review 时避免重犯）

| 错误 | 后果 | 教训 |
|---|---|---|
| 断言"浏览器播不了杜比/Hi-Res" | 把主功能降级为"下载后播放"，产品定位缩水 | **先验证官方能力边界，再判断技术可行性**。官方网页端能播的，扩展一定能拿到 |
| 断言"bilipai 无多账号设计" | 低估参考价值，重复造轮子 | 读 CHANGELOG 而不只是 README。**实现细节往往藏在性能优化条目里** |
| 断言"DNR 不能改 Cookie 头" | 设计了复杂的 debugger 方案 | 查官方文档的白名单，而不是凭印象 |
| 把 Dual Account Helper 当反例 | 差点自己发明已存在的轮子 | **先读懂参照实现的机制，再下"它是劣质方案"的结论** |
| 直接上三进程架构 | 过度设计，v1 成本翻倍 | **先用最小可行形态验证，再决定要不要加进程** |
| 假设第三方文档永远可查 | Q9 的验证路径一度建立在已关停的 bilibili-API-collect 上 | **关键参数以官方前端抓包为准**，别把第三方文档当长期依赖 |
| 技术选型只看单项优劣 | WXT 约定 vs 自定目录、Preact vs Shadow DOM、Vitest vs DNR 全是组合冲突 | **选型要验证组合兼容性，不是逐项打分** |
| 随口写具体版本号（TS 5.7） | 被人追问"为什么是 5.7"时答不上来 | **版本写范围（`^5.9`），不写没依据的精确值** |

---

## 附录 A：已撤回的方案归档

> 以下内容**全部不适用于 v1**，仅作为历史记录保留，避免将来重复犯错。看这些内容前请先确认你没被绕进去。

### A.1 三进程方案（v0.1，已撤回）

原设计：`浏览器扩展 + Rust Core 常驻进程 + Flutter GUI`，理由是"扩展拿不到高画质，必须由本地服务持副账号身份独立取流"。

**撤回原因**：Dual Account Helper 证明请求级代理在 JS 层就能完成全部取流，引入独立进程只增加两套语言、FFI 绑定、安装签名、自动更新的维护成本。见 [ADR 0001](./decisions/0001-use-mv3-pure-extension.md)。

### A.2 跨进程通信设计（v0.1，已撤回）

原设计：WebSocket 桥（`ws://127.0.0.1:<动态端口>/bridge`）+ 6 位配对码 + 扩展侧离线队列 + Connection State 状态机（missing_token / connecting / authenticating / connected / unauthorized / disconnected）。

**撤回原因**：同 A.1，v1 没有第二个进程。

**若 v2 做桌面端**，这套设计仍有参考价值（优于 Native Messaging：免注册 host manifest、跨浏览器一致）。届时再启用。

### A.3 Rust + Flutter 选型（v0.2，已归档）

| 模块 | 曾考虑的选型 | 备注 |
|---|---|---|
| Core | Rust 2021 + tokio + axum | 单二进制 |
| HTTP | `rquest`（TLS 指纹模拟）优先，`reqwest` 兜底 | B站 CDN 对指纹可能敏感 |
| 凭据 | `rusqlite` + SQLCipher + Windows DPAPI | 比扩展的档 1 强一个层级 |
| 加密 | `argon2` + `chacha20poly1305` + `secrecy` + `zeroize` | 标准组合 |
| Flutter ↔ Rust | `flutter_rust_bridge` v2 | **粗粒度 API**，别做成细粒度 RPC |
| 进程模型 | Core 独立进程，Flutter 只做客户端 | Flutter 崩了不影响后台 |
| 播放 | WebView2 或外挂本地播放器 | 别用 Flutter 的 `video_player` |

**若 v2 真要做桌面端**，且只针对 Windows，**C# + WPF/WinUI3 + WebView2 的总成本比 Rust + Flutter 更低**（WebView2 是微软自家组件）。选 Rust 的唯一硬理由是"要跨平台"。

### A.4 "劫持 + 重放 + 伪造响应"（v0.1，已删除）

原设计：劫持播放器的 heartbeat 请求 → Core 用主账号身份重放 → 向播放器返回伪造的 200，用来同时满足"高画质"和"历史归主"。

**删除原因**：采用请求级代理后，浏览器全程是主账号，历史天然归主，**这段逻辑完全不需要**。

这是架构选型带来的最大红利：**不是"更优雅地解决了问题"，而是"让问题不存在"。**


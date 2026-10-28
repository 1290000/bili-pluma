# Pluma

<img src="public/icon/128.png" width="96" alt="Pluma 图标">

> **B站双账号画质助手** —— 用主账号浏览、点赞、收藏、评论，让一个大会员账号专门负责播放。

GPL-3.0-only · Chrome 120+ / Edge · 当前 v0.9.0（未进 1.0，仍在观察期）

**用之前请确认：**本工具与哔哩哔哩官方无关联，未获授权或认可。B站用户协议通常禁止通过非官方工具访问服务，**本工具的行为可能被视为违反该协议**。如果这不可接受，请不要使用；也不要用它做账号共享、出租、售卖。因使用产生的账号风险由使用者自行承担。

---

## 它做什么

浏览器里有两个身份，职责完全分开：

| 身份 | 存在形式 | 负责 |
| --- | --- | --- |
| **主账号** | 浏览器自己的登录态，扩展不碰 | 收藏 · 点赞 · 评论 · 投币 · 播放历史 |
| **播放账号**（大会员） | 扩展加密存储的凭据 | 仅提供取流，解锁 4K / 1080P60 / HDR / 杜比 / Hi-Res |

原理是**请求级身份代理**：浏览器全程保持主账号登录，扩展只在白名单取流接口换一套凭据重发。**不切 cookie、不写 cookie jar，主账号会话全程没被动过。**

为了让画质菜单不被拦截、续播能接上，扩展会改写播放器读到的**会员状态**和**观看进度**，只影响本地判断，服务端权益不变（[ADR 0013](./docs/decisions/0013-patch-player-info-response.md) · [ADR 0017](./docs/decisions/0017-restore-primary-progress-in-playurl.md)）。

## 它不做什么

- ❌ 不绕过付费墙（会员番剧/电影仍需购买）· 不解锁地区限制 · 不伪造服务端权益
  （上面说的"改写会员状态"只骗播放器界面，账号实际权益不变）
- ❌ **不解锁你没有的权益**：4K / 1080P60 来自你登录的大会员账号，没有大会员就没有这些画质；
  会员专享的番剧 / 国创 / 电影同理——**播放账号本身要有该内容的观看权**（没买的单片、地区限制的内容照样看不了）
- 🚧 **番剧 / 国创 / 电影：源码已支持，随下一版发布**（[ADR 0019](./docs/decisions/0019-pgc-async-playurl-injection.md) – [ADR 0023](./docs/decisions/0023-intercept-playview-durl-swap.md)）。
  **`0.9.0` 的 zip 里没有**，想现在用请从源码构建
  - 主账号只能试看的集数会自动改用播放账号取流；免费集不接管——主账号本来就能看，接管只会把观看进度记到播放账号上
- ❌ **不支持直播**——这是决定，不是遗漏

---

## 安装

### 下载现成产物

1. 去 **Releases** 下载 `pluma-<版本>.zip`，解压
2. 打开 `edge://extensions/`（Chrome 是 `chrome://extensions/`），开「开发者模式」
3. 点「加载已解压的扩展程序」，选中 `pluma-<版本>` 文件夹（那层应能看到 `manifest.json`）
4. 点「详细信息」→ 打开「在 **InPrivate** 中允许」（Chrome 叫「在无痕模式下启用」）→ 重新加载
   **不能省**，否则扫码窗口打不开（产物未经商店签名，仅供学习交流）

### 从源码构建

前置 Node.js 20+、pnpm（版本见 `package.json` 的 `packageManager`）。`pnpm install && pnpm build` 后，第 3 步改选 **`.output/chrome-mv3`**。

### 装好之后

1. 点工具栏的 Pluma 图标
2. 点「扫码登录播放账号」，用大会员账号扫码（独立窗口，不影响当前登录）
3. 打开任意 B站视频，画质菜单里会出现 4K / 1080P60

popup 里应显示「已接管」——这是生效的标志。

---

## 凭据如何存储

凭据以 **AES-GCM** 加密存在本地，密钥也在本地，不上传任何服务器。

- ✅ 能防：其他网页脚本与扩展读到明文
- ❌ 不能防：本机程序（能读本机文件的同时拿得到密文和密钥）

`cookies` 权限只在扫码那一刻读一次，不读主账号（[ADR 0008](./docs/decisions/0008-cookies-permission-for-playback-credential.md)）。

## 音质需要你的环境配合

**Hi-Res** 通常开箱可用；**杜比全景声**需三条同时成立，缺一条就放不出，详见 [docs/guides/audio-environment.md](./docs/guides/audio-environment.md)。

## 接手这个项目

- **AI 代理 / 新来的开发者：先读 [AGENTS.md](./AGENTS.md)**
- **clone 后先跑一次** `git config core.hooksPath .githooks`
  —— 提交时会自动检查敏感信息，见 [.githooks/README.md](./.githooks/README.md)
- 改完代码跑 `node scripts/verify.mjs`（`--help` 看检查项）
- 文档索引：[docs/README.md](./docs/README.md)　未决问题：[docs/03](./docs/03-open-questions.md) §0

## 致谢

设计思路受益于 **Bili Dual Account Helper**（请求级身份代理）、**BiliPai**（多账号设计）。**均未使用其源代码。** 如有异议请联系删除致谢。

## 许可证

[GPL-3.0-only](./LICENSE) + [附加条款](./ADDITIONAL-TERMS.md)。可自由使用、修改、分发，但衍生作品须同样开源。

## 声明

本项目与哔哩哔哩（bilibili.com）官方无任何关联，未获授权或认可。**可能随时停止维护，请当作技术实践而非长期依赖。**

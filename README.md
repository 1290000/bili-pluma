<p align="center">
  <img src="public/icon/128.png" width="96" alt="Pluma">
</p>

<h1 align="center">Pluma</h1>

<p align="center"><b>B站助手 · 画质与净化</b></p>

<p align="center">主账号浏览、点赞、收藏；另一个大会员账号专门负责取流。</p>

<p align="center">
  <a href="https://github.com/1290000/bili-pluma/releases"><img src="https://img.shields.io/github/v/release/1290000/bili-pluma?label=Release&logo=github&logoColor=white&color=2f81f7" alt="Release"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
  <a href="https://github.com/1290000/bili-pluma/blob/main/LICENSE"><img src="https://img.shields.io/github/license/1290000/bili-pluma?label=license&color=e05d44" alt="License"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
</p>

<p align="center">
  <a href="https://t.me/Pluma129">Telegram 频道</a>　·　<a href="https://t.me/pluma666">Telegram 交流群</a>
</p>

> ⚠️ **与哔哩哔哩官方无任何关联，未获授权或认可。** B站用户协议通常禁止通过非官方工具访问服务，本工具的行为可能被视为违反该协议。不接受请不要使用，也不要用于账号共享、出租、售卖。**可能随时停止维护 —— 请当作技术实践，而非长期依赖。**

## 它是什么

浏览器里有两个身份，职责完全分开：

| 身份 | 负责 |
| --- | --- |
| **主账号**（浏览器自己的登录态，扩展不碰） | 收藏 · 点赞 · 评论 · 投币 · 播放历史 |
| **取流账号**（大会员，扩展加密保存） | 只负责取流 —— 按它**自己的会员权益**拿到 4K / 1080P60 / HDR / 杜比 / Hi-Res |

做法是**请求级身份代理**：只在白名单取流接口上换一套凭据重发。**不切 cookie、不写 cookie jar**，主账号会话全程没被动过。

为了让画质菜单出现、续播接得上，扩展会改写播放器读到的**会员状态**和**观看进度** —— 只影响本地判断，服务端权益不变（[ADR 0013](./docs/decisions/0013-patch-player-info-response.md) · [ADR 0017](./docs/decisions/0017-restore-primary-progress-in-playurl.md)）。

## 它不做什么

- 不绕过付费墙、不解锁地区限制、不伪造服务端权益 —— **取流账号本身要有该内容的观看权**
- 番剧 / 国创 / 电影：主账号只能试看的集数改由取流账号取流；**免费集不接管**（接管只会把进度记到取流账号上）
- 不支持直播 —— 这是决定，不是遗漏

## 安装

需要 Chrome 120+ 或 Edge。

1. 从 [Releases](https://github.com/1290000/bili-pluma/releases) 下载 `pluma-<版本>.zip`，解压到**固定文件夹**（以后更新会覆盖这里）<!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
2. 打开 `edge://extensions`（Chrome 用 `chrome://extensions`），开启「开发者模式」
3. 点「加载已解压的扩展程序」，选中解压出的文件夹（那层应能看到 `manifest.json`）
4. 点「详细信息」→ 打开「在 **InPrivate** 中允许」（Chrome 叫「在无痕模式下启用」）→ 重新加载
   **不能省**，否则扫码窗口打不开

装好后：点工具栏图标 → 「扫码登录取流账号」（独立窗口，不影响当前登录）→ 打开任意视频，画质菜单里会出现 4K / 1080P60。

**更新**：面板「关于」→「检查更新」→「立即更新」。第一次指定一次扩展目录，之后最多再点一次「允许」，不掉登录态。

## 凭据怎么存

**AES-GCM 加密存在本地，密钥也在本地，不上传任何服务器。**

- 能防：其他网页脚本与扩展读到明文
- 不能防：本机程序 —— 能读本机文件，就同时拿得到密文和密钥

`cookies` 权限只在扫码那一刻读一次，**不读主账号**（[ADR 0008](./docs/decisions/0008-cookies-permission-for-playback-credential.md)）。会记住主账号昵称（不含 mid 与凭据、不记录你看过什么，7 天过期，退出即清，[ADR 0025](./docs/decisions/0025-cache-primary-display-profile.md)）。

**Hi-Res** 通常开箱可用；**杜比全景声**要三条同时成立，缺一条就放不出 —— 见 [audio-environment.md](./docs/guides/audio-environment.md)。

## 从源码构建

Node.js 20+、pnpm（版本见 `package.json` 的 `packageManager`）。`pnpm install && pnpm build` 后，安装第 3 步改选 **`.output/chrome-mv3`**。

## 开发

- **先读 [AGENTS.md](./AGENTS.md)**
- clone 后跑一次 `git config core.hooksPath .githooks` —— 提交时自动检查敏感信息
- 改完跑 `node scripts/verify.mjs`（`--help` 看检查项）
- 文档索引 [docs/README.md](./docs/README.md)　未决问题 [docs/03-open-questions.md](./docs/03-open-questions.md) §0

## 致谢

思路受益于 **Bili Dual Account Helper**、**BiliPai**、**Ghost-Downloader-3**（界面形态），**均未使用其源代码**。
页内视觉清理的选择器与分类判据来自 **Bilibili-Evolved**（MIT，作者 the1812 与 RieN7），**使用了其源码中的选择器清单**，版权与许可原文见 [NOTICE.md](./NOTICE.md)。

## 许可证

[GPL-3.0-only](./LICENSE) + [附加条款](./ADDITIONAL-TERMS.md)。可自由使用、修改、分发，但衍生作品须同样开源。

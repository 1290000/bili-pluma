<p align="center">
  <img src="public/icon/128.png" width="96" alt="Pluma">
</p>

<h1 align="center">Pluma</h1>

<p align="center"><b>B站助手 · 画质与净化</b></p>

<p align="center">主账号浏览、点赞、收藏；另一个大会员账号负责取流。</p>

<p align="center">
  <a href="https://github.com/1290000/bili-pluma/releases"><img src="https://img.shields.io/github/v/release/1290000/bili-pluma?label=Release&logo=github&logoColor=white&color=2f81f7" alt="Release"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
  <a href="https://github.com/1290000/bili-pluma/blob/main/LICENSE"><img src="https://img.shields.io/github/license/1290000/bili-pluma?label=license&color=e05d44" alt="License"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
</p>

<p align="center">
  <a href="https://t.me/Pluma129">Telegram 频道</a>　·　<a href="https://t.me/pluma666">Telegram 交流群</a>
</p>

> ⚠️ 与哔哩哔哩官方无关联，未获授权或认可。使用可能违反 B站用户协议，风险自负；请勿用于账号共享或售卖。可能随时停止维护。

## 它是什么

浏览器保持主账号登录；扩展只在**白名单取流接口**上，用另一个大会员账号的凭据重发该请求 —— 不切 cookie，主账号会话全程没被动过。

| 身份 | 用途 |
| --- | --- |
| **主账号**（浏览器自己的登录态） | 收藏 · 点赞 · 评论 · 投币 · 播放历史 |
| **取流账号**（大会员，扩展加密保存） | 只负责取流，按它自己的会员权益出 4K / 1080P60 / HDR / 杜比 / Hi-Res |

画质菜单能出现、续播能接上，靠改写播放器读到的**会员状态**与**观看进度**；只影响本地判断，服务端权益不变。

## 不做什么

- 不绕过付费墙、不解锁地区限制 —— **取流账号本身要有该内容的观看权**
- 番剧 / 国创 / 电影：主账号只能试看的集数改由取流账号取流；**免费集不接管**
- 不支持直播

## 安装

需要 Chrome 120+ 或 Edge。

1. 从 [Releases](https://github.com/1290000/bili-pluma/releases) 下载 `pluma-<版本>.zip`，解压到固定文件夹<!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
2. `edge://extensions`（Chrome 用 `chrome://extensions`）→ 开启「开发者模式」
3. 点「加载已解压的扩展程序」，选中那个文件夹
4. 「详细信息」→ 打开「在 **InPrivate** 中允许」→ 重新加载 —— **不能省**，否则扫码窗口打不开

## 使用

1. 打开任意 B站 页面，鼠标贴到**页面最左边缘** → 面板滑出
2. 「账号」→ 扫码登录取流账号（独立窗口，不影响当前登录）
3. 「画质」→ 打开「自动接管取流」
4. 播放时画质菜单里会出现 4K / 1080P60

**更新**：面板「关于」→ 检查更新 → 立即更新。第一次指定一次扩展目录，之后最多再点一次「允许」，不掉登录态。

## 凭据

AES-GCM 加密存在本地，密钥也在本地，不上传服务器。能防其他网页与扩展读明文，**防不住本机程序**。

`cookies` 权限只在扫码那一刻用一次，不读主账号。会记住主账号昵称（不含 mid 与凭据，7 天过期，退出即清）。

杜比全景声需要环境配合，见 [audio-environment.md](./docs/guides/audio-environment.md)。

## 开发

- 先读 [AGENTS.md](./AGENTS.md)；clone 后跑一次 `git config core.hooksPath .githooks`
- 改完跑 `node scripts/verify.mjs`
- 自己构建：Node 20+ / pnpm，`pnpm install && pnpm build`，加载 `.output/chrome-mv3`

## 致谢与许可

思路受益于 **Bili Dual Account Helper**、**BiliPai**、**Ghost-Downloader-3**（界面形态），均未使用其代码；页内清理的选择器来自 **Bilibili-Evolved**（MIT），见 [NOTICE.md](./NOTICE.md)。

[GPL-3.0-only](./LICENSE) + [附加条款](./ADDITIONAL-TERMS.md)。

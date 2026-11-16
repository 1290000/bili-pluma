<p align="center">
  <img src="public/icon/128.png" width="96" alt="Pluma">
</p>

<h1 align="center">Pluma</h1>

<p align="center"><b>B站助手 · 画质与净化</b></p>

<p align="center">把会员账号能看的画质在播放器里放出来，把广告和不想看的推荐清掉。</p>

<p align="center">
  <a href="https://github.com/1290000/bili-pluma/releases"><img src="https://img.shields.io/github/v/release/1290000/bili-pluma?label=Release&logo=github&logoColor=white&color=2f81f7" alt="Release"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
  <a href="https://github.com/1290000/bili-pluma/blob/main/LICENSE"><img src="https://img.shields.io/github/license/1290000/bili-pluma?label=license&color=e05d44" alt="License"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
</p>

<p align="center">
  <a href="https://t.me/Pluma129">Telegram 频道</a>　·　<a href="https://t.me/pluma666">Telegram 交流群</a>
</p>

> ⚠️ 与哔哩哔哩官方无关联，未获授权或认可。使用可能违反 B站用户协议，风险自负；请勿用于账号共享或售卖。可能随时停止维护。

## 功能

| | |
| --- | --- |
| **画质** | 画质菜单里多出 4K / 1080P60 / HDR / 杜比全景声 / Hi-Res，能出哪些取决于你登录的那个大会员账号的权益 |
| **净化** | 删广告与推广，可保留活动横幅，可隐藏首页大图与分类 |
| **页内角标** | 播放器右下角显示当前身份与画质 |

> 取流账号只负责取流：收藏、点赞、评论、投币、历史仍记在主账号上，不切 cookie。

## 不做什么

- 不绕过付费墙、不解锁地区限制 —— **取流账号本身要有该内容的观看权**
- 番剧 / 国创 / 电影：主账号只能试看的集数改由取流账号取流；**免费集不接管**

## 安装

需要 Chrome 120+ 或 Edge。

1. 从 [Releases](https://github.com/1290000/bili-pluma/releases) 下载 `pluma-<版本>.zip`，解压到固定文件夹<!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
2. `edge://extensions`（Chrome 用 `chrome://extensions`）→ 开启「开发者模式」
3. 点「加载已解压的扩展程序」，选中那个文件夹

## 使用

1. 打开任意 B站 页面，鼠标贴到**页面最左边缘** → 面板滑出
2. 「净化」勾掉不想看的；「显示」调页内角标与首页推荐流
3. 想要更高画质：「账号」扫码登录一个大会员账号 —— 若提示需要「在 InPrivate 中允许」，按面板的引导去开一下，再回「画质」打开「自动接管取流」
4. 播放时画质菜单里就会出现对应档位

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

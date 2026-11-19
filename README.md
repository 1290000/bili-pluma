<p align="center">
  <img src="public/icon/128.png" width="96" alt="Pluma">
</p>

<h1 align="center">Pluma</h1>

<p align="center"><b>画质 · 净化 · 线路诊断 —— B站 网页扩展（Chrome / Edge）</b></p>

<p align="center">B站网页的画质，按会员权益解锁；广告和推荐位，按你的意思清理。</p>

<p align="center">
  <a href="https://github.com/1290000/bili-pluma/releases"><img src="https://img.shields.io/github/v/release/1290000/bili-pluma?label=Release&logo=github&logoColor=white&color=2f81f7" alt="Release"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
  <a href="https://github.com/1290000/bili-pluma/blob/main/LICENSE"><img src="https://img.shields.io/github/license/1290000/bili-pluma?label=license&color=e05d44" alt="License"></a><!-- secrets-ok: 仓库所有者用户名，公开信息，非凭据 -->
</p>

<p align="center">
  <a href="https://t.me/Pluma129">Telegram 频道</a>　·　<a href="https://t.me/pluma666">Telegram 交流群</a>
</p>

## 功能

| 组 | 能力 |
| --- | --- |
| **画质** | 登录一个大会员账号取流，画质菜单里出现 4K / 1080P60 / HDR / 杜比视界 / Hi-Res |
| | 只换取流身份 —— 收藏 / 点赞 / 投币 / 历史仍记在主账号，不切 cookie |
| | 番剧 / 国创 / 电影：主账号只能试看的集数改由取流账号取流 |
| | 首页推荐流可单独切到取流账号 |
| **净化** | 删广告与推广；可保留活动横幅；「调试模式」用红框标出命中项 |
| | 隐藏首页顶部大图，按分类隐藏专题推荐位（9 类：直播 / 番剧 / 国创 / 综艺 / 课堂 / 电影 / 电视剧 / 纪录片 / 漫画） |
| | 清理直播间水印 |
| **线路** | 屏蔽 PCDN 线路，把候选换成官方镜像 |
| | 加载时间轴：第几秒发出请求、走的哪条线路、有没有换线 |
| | 屏蔽没换成时如实说原因，不谎报成功 |
| **面板** | 鼠标贴页面最左边缘滑出，五个 Tab：画质 / 净化 / 显示 / 账号 / 关于 |
| | 页内角标：接管生效时，右下角显示实际分辨率 / 帧率 / 音频编码 |
| | 悬停预览、点击钉住 |
| **诊断与更新** | 自检信息 + 日志，可导出 JSON（不含凭据） |
| | 面板内检查更新并一键安装，不掉登录态 |

## 不做什么

- 不绕过付费墙、不解锁地区限制 —— **取流账号本身要有该内容的观看权**
- 免费集不接管（主账号本来就能看，接管只会把进度记到取流账号名下）

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

AES-GCM 加密存在本地，密钥也在本地，不上传服务器。

`cookies` 权限只在扫码那一刻用一次，不读主账号。会记住主账号昵称（不含 mid 与凭据，7 天过期，退出即清）。

杜比全景声需要环境配合，见 [audio-environment.md](./docs/guides/audio-environment.md)。

## 开发

- 先读 [AGENTS.md](./AGENTS.md)；clone 后跑一次 `git config core.hooksPath .githooks`
- 改完跑 `node scripts/verify.mjs`
- 自己构建：Node 20+ / pnpm，`pnpm install && pnpm build`，加载 `.output/chrome-mv3`

## 致谢

| 来源 | 关系 |
| --- | --- |
| **Bilibili-Evolved**（the1812、RieN7，MIT） | 页内清理与首页分类的选择器、判据 —— **有代码级复用** |
| **DSH / deepseek-harness** | 面板底板与浮层的材质、描边、状态色配方 |
| **Bettbox** | 加载时间轴的界面形态（结论卡 + 时间轴 + 图例，细节收进二级浮层） |
| **SuperLyric** | 加载速览行的信息层级（状态胶囊 + 等宽计数） |
| **bdFun**（GPL-3.0） | PCDN 换 host 的设计思路与镜像清单 |
| **BiliPai**（GPLv3） | 多账号设计；PCDN 规则清单与其同源 |
| **Bili Dual Account Helper** | 请求级身份代理思路 |

Bilibili-Evolved 与 DSH 有实质复用，其余未用其代码。逐项出处见 [NOTICE.md](./NOTICE.md)。

## 许可证与声明

[GPL-3.0-only](./LICENSE) + [附加条款](./ADDITIONAL-TERMS.md)。可自由使用、修改、分发，衍生作品须同样开源。

本项目为非官方扩展，与哔哩哔哩（bilibili.com）无隶属关系，未获授权或认可。**不破解任何加密，不绕过付费墙** —— 只在你自己账号已有的权益范围内改写播放器读到的判断。勿用于账号共享、出租或售卖。凭据只加密保存在本地。

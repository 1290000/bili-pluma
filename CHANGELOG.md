# CHANGELOG

> 只记**用户能感知的变化**。内部重构、测试补充、文档调整不进这里。
>
> 措辞规则见 [docs/guides/release-notes-template.md](./docs/guides/release-notes-template.md)：
> 中性动词，不用「破解」「解锁会员」「一键安装」「开箱即用」。

---

## 0.9.0

首个公开版本。

### 双账号分离

- 浏览器全程保持主账号登录，收藏、点赞、评论、投币、播放历史都记在主账号
- 取流按播放账号的权益走，支持 4K / 1080P60 / HDR / 杜比视界 / Hi-Res
- 播放账号凭据以 AES-GCM 加密存在本地，不上传任何服务器
- 观看进度跟随主账号，切换账号不会让视频从头开始

### 界面

- popup 显示当前状态与播放账号信息
- 页内角标显示是否已接管
- 设置页三个分区：账号 / 诊断 / 显示
- 诊断页可查看账号状态、音质环境自检、诊断日志，并导出一份便于排查的压缩包

### 安装

- Chrome 120+ / Edge，两个浏览器共用同一份产物
- 需要在扩展详情页手动打开「在 InPrivate 中允许」（Chrome 叫「在无痕模式下启用」）
- 也可以从源码构建：`pnpm install && pnpm build`，加载 `.output/chrome-mv3`

### 已知限制

- 不支持番剧 / 直播
- 不解锁地区限制
- 会员专享番剧、电影仍需购买

### 许可证

GPL-3.0-only + 附加条款，见 [LICENSE](./LICENSE) 与 [ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md)。

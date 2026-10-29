/**
 * 页内角标的状态与绘制入口（S3.2，2026-10-30 从 `entrypoints/content.ts` 下沉）
 *
 * ## 为什么单独一个模块
 *
 * 角标是 `content.ts` 里**最独立的一类职责**：它只读状态、调 `renderBadge` /
 * `removeBadge`，不参与 PGC 编排、不碰消息协议。留在一个 2000+ 行的入口文件里，
 * 改角标要在十几个消息分支之间翻找调用点。
 *
 * ## ⚠️ 本轮只下沉"状态定义 + 绘制入口"，`badgeState` 实例仍留在入口
 *
 * 原计划连实例一起搬，但实测发现它被 **8 处读写**、`paintBadge()` 被 **8 处调用**
 * （见方案 §3.2 的风险评估）。一次性搬走要改 16 处调用点 —— 那属于"在无法被
 * 反例覆盖的地方做大范围机械改动"。
 *
 * 所以本轮：
 *   - **搬走**：类型定义、初始状态工厂、绘制入口 `paintBadge()`
 *   - **留下**：`badgeState` 实例（入口里仍是同一个对象）
 *
 * 等 S3.4 消息泵路由表化之后，调用点会收敛成少数几个，那时再搬实例。
 *
 * ## ⚠️ 所有字段都来自主世界的实际观测
 *
 * 不用 `accept_quality` 之类的接口字段 —— 后者在未登录时就会返回含 8K 的
 * 完整数组，拿它展示等于骗用户。
 */

/** 角标需要的状态。字段全部来自主世界观测（见文件头） */
export interface BadgeState {
  /** 本页是否真的装上了代理规则（未配置 / 同账号 / 出错都是 false） */
  proxying: boolean;
  /** 当前播放画质高度（0 = 未知） */
  playingHeight: number;
  /** 视频编码族（如 `HEVC` / `AV1`） */
  videoFamily: string;
  /** 音频编码族 */
  audioFamily: string;
  /** 当前轨道的实际帧率（0 = 未知） */
  frameRate: number;
  /**
   * 浏览器 `(video-dynamic-range: high)` 的结果。
   *
   * 用来消除"SDR 的 HEVC 被误标成 HDR"：B站会给普通 4K 转 HEVC 省码率，
   * 那种轨也是 HEVC 但属于 SDR，只有浏览器确认是 HDR 才标徽章。
   */
  videoDynamicRange: boolean | null;
  /**
   * `(dynamic-range: high)` 的结果 —— **显示设备**是否支持 HDR。
   *
   * 与 `videoDynamicRange`（视频通道是否以 HDR 呈现）是两个不同的量：
   *   - display: high → 屏幕/系统开了 HDR
   *   - video: high   → 这条视频真的在走 HDR 输出
   *
   * 实测发现 `video` 会误报 standard（尤其 AV1 编码的 HDR 轨），
   * 所以判断 HDR 时必须两个信号一起看。
   */
  displayDynamicRange: boolean | null;
  /** HEVC 的 profile 段（如 `2.4.L153.90`），用于详情里标 10bit */
  hevcProfile: string;
  /**
   * 本视频是否**提供**杜比视界版本（来自服务端 `dash.dolby.vision`）。
   *
   * ⚠️ 是"视频能力"不是"当前播放状态"。只用在详情，
   * 不能当主文案 —— 否则就成了"视频有 DV 轨"说成"你在看 DV"。
   */
  dolbyVisionAvailable: boolean;
}

/** 一份全零初始状态。`proxying` 为 false —— 未接管前不画「已接管」 */
export function createBadgeState(): BadgeState {
  return {
    proxying: false,
    playingHeight: 0,
    videoFamily: '',
    audioFamily: '',
    frameRate: 0,
    videoDynamicRange: null,
    displayDynamicRange: null,
    hevcProfile: '',
    dolbyVisionAvailable: false,
  };
}

/** 绘制依赖，由入口注入（保持本模块不直接 import 渲染与样式） */
export interface BadgePainter {
  /** 画（或更新）角标 */
  render: (tokensCss: string, state: BadgeState) => void;
  /** 摘掉角标 */
  remove: () => void;
  /** shadow root 用的样式文本 */
  tokensCss: string;
}

/**
 * 重画角标。**所有字段变化后统一调这一个入口**。
 *
 * @param enabled 用户是否允许显示角标（设置页「显示」分区）。
 *   关掉时不只是"不画"，还要把已经画出来的**摘掉** —— 否则用户关掉开关后
 *   角标会一直留在页面上，直到刷新。
 */
export function paintBadge(state: BadgeState, enabled: boolean, painter: BadgePainter): void {
  if (!enabled) {
    painter.remove();
    return;
  }
  painter.render(painter.tokensCss, state);
}

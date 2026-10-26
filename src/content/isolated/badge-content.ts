/**
 * 状态文本的纯逻辑 —— 零 DOM、零 chrome API，可在 Node 里测。
 *
 * 角标的显示逻辑有个容易忽略的点：**它不能什么都往"已解锁"上写**。
 * 用户看到"4K"就必须真的是 4K，看到"Hi-Res"就必须真的有 FLAC 轨。
 * 否则这个角标就成了自我欺骗的装饰。
 *
 * 所以这里只做一件事：把已知事实翻译成短语，不知道的一律不说。
 */

/** 角标要显示的内容 */
export interface BadgeContent {
  /** 是否处于接管状态（false 时角标整体隐藏） */
  visible: boolean;
  /** 主文案，如 "4K" / "1080P" / "已接管" */
  label: string;
  /** 附加徽章，如 ["60fps", "Hi-Res"] */
  chips: string[];
  /** hover 详情 */
  detail: string;
}

/** 输入：从页面观测到的真实情况 */
export interface BadgeInput {
  /** 代理是否生效（DNR 规则在 + 开关开） */
  proxying: boolean;
  /** 页面实际播放高度（videoHeight）。0 表示还没开始播 */
  playingHeight: number;
  /** 播放器实际用的视频编码家族 */
  videoFamily: string;
  /** 播放器实际用的音频编码家族 */
  audioFamily: string;
  /**
   * 当前轨道的实际帧率（0 = 未知）。
   *
   * ⚠️ 是**数值**不是布尔。曾经用布尔 + 写死文案 "60fps"，
   * 导致 120fps 的视频被标成 60fps（用户实测报过 BV1beNcz2ECq）。
   */
  frameRate: number;
  /**
   * 浏览器的 `(video-dynamic-range: high)` 媒体查询结果。
   *
   * `true` = 当前视频通道确实以 HDR 呈现；`false` = 不是；`null`/省略 = 未知。
   *
   * ## 它用来消除「SDR 的 HEVC 被误标成 HDR」
   *
   * quality id 为 120 但编码是 HEVC 时，光看 codec 分不清是 HDR 还是 SDR 的 HEVC
   * （B 站会给 4K 视频转 HEVC 省码率）。这时用这个信号做**否定判断**：
   * 浏览器说不是 HDR，那就不是，不标 HDR 徽章。
   *
   * 注意它只能回答"是不是 HDR"，回答不了"HDR10 还是 HDR10+"——
   * 后者浏览器 API 根本读不到（见 docs/02-ui-spec.md §5）。
   */
  videoDynamicRange?: boolean | null;
  /**
   * `(dynamic-range: high)` 的结果 —— **显示设备**是否支持 HDR。
   *
   * 与 `videoDynamicRange` 是两回事，但**两者都是 HDR 的正面证据**：
   *   - display=high：屏幕和系统确实在 HDR 模式
   *   - video=high：视频通道确实以 HDR 呈现
   *
   * 实测踩过：用户屏幕和系统都开了 HDR、画面也是 HDR 效果，
   * 但 `video-dynamic-range` 返回 standard（AV1 编码的 HDR 轨上出现过）。
   * 只信它就会漏报。所以改成**两条证据取并集**。
   */
  displayDynamicRange?: boolean | null;
  /**
   * HEVC 的 profile 段，形如 `2.4.L153.90`。来自主世界的 `hevcProfile()`。
   *
   * 非 HEVC（AV1 / H.264）时为 `'?'` 或空。
   * 用来在详情里标出 10bit —— 只是排查线索，不是画质结论（见 `hevcBitDepth`）。
   */
  hevcProfile?: string | null;
  /**
   * 本视频是否**提供**杜比视界版本（服务端 `dash.dolby.vision`）。
   *
   * ⚠️ 是视频能力，不是当前播放状态。
   * 只能写进详情当提示，不能进主文案 ——
   * 否则会把"这个视频有 DV 轨"说成"你正在看 DV"，那是谎报。
   */
  dolbyVisionAvailable?: boolean;
  /**
   * 上一次成功观测到的播放高度（0 表示从未观测到）。
   *
   * 用途：本次读到 0 时不要清空已有信息——那会让角标在切画质瞬间
   * 闪回「已接管」。由调用方（`badge.ts`）维护，保持本函数无状态。
   */
  lastKnownHeight?: number;
}

/**
 * 高度 → 画质短语。
 *
 * ⚠️ 实现已移到 `@shared/utils/quality`（popup §2.3 也要用，而 core 不许依赖 content）。
 * 这里**保留导出**，因为角标的既有测试与调用方都从这里取；
 * 不要再写第二份 —— 8K/4K 的顺序曾经写反过，一份就够复发一次了。
 */
import { heightLabel } from '@shared/utils/quality';

export { heightLabel };

/**
 * 从 HEVC 的 level 推断"这条轨是否可能是 HDR"，返回理由字符串或 null。
 *
 * ## 依据（来自实测日志，不是推测）
 *
 * 用户环境实测：
 *   - 播放 4K HDR 视频时，`addSourceBuffer` 收到的 mime 是
 *     `hvc1.2.4.**L156**.90`
 *   - 同一视频的普通档是 `hev1.1.6.**L120**.90`
 *
 * HEVC 的 Level 里 L150 / L153 / L156 这些高位等级，
 * 意味着码率与分辨率都远超 SDR 4K 的常规需求。
 * **B站把 HDR 轨放在这些高等级上**，SDR 轨停在 L120~L153。
 *
 * ## 为什么必须加这条判据
 *
 * 原本只信 `(video-dynamic-range: high)`，但**实测证明它在用户环境下恒为 false**
 * （日志：`display=true video=false`，画面却确实是 HDR）。
 * 只靠它就永远标不出 HDR。
 *
 * ## 这是"弱信号"，不进主文案
 *
 * Level 高**不能 100% 证明是 HDR**（理论上高码率 SDR 也可能用高 Level）。
 * 所以它只作为 HDR 徽章的**替代证据**，且详情里如实写"HEVC L1xx"，
 * 让用户自己判断。
 *
 * @param profile `hevcProfile()` 的输出，形如 `2.4.L156.90`
 * @returns 形如 `'L156'` 的等级串；低于 L150 或解析失败返回 null
 */
export function hevcHdrLevel(profile: string | null | undefined): string | null {
  if (!profile || profile === '?') return null;

  const m = /L(\d+)/.exec(profile);
  if (!m) return null;

  const level = Number(m[1]);
  if (!Number.isFinite(level)) return null;

  // L150 = Level 5.0 起算。实测 HDR 轨是 L156，SDR 轨停在 L120~L153。
  return level >= 150 ? `L${String(level)}` : null;
}

/**
 * 从 HEVC 的 profile 字段推断位深，返回 "10bit" 或 null。
 *
 * ## 输入是什么
 *
 * `hevcProfile()` 从 codec 字符串里提出来的那一段，形如：
 *   `hvc1.2.4.L153.90`  →  `2.4.L153.90`
 *
 * 分解：profile_idc=2（Main10）、tier=L、level=153、约束=90
 *
 * ## 判据：profile_idc >= 2 就是 Main10
 *
 * HEVC 的 profile_idc：
 *   1 = Main（8bit）
 *   2 = Main10（10bit）
 *   3 = Main Still Picture
 *
 * 所以 `2.x.*` 说明是 Main10，也就是 **10bit 编码**。
 *
 * ## 为什么这是"弱信号"，只放详情不放主文案
 *
 * 10bit 编码**不等于 HDR**：
 *   - B站有些 SDR 视频也用 Main10 转码（避免色带）
 *   - 反过来 HDR 一定用 Main10，所以"不是 10bit"能**否定** HDR，
 *     但"是 10bit"**不能肯定** HDR
 *
 * 因此它只能作为排查线索（"这条轨确实是 10bit，可能走的是高动态范围那条"），
 * 不能当成画质结论。主文案仍然只写分辨率。
 *
 * @param profile `hevcProfile()` 的输出，非 HEVC 时为 '?'
 */
export function hevcBitDepth(profile: string | null | undefined): string | null {
  if (!profile || profile === '?') return null;

  // 形如 "2.4.L153.90"，第一段是 profile_idc
  const m = /^(\d+)\./.exec(profile);
  if (!m) return null;

  const profileIdc = Number(m[1]);
  if (!Number.isFinite(profileIdc)) return null;

  // 2 = Main10，3 = Main Still Picture（也是 10bit 能力）
  if (profileIdc >= 2) return '10bit';
  return null;
}

/**
 * 音频家族 → 徽章。
 *
 * 只有真正在解的编码才算。比如播放器选了 AAC 就绝不写 Hi-Res，
 * 哪怕 playurl 响应里带了 FLAC 轨。
 */
export function audioChip(family: string): string | null {
  if (family === 'FLAC') return 'Hi-Res';
  if (family === 'Dolby(EC-3)') return '杜比';
  if (family === 'ALAC') return 'ALAC';
  return null;
}

/**
 * 生成角标内容。
 *
 * ## 决策规则
 *
 * 1. **没在代理 → 不显示**。角标的意义是"我现在被接管了"，
 *    没接管时挂个角标只是干扰。
 * 2. **还没开始播 → 只说"已接管"**，不猜画质。
 *    此时写"4K"是作弊——用户会以为已经拿到了。
 * 3. **在播 → 说实际高度**，附加能确认的音视频特性。
 */
export function buildBadge(input: BadgeInput): BadgeContent {
  if (!input.proxying) {
    return { visible: false, label: '', chips: [], detail: '' };
  }

  const chips: string[] = [];
  // 只有明显高于常规帧率时才单独出徽章。
  // 30fps 是多数视频的默认值，标出来只是噪音；50 以上才算"高帧率"。
  if (input.frameRate >= 50) chips.push(`${String(input.frameRate)}fps`);

  const audio = audioChip(input.audioFamily);
  if (audio) chips.push(audio);

  /**
   * ## 高度为 0 时的处理 —— 别急着退回"已接管"
   *
   * 踩过的 bug：视频明显在播，角标却只显示「已接管」，过几秒才恢复正常。
   *
   * 原因：切画质 / 切换分辨率时 `<video>.videoHeight` 会短暂变成 0，
   * 而旧逻辑一看到 0 就整体退回初始态，把已知的分辨率、编码、音频徽章
   * **全部清空**。用户看到的就是"闪一下，然后什么都没了"。
   *
   * 现在的做法：
   *   - 首次加载（从没拿到过高度）→ 说「已接管」，这是诚实的
   *   - **曾经拿到过**高度、这次读到 0 → 是"暂时读不到"，
   *     保留上一次已知的 label 与 chips，只把 detail 换成"正在切换"
   *
   * 判据用调用方传入的 `lastKnownHeight`（见 badge.ts 的 lastPainted），
   * 这样纯函数本身无状态、可测。
   */
  if (input.playingHeight <= 0) {
    const lastKnown = input.lastKnownHeight ?? 0;
    if (lastKnown > 0) {
      return {
        visible: true,
        label: heightLabel(lastKnown),
        chips,
        detail: `取流身份：播放账号 ｜ 画面正在切换（上次 ${String(lastKnown)}p）`,
      };
    }
    return {
      visible: true,
      label: '已接管',
      chips: [],
      detail: '取流身份：播放账号。等待播放器开始加载视频…',
    };
  }

  /**
   * 画质名称。
   *
   * ## 基线：只看实际高度
   *
   * ⚠️ 曾经用 B站 quality id 反查当前轨道，已撤掉 ——
   * `<video>` 只给宽高，无法知道自己在放哪条 dash 轨，
   * 强行反查会匹配到同高度的另一条轨 → 「4K SDR 显示成杜比视界」。
   *
   * ## 杜比视界的判定：三个条件**同时**成立才写
   *
   * | 条件 | 理由 |
   * | --- | --- |
   * | `dolby.vision === true` | 服务端说这个视频**提供** DV 版本 |
   * | 高度 >= 2160 | DV 只存在于 4K 及以上 |
   * | 编码是 HEVC | **DV 必须走 HEVC**，AV1 / H.264 不承载 |
   *
   * 三个条件缺一不可：
   *   - 只有 `dolby.vision` → 用户切到 1080P 也会显示杜比视界（谎报）
   *   - 只有高度 + HEVC → 普通 HDR 也是 4K HEVC，会混淆
   *
   * 实测验证：用户的 DV 视频在 4K 下编码确实是 `HEVC(hvc1)`。
   */
  const isHevc = /HEVC/i.test(input.videoFamily);
  const isDolbyVision =
    input.dolbyVisionAvailable === true && input.playingHeight >= 2160 && isHevc;

  const label = isDolbyVision ? '杜比视界' : heightLabel(input.playingHeight);

  /**
   * ## HDR 徽章已移除（2026-10-26 实测决定）
   *
   * 不是偷懒，是**所有可用信号都被实测证伪**：
   *
   * | 信号 | 现状 |
   * | --- | --- |
   * | `(video-dynamic-range: high)` | 用户环境下**恒为 false**（日志实证：`display=true video=false`，画面却确实是 HDR） |
   * | `(dynamic-range: high)` | 只说明屏幕在 HDR 模式，属**观看条件**，曾导致 8K SDR 被误标 |
   * | HEVC Level（L156） | **HDR 与 8K SDR 完全相同**（两条视频实测都是 `hvc1.2.4.L156.90`），零区分度 |
   * | `dolby.vision` | 只说明"视频提供 DV 版本"，且实测那个视频是 `false` |
   *
   * 四个信号全废。继续做只有两种结果：猜则误报（8K SDR 标 HDR），
   * 不猜则漏报。**漏报可以接受，误报会让用户不再信任整个角标。**
   *
   * 所以角标只报能 100% 确定的三类：分辨率、帧率、音频编码。
   * 想看 HDR 请用播放器右键 →「视频统计信息」，那里是 B站自己的数据，最权威。
   */

  const detailParts = [`当前画面 ${String(input.playingHeight)}p`];
  if (input.frameRate > 0) detailParts.push(`${String(input.frameRate)}fps`);
  if (input.videoFamily && input.videoFamily !== 'unknown') {
    // 10bit 只作为线索附在编码后面，例如 "视频 HEVC(hvc1) 10bit"
    const depth = hevcBitDepth(input.hevcProfile);
    detailParts.push(depth ? `视频 ${input.videoFamily} ${depth}` : `视频 ${input.videoFamily}`);
  }
  if (input.audioFamily && input.audioFamily !== 'unknown') {
    detailParts.push(`音频 ${input.audioFamily}`);
  }

  /**
   * 视频提供杜比视界时，在详情里补一句。
   *
   * 措辞必须是「本视频提供」而不是「杜比视界」——
   * 因为 `dash.dolby.vision` 只说明服务端有这个版本，
   * 不说明播放器当前选中的就是它（用户实测过：杜比视界视频播的是 HDR 轨）。
   */
  const dolbyNote = input.dolbyVisionAvailable
    ? isDolbyVision
      ? '；当前播放杜比视界'
      : '；本视频提供杜比视界版本（当前未播放该版本）'
    : '';

  return {
    visible: true,
    label,
    chips,
    detail: `取流身份：播放账号 ｜ ${detailParts.join(' ｜ ')}${dolbyNote}`,
  };
}

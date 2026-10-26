/**
 * 取流数据结构。
 *
 * 字段命名做了 camelCase 归一化（B站原始响应是 snake_case），
 * 类型层不掺业务逻辑。解析在 `core/playinfo/parse.ts`。
 *
 * ⚠️ 判据纪律：判断"某个身份能拿到什么画质"只能用 `dash.video[].height` 等轨道字段，
 * **不能用 `acceptQuality`**（未登录时它返回含 8K 的假数组，见 docs/03-open-questions.md Q9
 * 与 poc/verify/RESULT.md §四）。
 *
 * ⚠️ **不要从 `quality` / `id` 反推动态范围**（HDR / 杜比视界）。实测数据里
 * 同一条 2160p 轨道会以不同 `codecid` 出现，quality id 与动态范围没有稳定对应关系。
 * 杜比视界只能用 `dash.dolby.vision` 这个服务端布尔值判断，且它表达的是
 * "本视频**提供**该版本"，不是"当前在播"。见 docs/decisions/0014-quality-compare-from-page-data.md。
 */

export interface VideoTrack {
  /** B站的 quality id（16/32/64/80/112/116/120/125/126/127） */
  id: number;
  /** 直链。缺失时为空串（能力统计不需要它，播放需要） */
  baseUrl: string;
  backupUrl: string[];
  /** bps */
  bandwidth: number;
  /** 7=H.264, 12=AV1, 13=HEVC */
  codecid: number;
  width: number;
  height: number;
  /**
   * 帧率，已解析成数字。
   *
   * ⚠️ **0 表示"解析不出来"，不是 30**。B站给的是字符串（`"60.000"`），
   * 有些轨道干脆没有这个字段。把 0 当默认值写进 UI 会凭空造出一个"30fps"。
   */
  frameRate: number;
  /** B站原始字符串，如 `"60.000"`。保留给诊断用，不参与判断 */
  frameRateRaw: string;
  mimeType: string;
}

export interface AudioTrack {
  id: number;
  baseUrl: string;
  backupUrl: string[];
  bandwidth: number;
  codecid: number;
  mimeType: string;
}

export interface DashData {
  /** 秒 */
  duration: number;
  video: VideoTrack[];
  audio: AudioTrack[];
  /** Hi-Res（FLAC in fMP4）；无则 null */
  flacAudio: AudioTrack | null;
  /** 杜比全景声（EC-3）；无则空数组 */
  dolbyAudio: AudioTrack[];
  /**
   * 服务端标注「本视频**提供**杜比视界版本」。
   *
   * ⚠️ 是**视频能力**，不是当前播放状态。只能用于"本视频提供"这类表述，
   * 不能写成"你在看杜比视界"。
   */
  dolbyVision: boolean;
}

export interface PlayInfo {
  /** 当前选中的画质 id */
  quality: number;

  /**
   * ⚠️ **这不是"你的账号能拿到哪些画质"。**
   *
   * 它表达的是"这个视频本身支持哪些画质"。2026-10-25 实测：未登录请求返回
   * `[127,120,116,80,64,32,16]`（含 8K/4K），但 `dash.video` 最高只有 480P。
   *
   * **判断权限边界的唯一正确依据是 `dash.video[].height` 的最大值。**
   * 见 docs/03-open-questions.md Q9。
   */
  acceptQuality: number[];

  /** 与 acceptQuality 一一对应的中文描述，仅用于展示 */
  acceptDescription: string[];

  /** 普通视频走 dash */
  dash: DashData | null;

  /**
   * 番剧走 durl（MP4 分段），且没有 dash。
   * v1 不支持番剧（ADR 0007），此字段保留仅为类型完整性。
   */
  durl: unknown[] | null;
}

// ── 能力与对比（数据形状放 shared，计算逻辑放 core/playinfo/rank.ts）──
//
// 为什么类型放这里而不是 rank.ts：`messages.ts` 要把它们放进跨环境消息里，
// 而 `shared` 不许依赖 `core`。类型是纯数据，放 shared 不违反分层。

/** 一个身份对某个视频的真实能力。只描述"拿得到什么"，不描述"在播什么" */
export interface Capability {
  /** `dash.video[].height` 的最大值。判权限边界的唯一依据 */
  maxHeight: number;
  /**
   * **全部轨道**里的最高帧率。
   *
   * 语义是"这个视频能给出的最高帧率"。⚠️ 它与 `maxHeight` 不一定是同一条轨：
   * 可能出现"4K 只有 60fps，而 1080P 有 120fps"。
   * 要回答"4K 能不能 60fps"，请用 `maxFrameRateAtTopHeight`。
   */
  maxFrameRate: number;
  /** **最高高度那一档**里的最高帧率。用于"4K60"这类表述 */
  maxFrameRateAtTopHeight: number;
  /** `dash.flac.audio` 存在（Hi-Res） */
  hasHiRes: boolean;
  /** `dash.dolby.audio` 非空（杜比全景声） */
  hasDolbyAudio: boolean;
  /** 服务端标注"本视频**提供**杜比视界版本"，不是"当前在播" */
  providesDolbyVision: boolean;
  /** 最高高度的那条轨（同高取码率更大者）。诊断用 */
  topTrack: VideoTrack | null;
  /** 视频轨条数（诊断用，能反映"这个身份拿到几条变体"） */
  videoCount: number;
  audioCount: number;
}

/** 两个身份的差异。正数 = 播放账号更强 */
export interface CapabilityDiff {
  /** 像素高度差，可正可负 */
  heightGain: number;
  /** 全轨道最高帧率差 */
  frameRateGain: number;
  /** 播放账号有 Hi-Res 而主账号没有 */
  hiResGained: boolean;
  dolbyAudioGained: boolean;
  /** 播放账号"提供的杜比视界"而主账号没有 */
  dolbyVisionGained: boolean;
  /** 是否存在任何一项提升。`false` 时 UI 应说"没有提升"而不是报错 */
  improved: boolean;
}

/** 主账号的显示信息。**只用于展示**，不含任何身份凭据 */
export interface PrimaryUser {
  uname: string;
  face: string | null;
  /**
   * 等级（如 6）。
   *
   * ⚠️ 从页面 `__INITIAL_STATE__.user.level_info.current_level` 容错读取 ——
   * 这个形状**没有实测确认过**，读不到就是 `null`，UI 退化成"只读"标签。
   * **不编一个等级**：卡片上写 "LV6" 就必须真是 6。
   */
  level: number | null;
}

/**
 * 主账号基线为什么不可用。
 *
 * ⚠️ 这个字段存在的唯一目的是**让"未知"可解释**。没有它，UI 只能显示
 * "主账号：未知"，用户和开发者都无法判断是"页面没加载完"还是"这条路根本走不通"。
 */
export type PrimaryBaselineReason =
  /** 基线可用，来自 SSR */
  | 'ssr'
  /** `__playinfo__` 是页面在**发过 playurl 之后**才写的 → 那份数据是播放账号身份，不能用 */
  | 'client-written'
  /** 页面根本没有 `__playinfo__` */
  | 'absent'
  /** 有数据但解析不出轨道 */
  | 'unparsable';

/** 当前页面两侧的取流数据（content 直连应答，不经 SW） */
export interface PageTracksView {
  bvid: string;
  /** 第几个分 P */
  p: number;
  updatedAt: number;
  primary: {
    /** 基线是否可用（`reason === 'ssr'` 且拿到了能力） */
    usable: boolean;
    reason: PrimaryBaselineReason;
    capability: Capability | null;
    user: PrimaryUser | null;
    /**
     * 主账号 mid（`document.cookie` 的 `DedeUserID`）。
     *
     * ⚠️ 只在**打开过视频页**之后才有 —— 设置页独立打开时拿不到。
     * 没有时 UI 要显示"打开任意视频页后可见"，**不许自己发 nav 去猜**
     * （决策 4：扩展不读主账号凭据）。
     */
    mid: string | null;
    /**
     * 主账号是否登录。
     *
     * ⚠️ **三态，不是布尔。** `document_start` 时 `document.cookie` 往往是空的，
     * 那时读不到 `DedeUserID` 不代表游客 —— 必须等 DOM 就绪后再下结论。
     * 把"还没读到"当成"没登录"，会让每个刚打开的页面都闪一下"未登录主账号"。
     */
    loggedIn: 'yes' | 'no' | 'unknown';
  };
  /** 播放账号实际拿到的（页面自己的 playurl 响应，已被 DNR 换成播放账号身份） */
  playback: { capability: Capability | null } | null;
  /** 两侧都拿到才有；否则 `null`，UI 必须显示"未知" */
  diff: CapabilityDiff | null;
}

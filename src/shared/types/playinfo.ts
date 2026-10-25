/**
 * 取流数据结构。
 *
 * 字段命名做了 camelCase 归一化（B站原始响应是 snake_case），
 * 解析在 `core/playinfo/parse.ts` 完成，类型层不掺业务逻辑。
 */

export interface VideoTrack {
  /** B站的 quality id（16/32/64/80/112/116/120/126/127） */
  id: number;
  baseUrl: string;
  backupUrl: string[];
  /** bps */
  bandwidth: number;
  /** 7=H.264, 12=AV1, 13=HEVC */
  codecid: number;
  width: number;
  height: number;
  /** B站给的是字符串，如 "60.000" */
  frameRate: string;
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

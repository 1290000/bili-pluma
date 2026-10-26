/**
 * 音质自检页 —— 回答"你的环境能放什么"。
 *
 * 待实现（`02-ui-spec.md` §4.3）：
 * - FLAC 解码：`new Audio().canPlayType('audio/flac')`
 * - EC-3 解码器：Store 包 `9nvjqjbdkn97` 是否安装
 * - Media Foundation flags / 系统空间音频 / 输出设备格式：**读不到，只能给操作路径**
 *
 * ⚠️ 原则（Q14）：**做不到就退化成"引导自查"，不虚报检测结果。**
 * `chrome://flags` 扩展读不到，文案要具体到"输什么、搜什么、选什么、重启"。
 */

import { Card, Pending } from '../ui';
import type { JSX } from 'preact';

export function AudioSection(): JSX.Element {
  return (
    <Card title="音质自检">
      <p class="lede">
        Hi-Res 通常开箱可用；杜比全景声需要系统层面配合。扩展不做任何解码， 这里只负责告诉你缺什么。
      </p>
      <Pending
        items={[
          'FLAC 解码能力检测（浏览器能直接回答）',
          'EC-3 解码扩展是否安装（能测则测）',
          'Media Foundation / 空间音频 / 输出格式的操作路径（读不到，给清单）',
          'Q14：确定自检的准确边界，测不到就明说"无法检测"',
        ]}
      />
    </Card>
  );
}

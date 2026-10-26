/**
 * 画质体检页 —— 回答"当前页解锁了什么"。
 *
 * 待实现（`02-ui-spec.md` §4.2 + [ADR 0014](../../../docs/decisions/0014-quality-compare-from-page-data.md)）：
 * - 五行对比表：最高清晰度 / 最高帧率 / 杜比视界 / Hi-Res / 杜比全景声
 * - **没有 HDR 行**（四个可用信号全被实测证伪）
 * - 只体检**当前打开的页面**，不做"输入任意 BV 查询"
 *
 * ⚠️ 前置：`playinfo/get` 的 handler 还没写；`fnval=4048` 是推算值，
 * 必须先做 Q9 校准，否则体检表会得出"播放账号也不支持 Hi-Res"的错误结论。
 */

import { Card, Pending } from '../ui';
import type { JSX } from 'preact';

export function QualitySection(): JSX.Element {
  return (
    <Card title="画质体检">
      <p class="lede">
        同一页面上，主账号能拿到什么、播放账号实际拿到什么，逐项对比。
        数据全部来自这一页已经收到的响应，不额外发请求。
      </p>
      <Pending
        items={[
          'Q9 校准：实测 fnval 取值，确认 Hi-Res / 杜比位（体检表的前置）',
          'playinfo/get 的 handler（现在只有消息类型，没有处理方）',
          '五行对比表（清晰度 / 帧率 / 杜比视界 / Hi-Res / 杜比全景声）',
          '「当前页」限定与无基线时的"未知"显示',
        ]}
      />
    </Card>
  );
}

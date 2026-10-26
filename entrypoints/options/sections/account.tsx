/**
 * 账号页 —— 回答"两个身份分别是谁"。
 *
 * 待实现（`02-ui-spec.md` §4.1）：
 * - 主账号卡片：**只读**，昵称/mid 来自页面通道（`__INITIAL_STATE__.user` + `DedeUserID`）
 * - 播放账号卡片：昵称 / mid / 会员类型 / 到期日 / 最近校验时间 / 凭据年龄
 * - 扫码登录：走隔离窗口（`chrome.windows.create({ incognito: true })`），**不能内嵌二维码**
 * - 退出播放账号：`account/remove`
 *
 * ⚠️ 主账号的昵称只在**打开过视频页**之后才有（来自页面数据）。
 * 设置页独立打开时拿不到 → 显示"打开任意视频页后可见"，
 * **不许自己发 nav 请求去猜**（决策 4：扩展不读主账号凭据）。
 */

import { Card, Pending } from '../ui';
import type { JSX } from 'preact';

export function AccountSection(): JSX.Element {
  return (
    <Card title="账号">
      <p class="lede">
        浏览器里有两个身份，职责完全分开：主账号负责收藏 / 点赞 / 评论 / 历史， 播放账号只提供取流。
      </p>
      <Pending
        items={[
          '主账号卡片（只读，昵称与 mid 来自当前视频页）',
          '播放账号卡片（昵称 · mid · 会员类型 · 到期日 · 最近校验）',
          '扫码登录（隔离窗口，不内嵌二维码）',
          '退出播放账号',
        ]}
      />
    </Card>
  );
}

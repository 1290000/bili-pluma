/**
 * popup 的「净化」视图 —— 偏好视图，不是状态视图。
 *
 * ## 设计约束（`docs/02-ui-spec.md` §0）
 *
 * popup 是**查看器**，不是操作台。所以这一屏：
 *   - **只放最近 3 项**，超出的走「管理 →」进设置页
 *   - **不解释原理**，只说"现在开没开""在当前页适不适用"
 *   - 与「画质」Tab 互斥，**默认不显示**（默认停在画质）
 *
 * ## 为什么每项要标"当前页适用性"
 *
 * 用户在视频页看到「删除直播水印」亮着会困惑。语义：
 *   - `applicable=false` → 灰显并写明"当前页不适用"
 *   - `applicable=true` → 正常可操作
 *
 * 这是 §5.3「不许谎报」原则的延伸：不要让人以为一个开关在这里有作用。
 */

import type { CleanPreferences } from '@/src/content/site-clean/clean-options';
import type { JSX } from 'preact';

/** popup 里最多显示几项 —— 超出的进设置页（§3.2 第 2 层） */
export const POPUP_CLEAN_MAX = 3;

export interface CleanRow {
  key: string;
  label: string;
  /** 当前页是否适用 */
  applicable: boolean;
  /** 当前页说明，如"首页" / "直播间" */
  scope: string;
  /** 是否已开 */
  on: boolean;
}

/**
 * 由偏好 + 当前页类型算出 popup 要显示的 3 行。
 *
 * ⚠️ **不能把全部分类塞进 popup** —— 9 个分类开关会让 popup 变成操作台。
 * 分类的完整勾选在设置页（§3.2 第 3 层）。
 */
export function buildCleanRows(
  prefs: CleanPreferences,
  page: 'home' | 'video' | 'live' | 'other',
): CleanRow[] {
  const rows: CleanRow[] = [
    {
      key: 'ad',
      label: '删除广告',
      applicable: page === 'home' || page === 'video',
      scope: '首页 / 视频页',
      // 广告清理无总开关，只要扩展在这个页面上就是"生效中"
      on: true,
    },
    {
      key: 'home',
      label: '首页净化',
      applicable: page === 'home',
      scope: '首页',
      on: prefs.hideCategories.length > 0 || prefs.options.homeHideSwipe,
    },
    {
      key: 'watermark',
      label: '删除直播水印',
      applicable: page === 'live',
      scope: '直播间',
      // 水印清理也无开关（见 live-clean.ts 文件头），在直播间即生效
      on: true,
    },
  ];
  return rows.slice(0, POPUP_CLEAN_MAX);
}

export function CleanView(props: { rows: CleanRow[]; onManage: () => void }): JSX.Element {
  return (
    <div class="clean">
      {props.rows.map((r) => (
        <div class={`clean-row ${r.applicable ? '' : 'na'}`} key={r.key}>
          <span class="clean-main">
            <span class="clean-name">{r.label}</span>
            <span class="clean-scope">{r.applicable ? `当前页：${r.scope}` : '当前页不适用'}</span>
          </span>
          <span class={`clean-state ${r.on && r.applicable ? 'on' : ''}`}>
            {r.applicable ? (r.on ? '已生效' : '未启用') : '—'}
          </span>
        </div>
      ))}

      <button class="ghost small manage" onClick={props.onManage}>
        共 3 项 · 管理 →
      </button>
    </div>
  );
}

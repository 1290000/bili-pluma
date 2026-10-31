/**
 * 净化分区 —— 回答"我让网站变成什么样"（ADR 0031 / 0032）。
 *
 * ## 为什么单开一个分区
 *
 * 「显示」分区回答"我怎么看到状态"，「净化」回答"我让网站变成什么样"。
 * 两者语义不同，混在一起下一次加功能就没地方了 —— 见 `docs/02-ui-spec.md` §4.3。
 *
 * ## 数据形状（**最容易出错的地方**）
 *
 * storage 里存的是 `{ options: {...}, hideCategories: [...] }`，
 * 两个都是各自独立的写入函数：
 *
 * | 改什么 | 调什么 |
 * | --- | --- |
 * | 布尔开关 | `writeCleanOptionFlags()` —— **保留**已有 hideCategories |
 * | 分类勾选 | `writeCleanHideCategories()` —— **保留**已有 options |
 *
 * ⚠️ **不要用一个函数写两半**。曾经只有扁平写入函数，
 * 写分类会把布尔项弄丢、写布尔项会把分类弄丢（2026-10-31 verifier 指出）。
 *
 * ## 生效方式
 *
 * 写 storage → content script 的 `chrome.storage.onChanged` → 立即生效，不用刷新。
 * 与「显示」分区的角标开关同一模式。
 */

import {
  CLEAN_OPTION_META,
  DEFAULT_CLEAN_OPTIONS,
  applyAdOptionCoupling,
  normalizeCleanPreferences,
  type CleanOptions,
} from '@/src/content/site-clean/clean-options';
import { OBSERVED_CATEGORIES } from '@/src/content/site-clean/home-selectors';
import {
  readRawCleanOptions,
  writeCleanHideCategories,
  writeCleanOptionFlags,
} from '@platform/storage/ui-prefs-store';
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { Card } from '../ui';

export function CleanSection(): JSX.Element {
  /** `null` = 还没读出来。此时禁用全部控件，避免把"未知"当成"关"写回去 */
  const [options, setOptions] = useState<CleanOptions | null>(null);
  const [cats, setCats] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void readRawCleanOptions().then((raw) => {
      const p = normalizeCleanPreferences(raw);
      setOptions(p.options);
      setCats(p.hideCategories);
    });
  }, []);

  /**
   * 切换一个布尔开关。
   *
   * ⚠️ **必须过 `applyAdOptionCoupling()`**：`adDebug` 与 `adHideContainer` 双向互斥，
   * **最后操作的那个生效** —— 所以要把 `key` 传进去，否则无法判断谁该被关掉。
   *
   * 若只在渲染时推导，存储里会留下矛盾组合，用户关掉一个后行为会跳变。
   */
  const toggle = useCallback(
    async (key: keyof CleanOptions, next: boolean) => {
      if (!options) return;
      const prev = options;
      const coupled = applyAdOptionCoupling({ ...options, [key]: next }, key);
      setBusy(true);
      setError(null);
      setOptions(coupled); // 乐观更新：开关要跟手（含联动的那个）
      try {
        await writeCleanOptionFlags(coupled);
      } catch (e) {
        setOptions(prev);
        setError(e instanceof Error ? e.message.slice(0, 60) : '保存失败');
      } finally {
        setBusy(false);
      }
    },
    [options],
  );

  /** 勾选/取消一个分类 */
  const toggleCat = useCallback(
    async (cat: string, on: boolean) => {
      if (!cats) return;
      const prev = cats;
      const next = on ? [...cats, cat] : cats.filter((c) => c !== cat);
      setBusy(true);
      setError(null);
      setCats(next);
      try {
        await writeCleanHideCategories(next);
      } catch (e) {
        setCats(prev);
        setError(e instanceof Error ? e.message.slice(0, 60) : '保存失败');
      } finally {
        setBusy(false);
      }
    },
    [cats],
  );

  const disabled = busy || options === null || cats === null;

  /** 总开关（adEnabled）本身永远可点；其余广告子项在总开关关闭时置灰 */
  const isSubAdOption = (key: string): boolean => key !== 'adEnabled';
  const subDisabled = disabled || options?.adEnabled !== true;

  return (
    <>
      <Card title="删除广告">
        {CLEAN_OPTION_META.filter((m) => m.key === 'adEnabled').map((meta) => (
          <label class="pref" key={meta.key}>
            <span class="pref-label">
              {meta.label}
              <span class="pref-hint">{meta.hint}</span>
            </span>
            <span class={`switch ${options?.[meta.key] ? 'on' : ''} ${busy ? 'busy' : ''}`}>
              <input
                type="checkbox"
                checked={options?.[meta.key] === true}
                disabled={disabled}
                onChange={(e) => void toggle(meta.key, (e.target as HTMLInputElement).checked)}
              />
              <span class="knob" />
            </span>
          </label>
        ))}

        {CLEAN_OPTION_META.filter((m) => isSubAdOption(m.key)).map((meta) => (
          <label class={`pref ${subDisabled ? 'dim' : ''}`} key={meta.key}>
            <span class="pref-label">
              {meta.label}
              <span class="pref-hint">{meta.hint}</span>
            </span>
            <span class={`switch ${options?.[meta.key] ? 'on' : ''} ${busy ? 'busy' : ''}`}>
              <input
                type="checkbox"
                checked={options?.[meta.key] === true}
                disabled={subDisabled}
                onChange={(e) => void toggle(meta.key, (e.target as HTMLInputElement).checked)}
              />
              <span class="knob" />
            </span>
          </label>
        ))}
      </Card>

      <Card title="首页净化">
        <p class="pref-hint block">
          勾选的分类会在首页专题推荐位里隐藏。默认全不隐藏——这些是内容推荐，不是广告。
        </p>
        {OBSERVED_CATEGORIES.map((cat) => (
          <label class="pref" key={cat}>
            <span class="pref-label">{cat}</span>
            <span class={`switch ${cats?.includes(cat) ? 'on' : ''} ${busy ? 'busy' : ''}`}>
              <input
                type="checkbox"
                checked={cats?.includes(cat) === true}
                disabled={disabled}
                onChange={(e) => void toggleCat(cat, (e.target as HTMLInputElement).checked)}
              />
              <span class="knob" />
            </span>
          </label>
        ))}
      </Card>

      {error && <p class="hint danger">{error}</p>}

      <p class="pref-hint block">
        说明：分类清单来自实测（B站 首页当前只有这 {OBSERVED_CATEGORIES.length} 类专题推荐位）。
        未列出的分类即使上游有，也不会出现在这里——因为勾了也没有对应卡片。
      </p>
    </>
  );
}

/** 供「恢复默认」按钮复用 —— 默认值只在这里引用一次 */
export const CLEAN_DEFAULTS = DEFAULT_CLEAN_OPTIONS;

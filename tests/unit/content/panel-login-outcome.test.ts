// @vitest-environment node

/**
 * 登录窗口打开的**失败原因区分**（2026-11-10）。
 *
 * ## 为什么需要这个
 *
 * 用户真机反馈「点了没反应」。根因是面板所有消息都 `.catch(() => null)` ——
 * **失败完全静默**，用户无法判断是网络问题、没开 InPrivate 权限、还是按钮坏了。
 *
 * `login/open` 有明确的 `reason`，必须转成人话。
 *
 * ## `incognito-disabled` 是唯一"用户能自己修"的失败
 *
 * 它是**最常见**的一种：用户没在扩展详情页勾「在 InPrivate 中允许」。
 * 笼统说"登录窗口打不开"等于让他无从下手 —— 必须直接告诉他去哪里勾。
 */

import { describe, expect, it } from 'vitest';

import { describeLoginOutcome } from '../../../src/content/panel/login-outcome';

describe('★★ login/open 应答 → 用户提示', () => {
  it('★★ opened:true → 成功提示，告诉用户去扫码', () => {
    const r = describeLoginOutcome({ type: 'login/open:ok', opened: true });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('扫码');
  });

  it('★★ opened:false + incognito-disabled → **必须**告诉他去扩展详情页开权限', () => {
    /**
     * 反例：把 `incognito-disabled` 分支删掉（退回笼统文案）→ 本条必红。
     *
     * 这是用户能自己修的唯一一种失败，提示里必须出现：
     *   - 「InPrivate」（勾选项的名字）
     *   - 「扩展详情页」（去哪里勾）
     */
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'incognito-disabled',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('InPrivate');
    expect(r.text).toContain('扩展详情页');
    // 不能只说"打不开"
    expect(r.text).not.toBe('登录窗口打不开，请重试');
  });

  it('★ opened:false + 其他 reason → 笼统失败（那种用户修不了）', () => {
    const r = describeLoginOutcome({
      type: 'login/open:ok',
      opened: false,
      reason: 'window-create-failed',
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('打不开');
    // 不该误导用户去动 InPrivate 权限
    expect(r.text).not.toContain('InPrivate');
  });

  it('★ 应答类型不对（background 异常）→ 失败提示', () => {
    const r = describeLoginOutcome({ type: 'login/open:err' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('打不开');
  });

  it('★ 应答是 null（消息发送失败）→ 失败提示，不抛', () => {
    const r = describeLoginOutcome(null);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('打不开');
  });

  it('★ 应答缺少 opened 字段 → 当作失败（不能乐观地报成功）', () => {
    /**
     * 乐观默认（`opened !== false` 就当成功）会让"窗口没打开"被报成
     * "已打开，请扫码" —— 用户扫半天没反应。
     */
    const r = describeLoginOutcome({ type: 'login/open:ok' });
    expect(r.ok).toBe(false);
  });
});

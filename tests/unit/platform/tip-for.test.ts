// @vitest-environment jsdom

/**
 * `tipFor()` 的**三态判据**（2026-11-10 真机修的恐慌性误报）。
 *
 * ## 这个文件为什么之前不存在，以及为什么现在必须有
 *
 * `tipFor()` 一直没有任何单测 —— 于是下面这个 bug 藏到了真机验收才被发现：
 *
 * 现场：4K 正常在播、总开关显示「已开启（3 条路径规则）」，
 * 而诊断浮层**顶部红字**报「代理开了但全局规则没装上 —— 打开视频页不会生效」。
 *
 * 根因：`DNR 全局路径规则` 那一行**只在 `getSessionRules()` 成功时才被 `put()`**。
 * 而面板的 content script 环境里 `chrome.declarativeNetRequest` 整个是 `undefined`
 * → 抛错 → 走 catch → **那一行根本不存在**。
 *
 * 旧代码 `if (!pathRow?.ok) { 报警 }` 对 `undefined` 求值为 `true`
 * → 把**"读不到（未知）"当成了"没装上（失败）"**。
 *
 * 这与 `02-ui-spec.md` §7 反模式表里「把'开关关闭'表达成功能失败」是同一类错误：
 * **用户看到会以为功能坏了**，而功能其实是好的。
 *
 * ## 三态契约
 *
 * | `row` | 含义 | `tipFor` 该做什么 |
 * | --- | --- | --- |
 * | `undefined` | 没产出行（读取失败 / 环境不支持） | **中性，不报警** |
 * | `{ ok: false }` | 读到了，确实是坏的 | **报警** |
 * | `{ ok: true }` | 读到了，正常 | 往下走 |
 */

import { describe, expect, it } from 'vitest';

import { tipFor, type DiagRow } from '@platform/diagnostics/collect';

/** 一条"代理开着且规则齐全"的基线 */
function base(): DiagRow[] {
  return [
    { label: '播放代理总开关', value: '已开启（3 条路径规则）', ok: true },
    { label: 'DNR 全局路径规则', value: '3', ok: true },
    { label: 'DNR 标签页规则', value: '1', ok: true },
  ];
}

/** 从 rows 里摘掉某个 label（模拟"那一项读取失败，压根没产出行"） */
function without(rows: DiagRow[], label: string): DiagRow[] {
  return rows.filter((r) => r.label !== label);
}

describe('★ DNR 全局路径规则：三态', () => {
  it('★★ 行不存在（读不到）→ **不**报"没装上"', () => {
    /**
     * 这是真机那个 bug 的直接反例。
     * 反例：把判据改回 `if (!pathRow?.ok)` → 本条必红，
     * 文案会变成"代理开了但全局规则没装上"。
     */
    const tip = tipFor(without(base(), 'DNR 全局路径规则'));
    expect(tip).not.toContain('没装上');
    expect(tip).toContain('未知');
  });

  it('★ ok === false（读到了确实是 0）→ 才报"没装上"', () => {
    /**
     * ⚠️ 总开关也要 `ok: true`：否则会先命中"代理已关闭"那条更靠前的分支。
     *
     * ⚠️ 这里构造的是 **DNR 规则那一行** `ok: false`（读到了，确实是 0 条）——
     * 它与总开关的 `ok` 是两件事：总开关只管开/关，规则数由第 7 项的三态判据负责
     * （见 `collect.ts` 第 6 项与第 7 项的分工）。
     *
     * 2026-11-10 更正：此处原写「'开关开着但规则 0 条'就是最危险状态」——
     * 那句已随 `collect.ts` 判据修复一起推翻，见 `popup-state.ts:295-315`（用户已否决报警）。
     */
    const rows: DiagRow[] = [
      {
        label: '播放代理总开关',
        value: '已开启（0 条路径规则（本实例视角，不等于全局））',
        ok: true,
      },
      { label: 'DNR 全局路径规则', value: '0', ok: false },
      { label: 'DNR 标签页规则', value: '0', ok: false },
    ];
    expect(tipFor(rows)).toContain('没装上');
  });

  it('ok === true → 不报"没装上"', () => {
    expect(tipFor(base())).not.toContain('没装上');
  });
});

describe('★ DNR 标签页规则：三态', () => {
  it('★ 行不存在 → 中性（不说不正常）', () => {
    const tip = tipFor(without(base(), 'DNR 标签页规则'));
    expect(tip).toContain('未知');
    // 不能因为缺一行就落到"没装上"
    expect(tip).not.toContain('没装上');
  });

  it('ok === false → 说明"标签页规则为 0 是正常的"（当前没有视频页）', () => {
    const rows: DiagRow[] = [
      { label: '播放代理总开关', value: '已开启（3 条路径规则）', ok: true },
      { label: 'DNR 全局路径规则', value: '3', ok: true },
      { label: 'DNR 标签页规则', value: '0', ok: false },
    ];
    const tip = tipFor(rows);
    expect(tip).toContain('标签页规则为 0');
    // 这条也不该说"没装上"
    expect(tip).not.toContain('全局规则没装上');
  });

  it('ok === true → 规则齐全', () => {
    expect(tipFor(base())).toContain('规则齐全');
  });
});

describe('★ 播放代理总开关', () => {
  it('ok === false → 报"代理已关闭"', () => {
    const rows: DiagRow[] = [
      { label: '播放代理总开关', value: '已关闭', ok: false },
      { label: 'DNR 全局路径规则', value: '0', ok: false },
    ];
    expect(tipFor(rows)).toContain('代理已关闭');
  });

  it('行不存在 → 说"状态未知"，不说"已关闭"（不替用户下结论）', () => {
    const tip = tipFor(without(base(), '播放代理总开关'));
    expect(tip).toContain('未知');
    expect(tip).not.toContain('代理已关闭');
  });
});

describe('主账号基线优先', () => {
  it('基线不可用时优先于 DNR 状态报警（ADR 0014 的验证门）', () => {
    const rows: DiagRow[] = [
      { label: '主账号基线 · BV1xx P1', value: '⚠️ 客户端写入 → 不可用', ok: false },
      { label: '播放代理总开关', value: '已关闭', ok: false },
    ];
    expect(tipFor(rows)).toBe('主账号基线不可用');
  });

  it('基线正常时不干扰后续判断', () => {
    const rows: DiagRow[] = [
      { label: '主账号基线 · BV1xx P1', value: 'SSR，可用', ok: true },
      ...base(),
    ];
    expect(tipFor(rows)).toContain('规则齐全');
  });
});

describe('★ 真机复现：面板环境（DNR 相关三行全部缺失）', () => {
  it('★★ 总开关 ok、DNR 三行全缺 → 中性文案，绝不报警', () => {
    /**
     * 这正是真机上的实际形状：`chrome.declarativeNetRequest` 在 content script 里
     * 是 `undefined`，所以「DNR 全局路径规则」「DNR 标签页规则」都产不出行。
     * 而「播放代理总开关」走的是 `proxy/status` 消息，**能拿到且是对的**。
     */
    const rows: DiagRow[] = [
      {
        label: 'InPrivate 权限',
        value: '读取失败: chrome.extension.isAllowedIncognitoAccess is not a function',
      },
      { label: '播放代理总开关', value: '已开启（3 条路径规则）', ok: true },
      { label: '代理路径白名单', value: 'r3 · 核对于 2026-11-06' },
    ];
    const tip = tipFor(rows);
    expect(tip).not.toContain('没装上');
    expect(tip).not.toContain('不会生效');
    expect(tip).toContain('未知');
  });
});

describe('空输入不崩', () => {
  it('空数组返回中性文案', () => {
    expect(() => tipFor([])).not.toThrow();
    expect(tipFor([]).length).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom

/**
 * 「关于」Tab 的渲染（`aboutTab`）。
 *
 * ## 2026-11-17 排版改造后，这里守的是"结构"而不是"一句话"
 *
 * 版式从"一条版本行 + 三个等大按钮"变成"元信息卡 + 并排主次按钮 + 文字链 + 署名区"。
 * 结构一变，纯文案断言就不够用了 —— 下面每组都在守**一个必须成立的结构约束**：
 *
 * | 组 | 守什么 | 破了会怎样 |
 * | --- | --- | --- |
 * | 元信息卡 | 三行 label/value 分开渲染 | 回到一行长文案 ⇒ 252px 里必然折行 |
 * | 状态徽标 | 只在"有新版本"时出现 | 无新版也挂徽标 ⇒ 与"已是最新"重复；读不到时瞎标 |
 * | 主次按钮 | 同一父容器、主在前、accent 修饰 | 竖排回来 / 主操作被埋没 |
 * | GitHub 链接 | 用 `.btn-link`，不是 `.acct-btn` | 又变回三个等大按钮，看不出主次 |
 * | 护栏 | `dismissed` 时「立即更新」**仍可点** | 用户进一次关于页就再也无法更新 |
 *
 * 最后一条是**产品级护栏**，任何重构都不许删（理由见用例内注释）。
 */

import { describe, expect, it, vi } from 'vitest';

import { aboutTab } from '@/src/content/panel/tabs';
import type { UpdateStatusView } from '@shared/types/update';
import { CONTRIBUTORS } from '@/src/generated/contributors';

function view(over: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    currentVersion: '1.1.0',
    latestVersion: null,
    latestSizeBytes: null,
    latestZipUrl: null,
    phase: 'idle',
    autoCheckEnabled: true,
    intervalDays: 1,
    lastCheckAt: Date.now() - 3 * 60_000,
    lastAppliedVersion: null,
    lastFailedVersion: null,
    ...over,
  };
}

const noop = {
  check: () => {},
  openUpdate: () => {},
  openReleases: () => {},
  toggleAuto: () => {},
  busy: false,
};

function text(node: HTMLElement, testid: string): string {
  return node.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';
}

function testid(node: HTMLElement, id: string): HTMLElement | null {
  return node.querySelector(`[data-testid="${id}"]`);
}

describe('aboutTab：读不到状态时不许谎报', () => {
  it('view 为 null ⇒ 只说读不到，不显示"已是最新"，也不放徽标', () => {
    const node = aboutTab(null, noop);
    expect(node.textContent).toContain('读不到更新状态');
    expect(node.textContent).not.toContain('已是最新');
    // 没有版本号可显示，也没有徽标（看不见的东西不许下结论）
    expect(text(node, 'update-current')).toBe('');
    expect(testid(node, 'update-badge')).toBeNull();
  });
});

describe('aboutTab：元信息卡（三行 label/value）', () => {
  it('三行都渲染成独立的 label/value，不再是一行长文案', () => {
    const node = aboutTab(view(), noop);
    const rows = node.querySelectorAll('.about-meta .diag-row');
    expect(rows).toHaveLength(3);
    // 每行都是"标签 + 值"两段，不是一整句
    for (const row of rows) {
      expect(row.querySelector('.diag-label')?.textContent).toBeTruthy();
      expect(row.querySelector('.diag-value')?.textContent).toBeTruthy();
    }
    expect(Array.from(rows).map((r) => r.querySelector('.diag-label')?.textContent)).toEqual([
      '当前',
      '最新',
      '上次检查',
    ]);
  });

  it('无新版（比过了、不新）⇒ 当前 v1.1.0 / 最新「已是最新」，不写"最新 v1.1.0"这种重复信息', () => {
    // ⚠️ 必须显式给 latestVersion：`view()` 的默认值是 null，那是"从没查过"（第四态）
    const node = aboutTab(view({ latestVersion: '1.1.0' }), noop);
    expect(text(node, 'update-current')).toBe('v1.1.0');
    expect(text(node, 'update-latest')).toBe('已是最新');
  });

  it('有新版 ⇒ 最新那一行带版本与体积（283 KB 这种量级）', () => {
    const node = aboutTab(
      view({ latestVersion: '1.2.0', latestSizeBytes: 289_831, phase: 'available' }),
      noop,
    );
    expect(text(node, 'update-current')).toBe('v1.1.0');
    expect(text(node, 'update-latest')).toBe('v1.2.0 · 283 KB');
  });

  it('体积缺失时不显示多余的分隔符', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', latestSizeBytes: null }), noop);
    expect(text(node, 'update-latest')).toBe('v1.2.0');
  });

  it('「上次检查」用相对说法，且值用 muted（它不是主角）', () => {
    const node = aboutTab(view({ lastCheckAt: Date.now() - 3 * 60_000 }), noop);
    expect(text(node, 'update-last-check')).toBe('3 分钟前');
    expect(testid(node, 'update-last-check')?.className).toBe('diag-value soft');
  });

  it('从未检查过 ⇒ 说"从未检查"', () => {
    const node = aboutTab(view({ lastCheckAt: null }), noop);
    expect(text(node, 'update-last-check')).toBe('从未检查');
  });

  it('时钟回拨（lastCheckAt 在未来）⇒ 说"刚刚"，不显示负数', () => {
    const node = aboutTab(view({ lastCheckAt: Date.now() + 10 * 60_000 }), noop);
    expect(text(node, 'update-last-check')).toBe('刚刚');
  });

  it('卡头是「更新」，且卡是第一个子节点（版式顺序不能乱）', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0' }), noop);
    const first = node.firstElementChild as HTMLElement;
    expect(first.className).toBe('about-meta');
    expect(first.querySelector('.about-meta-title')?.textContent).toBe('更新');
  });
});

describe('aboutTab：状态徽标（仅「有新版本」时出现）', () => {
  it('有新版 ⇒ 渲染徽标，用的是既有 .pill.pill-good', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'available' }), noop);
    const badge = testid(node, 'update-badge');
    expect(badge).not.toBeNull();
    expect(badge?.className).toBe('pill pill-good');
    expect(badge?.textContent).toBe('有新版本');
  });

  it('无新版 ⇒ 不渲染徽标（版本行已写「已是最新」，再挂一个是重复）', () => {
    const node = aboutTab(view({ latestVersion: '1.1.0' }), noop);
    expect(testid(node, 'update-badge')).toBeNull();
  });

  /**
   * ## 本地比线上新 ≠ 有新版本（2026-11-17 真机 bug）
   *
   * 用户装了 1.2.0 的包、线上最新还是 1.1.0。旧判据是
   * `latest !== view.currentVersion`（字符串不等）⇒ 卡头挂上「有新版本」，
   * 而「立即更新」用 `phase`（走 `isNewer`）⇒ `idle` ⇒ 禁用。
   *
   * **同一个面板，上半部分说有新版、下半部分说没有。** 这条钉住它。
   *
   * 变异验证：把 `isNewerThan(latest, view.currentVersion)` 换回
   * `latest !== view.currentVersion` → 本条必红（徽标冒出来）。
   */
  it('★★★ 线上 1.1.0 / 本地 1.2.0 ⇒ 没有新版：无徽标、版本行说「已是最新」', () => {
    const node = aboutTab(
      view({ currentVersion: '1.2.0', latestVersion: '1.1.0', phase: 'idle' }),
      noop,
    );
    expect(testid(node, 'update-badge'), '本地比线上新，不该报「有新版本」').toBeNull();
    expect(text(node, 'update-current')).toBe('v1.2.0');
    expect(text(node, 'update-latest')).toBe('已是最新');
    // 与「立即更新」的可用性一致（同一条判据 ⇒ 按钮禁用的同时也无徽标）
    expect((testid(node, 'update-now') as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * ## 第四态：`latestVersion === null`（后台应答了，但从没查过 GitHub）
   *
   * 它掉进"无新版"分支就会显示「已是最新」—— 而同一张卡下面的「上次检查」
   * 正写着「从未检查」，两行互相打脸。**没比过 ≠ 比过了不新。**
   *
   * 这是 §0 铁律（"读不到时绝不显示已是最新"）的第四态，规格见
   * `docs/02-ui-spec.md` §5.3 的四态表。
   *
   * 变异验证：删掉 `latest === null` 那条分支（退回两分支）→ 本条必红。
   */
  it('★★ latest=null（从没查过）⇒ 说「还没检查过」，既不放徽标也不许说「已是最新」', () => {
    const node = aboutTab(view({ latestVersion: null, lastCheckAt: null }), noop);
    expect(testid(node, 'update-badge'), '没比过，不能标"有新版本"').toBeNull();
    expect(text(node, 'update-latest'), '没比过就说"已是最新"是谎报').toBe('还没检查过');
    // 与下面那行自洽：卡里不能一边说"已是最新"一边说"从未检查"
    expect(text(node, 'update-last-check')).toBe('从未检查');
  });

  /**
   * dismiss 之后 `phase` 变 `dismissed`，但"有新版"这个事实没变：
   * 红点该消失（不再提示），卡里的徽标该留着（用户已经在这一页上了，不是打扰）。
   */
  it('phase=dismissed 但仍有新版 ⇒ 卡里照常标「有新版本」', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'dismissed' }), noop);
    expect(testid(node, 'update-badge')?.textContent).toBe('有新版本');
    expect(text(node, 'update-latest')).toBe('v1.2.0');
  });
});

describe('aboutTab：主次按钮并排', () => {
  it('★★ 「立即更新」与「检查更新」在同一个父容器里，且主按钮在前', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'available' }), noop);
    const update = testid(node, 'update-now') as HTMLButtonElement;
    const check = testid(node, 'update-check') as HTMLButtonElement;

    expect(update.parentElement).toBe(check.parentElement);
    expect(update.parentElement?.className).toBe('acct-actions');
    // 主在左、次在右：DOM 顺序决定视觉顺序（flex 不反向）
    expect(Array.from(update.parentElement?.children ?? [])).toEqual([update, check]);
  });

  it('★★ 主按钮用 .acct-btn.accent（只换填充，高度与 .acct-btn 一致）', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'available' }), noop);
    const update = testid(node, 'update-now') as HTMLButtonElement;
    /**
     * ⚠️ 不许改成 `.primary-btn`：它字号是 body、还带 `margin-top:2px`，
     * 与 `.acct-btn` 并排会不等高（这一条是排版改造时明确否掉的方案）。
     */
    expect(update.className).toBe('acct-btn accent');
    expect(update.className).not.toContain('primary-btn');
    // 次按钮仍是普通 .acct-btn（ghost）
    expect((testid(node, 'update-check') as HTMLElement).className).toBe('acct-btn ghost');
  });

  it('按钮组排在元信息卡之后（主操作紧贴卡片，不被开关夹在中间）', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'available' }), noop);
    const children = Array.from(node.children);
    const cardIdx = children.findIndex((c) => c.classList.contains('about-meta'));
    const rowIdx = children.findIndex((c) => c.classList.contains('acct-actions'));
    const switchIdx = children.findIndex((c) => c.classList.contains('row'));
    expect(cardIdx).toBe(0);
    expect(rowIdx).toBeGreaterThan(cardIdx);
    // 开关在按钮组**之后** —— 以前是"检查更新 → 开关 → 立即更新"的三明治
    expect(switchIdx).toBeGreaterThan(rowIdx);
  });

  it('busy 时「检查更新」置灰、文案改成"检查中…"', () => {
    const node = aboutTab(view(), { ...noop, busy: true });
    const btn = testid(node, 'update-check') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('检查中…');
  });

  it('点「检查更新」回调一次', () => {
    const check = vi.fn();
    const node = aboutTab(view(), { ...noop, check });
    (testid(node, 'update-check') as HTMLButtonElement).click();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('没有新版时「立即更新」禁用（点了也只会拿到"没有可更新的版本"）', () => {
    const node = aboutTab(view(), noop);
    expect((testid(node, 'update-now') as HTMLButtonElement).disabled).toBe(true);
  });

  it('有新版时「立即更新」可点，且与 Releases 是两个独立回调', () => {
    const openUpdate = vi.fn();
    const openReleases = vi.fn();
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'available' }), {
      ...noop,
      openUpdate,
      openReleases,
    });
    const btn = testid(node, 'update-now') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(openUpdate).toHaveBeenCalledTimes(1);
    expect(openReleases).not.toHaveBeenCalled();
  });

  /**
   * ## 产品级护栏（任何重构都不许删）
   *
   * `dismiss` 只表示"不再提示"，**不代表没有更新**。用户点进「关于」页会自动
   * dismiss（打开即视为已读），若「立即更新」的可用性绑在 `phase === 'available'` 上，
   * 用户一进这一页按钮就永久禁用 —— **从此无法更新**，比"红点消不掉"严重得多。
   */
  it('★★ phase 是 dismissed 时「立即更新」**必须仍可点**（否则一进关于页就再也更新不了）', () => {
    const openUpdate = vi.fn();
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'dismissed' }), {
      ...noop,
      openUpdate,
    });
    const btn = testid(node, 'update-now') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(openUpdate).toHaveBeenCalledTimes(1);
  });

  it('phase 是 dismissed 时版本行仍说「最新 v1.2.0」，不许谎报"已是最新"', () => {
    const node = aboutTab(view({ latestVersion: '1.2.0', phase: 'dismissed' }), noop);
    expect(text(node, 'update-latest')).toBe('v1.2.0');
    expect(text(node, 'update-latest')).not.toBe('已是最新');
  });

  it('只有真的没有新版（idle / pending-reload）才禁用「立即更新」', () => {
    for (const phase of ['idle', 'pending-reload'] as const) {
      const node = aboutTab(view({ phase }), noop);
      expect((testid(node, 'update-now') as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('aboutTab：GitHub Releases 是文字链接', () => {
  it('★★ 用 .btn-link，不是 .acct-btn（不再与主操作抢视觉重量）', () => {
    const node = aboutTab(view(), noop);
    const releases = testid(node, 'update-releases') as HTMLButtonElement;
    expect(releases.className).toBe('btn-link');
    expect(releases.className).not.toContain('acct-btn');
  });

  it('仍然是 <button>（能聚焦、能键盘触发），不是 <a>', () => {
    const node = aboutTab(view(), noop);
    const releases = testid(node, 'update-releases');
    expect(releases?.tagName).toBe('BUTTON');
    expect(releases?.getAttribute('type')).toBe('button');
  });

  it('文案带外链箭头，且点它走 openReleases', () => {
    const openReleases = vi.fn();
    const node = aboutTab(view(), { ...noop, openReleases });
    const releases = testid(node, 'update-releases') as HTMLButtonElement;
    expect(releases.textContent).toBe('GitHub Releases ↗');
    releases.click();
    expect(openReleases).toHaveBeenCalledTimes(1);
  });
});

describe('aboutTab：自动检查开关', () => {
  it('标签必须是「自动检查更新」——「自动」两字独自承担"关掉只停自动、手动仍在"', () => {
    const node = aboutTab(view({ autoCheckEnabled: false }), noop);
    expect(node.textContent).toContain('自动检查更新');
    expect(node.textContent, '「自动」被删 ⇒ 会被读成关掉后手动也失效').toContain('自动');
  });

  /**
   * ## 节奏文案：默认 1 天必须读作「每天」
   *
   * 默认值是 1（`DEFAULT_UPDATE_STATE.intervalDays`），原来的模板拼出
   * 「每 1 天首次打开时查一次」—— 中文不通顺，而且"首次打开"是错的
   * （触发点是 SW 每次启动 + `shouldCheck` 闸门，不是用户打开浏览器）。
   *
   * 变异验证：把 `autoCheckHint` 的三目写死成 `每 N 天最多查一次` → 本条必红。
   */
  it('★★ intervalDays=1 ⇒ 「每天最多查一次」，不出现"每 1 天"', () => {
    const node = aboutTab(view({ intervalDays: 1 }), noop);
    expect(node.textContent).toContain('每天最多查一次');
    expect(node.textContent, '「每 1 天」中文不通顺').not.toContain('每 1 天');
  });

  it('★★ intervalDays=7 ⇒ 「每 7 天最多查一次」', () => {
    const node = aboutTab(view({ intervalDays: 7 }), noop);
    expect(node.textContent).toContain('每 7 天最多查一次');
  });

  /**
   * 「最多」这个词不是修饰：
   * SW 一天会启动很多次，闸门保证一天只真正发一次请求。
   * 写成"每 N 天查一次"会让人以为后台有定时任务 —— 本项目明确没有（ADR 0015）。
   */
  it('★ 文案说「最多」查一次，且不提"首次打开"（那是 SW 启动，不是用户开浏览器）', () => {
    for (const days of [1, 3, 7]) {
      const text = aboutTab(view({ intervalDays: days }), noop).textContent ?? '';
      expect(text).toContain('最多查一次');
      expect(text, '「首次打开」把 SW 启动说成了用户行为').not.toContain('首次打开');
    }
  });

  /**
   * ## hint 里**不许**再出现"手动"（2026-11-17 用户决定）
   *
   * 那句「（关掉后仍可手动检查）」被删掉了，理由：①标签里的「自动」已经说明；
   * ②252px 里加半句就折成两行，是净增噪音。
   *
   * 这条断言是**防止有人"好心"加回来**：加回来不会有任何别的测试响 ——
   * 文案变长既不影响结构也不影响功能。而它一旦回来，`docs/02-ui-spec.md`
   * §5.3 的反模式表就与代码相反了（那张表现在写的是"hint 只写检查节奏"）。
   *
   * 变异验证：把 `（关掉后仍可手动检查）` 拼回 hint → 本条必红。
   */
  it('★★ hint 只写节奏，不重复"手动仍可用"（那句话已由标签里的「自动」承担）', () => {
    for (const days of [1, 3, 7]) {
      const text = aboutTab(view({ intervalDays: days }), noop).textContent ?? '';
      expect(text, 'hint 又把"手动"写回来了 —— 与 §5.3 反模式表冲突').not.toContain('手动');
    }
  });
});

describe('aboutTab：失败提示', () => {
  it('用现有的 .warn，不是不存在的 .warning', () => {
    const node = aboutTab(view({ lastFailedVersion: '1.2.0' }), noop);
    const el = testid(node, 'update-failed');
    expect(el?.className).toBe('pane-note warn');
  });

  it('★★ 失败提示在**卡片外**（它是一整句长文案，塞进卡里会把卡撑变形）', () => {
    const node = aboutTab(view({ lastFailedVersion: '1.2.0' }), noop);
    const failed = testid(node, 'update-failed');
    expect(failed?.closest('.about-meta')).toBeNull();
  });
});

describe('aboutTab：署名区', () => {
  it('功能与署名之间只有一条分隔线，且署名在最后一块', () => {
    const node = aboutTab(view(), noop);
    const dividers = node.querySelectorAll('.about-divider');
    expect(dividers, '分隔线多于一条会变成满屏横线').toHaveLength(1);
    // 分隔线之后只剩署名区
    const last = node.lastElementChild as HTMLElement;
    expect(last.className).toBe('about-credit');
    expect(last.previousElementSibling).toBe(dividers[0]);
  });

  it('生成物里没有 Bot、没有超量', () => {
    // 这份数据由 scripts/gen-contributors.mjs 生成，这里只核对"生成规则真的生效了"
    expect(CONTRIBUTORS.length).toBeGreaterThan(0);
    expect(CONTRIBUTORS.length).toBeLessThanOrEqual(12);
    for (const person of CONTRIBUTORS) {
      expect(person.login.toLowerCase()).not.toContain('[bot]');
      expect(person.avatarUrl.startsWith('https://')).toBe(true);
      expect(person.htmlUrl.startsWith('https://github.com/')).toBe(true);
    }
  });

  it('按 contributions 降序', () => {
    const counts = CONTRIBUTORS.map((p) => p.contributions);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('面板里渲染出每一位的 login（头像是修饰，名字是必须的）', () => {
    const node = aboutTab(view(), noop);
    for (const person of CONTRIBUTORS) {
      expect(node.textContent).toContain(person.login);
    }
  });

  it('点头像/名字走 open，不触发面板其他动作', () => {
    const node = aboutTab(view(), noop);
    const first = node.querySelector('.contributor') as HTMLButtonElement;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    first.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]?.[0])).toContain('github.com/');
    open.mockRestore();
  });
});

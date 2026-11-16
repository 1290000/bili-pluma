// @vitest-environment node

/**
 * 入口 `content-panel.content.ts` 的**更新状态跨 Tab 同步**接线断言（2026-11-17）。
 *
 * ## 为什么只能这样测
 *
 * 与 `entry-wiring.test.ts` 完全同一个理由：它是 **WXT 入口**，
 * `export default defineContentScript({...})` 在 import 时就有副作用，
 * 且依赖 `chrome.*` / `document` / WXT 注入环境。项目里三个同类入口测试
 * （`content-entry.test.ts` / `pgc-proxy-off.test.ts` / `entry-wiring.test.ts`）
 * 都改用源码断言，这里跟着走，不发明第四种做法。
 *
 * **行为层面**由 `about-dismiss-wiring.test.ts` 的「跨 Tab 同步」那一组覆盖
 * （它驱动真实 `panel.ts` 的 `applyUpdateStatus`）。本文件只防两件事：
 *
 * 1. 那一行调用点被删掉
 * 2. 键名被写成手写字符串（违反"一处定义、两处使用"）
 *
 * ## ⚠️ 断言**必须**在剥掉注释后的文本上做（2026-11-17 四轮加固）
 *
 * 第一版是纯文本 `toContain`，被 QA 一击即破：把整块同步代码用 `/* *\/`
 * **注释掉**（功能完全失效），三条断言**全绿**。
 *
 * 而"临时注释掉"恰恰是回退最常见的形态 —— 调试时注掉、忘了恢复、提交。
 * 所以现在先用 `scripts/lib/mask-source.ts` 抹白注释再匹配：
 *
 * | 视图 | 遮挡 | 用来断言什么 |
 * | --- | --- | --- |
 * | `maskCommentsAndStrings()` | 注释 + 字符串 | 「这行代码真的会被执行」 |
 * | `maskComments()` | 只遮注释 | 「这个字面量有没有出现在代码里」 |
 *
 * 第二种视图不能省：模块说明符是字符串，用第一种视图会被一并抹白，
 * 断言就永远不成立（或永远成立）。
 *
 * ## 不覆盖什么（写清边界）
 *
 * - 测不到 `chrome.storage.onChanged` 真的会触发（那要真机）
 * - 测不到 `normalizeUpdateState` 对畸形数据的处理（由 core 的单测覆盖）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { maskComments, maskCommentsAndStrings } from '../../../../scripts/lib/mask-source';

const ENTRY_RAW = readFileSync(
  resolve(process.cwd(), 'entrypoints/content-panel.content.ts'),
  'utf8',
);

/** 代码视图：注释被抹成空白 —— 注释掉的代码**在这里看不见** */
const ENTRY_CODE = maskCommentsAndStrings(ENTRY_RAW);

/** 字面量视图：只遮注释，字符串原样保留 */
const ENTRY_LITERALS = maskComments(ENTRY_RAW);

describe('★★ 更新状态跨 Tab 同步', () => {
  it('★★★ onChanged 里必须读 UPDATE_STATE_KEY 并把新状态推进面板', () => {
    /**
     * 少了这几行，多 Tab 下会残留红点：
     * A 里看过「关于」→ 后台记成已读 → B 的红点**仍然亮着**（界面与事实相反）。
     *
     * 同时这也是"SW 自动检查晚于面板挂载"时唯一能让红点出现的路径。
     *
     * ⚠️ 断言打在 `ENTRY_CODE` 上：整块被注释掉时这里必须红。
     */
    expect(ENTRY_CODE, '没监听更新状态 —— 多 Tab 的红点会互相残留').toContain(
      'changes[UPDATE_STATE_KEY]',
    );
    expect(ENTRY_CODE, '读到了状态却没推给面板').toContain('applyUpdateStatus(');
    expect(ENTRY_CODE, '原始 storage 值必须过 toStatusView，不许自己拼 phase').toContain(
      'toStatusView(state, currentVersion())',
    );
    // 归一化不能省：存储里的值可能是老版本写的 / 被手改过
    expect(ENTRY_CODE).toContain('normalizeUpdateState(updateChange.newValue)');
  });

  it('★★ 键名不许手写字符串（一处定义、两处使用）', () => {
    // 注释里出现 `pluma:update-state` 是允许的（文档说明），所以看字面量视图
    expect(ENTRY_LITERALS, '键名必须从常量来，手写字符串会与 state-store 漂移').not.toContain(
      "'pluma:update-state'",
    );
    expect(ENTRY_LITERALS, '必须从 platform 的 state-store 引常量').toContain(
      "import { UPDATE_STATE_KEY } from '@platform/update/state-store'",
    );
  });

  it('★ 面板销毁时同一个 listener 要被解绑（不许新增一个没解绑的）', () => {
    expect(ENTRY_CODE).toContain('chrome.storage.onChanged.removeListener(onChanged)');
    // 只允许一个 onChanged 注册：多注册一个就有解绑漏一个的风险
    expect(ENTRY_CODE.match(/chrome\.storage\.onChanged\.addListener/g) ?? []).toHaveLength(1);
  });
});

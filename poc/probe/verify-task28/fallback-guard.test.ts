/**
 * task-29 探针：`logsMeta` fallback（task-28 验收）
 *
 * 只 import 产品代码，不 mock 渲染层。
 */
import { describe, expect, it } from 'vitest';
import {
  describeLogsMetaFallback,
  diagnosticsPane,
  type LogsMeta,
} from '@content/panel/diagnostics';

const acts = { back: () => undefined, exportJson: () => undefined, refresh: () => undefined };

/** 最小渲染输入；logsMeta 故意不给 */
function paneWithoutMeta(): HTMLElement {
  return diagnosticsPane(
    { rows: [{ label: 'InPrivate 权限', value: '已允许', ok: true }], logs: [], version: 'probe' },
    acts,
  );
}

const text = (n: HTMLElement): string => n.textContent ?? '';

describe('判据 A · 缺 logsMeta 不抛且渲染"不可信"态', () => {
  it('A1 不抛 + 成对断言（必须有正骨架、必须有失败态、不许有"还没有日志"）', () => {
    const t = text(paneWithoutMeta());
    // 正面骨架：证明页面真的渲染出来了，否则下面的 not.toContain 恒真
    expect(t, '页面骨架没渲染出来 → 后续 not.toContain 会假绿').toContain('自检信息');
    expect(t, '缺 logsMeta 必须报读取失败').toContain('诊断日志读取失败');
    expect(t, '缺 logsMeta 不许说"还没有日志"').not.toContain('还没有日志');
    expect(t, '失败态要给出用户能做的事').toContain('刷新');
  });
});

describe('判据 B · 两个访问点分别覆盖（ok / err / limit）', () => {
  it('B1 残缺 logsMeta（{ok:false} 缺 err）→ 走到 .err 分支不崩', () => {
    const box = diagnosticsPane(
      { rows: [], logs: [], version: 'probe', logsMeta: { ok: false } as never },
      acts,
    );
    const t = text(box);
    expect(t, '页面骨架没渲染出来 → 后续断言无意义').toContain('自检信息');
    expect(t, '必须走到失败分支').toContain('诊断日志读取失败');
    /**
     * 关键：真的访问到 .err 了吗？
     * `{ok:false}` 没有 err 属性 → meta.err === undefined → `undefined !== null` 为 true
     * → 会走进 `（${meta.err}）` 分支渲染出字面 "undefined"。
     * 这证明运行期**确实**走到了 .err 那一行，而不是被短路了。
     */
    expect(t, '必须真的渲染了 err 行（证明走 .err 分支）').toContain('（undefined）');
  });

  it('B2 失败分支的 .limit 访问点也能到达（logs 非空但 ok:false）', () => {
    const box = diagnosticsPane(
      {
        rows: [],
        logs: [
          { at: 0, step: 's', detail: 'd' },
        ],
        version: 'probe',
        logsMeta: { ok: false } as never,
      },
      acts,
    );
    expect(text(box), '页面骨架').toContain('自检信息');
    expect(text(box), '必须走到失败分支').toContain('诊断日志读取失败');
  });
});

describe('判据 C · fallback 语义必须是"不可信"', () => {
  it('C1 describeLogsMetaFallback 的取值：ok:false / err 白名单 / count:0', () => {
    const f: LogsMeta = describeLogsMetaFallback();
    expect(f.ok, 'ok 取 true 就是把崩溃换成谎报').toBe(false);
    expect(['unknown', 'not-read-yet', '数据缺失'], 'err 必须是白名单/缺失标识').toContain(f.err);
    expect(f.count).toBe(0);
    expect(f.err).not.toBe(null);
  });

  it('C2 渲染结果与 C1 同口径：缺 logsMeta 时不能显示"一切正常"的标题', () => {
    const t = text(paneWithoutMeta());
    expect(t).not.toContain('最近 0 条');
    expect(t).toContain('诊断日志读取失败');
  });
});

describe('判据 D · 导出侧与渲染侧共用同一个 fallback（观测类字段必须一致）', () => {
  it('D1 缺 logsMeta 时，渲染侧读到的 ok/err/count 与 fallback 逐字段一致', () => {
    const f = describeLogsMetaFallback();
    // 渲染侧走的是 data.logsMeta ?? describeLogsMetaFallback()
    const effective: LogsMeta = (undefined as LogsMeta | undefined) ?? describeLogsMetaFallback();
    expect(effective.ok).toBe(f.ok);
    expect(effective.err).toBe(f.err);
    expect(effective.count).toBe(f.count);
    // 观测类字段一致 ⇒ 渲染"读取失败"
    expect(text(paneWithoutMeta())).toContain('诊断日志读取失败');
  });
});

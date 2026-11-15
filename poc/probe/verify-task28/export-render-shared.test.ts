/**
 * 探针 2：导出侧 + 渲染侧是否真的共用同一个 fallback（判据 D）
 */
import { describe, expect, it } from 'vitest';
import { describeLogsMetaFallback, diagnosticsPane, type LogsMeta } from '@content/panel/diagnostics';

const acts = { back: () => undefined, exportJson: () => undefined, refresh: () => undefined };

/** 渲染侧：缺 logsMeta 时生效的 meta（与 diagnosticsPane 内部同一行表达式） */
function renderEffectiveMeta(): LogsMeta {
  const data = { rows: [], logs: [], version: 'probe' } as { logsMeta?: LogsMeta };
  return data.logsMeta ?? describeLogsMetaFallback();
}

/** 导出侧：panel.ts:1067 的表达式（DIAG_LIMIT/instanceId/readAt 用探针值） */
function exportEffectiveMeta(): LogsMeta {
  const diagData: { logsMeta?: LogsMeta } | null = null;
  const PROBE_LIMIT = 7;
  return (
    diagData?.logsMeta ?? {
      ...describeLogsMetaFallback(),
      limit: PROBE_LIMIT,
      instanceId: 'probe-instance',
      readAt: 1700000000000,
    }
  );
}

describe('判据 D · 观测类字段逐字段相等，动作类允许不同', () => {
  it('D1 ok / err / count 两侧完全相等（观测类）', () => {
    const r = renderEffectiveMeta();
    const e = exportEffectiveMeta();
    expect({ ok: e.ok, err: e.err, count: e.count }).toEqual({ ok: r.ok, err: r.err, count: r.count });
  });

  it('D2 动作类字段（limit / instanceId / readAt）允许不同 —— 这是审过 engineer 理由后同意的边界', () => {
    const e = exportEffectiveMeta();
    // engineer 的理由：这三个描述"这次导出动作本身"，不是"日志读到了什么"
    expect(e.limit).toBe(7);
    expect(e.instanceId).toBe('probe-instance');
    expect(e.readAt).toBe(1700000000000);
    // 渲染侧取的是 fallback 的中性值
    expect(renderEffectiveMeta().limit).toBe(0);
  });

  it('D3 两侧都真的是"不可信"语义（防止两边一起错成 ok:true）', () => {
    expect(renderEffectiveMeta().ok).toBe(false);
    expect(exportEffectiveMeta().ok).toBe(false);
    expect(renderEffectiveMeta().err).toBe('unknown');
    expect(exportEffectiveMeta().err).toBe('unknown');
  });
});

describe('判据 E · 不许用类型逃逸抹平 logsMeta 可缺性', () => {
  it('E1 diagnosticsPane 的 logsMeta 仍然是可缺（不是被改成必填）', () => {
    // 编译期证明：不传 logsMeta 依然合法
    const node = diagnosticsPane({ rows: [], logs: [], version: 'probe' }, acts);
    expect(node).toBeTruthy();
  });
});

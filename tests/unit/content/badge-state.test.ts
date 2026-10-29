/**
 * 角标状态与绘制入口的行为测试（S3.2）
 *
 * 这段逻辑原先在 `entrypoints/content.ts` 里，零测试。
 * 下沉并注入 painter 之后才第一次可测。
 *
 * 守两件事：
 *   1. 关闭角标时**摘掉已画的**（不是"不画"）
 *   2. 每个字段都能被单独更新并反映到下一次绘制（状态对象是唯一真相源）
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createBadgeState,
  paintBadge,
  type BadgePainter,
  type BadgeState,
} from '@/src/content/isolated/badge-state';

function painterSpy(): BadgePainter & {
  render: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    render: vi.fn(),
    remove: vi.fn(),
    tokensCss: '/* tokens */',
  } as unknown as BadgePainter & {
    render: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

describe('角标状态与绘制（S3.2 下沉后新增覆盖）', () => {
  describe('createBadgeState', () => {
    it('初始 proxying 为 false（未接管前不画「已接管」）', () => {
      const s = createBadgeState();
      expect(s.proxying).toBe(false);
    });

    it('HDR 相关字段初始为 null（未知 ≠ 不支持）', () => {
      const s = createBadgeState();
      expect(s.videoDynamicRange).toBeNull();
      expect(s.displayDynamicRange).toBeNull();
    });

    it('每次调用返回独立对象（不共享引用）', () => {
      const a = createBadgeState();
      const b = createBadgeState();
      a.proxying = true;
      expect(b.proxying).toBe(false);
    });
  });

  describe('paintBadge', () => {
    it('启用时调 render 并传入 tokensCss 与状态', () => {
      const state = createBadgeState();
      state.proxying = true;
      state.playingHeight = 2160;
      const painter = painterSpy();

      paintBadge(state, true, painter);

      expect(painter.remove).not.toHaveBeenCalled();
      expect(painter.render).toHaveBeenCalledTimes(1);
      expect(painter.render).toHaveBeenCalledWith('/* tokens */', state);
    });

    it('关闭时**摘掉**角标，而不是什么都不做', () => {
      /**
       * 这是关键差异：用户关掉「显示角标」后，已经画出来的必须移除，
       * 否则它会一直留在页面上直到刷新。
       */
      const painter = painterSpy();
      paintBadge(createBadgeState(), false, painter);

      expect(painter.remove).toHaveBeenCalledTimes(1);
      expect(painter.render).not.toHaveBeenCalled();
    });

    it('状态变化会反映到下一次渲染（状态对象是唯一真相源）', () => {
      const state = createBadgeState();
      const painter = painterSpy();

      paintBadge(state, true, painter);
      state.playingHeight = 2160;
      state.dolbyVisionAvailable = true;
      paintBadge(state, true, painter);

      const secondCall = painter.render.mock.calls[1] as [string, BadgeState];
      expect(secondCall[1].playingHeight).toBe(2160);
      expect(secondCall[1].dolbyVisionAvailable).toBe(true);
    });
  });
});

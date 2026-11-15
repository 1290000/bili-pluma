// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isExtensionContextAlive,
  ORPHAN_POLL_MS,
  startOrphanWatch,
} from '@/src/content/panel/orphan-hint';

interface ChromeStub {
  runtime?: { id?: string };
}

function stubChrome(value: ChromeStub | undefined): void {
  vi.stubGlobal('chrome', value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isExtensionContextAlive：纯本地判断', () => {
  it('有 runtime.id ⇒ 活着', () => {
    stubChrome({ runtime: { id: 'abc' } });
    expect(isExtensionContextAlive()).toBe(true);
  });

  it('id 变成 undefined（扩展被 reload 之后的状态）⇒ 已死', () => {
    stubChrome({ runtime: {} });
    expect(isExtensionContextAlive()).toBe(false);
  });

  it('id 是空串 ⇒ 已死（宁可多提示，也不留死壳）', () => {
    stubChrome({ runtime: { id: '' } });
    expect(isExtensionContextAlive()).toBe(false);
  });

  it('runtime 整体不存在 / chrome 不存在 ⇒ 已死', () => {
    stubChrome({});
    expect(isExtensionContextAlive()).toBe(false);
    stubChrome(undefined);
    expect(isExtensionContextAlive()).toBe(false);
  });

  it('读属性本身抛错 ⇒ 已死，不向外抛', () => {
    vi.stubGlobal('chrome', {
      get runtime(): never {
        throw new Error('Extension context invalidated.');
      },
    });
    expect(isExtensionContextAlive()).toBe(false);
  });
});

describe('startOrphanWatch：不等用户动作就能发现', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('一直活着 ⇒ 永不提示', () => {
    const onOrphan = vi.fn();
    startOrphanWatch({ onOrphan, isAlive: () => true, isHidden: () => false });
    vi.advanceTimersByTime(ORPHAN_POLL_MS * 5);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('中途变死 ⇒ 立刻提示一次，并且自己停掉（不重复弹）', () => {
    let alive = true;
    const onOrphan = vi.fn();
    startOrphanWatch({ onOrphan, isAlive: () => alive, isHidden: () => false });

    vi.advanceTimersByTime(ORPHAN_POLL_MS);
    expect(onOrphan).not.toHaveBeenCalled();

    alive = false;
    vi.advanceTimersByTime(ORPHAN_POLL_MS);
    expect(onOrphan).toHaveBeenCalledTimes(1);

    // 停掉之后不再累加 —— 否则提示会每秒重画一次
    vi.advanceTimersByTime(ORPHAN_POLL_MS * 5);
    expect(onOrphan).toHaveBeenCalledTimes(1);
  });

  it('后台标签页不判，切回前台那一拍才提示', () => {
    const alive = false;
    let hidden = true;
    const onOrphan = vi.fn();
    startOrphanWatch({ onOrphan, isAlive: () => alive, isHidden: () => hidden });

    vi.advanceTimersByTime(ORPHAN_POLL_MS * 3);
    expect(onOrphan).not.toHaveBeenCalled();

    hidden = false;
    vi.advanceTimersByTime(ORPHAN_POLL_MS);
    expect(onOrphan).toHaveBeenCalledTimes(1);
  });

  it('返回的 stop 能停掉监听', () => {
    const onOrphan = vi.fn();
    const stop = startOrphanWatch({ onOrphan, isAlive: () => false, isHidden: () => false });
    stop();
    vi.advanceTimersByTime(ORPHAN_POLL_MS * 3);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('默认间隔是 1 秒（"立刻看到"与开销的折中）', () => {
    expect(ORPHAN_POLL_MS).toBe(1000);
  });
});

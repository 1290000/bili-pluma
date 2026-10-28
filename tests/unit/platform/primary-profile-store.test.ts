/**
 * 主账号显示档案（ADR 0025）—— 守的是**字段边界**与**写入守卫**。
 *
 * ## 为什么这两件事必须用测试钉住
 *
 * 这份缓存是扩展里**唯一持久保存的"人"的信息**。它的风险不是崩溃，
 * 而是静默地多存了一点、或者被页面注入了假数据，而没人发现：
 *
 *   - 多存一个 `mid` → 从"一段文字"变成"可跨站对账的账号标识"
 *   - 多存一个页面标题 → 变成"他在看什么"
 *   - 少一道 `mid` 守卫 → 页面脚本伪造一条 `ssr-playinfo` 就能把假昵称写进存储
 *
 * 所以下面的断言分三组：**不存什么**、**该拒的拒**、**该收的收**。
 *
 * ## 为什么自己做 storage stub
 *
 * 仓库里没有 `chrome.*` 的测试基建，现有 platform 测试都刻意避开了它
 * （选纯函数测）。这个模块的守卫逻辑正是它唯一有价值的部分，绕不开。
 * 用一个内存 Map 模拟 `get/set/remove`，跑在 node 里，不引入任何依赖。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  PRIMARY_PROFILE_TTL_MS,
  clearPrimaryProfile,
  hashMid,
  readPrimaryProfile,
  savePrimaryProfile,
} from '@platform/storage/primary-profile-store';

/** 内存版 `chrome.storage.local` */
const store = new Map<string, unknown>();

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (k: string) => Promise.resolve(store.has(k) ? { [k]: store.get(k) } : {}),
        set: (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          return Promise.resolve();
        },
        remove: (k: string) => {
          store.delete(k);
          return Promise.resolve();
        },
      },
    },
  };
});

const KEY = 'pluma:primary-profile';
const T0 = 1_760_000_000_000;
const MID = '1000001';

function writeRaw(v: unknown): void {
  store.set(KEY, v);
}

function readRaw(): Record<string, unknown> | undefined {
  return store.get(KEY) as Record<string, unknown> | undefined;
}

describe('savePrimaryProfile：写入守卫', () => {
  it('同时有 uname 和真实 mid 才写', async () => {
    const ok = await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    expect(ok).toBe(true);
    expect(readRaw()?.uname).toBe('主账号');
  });

  it('没有 mid 时拒绝写入（页面伪造 ssr-playinfo 的那条路）', async () => {
    const ok = await savePrimaryProfile({ uname: '假昵称', face: null, level: 6 }, null, T0);
    expect(ok).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });

  it('mid 不是纯数字时拒绝写入（形状不对的不认）', async () => {
    const ok = await savePrimaryProfile({ uname: '假昵称', face: null, level: 6 }, 'abc', T0);
    expect(ok).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });

  it('uname 为空时拒绝写入（游客态不会覆盖掉真实昵称）', async () => {
    const ok = await savePrimaryProfile({ uname: '', face: null, level: null }, MID, T0);
    expect(ok).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });
});

describe('savePrimaryProfile：字段边界（不许越界存东西）', () => {
  it('存下来的对象里没有 mid 本身', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    const raw = readRaw();
    expect(raw).toBeDefined();
    // 序列化后整份扫一遍：mid 不能以任何形式出现
    expect(JSON.stringify(raw)).not.toContain(MID);
  });

  it('只有约定的五个字段，多一个都不行', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    expect(Object.keys(readRaw() ?? {}).sort()).toEqual(
      ['face', 'level', 'midHash', 'savedAt', 'uname'].sort(),
    );
  });

  it('调用方多塞的字段被丢弃（不落盘）', async () => {
    // 模拟未来某次改动顺手多传一个页面标题 —— 结构体拼装处只取白名单
    const sneaky = {
      uname: '主账号',
      face: null,
      level: 6,
      pageTitle: '某番剧第 8 集',
    } as { uname: string; face: string | null; level: number | null };
    await savePrimaryProfile(sneaky, MID, T0);
    expect(JSON.stringify(readRaw())).not.toContain('某番剧');
  });
});

describe('savePrimaryProfile：去重与换号', () => {
  it('同账号同内容不重复写（省 storage 写入，也保住 TTL）', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    const again = await savePrimaryProfile(
      { uname: '主账号', face: null, level: 6 },
      MID,
      T0 + 5000,
    );
    expect(again).toBe(false);
    // savedAt 没被刷新，所以 TTL 仍然从第一次算起
    expect(readRaw()?.savedAt).toBe(T0);
  });

  it('换了账号（mid 不同）就覆盖', async () => {
    await savePrimaryProfile({ uname: '甲', face: null, level: 6 }, MID, T0);
    const ok = await savePrimaryProfile(
      { uname: '乙', face: null, level: 3 },
      '1000002',
      T0 + 1000,
    );
    expect(ok).toBe(true);
    expect(readRaw()?.uname).toBe('乙');
  });

  it('等级变了也覆盖（不是只看昵称）', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 5 }, MID, T0);
    const ok = await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0 + 1000);
    expect(ok).toBe(true);
    expect(readRaw()?.level).toBe(6);
  });
});

describe('readPrimaryProfile：过期与形状校验', () => {
  it('TTL 内能读到', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    const hit = await readPrimaryProfile(T0 + PRIMARY_PROFILE_TTL_MS - 1000);
    expect(hit?.uname).toBe('主账号');
    expect(hit?.level).toBe(6);
  });

  it('超过 TTL 当作没有 —— 宁可不说，也不给一个可能错了半年的名字', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    expect(await readPrimaryProfile(T0 + PRIMARY_PROFILE_TTL_MS + 1)).toBeNull();
  });

  it('savedAt 在未来（时钟被改 / 篡改）不认', async () => {
    writeRaw({ uname: '主账号', face: null, level: 6, savedAt: T0 + 10 * 60_000, midHash: 'x' });
    expect(await readPrimaryProfile(T0)).toBeNull();
  });

  it('等级是字符串时退化成 null（不认 "6"）', async () => {
    writeRaw({ uname: '主账号', face: null, level: '6', savedAt: T0, midHash: 'x' });
    expect((await readPrimaryProfile(T0))?.level).toBeNull();
  });

  it('缺 uname / savedAt 的脏数据读不出来', async () => {
    writeRaw({ face: null, level: 6, savedAt: T0 });
    expect(await readPrimaryProfile(T0)).toBeNull();

    writeRaw({ uname: '主账号', face: null, level: 6 });
    expect(await readPrimaryProfile(T0)).toBeNull();
  });

  it('完全没写过时返回 null，不抛错', async () => {
    expect(await readPrimaryProfile(T0)).toBeNull();
  });
});

describe('hashMid', () => {
  it('同一个 mid 得到同一个散列，不同 mid 不同', async () => {
    const a = await hashMid(MID);
    const b = await hashMid(MID);
    const c = await hashMid('1000002');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64); // SHA-256 十六进制
  });

  it('散列里不含原文（不是简单拼接）', async () => {
    expect(await hashMid(MID)).not.toContain(MID);
  });

  it('空 mid 返回空串（调用方据此跳过比对）', async () => {
    expect(await hashMid('')).toBe('');
  });
});

describe('clearPrimaryProfile', () => {
  it('退出播放账号后读不到了', async () => {
    await savePrimaryProfile({ uname: '主账号', face: null, level: 6 }, MID, T0);
    expect(await readPrimaryProfile(T0)).not.toBeNull();

    await clearPrimaryProfile();
    expect(await readPrimaryProfile(T0)).toBeNull();
  });
});

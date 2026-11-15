import { describe, expect, it } from 'vitest';

import {
  isAllowedPath,
  normalizeEntryPath,
  planWrites,
  readManifestVersion,
} from '@core/update/plan';
import type { ZipEntry } from '@core/update/zip';

const ALLOWED = ['manifest.json', 'background.js', 'chunks/', 'assets/', '安装说明.txt'];
const OPTIONS = { allowedTopLevel: ALLOWED, maxTotalBytes: 10 * 1024 * 1024 };

function entry(name: string, content = 'x', unixMode: number | null = 0o100644): ZipEntry {
  return { name, data: new TextEncoder().encode(content), unixMode };
}

describe('normalizeEntryPath：路径安全', () => {
  it('反斜杠归一成正斜杠', () => {
    expect(normalizeEntryPath('chunks\\a.js')).toBe('chunks/a.js');
  });

  it('去掉开头的 ./', () => {
    expect(normalizeEntryPath('./manifest.json')).toBe('manifest.json');
  });

  const dangerous = [
    '/etc/passwd',
    'C:/Windows/system32/x.dll',
    '../escape.js',
    'chunks/../../escape.js',
    'chunks//a.js',
    'chunks/./a.js',
    '',
    'a\0b',
  ];

  for (const bad of dangerous) {
    it(`拒绝 ${JSON.stringify(bad)}`, () => {
      expect(() => normalizeEntryPath(bad)).toThrow();
    });
  }
});

describe('isAllowedPath', () => {
  it('根文件要求全等，不允许前缀匹配', () => {
    expect(isAllowedPath('manifest.json', ALLOWED)).toBe(true);
    expect(isAllowedPath('manifest.json.bak', ALLOWED)).toBe(false);
  });

  it('目录项允许整棵子树', () => {
    expect(isAllowedPath('chunks/a/b/c.js', ALLOWED)).toBe(true);
    expect(isAllowedPath('chunksx/a.js', ALLOWED)).toBe(false);
  });
});

describe('planWrites', () => {
  it('白名单内的条目全部进入 writes', () => {
    const plan = planWrites([entry('manifest.json'), entry('chunks/new-hash.js')], OPTIONS);
    expect(plan.writes.map((w) => w.path)).toEqual(['manifest.json', 'chunks/new-hash.js']);
    expect(plan.rejected).toEqual([]);
  });

  it('顶层不在白名单 ⇒ 拒绝，且给出原因（不许静默丢弃）', () => {
    const plan = planWrites([entry('manifest.json'), entry('steal.js')], OPTIONS);
    expect(plan.writes.map((w) => w.path)).toEqual(['manifest.json']);
    expect(plan.rejected).toEqual([{ path: 'steal.js', reason: '顶层不在白名单' }]);
  });

  it('软链接条目 ⇒ 拒绝（防止写穿到别处）', () => {
    const plan = planWrites([entry('chunks/link.js', 'x', 0o120777)], OPTIONS);
    expect(plan.writes).toEqual([]);
    expect(plan.rejected[0]?.reason).toBe('软链接条目');
  });

  it('路径穿越 ⇒ 拒绝', () => {
    const plan = planWrites([entry('../evil.js')], OPTIONS);
    expect(plan.writes).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
  });

  it('同名条目出现两次 ⇒ 拒绝第二条（打包有问题，不玩"后者覆盖"）', () => {
    const plan = planWrites([entry('manifest.json', 'a'), entry('manifest.json', 'b')], OPTIONS);
    expect(plan.writes).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toBe('重复条目');
  });

  it('总量超上限 ⇒ 直接抛错（不做部分写入）', () => {
    expect(() =>
      planWrites([entry('manifest.json', 'x'.repeat(100))], { ...OPTIONS, maxTotalBytes: 50 }),
    ).toThrow(/总量超过上限/);
  });

  it('统计的 totalBytes 是解压后的大小', () => {
    const plan = planWrites(
      [entry('manifest.json', 'abcd'), entry('background.js', 'xy')],
      OPTIONS,
    );
    expect(plan.totalBytes).toBe(6);
  });
});

describe('readManifestVersion', () => {
  it('读出真实版本号', () => {
    expect(readManifestVersion([entry('manifest.json', '{"version":"1.2.0"}')])).toBe('1.2.0');
  });

  it('没有 manifest.json ⇒ 抛错', () => {
    expect(() => readManifestVersion([entry('background.js')])).toThrow(/没有 manifest.json/);
  });

  it('不是 JSON ⇒ 抛错', () => {
    expect(() => readManifestVersion([entry('manifest.json', '{oops')])).toThrow(/不是合法 JSON/);
  });

  it('没有 version 字段 ⇒ 抛错（否则"要装的版本"无从确认）', () => {
    expect(() => readManifestVersion([entry('manifest.json', '{"name":"x"}')])).toThrow(
      /没有 version/,
    );
  });
});

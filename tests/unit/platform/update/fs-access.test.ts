import { describe, expect, it, vi } from 'vitest';

import { readDirManifestVersion, writeFiles, type PermDirHandle } from '@platform/update/fs-access';

interface FakeFile {
  bytes: Uint8Array;
}

/**
 * 内存里的假目录句柄 —— 只实现 `writeFiles` 用到的四个方法。
 *
 * ⚠️ 刻意**不**实现 `createWritable` 的流语义：这里验的是"路径怎么落、
 * 写完怎么复核"，不是 Chromium 的写入实现。
 */
function fakeDir(options: { realBytes?: number } = {}) {
  const files = new Map<string, FakeFile>();
  const createdDirs: string[] = [];

  const makeDir = (prefix: string): PermDirHandle => {
    const dir = {
      name: prefix || 'root',
      kind: 'directory' as const,
      async getDirectoryHandle(segment: string) {
        createdDirs.push(`${prefix}/${segment}`);
        return makeDir(`${prefix}/${segment}`);
      },
      async getFileHandle(fileName: string, opts?: { create?: boolean }) {
        const key = `${prefix}/${fileName}`;
        if (!files.has(key) && opts?.create !== true) throw new Error(`不存在：${key}`);
        return {
          kind: 'file' as const,
          name: fileName,
          async createWritable() {
            return {
              async write(data: Uint8Array) {
                files.set(key, { bytes: new Uint8Array(data) });
              },
              async close() {
                /* noop */
              },
            };
          },
          async getFile() {
            const stored = files.get(key);
            if (!stored) throw new Error(`不存在：${key}`);
            // `realBytes` 用来模拟"写进去的字节数不对"（磁盘满 / 被截断）
            const size = options.realBytes ?? stored.bytes.byteLength;
            return { size, text: () => Promise.resolve(new TextDecoder().decode(stored.bytes)) };
          },
        };
      },
    };
    return dir as unknown as PermDirHandle;
  };

  return { handle: makeDir(''), files, createdDirs };
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

describe('writeFiles：路径与目录', () => {
  it('根文件直接落，子目录按段递归创建', async () => {
    const { handle, files, createdDirs } = fakeDir();
    await writeFiles(handle, [
      { path: 'manifest.json', data: bytes('{"version":"1.2.0"}') },
      { path: 'chunks/a/b.js', data: bytes('x') },
    ]);

    expect([...files.keys()]).toEqual(['/manifest.json', '/chunks/a/b.js']);
    expect(createdDirs).toContain('/chunks');
    expect(createdDirs).toContain('/chunks/a');
  });

  it('返回文件数与总字节数', async () => {
    const { handle } = fakeDir();
    const result = await writeFiles(handle, [
      { path: 'a.js', data: bytes('12345') },
      { path: 'b.js', data: bytes('123') },
    ]);
    expect(result).toEqual({ files: 2, bytes: 8 });
  });

  it('进度回调按顺序、末次 index 等于总数', async () => {
    const { handle } = fakeDir();
    const seen: number[] = [];
    await writeFiles(
      handle,
      [
        { path: 'a.js', data: bytes('a') },
        { path: 'b.js', data: bytes('b') },
      ],
      (p) => {
        seen.push(p.index);
        expect(p.total).toBe(2);
      },
    );
    expect(seen).toEqual([1, 2]);
  });

  it('空路径段被拒绝（不能靠 path 拼出越界写入）', async () => {
    const { handle } = fakeDir();
    await expect(
      writeFiles(handle, [{ path: 'chunks//a.js', data: bytes('x') }]),
    ).rejects.toThrow();
  });
});

describe('writeFiles：写后复核', () => {
  it('回读 size 不符 ⇒ 抛错，绝不当成成功', async () => {
    // 模拟"写进去了但字节数不对"
    const { handle } = fakeDir({ realBytes: 3 });
    await expect(writeFiles(handle, [{ path: 'a.js', data: bytes('12345') }])).rejects.toThrow(
      /写入校验失败/,
    );
  });
});

describe('readDirManifestVersion', () => {
  it('读出目录里的版本号', async () => {
    const { handle, files } = fakeDir();
    files.set('/manifest.json', { bytes: bytes('{"version":"1.1.0"}') });
    await expect(readDirManifestVersion(handle)).resolves.toBe('1.1.0');
  });

  it('目录里没有 manifest.json ⇒ 明确说"选到别的地方了"', async () => {
    const { handle } = fakeDir();
    await expect(readDirManifestVersion(handle)).rejects.toThrow(/没有 manifest\.json/);
  });

  it('manifest 没有 version ⇒ 抛错', async () => {
    const { handle, files } = fakeDir();
    files.set('/manifest.json', { bytes: bytes('{"name":"x"}') });
    await expect(readDirManifestVersion(handle)).rejects.toThrow(/没有 version/);
  });
});

describe('writeFiles 与真实数据的配合', () => {
  it('中文文件名与目录都能写', async () => {
    const { handle, files } = fakeDir();
    await writeFiles(handle, [{ path: '安装说明.txt', data: bytes('装我') }]);
    expect([...files.keys()]).toEqual(['/安装说明.txt']);
  });

  it('同一个目录被写多次不会互相覆盖（不同文件名）', async () => {
    const { handle, files } = fakeDir();
    const spy = vi.fn();
    await writeFiles(
      handle,
      [
        { path: 'icon/16.png', data: bytes('a') },
        { path: 'icon/32.png', data: bytes('b') },
      ],
      spy,
    );
    expect(files.size).toBe(2);
  });
});

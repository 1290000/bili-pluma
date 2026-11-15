import { describe, expect, it } from 'vitest';

import { crc32, readZip } from '@core/update/zip';

import { buildZip } from './zip-fixture';

const LIMIT = 1024 * 1024;

describe('crc32', () => {
  it('与标准校验值一致（"123456789" → 0xCBF43926）', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('空输入是 0', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('readZip：正常解包', () => {
  it('store 与 deflate 都能读，内容一字不差', async () => {
    const zip = buildZip([
      { name: 'manifest.json', content: '{"version":"1.2.0"}', method: 'store' },
      { name: 'background.js', content: 'console.log(1);'.repeat(50), method: 'deflate' },
    ]);
    const entries = await readZip(zip, { maxEntryBytes: LIMIT });

    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'background.js']);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe('{"version":"1.2.0"}');
    expect(new TextDecoder().decode(entries[1]?.data)).toBe('console.log(1);'.repeat(50));
  });

  it('保留子目录路径与中文文件名', async () => {
    const zip = buildZip([
      { name: 'content-scripts/content.js', content: 'x' },
      { name: '安装说明.txt', content: '装我' },
    ]);
    const entries = await readZip(zip, { maxEntryBytes: LIMIT });
    expect(entries.map((e) => e.name)).toEqual(['content-scripts/content.js', '安装说明.txt']);
  });

  it('目录条目被跳过，不产生空的写入项', async () => {
    const zip = buildZip([
      { name: 'chunks/', content: '' },
      { name: 'chunks/a.js', content: 'a' },
    ]);
    const entries = await readZip(zip, { maxEntryBytes: LIMIT });
    expect(entries.map((e) => e.name)).toEqual(['chunks/a.js']);
  });

  it('带注释的 zip 也能找到 EOCD', async () => {
    const zip = buildZip([{ name: 'manifest.json', content: '{}' }], '这是一段注释');
    const entries = await readZip(zip, { maxEntryBytes: LIMIT });
    expect(entries).toHaveLength(1);
  });

  it('unix 权限位被带出来（软链接判据靠它）', async () => {
    const zip = buildZip([{ name: 'link.js', content: 'x', mode: 0o120777 }]);
    const entries = await readZip(zip, { maxEntryBytes: LIMIT });
    expect(entries[0]?.unixMode).toBe(0o120777);
  });
});

describe('readZip：拒绝异常包（每条都要有具体原因）', () => {
  it('不是 zip', async () => {
    await expect(
      readZip(new TextEncoder().encode('hello').buffer, { maxEntryBytes: LIMIT }),
    ).rejects.toThrow(/不是 zip/);
  });

  it('CRC 对不上 ⇒ 判为损坏，不许当成"解压成功"', async () => {
    const zip = buildZip([
      { name: 'manifest.json', content: '{"version":"1.0.0"}', breakCrc: true },
    ]);
    await expect(readZip(zip, { maxEntryBytes: LIMIT })).rejects.toThrow(/CRC 校验失败/);
  });

  it('加密条目', async () => {
    const zip = buildZip([{ name: 'manifest.json', content: '{}', encrypted: true }]);
    await expect(readZip(zip, { maxEntryBytes: LIMIT })).rejects.toThrow(/加密/);
  });

  it('不认识的压缩方法', async () => {
    const zip = buildZip([{ name: 'manifest.json', content: '{}', fakeMethod: 12 }]);
    await expect(readZip(zip, { maxEntryBytes: LIMIT })).rejects.toThrow(/不支持的压缩方法/);
  });

  it('单条目超过上限', async () => {
    const zip = buildZip([{ name: 'big.js', content: 'x'.repeat(200) }]);
    await expect(readZip(zip, { maxEntryBytes: 100 })).rejects.toThrow(/条目过大/);
  });

  it('数据被截断（中央目录还在，正文缺了）', async () => {
    const zip = buildZip([{ name: 'a.js', content: 'x'.repeat(300) }]);
    const truncated = zip.slice(0, zip.byteLength - 120);
    await expect(readZip(truncated, { maxEntryBytes: LIMIT })).rejects.toThrow();
  });
});

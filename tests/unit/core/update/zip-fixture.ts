/**
 * 测试用的最小 ZIP 写入器。
 *
 * ## 为什么不用真实发行包当 fixture
 *
 * `pluma-1.1.0.zip` 有 283 KB，往仓库里塞一个二进制产物既脏又会过期。
 * 这里按 ZIP 规范手搓字节，能精确构造**边界**场景（软链接条目、未知压缩方法、
 * 加密位、CRC 错、路径穿越），这些用真包反而造不出来。
 *
 * ⚠️ 写入器只服务于测试，别在产品代码里引它。
 */

import { deflateRawSync } from 'node:zlib';

import { crc32 } from '@core/update/zip';

export interface FixtureEntry {
  name: string;
  content: string | Uint8Array;
  /** `store` 不压缩，`deflate` 走 deflate-raw */
  method?: 'store' | 'deflate';
  /** unix 权限位，写进 external attributes（软链接用 0o120777） */
  mode?: number;
  /** 置位后故意把 CRC 写错，用来测校验 */
  breakCrc?: boolean;
  /** 置位后写成"未知压缩方法"，用来测拒绝分支 */
  fakeMethod?: number;
  /** 置位后写入加密标志位 */
  encrypted?: boolean;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

export function buildZip(entries: readonly FixtureEntry[], comment = ''): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = toBytes(entry.content);
    const method = entry.fakeMethod ?? (entry.method === 'store' ? 0 : 8);
    const body = method === 8 ? deflateRawSync(Buffer.from(raw)) : Buffer.from(raw);
    const crc = entry.breakCrc === true ? 0xdeadbeef : crc32(raw);
    const nameBytes = Buffer.from(entry.name, 'utf-8');
    const flags = entry.encrypted === true ? 0x0001 : 0;

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(body.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      body,
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(0x031e),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(body.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32((entry.mode ?? 0o100644) << 16),
      u32(offset),
      nameBytes,
    ]);
    centrals.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'utf-8');
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(commentBytes.length),
    commentBytes,
  ]);

  const all = Buffer.concat([...locals, centralBuf, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

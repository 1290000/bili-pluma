/**
 * 零依赖 ZIP 读取 —— 只用 `DecompressionStream('deflate-raw')`，不引第三方库。
 *
 * ## 为什么不引库
 *
 * 我们只需要"把一个平铺的 zip 解开、拿到名字+字节"，`fflate` 之类能做的事
 * 这里 200 行就够；而这个代码要跑在扩展里、要被审计、要被单测。
 * 少一个依赖 = 少一份要信任的东西（本项目的分发方式已经够敏感了）。
 *
 * `DecompressionStream` 在 Chromium 103+ 与 Node 18+ 都有（本机 Node 22 实测可用），
 * 所以解析逻辑能在 vitest 里直接跑。
 *
 * ## 只支持什么 / 明确拒绝什么
 *
 * 支持：store(0) 与 deflate(8)、有/无 data descriptor、UTF-8 与 ASCII 文件名。
 * **拒绝**：ZIP64（我们包固定 283 KB 量级）、加密、不认识的压缩方法、多卷。
 * 拒绝时抛带具体原因的错 —— 更新流程里"为什么解不开"必须能说清楚。
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

export interface ZipEntry {
  /** 归一化后的路径：正斜杠、无前导斜杠 */
  name: string;
  data: Uint8Array;
  /** 来自中央目录 external attributes 的 unix 权限位；拿不到就是 `null` */
  unixMode: number | null;
}

export interface ReadZipOptions {
  /** 单个条目最大字节数，超出即判异常包 */
  maxEntryBytes: number;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32（IEEE）。**必须校验**：解压成功不等于数据正确 ——
 * store 方式的条目被截断时 deflate 不会报错，只有 CRC 能发现。
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEocd(view: DataView): number {
  const len = view.byteLength;
  if (len < EOCD_MIN_BYTES) throw new Error('不是 zip：文件太小');
  const lowest = Math.max(0, len - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let i = len - EOCD_MIN_BYTES; i >= lowest; i -= 1) {
    if (u32(view, i) === EOCD_SIG) return i;
  }
  throw new Error('不是 zip：找不到中央目录结束记录（EOCD）');
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // 用 writer/reader 而不是 `pipeThrough`：lib.dom 里 `DecompressionStream` 的
  // 泛型与 `pipeThrough` 要求的 `ReadableWritablePair` 对不上，写了就得加 cast。
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reading = new Response(ds.readable).arrayBuffer();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await reading);
}

/**
 * 解析 zip 并**一次性**把所有条目读进内存。
 *
 * 一次读全是有意的：更新包只有 283 KB 量级，而"边解析边写盘"会让
 * 半途失败更难收场（见方案 §5 风险 1）。
 */
export async function readZip(buffer: ArrayBuffer, options: ReadZipOptions): Promise<ZipEntry[]> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);

  // ZIP64 会在这里露出占位符（0xffff / 0xffffffff），我们不支持
  if (u32(view, eocd - 20) === ZIP64_LOCATOR_SIG) {
    throw new Error('不支持 ZIP64 格式的包');
  }

  const entryCount = u16(view, eocd + 10);
  const cdOffset = u32(view, eocd + 16);
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error('不支持 ZIP64 格式的包');
  }
  if (cdOffset >= view.byteLength) {
    throw new Error('zip 结构损坏：中央目录偏移越界');
  }

  const entries: ZipEntry[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > view.byteLength || u32(view, cursor) !== CD_SIG) {
      throw new Error(`zip 结构损坏：第 ${String(i + 1)} 个中央目录项无效`);
    }

    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const expectedCrc = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLen = u16(view, cursor + 28);
    const extraLen = u16(view, cursor + 30);
    const commentLen = u16(view, cursor + 32);
    const externalAttrs = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);

    if ((flags & 0x0001) !== 0) throw new Error('不支持加密的 zip 条目');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('不支持 ZIP64 格式的包');
    }

    const nameStart = cursor + 46;
    const name = decodeName(bytes.slice(nameStart, nameStart + nameLen));

    // 目录项（名以 / 结尾、大小为 0）不需要内容，但仍要占位以保持顺序判断
    if (name.endsWith('/')) {
      cursor = nameStart + nameLen + extraLen + commentLen;
      continue;
    }

    if (uncompressedSize > options.maxEntryBytes) {
      throw new Error(`条目过大：${name} 解压后 ${String(uncompressedSize)} 字节`);
    }

    if (localOffset + 30 > view.byteLength || u32(view, localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 结构损坏：${name} 的本地文件头无效`);
    }
    const localNameLen = u16(view, localOffset + 26);
    const localExtraLen = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > view.byteLength) {
      throw new Error(`zip 结构损坏：${name} 的数据越界`);
    }

    const raw = bytes.slice(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new Error(`不支持的压缩方法 ${String(method)}：${name}`);
    }

    if (data.byteLength !== uncompressedSize) {
      throw new Error(
        `解压后长度不符：${name} 期望 ${String(uncompressedSize)}，实得 ${String(data.byteLength)}`,
      );
    }

    if (crc32(data) !== expectedCrc) {
      throw new Error(`CRC 校验失败：${name}（数据损坏或包被改过）`);
    }

    const mode = externalAttrs >>> 16;
    entries.push({ name, data, unixMode: mode === 0 ? null : mode });
    cursor = nameStart + nameLen + extraLen + commentLen;
  }

  return entries;
}

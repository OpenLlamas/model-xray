import { deflateSync } from 'node:zlib';

let cachedTable: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (cachedTable) return cachedTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  cachedTable = table;
  return table;
}

export function crc32(buf: Uint8Array): number {
  const table = crcTable();
  let c = 0xffffffff;
  for (const byte of buf) {
    c = (table[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function solidRgbPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function dataUrlPng(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

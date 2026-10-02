import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { crc32, dataUrlPng, solidRgbPng } from '../../src/png.js';

test('crc32 matches known vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

test('solidRgbPng produces a valid decodable PNG', () => {
  const png = solidRgbPng(8, [30, 60, 220]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? -1;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    }
    pos += 12 + len;
  }
  assert.equal(width, 8);
  assert.equal(height, 8);
  assert.equal(colorType, 2);

  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (8 * 3 + 1) * 8);
  assert.deepEqual([raw[0], raw[1], raw[2], raw[3]], [0, 30, 60, 220]);
  assert.deepEqual([raw[raw.length - 3], raw[raw.length - 2], raw[raw.length - 1]], [30, 60, 220]);
});

test('recompression of the same color is deterministic', () => {
  const a = deflateSync(solidRgbPng(4, [1, 2, 3]));
  const b = deflateSync(solidRgbPng(4, [1, 2, 3]));
  assert.deepEqual([...a], [...b]);
});

test('dataUrlPng has base64 payload', () => {
  const url = dataUrlPng(solidRgbPng(2, [0, 0, 0]));
  assert.ok(url.startsWith('data:image/png;base64,'));
});

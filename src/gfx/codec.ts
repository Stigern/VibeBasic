// Picture files from drawn pixels (Image, SavePicture): PNG (stored, uncompressed deflate: valid and fast, no library) and
// 24-bit BMP. Input is opaque RGBA bytes, row by row from the top.

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const rowLen = w * 3 + 1;
  const raw = new Uint8Array(rowLen * h);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0;   // filter: none
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * rowLen + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  // zlib stream of stored blocks
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const from = b * 65535, len = Math.min(65535, raw.length - from);
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff; z[o++] = len >>> 8; z[o++] = ~len & 0xff; z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(from, from + len), o);
    o += len;
  }
  let a = 1, b2 = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b2 = (b2 + a) % 65521; }
  const adler = ((b2 << 16) | a) >>> 0;
  z[o++] = adler >>> 24; z[o++] = (adler >>> 16) & 0xff; z[o++] = (adler >>> 8) & 0xff; z[o++] = adler & 0xff;

  const chunks: [string, Uint8Array][] = [
    ['IHDR', Uint8Array.of(w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff, h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, 8, 2, 0, 0, 0)],
    ['IDAT', z],
    ['IEND', new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let p = 8;
  for (const [type, data] of chunks) {
    const v = new DataView(out.buffer);
    v.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    v.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return out;
}

export function encodeBmp(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const stride = (w * 3 + 3) & ~3;
  const size = 54 + stride * h;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);   // bottom-up
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, stride * h, true);
  v.setInt32(38, 3780, true);   // 96 dpi
  v.setInt32(42, 3780, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      out[row + x * 3] = rgba[s + 2]; out[row + x * 3 + 1] = rgba[s + 1]; out[row + x * 3 + 2] = rgba[s];
    }
  }
  return out;
}

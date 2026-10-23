// Pictures of imported VB6 forms (.frx): the image type by its first bytes, and BMP / ICO converted to PNG (pure TypeScript, so
// the import works the same in the app, the browser and the tests). Used by vb6Import.ts.

export type ImageKind = 'bmp' | 'ico' | 'cur' | 'gif' | 'jpg' | 'png' | 'wmf' | 'emf';
export interface RgbaImage { width: number; height: number; rgba: Uint8Array }

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number): number => u32(b, o) | 0;
/** The largest width and height of an imported picture (a larger one is skipped with a warning). */
const MAX_SIDE = 8192;

/** The image type of `b` by its signature, or null when unknown. */
export function imageKind(b: Uint8Array): ImageKind | null {
  if (b.length < 4) return null;
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return b[2] === 1 ? 'ico' : 'cur';
  if (u32(b, 0) === 0x9ac6cdd7 || (b[0] === 1 && b[1] === 0 && b[2] === 9 && b[3] === 0)) return 'wmf';
  if (u32(b, 0) === 1 && b.length > 44 && u32(b, 40) === 0x464d4520) return 'emf';
  return null;
}

/**
 * A device-independent bitmap at `off` (BITMAPINFOHEADER or BITMAPCOREHEADER, 1/4/8/16/24/32 bits, BI_RGB or BI_BITFIELDS).
 * `pixelsAt`: where the pixels start (a .bmp file says so; otherwise right after the colour table). `icon`: the DIB of an icon
 * (the height counts the XOR and AND bitmaps; the AND mask makes pixels transparent). RLE bitmaps throw.
 */
function decodeDib(b: Uint8Array, off: number, pixelsAt: number | null, icon: boolean): RgbaImage {
  const hs = u32(b, off);
  const core = hs === 12;
  const width = core ? u16(b, off + 4) : i32(b, off + 4);
  let height = core ? u16(b, off + 6) : i32(b, off + 8);
  const bpp = core ? u16(b, off + 10) : u16(b, off + 14);
  const compression = core ? 0 : u32(b, off + 16);
  if (compression !== 0 && compression !== 3) throw new Error('compressed (RLE) bitmaps are not supported');
  if (icon) height = Math.floor(height / 2);
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0) throw new Error('bad bitmap size');
  if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`the picture is too big (over ${MAX_SIDE} x ${MAX_SIDE} pixels)`);
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new Error(`${bpp}-bit bitmaps are not supported`);
  let p = off + hs;
  let masks: [number, number, number] | null = null;
  if (compression === 3) {
    masks = hs >= 52 ? [u32(b, off + 40), u32(b, off + 44), u32(b, off + 48)] : [u32(b, p), u32(b, p + 4), u32(b, p + 8)];
    if (hs < 52) p += 12;
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f];
  const clrUsed = core ? 0 : u32(b, off + 32);
  // biClrUsed comes from the file: never more entries than the bit depth can index
  const nColors = bpp <= 8 ? Math.min(clrUsed || 1 << bpp, 1 << bpp) : 0;
  const entry = core ? 3 : 4;
  if (p + nColors * entry > b.length) throw new Error('the bitmap is cut short');
  const palette: number[][] = [];
  for (let i = 0; i < nColors; i++) palette.push([b[p + i * entry + 2], b[p + i * entry + 1], b[p + i * entry]]);
  p += nColors * entry;
  const data = pixelsAt ?? p;
  const stride = ((width * bpp + 31) >>> 5) * 4;
  if (data + stride * height > b.length) throw new Error('the bitmap is cut short');   // before the pixels are allocated
  const rgba = new Uint8Array(width * height * 4);
  const chan = (v: number, m: number): number => {
    if (!m) return 0;
    const shift = Math.log2(m & -m), max = m >>> shift;
    return Math.round((((v & m) >>> shift) * 255) / max);
  };
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = data + (topDown ? y : height - 1 - y) * stride;
    if (row + stride > b.length) throw new Error('the bitmap is cut short');
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0, g = 0, bl = 0, a = 255;
      if (bpp <= 8) {
        const bit = x * bpp, byte = b[row + (bit >>> 3)];
        const idx = (byte >>> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        [r, g, bl] = palette[idx] ?? [0, 0, 0];
      } else if (bpp === 16) {
        const v = u16(b, row + x * 2);
        r = chan(v, masks![0]); g = chan(v, masks![1]); bl = chan(v, masks![2]);
      } else if (bpp === 24 || bpp === 32) {
        const q = row + x * (bpp / 8);
        if (masks && bpp === 32) { const v = u32(b, q); r = chan(v, masks[0]); g = chan(v, masks[1]); bl = chan(v, masks[2]); } else { bl = b[q]; g = b[q + 1]; r = b[q + 2]; }
        if (bpp === 32) { a = b[q + 3]; if (a) anyAlpha = true; }
      } else throw new Error(`${bpp}-bit bitmaps are not supported`);
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = a;
    }
  }
  // 32-bit BI_RGB usually leaves the 4th byte 0: then it is no alpha channel
  if (bpp === 32 && !anyAlpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  if (icon && !(bpp === 32 && anyAlpha)) {
    const maskAt = data + stride * height, mStride = ((width + 31) >>> 5) * 4;
    if (maskAt + mStride * height <= b.length) {
      for (let y = 0; y < height; y++) {
        const row = maskAt + (topDown ? y : height - 1 - y) * mStride;
        for (let x = 0; x < width; x++) if ((b[row + (x >>> 3)] >>> (7 - (x & 7))) & 1) rgba[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  return { width, height, rgba };
}

/** A .bmp file (BITMAPFILEHEADER + DIB). */
export function decodeBmp(b: Uint8Array): RgbaImage {
  if (imageKind(b) !== 'bmp') throw new Error('not a bitmap');
  return decodeDib(b, 14, u32(b, 10), false);
}

/** The largest image of a .ico / .cur file: a PNG entry as its bytes, a DIB entry decoded. */
export function decodeIco(b: Uint8Array): RgbaImage | { png: Uint8Array } {
  const n = u16(b, 4);
  if (!n) throw new Error('an empty icon');
  let best = -1, bestArea = -1;
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const area = (b[e] || 256) * (b[e + 1] || 256) * 1000 + u16(b, e + 6);   // size first, then colour depth
    if (area > bestArea) { bestArea = area; best = e; }
  }
  const size = u32(b, best + 8), at = u32(b, best + 12);
  const img = b.subarray(at, at + size);
  if (imageKind(img) === 'png') return { png: img.slice() };
  return decodeDib(b, at, null, true);
}

// ---------------------------------------------------------------------------------------------------------------
// PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new TextEncoder().encode(type);
  return [be32(data.length), t, data, be32(crc32([t, data]))];
}

/** zlib data: CompressionStream when the platform has it, else stored (uncompressed) deflate blocks. */
async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* fall back below */ }
  }
  const out: number[] = [0x78, 0x01];
  for (let i = 0; i === 0 || i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    out.push(i + len >= raw.length ? 1 : 0, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255);
    for (let k = 0; k < len; k++) out.push(raw[i + k]);
  }
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  out.push(...be32(((b << 16) | a) >>> 0));
  return new Uint8Array(out);
}

/** An RGBA image as a PNG file. */
export async function encodePng(img: RgbaImage): Promise<Uint8Array> {
  const { width, height, rgba } = img;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0); ihdr.set(be32(height), 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8 bits, RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk('IHDR', ihdr), ...chunk('IDAT', await zlib(raw)), ...chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A picture from a .frx as a project asset: BMP and ICO/CUR become PNG, GIF / JPG / PNG keep their type. Throws for metafiles
 *  and unknown data. */
export async function pictureAsset(b: Uint8Array): Promise<{ mime: string; bytes: Uint8Array }> {
  const kind = imageKind(b);
  switch (kind) {
    case 'gif': return { mime: 'image/gif', bytes: b };
    case 'jpg': return { mime: 'image/jpeg', bytes: b };
    case 'png': return { mime: 'image/png', bytes: b };
    case 'bmp': return { mime: 'image/png', bytes: await encodePng(decodeBmp(b)) };
    case 'ico': case 'cur': {
      const r = decodeIco(b);
      return { mime: 'image/png', bytes: 'png' in r ? r.png : await encodePng(r) };
    }
    case 'wmf': case 'emf': throw new Error('metafiles (WMF/EMF) are not supported');
    default: throw new Error('unknown picture data');
  }
}

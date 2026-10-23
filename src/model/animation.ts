// Animation (MSCOMCT2.OCX): which files it plays and how long their frames last. The WebView plays the pictures (an <img> for GIF, APNG and WebP,
// a <video> for MP4 and WebM); the run session only needs the frame delays to know when Play ends, so they are read from the file here.

export type AnimKind = 'image' | 'video';

const KINDS: Record<string, { kind: AnimKind; mime: string }> = {
  gif: { kind: 'image', mime: 'image/gif' }, png: { kind: 'image', mime: 'image/png' }, apng: { kind: 'image', mime: 'image/apng' },
  webp: { kind: 'image', mime: 'image/webp' },
  mp4: { kind: 'video', mime: 'video/mp4' }, m4v: { kind: 'video', mime: 'video/mp4' }, webm: { kind: 'video', mime: 'video/webm' },
};

const ext = (path: string): string => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';

/** What the Animation can play, from the file name; undefined for AVI and everything else (error 35752). */
export function animationFormat(path: string): { kind: AnimKind; mime: string } | undefined { return KINDS[ext(path)]; }

/** The frames of a file: the delay of each in ms (empty: not known; a picture with one frame has one). */
export function frameDelays(bytes: Uint8Array, kind: AnimKind): number[] {
  if (kind === 'video') return [];
  try {
    return gifDelays(bytes) ?? apngDelays(bytes) ?? webpDelays(bytes) ?? [0];
  } catch {
    return [0];
  }
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
/** Browsers play a GIF delay of 0 or 1 centisecond as 100 ms. */
const gifMs = (cs: number): number => (cs <= 1 ? 100 : cs * 10);

function gifDelays(b: Uint8Array): number[] | null {
  if (b.length < 14 || ascii(b, 0, 3) !== 'GIF') return null;
  const out: number[] = [];
  let p = 13;
  const flags = b[10];
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  let delay = 10;
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) break;
    if (t === 0x21) {   // extension: 0xF9 holds the delay of the next frame
      const label = b[p++];
      if (label === 0xf9 && b[p] >= 4) delay = gifMs(b[p + 2] | (b[p + 3] << 8));
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
    } else if (t === 0x2c) {   // an image: descriptor, optional colour table, LZW data blocks
      const f = b[p + 8];
      p += 9;
      if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
      p++;   // LZW minimum code size
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
      out.push(delay);
      delay = 10;
    } else break;
  }
  return out.length ? out : null;
}

function apngDelays(b: Uint8Array): number[] | null {
  if (b.length < 8 || b[0] !== 0x89 || ascii(b, 1, 3) !== 'PNG') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: number[] = [];
  let animated = false;
  for (let p = 8; p + 8 <= b.length;) {
    const len = v.getUint32(p), type = ascii(b, p + 4, 4);
    if (type === 'acTL') animated = true;
    else if (type === 'fcTL') {
      const num = v.getUint16(p + 8 + 20), den = v.getUint16(p + 8 + 22) || 100;
      out.push(Math.max(10, Math.round(num * 1000 / den)));
    } else if (type === 'IDAT') break;
    p += 12 + len;
  }
  return animated && out.length ? out : [0];
}

function webpDelays(b: Uint8Array): number[] | null {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const out: number[] = [];
  for (let p = 12; p + 8 <= b.length;) {
    const type = ascii(b, p, 4), len = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
    if (type === 'ANMF') out.push(Math.max(10, b[p + 8 + 12] | (b[p + 8 + 13] << 8) | (b[p + 8 + 14] << 16)));
    p += 8 + len + (len & 1);
  }
  return out.length ? out : [0];
}

/** The start (ms) of frame `n` (0-based); a frame past the end is the end. */
export function frameStart(delays: readonly number[], n: number): number {
  let t = 0;
  for (let i = 0; i < n && i < delays.length; i++) t += delays[i];
  return t;
}

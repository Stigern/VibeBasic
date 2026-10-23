// VB6 colours. Ordinary colours are BGR `&H00BBGGRR`; system colours are `&H800000xx` mapped to the Win98 palette.
//
// The interpreter produces system colours as NEGATIVE numbers (VB6 hex literals are signed:
// &H8000000F = -2147483633), while code written as 0x8000000F is positive. Both are accepted.

/** Win98 system colours, keyed by the unsigned colour code (e.g. 0x8000000F). */
export const SYSTEM_COLORS: Readonly<Record<number, string>> = {
  0x80000000: '#c0c0c0', 0x80000001: '#008080', 0x80000002: '#000080', 0x80000003: '#808080',
  0x80000005: '#ffffff', 0x80000006: '#000000', 0x80000008: '#000000', 0x80000009: '#ffffff',
  0x8000000c: '#808080', 0x8000000d: '#000080', 0x8000000e: '#ffffff', 0x8000000f: '#c0c0c0', 0x80000010: '#808080',
  0x80000011: '#808080', 0x80000012: '#000000', 0x80000014: '#ffffff', 0x80000015: '#000000',
  0x80000016: '#dfdfdf', 0x80000017: '#000000', 0x80000018: '#ffffe1',
};

/** Colour used for a system colour index that is not in SYSTEM_COLORS: button face grey. */
const UNKNOWN_SYSTEM_COLOR = '#c0c0c0';

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

export function vbColorToCss(n: number): string {
  const u = n >>> 0;
  if (u >>> 24 === 0x80) return SYSTEM_COLORS[u] ?? UNKNOWN_SYSTEM_COLOR;
  return '#' + hex2(u & 0xff) + hex2((u >>> 8) & 0xff) + hex2((u >>> 16) & 0xff);
}

const rgb = (rrggbb: number): number => ((rrggbb & 0xff) << 16) | (rrggbb & 0xff00) | (rrggbb >>> 16);

/** The 48-colour palette of the VB6 colour picker (6 rows of 8), as VB BGR values. */
export const PALETTE_48: readonly number[] = [
  0xff8080, 0xffff80, 0x80ff80, 0x00ff80, 0x80ffff, 0x0080ff, 0xff80c0, 0xff80ff,
  0xff0000, 0xffff00, 0x80ff00, 0x00ff40, 0x00ffff, 0x0080c0, 0x8080c0, 0xff00ff,
  0x804040, 0xff8040, 0x00ff00, 0x008080, 0x004080, 0x8080ff, 0x800040, 0xff0080,
  0x800000, 0xff8000, 0x008000, 0x008040, 0x0000ff, 0x0000a0, 0x800080, 0x8000ff,
  0x400000, 0x804000, 0x004000, 0x004040, 0x000080, 0x000040, 0x400040, 0x400080,
  0x000000, 0x808000, 0x808040, 0x808080, 0x408080, 0xc0c0c0, 0x400040, 0xffffff,
].map(rgb);

import { vbColorToCss, SYSTEM_COLORS, PALETTE_48 } from '../../src/model/colors';
import { twipsToPx, pxToTwips } from '../../src/model/twips';

test('colors', () => {
  expect(vbColorToCss(0x8000000f)).toBe('#c0c0c0');
  expect(vbColorToCss(0x0000ff)).toBe('#ff0000');
  expect(vbColorToCss(0xff0000)).toBe('#0000ff');
});

test('system colour in signed form (as the interpreter produces &H8000000F) maps like the unsigned form', () => {
  expect(0x8000000f | 0).toBe(-2147483633);
  expect(vbColorToCss(-2147483633)).toBe('#c0c0c0');
  expect(vbColorToCss(-2147483633)).toBe(vbColorToCss(0x8000000f));
  // a signed value that differs from the default grey, to prove the lookup is not accidental
  expect(vbColorToCss(0x80000002 | 0)).toBe('#000080');
  expect(vbColorToCss(0x80000018 | 0)).toBe('#ffffe1');
});

test('every system colour in the table maps to its documented value', () => {
  const table: Record<number, string> = {
    0x80000000: '#c0c0c0', 0x80000001: '#008080', 0x80000002: '#000080', 0x80000003: '#808080',
    0x80000005: '#ffffff', 0x80000006: '#000000', 0x80000008: '#000000', 0x80000009: '#ffffff',
    0x8000000d: '#000080', 0x8000000e: '#ffffff', 0x8000000f: '#c0c0c0', 0x80000010: '#808080',
    0x80000011: '#808080', 0x80000012: '#000000', 0x80000014: '#ffffff', 0x80000015: '#000000',
    0x80000016: '#dfdfdf', 0x80000017: '#000000', 0x80000018: '#ffffe1',
  };
  for (const [k, v] of Object.entries(table)) {
    expect(vbColorToCss(Number(k))).toBe(v);
    expect(vbColorToCss(Number(k) | 0)).toBe(v);
    expect(SYSTEM_COLORS[Number(k)]).toBe(v);
  }
});

test('unknown system colour index falls back to button face grey', () => {
  expect(vbColorToCss(0x800000ff)).toBe('#c0c0c0');
  expect(vbColorToCss(0x800000ff | 0)).toBe('#c0c0c0');
  expect(vbColorToCss(0x80000004)).toBe('#c0c0c0');
});

test('ordinary colours: black, white, mixed BGR', () => {
  expect(vbColorToCss(0)).toBe('#000000');
  expect(vbColorToCss(0xffffff)).toBe('#ffffff');
  expect(vbColorToCss(0x0080ff)).toBe('#ff8000');   // R=255 G=128 B=0
  expect(vbColorToCss(0x123456)).toBe('#563412');
});

test('PALETTE_48 has 48 distinct-ish valid VB colours', () => {
  expect(PALETTE_48).toHaveLength(48);
  for (const c of PALETTE_48) { expect(Number.isInteger(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(0xffffff); }
  expect(PALETTE_48).toContain(0xffffff);
  expect(PALETTE_48).toContain(0);
});

test('twips', () => {
  expect(twipsToPx(1215)).toBe(81);
  expect(twipsToPx(4800)).toBe(320);
  expect(twipsToPx(7)).toBe(0);
  expect(twipsToPx(8)).toBe(1);
  expect(pxToTwips(320)).toBe(4800);
  expect(pxToTwips(twipsToPx(3600))).toBe(3600);
});

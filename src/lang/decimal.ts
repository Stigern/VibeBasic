// VB6's Decimal (Variant subtype 14, made by CDec): a 96-bit integer scaled by a power of ten from 0 to 28, so up to
// 29 significant digits (±79,228,162,514,264,337,593,543,950,335). Kept exact as a BigInt and its scale; results
// round to 28 decimals or fewer (banker's rounding) when they would not fit, and overflow is error 6.

import { VBRuntimeError } from './errors';

const MAX = 2n ** 96n - 1n;
const MAX_SCALE = 28;
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** A Decimal value: `m` × 10^-`s` (no trailing zeros in `m` while `s` > 0). */
export class VBDecimal {
  readonly kind = 'decimal' as const;
  constructor(readonly m: bigint, readonly s: number) {}
  toString(): string { return decText(this); }
}

/** n / d rounded to the nearest whole number, halves to even. */
function roundDiv(n: bigint, d: bigint): bigint {
  if (d < 0n) { n = -n; d = -d; }
  let q = n / d;
  const r2 = abs(n % d) * 2n;
  if (r2 > d || (r2 === d && q % 2n !== 0n)) q += n < 0n ? -1n : 1n;
  return q;
}

/** `m` × 10^-`s` as a Decimal (also for one read from a file): fewer decimals (rounded) when needed to fit; error 6 when the whole part does not. */
export function make(m: bigint, s: number): VBDecimal {
  for (let sc = Math.min(s, MAX_SCALE); sc >= 0; sc--) {
    const q = sc === s ? m : roundDiv(m, pow10(s - sc));
    if (abs(q) <= MAX) {
      let x = q;
      let k = sc;
      while (k > 0 && x % 10n === 0n) { x /= 10n; k--; }
      return new VBDecimal(x, k);
    }
  }
  throw new VBRuntimeError(6);
}

/** Decimal of numeric text (`-12.5`, `1E+20`, ` .5 `); undefined when it is not plain decimal digits. */
export function decFromText(text: string): VBDecimal | undefined {
  const t = /^\s*([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(text);
  if (!t || (t[2] === '' && (t[3] ?? '') === '')) return undefined;
  const frac = t[3] ?? '';
  let m = BigInt((t[2] || '0') + frac);
  if (t[1] === '-') m = -m;
  let s = frac.length - Number(t[4] ?? 0);
  if (s < 0) { m *= pow10(-s); s = 0; }
  return make(m, s);
}

/** A Double as a Decimal: its 15 significant digits, as VB6 converts it (CDec(0.1) is exactly 0.1). */
export function decFromNumber(n: number): VBDecimal {
  if (!Number.isFinite(n)) throw new VBRuntimeError(6);
  return decFromText(n.toPrecision(15))!;
}

/** Exact text: no exponent, no trailing zeros (`-0.5`, `12345678901234567890`). */
export function decText(d: VBDecimal): string {
  const neg = d.m < 0n;
  let digits = abs(d.m).toString();
  if (d.s > 0) {
    digits = digits.padStart(d.s + 1, '0');
    digits = `${digits.slice(0, -d.s)}.${digits.slice(-d.s)}`;
  }
  return neg ? '-' + digits : digits;
}

export const decToNumber = (d: VBDecimal): number => Number(decText(d));

function align(a: VBDecimal, b: VBDecimal): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.m * pow10(s - a.s), b.m * pow10(s - b.s), s];
}

export function decAdd(a: VBDecimal, b: VBDecimal): VBDecimal {
  const [x, y, s] = align(a, b);
  return make(x + y, s);
}

export function decSub(a: VBDecimal, b: VBDecimal): VBDecimal {
  const [x, y, s] = align(a, b);
  return make(x - y, s);
}

export const decMul = (a: VBDecimal, b: VBDecimal): VBDecimal => make(a.m * b.m, a.s + b.s);

/** a / b with as many decimals as fit (up to 28); 0 / 0 is error 6, x / 0 error 11 as for other numbers. */
export function decDiv(a: VBDecimal, b: VBDecimal): VBDecimal {
  if (b.m === 0n) throw new VBRuntimeError(a.m === 0n ? 6 : 11);
  for (let sc = MAX_SCALE; sc >= 0; sc--) {
    const k = sc - a.s + b.s;   // a.m × 10^k / b.m has scale sc
    const q = k >= 0 ? roundDiv(a.m * pow10(k), b.m) : roundDiv(a.m, b.m * pow10(-k));
    if (abs(q) <= MAX) return make(q, sc);
  }
  throw new VBRuntimeError(6);
}

export const decNeg = (a: VBDecimal): VBDecimal => new VBDecimal(-a.m, a.s);
export const decAbs = (a: VBDecimal): VBDecimal => (a.m < 0n ? decNeg(a) : a);
export const decSign = (a: VBDecimal): -1 | 0 | 1 => (a.m < 0n ? -1 : a.m > 0n ? 1 : 0);

export function decCmp(a: VBDecimal, b: VBDecimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Int (toward minus infinity) or Fix (toward zero). */
export function decWhole(a: VBDecimal, floor: boolean): VBDecimal {
  if (a.s === 0) return a;
  const p = pow10(a.s);
  let q = a.m / p;   // BigInt division truncates toward zero
  if (floor && a.m < 0n && a.m % p !== 0n) q -= 1n;
  return new VBDecimal(q, 0);
}

/** Round(a, digits): banker's rounding to `digits` decimals (0-28). */
export function decRound(a: VBDecimal, digits: number): VBDecimal {
  if (a.s <= digits) return a;
  return make(roundDiv(a.m, pow10(a.s - digits)), digits);
}

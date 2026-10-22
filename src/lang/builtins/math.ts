// Math built-ins: Abs Int Fix Sgn Sqr Round Hex Oct Log Exp Sin Cos Tan Atn Rnd Randomize.

import { VBRuntimeError } from '../errors';
import { plain } from '../interp/operators';
import { Null, bankers, isDate, toNumber, type VBValue } from '../values';
import { def, intArg, isNullV, newRndState, type BuiltinCtx, type RndState } from './util';

const finite = (n: number): number => {
  if (!Number.isFinite(n)) throw new VBRuntimeError(6);
  return n === 0 ? 0 : n; // no -0
};

/** A one-argument numeric function that gives Null for Null. */
function num1(name: string, fn: (n: number) => number): void {
  def(name, 1, 1, a => (isNullV(plain(a[0])) ? Null : finite(fn(toNumber(a[0])))));
}

num1('abs', Math.abs);
num1('sgn', Math.sign);

/** Int/Fix keep a Date a Date. */
function intLike(name: string, fn: (n: number) => number): void {
  def(name, 1, 1, a => {
    const v = plain(a[0]);
    if (isNullV(v)) return Null;
    const r = finite(fn(toNumber(v)));
    return isDate(v) ? { kind: 'date', serial: r } : r;
  });
}
intLike('int', Math.floor);
intLike('fix', Math.trunc);

def('sqr', 1, 1, a => {
  const n = toNumber(a[0]);
  if (n < 0) throw new VBRuntimeError(5);
  return Math.sqrt(n);
});
def('log', 1, 1, a => {
  const n = toNumber(a[0]);
  if (n <= 0) throw new VBRuntimeError(5);
  return finite(Math.log(n));
});
def('exp', 1, 1, a => finite(Math.exp(toNumber(a[0]))));
def('sin', 1, 1, a => finite(Math.sin(toNumber(a[0]))));
def('cos', 1, 1, a => finite(Math.cos(toNumber(a[0]))));
def('tan', 1, 1, a => finite(Math.tan(toNumber(a[0]))));
def('atn', 1, 1, a => finite(Math.atan(toNumber(a[0]))));

/** Round half to even at `digits` decimals (VB6 `Round`). */
def('round', 1, 2, a => {
  const n = toNumber(a[0]);
  const d = a[1] === undefined ? 0 : intArg(a[1]);
  if (d < 0 || d > 15) throw new VBRuntimeError(5);
  const scale = 10 ** d;
  const scaled = Number((n * scale).toPrecision(15)); // 1.005 * 100 = 100.49999999999999 -> 100.5
  return finite(bankers(scaled) / scale);
});

// ---- Hex / Oct ----

function radix(name: string, base: 8 | 16): void {
  def(name, 1, 1, a => {
    const v = plain(a[0]);
    if (isNullV(v)) return Null;
    const n = bankers(toNumber(v));
    if (n < -2147483648 || n > 4294967295) throw new VBRuntimeError(6);
    // Negative whole numbers are two's complement: 16 bit in the Integer range, otherwise 32 bit.
    const u = n >= 0 ? n : n >= -32768 ? n + 0x10000 : n + 0x100000000;
    return u.toString(base).toUpperCase();
  });
}
radix('hex', 16);
radix('oct', 8);

// ---- Rnd / Randomize ----

/** mulberry32; the state lives in `ctx.rnd` (per Program), starting from a fixed seed as in VB. */
function nextRandom(r: RndState): number {
  r.state = (r.state + 0x6d2b79f5) | 0;
  let t = r.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function seedFrom(r: RndState, n: number): void {
  // Mix the bits of the double so that nearby seeds give unrelated sequences.
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, n);
  r.state = (buf.getInt32(0) ^ Math.imul(buf.getInt32(4), 0x9e3779b1)) | 0;
  r.first = false;
}

const rndOf = (ctx: BuiltinCtx): RndState => (ctx.rnd ??= newRndState());

def('rnd', 0, 1, (a, ctx) => {
  const r = rndOf(ctx);
  const x = a[0] === undefined ? 1 : toNumber(a[0]);
  if (x === 0) return r.last;
  if (x < 0) seedFrom(r, x);
  else if (r.first) { r.first = false; return r.last; }
  r.last = nextRandom(r);
  return r.last;
});

def('randomize', 0, 1, (a, ctx) => {
  seedFrom(rndOf(ctx), a[0] === undefined ? Date.now() : toNumber(a[0]));
  return 0 as VBValue;
});

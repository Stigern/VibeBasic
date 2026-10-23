// Financial functions, with VB6's argument order and defaults: Pmt PPmt IPmt FV PV NPer Rate (annuities: a negative
// amount is paid out, a positive one received; Type 0 pays at the end of a period, 1 at the start), NPV IRR MIRR (a
// one-dimensional array of cash flows) and the depreciations DDB SLN SYD. Invalid arguments and an iteration that
// does not converge (Rate, IRR: 20 tries to within 0.00001 percent, from Guess, default 0.1) are error 5.

import { VBRuntimeError } from '../errors';
import { VBArray, toNumber, type VBValue } from '../values';
import { def } from './util';

/** The names on the reference card's own line ("Financial: ..."). */
export const FINANCIAL = ['DDB', 'FV', 'IPmt', 'IRR', 'MIRR', 'NPer', 'NPV', 'Pmt', 'PPmt', 'PV', 'Rate', 'SLN', 'SYD'];

const bad = (): never => { throw new VBRuntimeError(5); };
const n = (v: VBValue): number => toNumber(v);
const opt = (v: VBValue | undefined, d: number): number => (v === undefined ? d : toNumber(v));
/** Type: 0 at the end of each period, any other value at the start. */
const due = (v: VBValue | undefined): number => (opt(v, 0) !== 0 ? 1 : 0);
const finite = (x: number): number => (Number.isFinite(x) ? x : bad());

function fv(r: number, nper: number, pmt: number, pv: number, type: number): number {
  if (r === 0) return -(pv + pmt * nper);
  const f = (1 + r) ** nper;
  return -(pv * f + pmt * (1 + r * type) * (f - 1) / r);
}

function pmt(r: number, nper: number, pv: number, fvv: number, type: number): number {
  if (nper === 0) bad();
  if (r === 0) return -(pv + fvv) / nper;
  const f = (1 + r) ** nper;
  return -(fvv + pv * f) * r / ((f - 1) * (1 + r * type));
}

function ipmt(r: number, per: number, nper: number, pv: number, fvv: number, type: number): number {
  if (per < 1 || per > nper) bad();
  const p = pmt(r, nper, pv, fvv, type);
  if (per === 1) return type ? 0 : -pv * r;
  return (type ? fv(r, per - 2, p, pv, 1) - p : fv(r, per - 1, p, pv, 0)) * r;
}

/** The cash flows of an array argument (error 13 for anything else). */
function flows(v: VBValue): number[] {
  if (!(v instanceof VBArray) || !v.allocated || v.bounds.length !== 1) throw new VBRuntimeError(13);
  return v.values().map(x => toNumber(x));
}

/** Newton's method from `guess`; error 5 when 20 tries do not get within 1e-7. */
function solve(f: (r: number) => number, guess: number): number {
  let r = guess;
  for (let i = 0; i < 20; i++) {
    const h = Math.max(1e-7, Math.abs(r) * 1e-7);
    const y = f(r);
    const d = (f(r + h) - f(r - h)) / (2 * h);
    if (!Number.isFinite(y) || !Number.isFinite(d) || d === 0) break;
    const next = r - y / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-7) return next;
    r = next;
  }
  return bad();
}

const num = { num: true };

def('FV', 3, 5, a => finite(fv(n(a[0]), n(a[1]), n(a[2]), opt(a[3], 0), due(a[4]))), num);
def('PV', 3, 5, a => {
  const r = n(a[0]), nper = n(a[1]), p = n(a[2]), fvv = opt(a[3], 0), type = due(a[4]);
  if (r === 0) return -(fvv + p * nper);
  const f = (1 + r) ** nper;
  return finite(-(fvv + p * (1 + r * type) * (f - 1) / r) / f);
}, num);
def('Pmt', 3, 5, a => finite(pmt(n(a[0]), n(a[1]), n(a[2]), opt(a[3], 0), due(a[4]))), num);
def('IPmt', 4, 6, a => finite(ipmt(n(a[0]), n(a[1]), n(a[2]), n(a[3]), opt(a[4], 0), due(a[5]))), num);
def('PPmt', 4, 6, a => {
  const r = n(a[0]), per = n(a[1]), nper = n(a[2]), pv = n(a[3]), fvv = opt(a[4], 0), type = due(a[5]);
  return finite(pmt(r, nper, pv, fvv, type) - ipmt(r, per, nper, pv, fvv, type));
}, num);
def('NPer', 3, 5, a => {
  const r = n(a[0]), p = n(a[1]), pv = n(a[2]), fvv = opt(a[3], 0), type = due(a[4]);
  if (r === 0) return p === 0 ? bad() : -(pv + fvv) / p;
  const x = p * (1 + r * type);
  const q = (x - fvv * r) / (x + pv * r);
  if (!(q > 0) || r <= -1) bad();
  return finite(Math.log(q) / Math.log(1 + r));
}, num);
def('Rate', 3, 6, a => {
  const nper = n(a[0]), p = n(a[1]), pv = n(a[2]), fvv = opt(a[3], 0), type = due(a[4]);
  if (nper <= 0) bad();
  return solve(r => (Math.abs(r) < 1e-12 ? pv + p * nper + fvv
    : pv * (1 + r) ** nper + p * (1 + r * type) * ((1 + r) ** nper - 1) / r + fvv), opt(a[5], 0.1));
}, num);
def('NPV', 2, 2, a => {
  const r = n(a[0]);
  if (r === -1) bad();
  return finite(flows(a[1]).reduce((s, v, i) => s + v / (1 + r) ** (i + 1), 0));
}, num);
def('IRR', 1, 2, a => {
  const v = flows(a[0]);
  if (!v.some(x => x > 0) || !v.some(x => x < 0)) bad();
  return solve(r => v.reduce((s, x, i) => s + x / (1 + r) ** i, 0), opt(a[1], 0.1));
}, num);
def('MIRR', 3, 3, a => {
  const v = flows(a[0]);
  const fin = n(a[1]), re = n(a[2]);
  if (fin === -1 || re === -1 || v.length < 2) bad();
  let pos = 0, neg = 0;
  v.forEach((x, i) => {
    if (x > 0) pos += x * (1 + re) ** (v.length - 1 - i);
    else neg += x / (1 + fin) ** i;
  });
  if (pos === 0 || neg === 0) bad();
  return finite((-pos / neg) ** (1 / (v.length - 1)) - 1);
}, num);
def('DDB', 4, 5, a => {
  const cost = n(a[0]), salvage = n(a[1]), life = n(a[2]), period = n(a[3]), factor = opt(a[4], 2);
  if (cost < 0 || salvage < 0 || life <= 0 || period <= 0 || period > life || factor <= 0) bad();
  let rate = factor / life;
  let old: number;
  if (rate >= 1) { rate = 1; old = period === 1 ? cost : 0; }
  else old = cost * (1 - rate) ** (period - 1);
  const now = cost * (1 - rate) ** period;
  return Math.max(0, now < salvage ? old - salvage : old - now);
}, num);
def('SLN', 3, 3, a => {
  const life = n(a[2]);
  if (life === 0) bad();
  return (n(a[0]) - n(a[1])) / life;
}, num);
def('SYD', 4, 4, a => {
  const cost = n(a[0]), salvage = n(a[1]), life = n(a[2]), period = n(a[3]);
  if (life <= 0 || period <= 0 || period > life) bad();
  return (cost - salvage) * (life - period + 1) * 2 / (life * (life + 1));
}, num);

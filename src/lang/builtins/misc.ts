// Dialogs and host services (MsgBox InputBox DoEvents LoadPicture), colours
// (RGB QBColor), Environ/Command, and the Variant helpers IIf Choose Switch Array.

import { VBRuntimeError } from '../errors';
import { plain, truthy } from '../interp/operators';
import { Empty, Null, Nothing, VBArray, toStr, type VBValue } from '../values';
import { def, intArg, optInt } from './util';

// ---- dialogs ----

def('MsgBox', 1, 5, (a, ctx) => {
  const prompt = toStr(a[0]);
  const buttons = optInt(a[1], 0);
  const title = a[2] === undefined ? (ctx.appTitle ?? 'Project1') : toStr(a[2]);
  return ctx.host.msgBox(prompt, buttons, title);
});

def('InputBox', 1, 5, (a, ctx) => {
  const title = a[1] === undefined ? (ctx.appTitle ?? 'Project1') : toStr(a[1]);
  return ctx.host.inputBox(toStr(a[0]), title, a[2] === undefined ? '' : toStr(a[2]));
});

def('DoEvents', 0, 0, async (_a, ctx) => {
  await ctx.host.doEvents();
  return 0;
});

def('Beep', 0, 0, (_a, ctx) => {
  ctx.host.beep?.();
  return Empty;
});

/** There is no process spawning in VibeBasic; error 5 with a clear text (the code check lists Shell as not supported). */
def('Shell', 1, 2, () => {
  throw new VBRuntimeError(5, 'Shell is not available in VibeBasic');
});

def('LoadPicture', 0, 2, (a, ctx) => (a[0] === undefined ? Nothing : ctx.host.loadPicture(toStr(a[0]))));
/** SavePicture picture, path: a drawn Image as BMP (.bmp) or PNG; a loaded picture as its own file. */
def('SavePicture', 2, 2, async (a, ctx) => {
  const path = toStr(a[1]);
  if (!ctx.host.pictureBytes) throw new VBRuntimeError(481);
  const bytes = ctx.host.pictureBytes(a[0], /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '');
  if (!ctx.files) throw new VBRuntimeError(68);
  await ctx.files.writeFile(path, bytes);
  return Empty;
});

// ---- colours ----

def('RGB', 3, 3, a => {
  const [r, g, b] = a.map(v => {
    const n = intArg(v);
    if (n < 0) throw new VBRuntimeError(5);
    return Math.min(n, 255);
  });
  return r + g * 256 + b * 65536;
});

const QB_COLORS = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
  0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];
def('QBColor', 1, 1, a => {
  const n = intArg(a[0]);
  if (n < 0 || n > 15) throw new VBRuntimeError(5);
  return QB_COLORS[n];
});

// ---- environment ----

/** Environ(name): the value ('' when not set; the name exact, else without regard to case, as on Windows). Environ(n): the n-th
 *  "NAME=value" entry ('' after the last; 5 for n < 1). */
def('Environ', 1, 1, async (a, ctx) => {
  const env = (await ctx.host.environment?.()) ?? [];
  if (typeof a[0] === 'string') {
    const name = a[0];
    if (name === '') throw new VBRuntimeError(5);
    const l = name.toLowerCase();
    return (env.find(([k]) => k === name) ?? env.find(([k]) => k.toLowerCase() === l))?.[1] ?? '';
  }
  const n = intArg(a[0]);
  if (n < 1) throw new VBRuntimeError(5);
  const e = env[n - 1];
  return e ? `${e[0]}=${e[1]}` : '';
});
def('Command', 0, 0, (_a, ctx) => ctx.host.commandLine?.() ?? '');

// ---- Variant helpers (arguments are evaluated eagerly, as for any function) ----

def('IIf', 3, 3, a => (truthy(a[0]) ? a[1] : a[2]));

def('Choose', 2, 100, a => {
  const i = intArg(a[0]);
  return i >= 1 && i < a.length ? a[i] : Null;
});

def('Switch', 2, 100, a => {
  if (a.length % 2 !== 0) throw new VBRuntimeError(450);
  for (let i = 0; i < a.length; i += 2) if (truthy(a[i])) return a[i + 1];
  return Null;
});

/** Array(...): lower bound from the calling module's Option Base. */
def('Array', 0, 100, (a, ctx) => {
  const lo = ctx.optionBase ?? 0;
  const arr = new VBArray('Variant', [[lo, lo + a.length - 1]]);
  a.forEach((v, i) => arr.set([lo + i], v === undefined ? Empty : plain(v)));
  return arr as VBValue;
});

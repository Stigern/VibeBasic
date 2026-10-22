// Dialogs and host services (MsgBox InputBox DoEvents LoadPicture), colours
// (RGB QBColor), Environ/Command, and the Variant helpers IIf Choose Switch Array.

import { VBRuntimeError } from '../errors';
import { plain, truthy } from '../interp/operators';
import { Empty, Null, Nothing, VBArray, toStr, type VBValue } from '../values';
import { def, intArg, optInt } from './util';

// ---- dialogs ----

def('msgbox', 1, 5, (a, ctx) => {
  const prompt = toStr(a[0]);
  const buttons = optInt(a[1], 0);
  const title = a[2] === undefined ? (ctx.appTitle ?? 'Project1') : toStr(a[2]);
  return ctx.host.msgBox(prompt, buttons, title);
});

def('inputbox', 1, 5, (a, ctx) => {
  const title = a[1] === undefined ? (ctx.appTitle ?? 'Project1') : toStr(a[1]);
  return ctx.host.inputBox(toStr(a[0]), title, a[2] === undefined ? '' : toStr(a[2]));
});

def('doevents', 0, 0, async (_a, ctx) => {
  await ctx.host.doEvents();
  return 0;
});

def('loadpicture', 0, 2, (a, ctx) => (a[0] === undefined ? Nothing : ctx.host.loadPicture(toStr(a[0]))));

// ---- colours ----

def('rgb', 3, 3, a => {
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
def('qbcolor', 1, 1, a => {
  const n = intArg(a[0]);
  if (n < 0 || n > 15) throw new VBRuntimeError(5);
  return QB_COLORS[n];
});

// ---- environment ----

def('environ', 1, 1, () => '');
def('command', 0, 0, () => '');

// ---- Variant helpers (arguments are evaluated eagerly, as for any function) ----

def('iif', 3, 3, a => (truthy(a[0]) ? a[1] : a[2]));

def('choose', 2, 100, a => {
  const i = intArg(a[0]);
  return i >= 1 && i < a.length ? a[i] : Null;
});

def('switch', 2, 100, a => {
  if (a.length % 2 !== 0) throw new VBRuntimeError(450);
  for (let i = 0; i < a.length; i += 2) if (truthy(a[i])) return a[i + 1];
  return Null;
});

def('array', 0, 100, a => {
  const arr = new VBArray('Variant', [[0, a.length - 1]]);
  a.forEach((v, i) => arr.set([i], v === undefined ? Empty : plain(v)));
  return arr as VBValue;
});

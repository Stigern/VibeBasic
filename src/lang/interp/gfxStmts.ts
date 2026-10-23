// The drawing statements (Print, PSet, Line, Circle, Scale on a Form, PictureBox or Printer): the arguments are evaluated here
// and the object draws (VBObject.graphics).

import type { Expr, GfxPoint, GfxStmt } from '../ast';
import { VBRuntimeError } from '../errors';
import type { GfxCallPoint, GraphicsCall, PrintPiece, VBObject } from '../host';
import { printItemText } from '../printFormat';
import { NothingT, isObject, toNumber, type VBValue } from '../values';
import type { Gen } from './driver';
import { afterHostCall, awaitHost, evalExpr } from './eval';
import { printItems } from './fileStmts';
import type { Frame } from './scope';
import { shown } from './staticTypes';

/** Collects Print items as pieces (the object lays them out in its font). */
class Pieces {
  readonly list: PrintPiece[] = [];
  addItem(v: VBValue): void { this.list.push(printItemText(v)); }
  addSemicolon(): void {}
  addComma(): void { this.list.push({ zone: true }); }
  addSpc(n: number): void { this.list.push({ spc: n }); }
  addTab(n?: number): void { this.list.push(n === undefined ? { zone: true } : { tab: n }); }
}

function* num(f: Frame, e: Expr): Gen<number> {
  return toNumber(shown(f, e, yield* evalExpr(f, e)));
}

function* opt(f: Frame, e: Expr | undefined): Gen<number | undefined> {
  return e ? yield* num(f, e) : undefined;
}

function* point(f: Frame, p: GfxPoint | undefined): Gen<GfxCallPoint | undefined> {
  if (!p) return undefined;
  return { step: p.step, x: yield* num(f, p.x), y: yield* num(f, p.y) };
}

export function* execGraphics(f: Frame, s: GfxStmt): Gen<void> {
  let obj: VBValue | VBObject | undefined;
  if (s.object) obj = yield* evalExpr(f, s.object);
  else {
    obj = f.module.kind === 'form' && f.proc !== null ? f.rt.host.resolveName(f.module.name, 'Me') : undefined;
    if (!obj) throw VBRuntimeError.compile('Method not valid without suitable object');
  }
  if (obj instanceof NothingT) throw new VBRuntimeError(91);
  if (!isObject(obj)) throw new VBRuntimeError(424);
  let call: GraphicsCall;
  switch (s.method) {
    case 'print': {
      const p = new Pieces();
      const newline = yield* printItems(f, s.items, p);
      call = { method: 'print', pieces: p.list, newline };
      break;
    }
    case 'pset': call = { method: 'pset', at: (yield* point(f, s.at))!, color: yield* opt(f, s.color) }; break;
    case 'line':
      call = { method: 'line', from: yield* point(f, s.from), to: (yield* point(f, s.to))!, color: yield* opt(f, s.color), box: s.box };
      break;
    case 'circle':
      call = {
        method: 'circle', at: (yield* point(f, s.at))!, radius: yield* num(f, s.radius), color: yield* opt(f, s.color),
        start: yield* opt(f, s.start), end: yield* opt(f, s.end), aspect: yield* opt(f, s.aspect),
      };
      break;
    case 'scale': call = { method: 'scale', from: yield* point(f, s.from), to: yield* point(f, s.to) }; break;
  }
  // `obj.Scale` on an object of the program's own that has a Scale method (not a drawing surface)
  if (!obj.graphics && s.method === 'scale' && !s.from) {
    const r = obj.callMethod('Scale', []);
    if (r instanceof Promise) yield* awaitHost(f, r); else yield* afterHostCall(f);
    return;
  }
  if (!obj.graphics) throw new VBRuntimeError(438);
  const r = obj.graphics(call);
  if (r instanceof Promise) yield* awaitHost(f, r.then(() => 0)); else yield* afterHostCall(f);
}

// The file I/O statements (Open, Close, Print #, Write #, Input #, Line Input #, Get, Put, Seek, Name) and the print
// items they share with Debug.Print. The files themselves are Runtime.files (fileio/fileIO.ts).

import type { Expr, PrintItem, Stmt, VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import { writeItemText } from '../fileio/textFormat';
import { PrintLine } from '../printFormat';
import { VBArray, VBRecord, bankers, isDate, toNumber, toStr, vbTypeName, type VBValue } from '../values';
import type { Gen } from './driver';
import { assign, evalExpr, lookup } from './eval';
import { Frame, Variable, lc } from './scope';
import { shown } from './staticTypes';

/** Evaluates print items into `line`; true when the statement ends the line (no trailing `;` or `,`). */
export function* printItems(f: Frame, items: PrintItem[], line: PrintLine): Gen<boolean> {
  for (const it of items) {
    if (it.expr) line.addItem(shown(f, it.expr, yield* evalExpr(f, it.expr)));
    else if (it.fn) {
      const n = it.fn.arg ? bankers(toNumber(yield* evalExpr(f, it.fn.arg))) : undefined;
      if (it.fn.kind === 'spc') line.addSpc(n ?? 0);
      else line.addTab(n);
    }
    if (it.sep === ';') line.addSemicolon();
    else if (it.sep === ',') line.addComma();
  }
  const last = items[items.length - 1];
  return last === undefined || last.sep === undefined;
}

function* fileNum(f: Frame, e: Expr): Gen<number> {
  return bankers(toNumber(yield* evalExpr(f, e)));
}

/** The declared type of a Get/Input target (a variable, an array element, a field of a record); Variant when unknown. */
function* targetType(f: Frame, e: Expr): Gen<{ type: VBTypeName; fixedLength?: number }> {
  if (e.kind === 'name') {
    const b = lookup(f, lc(e.name), e.name);
    if (b instanceof Variable) return { type: b.type, fixedLength: b.opts.fixedLength };
  } else if (e.kind === 'call' && e.target.kind === 'name') {
    const b = lookup(f, lc(e.target.name), e.target.name);
    if (b instanceof Variable && b.value instanceof VBArray) return { type: b.value.elemType, fixedLength: b.value.fixedLength };
  } else if (e.kind === 'member') {
    const base = yield* evalExpr(f, e.object);
    if (base instanceof VBRecord) {
      const fi = f.rt.typeInfo(base.typeName).fields.get(lc(e.name));
      if (fi) return { type: fi.type, fixedLength: fi.fixedLength };
    }
  }
  return { type: 'Variant' };
}

const isTarget = (e: Expr) => e.kind === 'name' || e.kind === 'member' || e.kind === 'call' || e.kind === 'withMember';

/** The layout Put writes for an expression that is not a variable (`Put #1, , 5` writes an Integer). */
function valueType(v: VBValue): VBTypeName {
  if (typeof v === 'number') return vbTypeName(v) as VBTypeName;
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Boolean';
  if (isDate(v)) return 'Date';
  if (v instanceof VBRecord) return { userType: v.typeName };
  if (v instanceof VBArray) return v.elemType;
  return 'Variant';
}

export function* execFileStmt(f: Frame, s: Stmt): Gen<void> {
  const files = f.rt.files;
  switch (s.kind) {
    case 'open': {
      const path = toStr(yield* evalExpr(f, s.path));
      const num = yield* fileNum(f, s.file);
      const recLen = s.recLen ? bankers(toNumber(yield* evalExpr(f, s.recLen))) : undefined;
      yield files.open(path, s.mode, s.access, num, recLen);
      return;
    }
    case 'close': {
      const nums: number[] = [];
      for (const e of s.files) nums.push(yield* fileNum(f, e));
      yield files.close(s.files.length ? nums : null);
      return;
    }
    case 'printFile': {
      const num = yield* fileNum(f, s.file);
      const line = new PrintLine(files.column(num));
      const newline = yield* printItems(f, s.items, line);
      const w = files.writeText(num, line.text() + (newline ? '\r\n' : ''), newline ? 0 : line.column());
      if (w) yield w;
      return;
    }
    case 'writeFile': {
      const num = yield* fileNum(f, s.file);
      files.column(num);   // Bad file mode before the items are evaluated
      const parts: string[] = [];
      // an omitted item (`Write #1, a, , b`) is an empty field
      for (const it of s.items) {
        if (it.expr) parts.push(writeItemText(shown(f, it.expr, yield* evalExpr(f, it.expr))));
        else if (!it.fn) parts.push('');
      }
      const last = s.items[s.items.length - 1];
      const newline = last === undefined || last.sep === undefined;
      const text = parts.join(',') + (newline ? '\r\n' : ',');
      const w = files.writeText(num, text, newline ? 0 : files.column(num) + text.length);
      if (w) yield w;
      return;
    }
    case 'inputFile': case 'lineInput': {
      const num = yield* fileNum(f, s.file);
      for (const t of s.targets) {
        if (s.kind === 'lineInput') { yield* assign(f, t, files.lineInput(num), false); continue; }
        const { type } = yield* targetType(f, t);
        const field = files.inputField(num);
        yield* assign(f, t, type === 'String' ? field.text : field.value, false);
      }
      return;
    }
    case 'getFile': case 'putFile': {
      const num = yield* fileNum(f, s.file);
      const rec = s.rec ? bankers(toNumber(yield* evalExpr(f, s.rec))) : undefined;
      const cur = yield* evalExpr(f, s.target);
      if (s.kind === 'putFile') {
        const { type, fixedLength } = isTarget(s.target) ? yield* targetType(f, s.target) : { type: valueType(cur), fixedLength: undefined };
        // a Variant variable holding a record or an array writes it as that (no Variant tag)
        const t = type === 'Variant' && (cur instanceof VBRecord || cur instanceof VBArray) ? valueType(cur) : type;
        yield files.put(num, rec, cur, t, fixedLength);
        return;
      }
      const { type, fixedLength } = yield* targetType(f, s.target);
      const v = (yield files.get(num, rec, cur, type, fixedLength)) as VBValue;
      if (!(v instanceof VBArray)) yield* assign(f, s.target, v, false);   // arrays are filled in place
      return;
    }
    case 'seekFile': {
      const num = yield* fileNum(f, s.file);
      files.seek(num, bankers(toNumber(yield* evalExpr(f, s.pos))));
      return;
    }
    case 'name': {
      const from = toStr(yield* evalExpr(f, s.from));
      const to = toStr(yield* evalExpr(f, s.to));
      yield files.rename(from, to);
      return;
    }
  }
  throw new VBRuntimeError(51, 'Internal error: not a file statement');
}

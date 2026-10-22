// Debug.Print formatting. Task 5 has the core rules the golden programs need;
// Task 6 completes it (dates by locale, etc.).
//
// - Numbers: a space before non-negative numbers, a space after every number,
//   no zero before the decimal point (" .5", "-.5").
// - `;` adds nothing; `,` moves to the next 14-character print zone.

import { VBRuntimeError } from './errors';
import { EmptyT, NullT, NothingT, VBArray, VBRecord, isDate, toStr, type VBValue } from './values';
import type { VBObject } from './host';

export const PRINT_ZONE = 14;

/** `Str`/Print text of a number: leading space if not negative, no zero before the decimal point. */
export function printNumber(n: number): string {
  let s = toStr(n);
  if (s.startsWith('0.')) s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return n < 0 ? s : ' ' + s;
}

function isObject(v: VBValue): v is VBObject {
  return typeof v === 'object' && !(v instanceof EmptyT) && !(v instanceof NullT) && !(v instanceof NothingT)
    && !(v instanceof VBArray) && !(v instanceof VBRecord) && !isDate(v);
}

/** Text of one Print item. */
export function printItemText(v: VBValue): string {
  if (isObject(v)) {
    if (v.defaultMember === undefined) throw new VBRuntimeError(438);
    return printItemText(v.getMember(v.defaultMember, []));
  }
  if (typeof v === 'number') return printNumber(v) + ' ';
  if (v instanceof NullT) return 'Null';
  return toStr(v); // strings, booleans, Empty, dates; arrays/records/Nothing raise errors
}

/** One Debug.Print line being built. `startColumn` is where the line starts (after an earlier `;`). */
export class PrintLine {
  private out = '';
  constructor(private startColumn = 0) {}

  addItem(v: VBValue): void { this.out += printItemText(v); }
  addSemicolon(): void {}
  addComma(): void {
    const col = this.startColumn + this.out.length;
    const next = (Math.floor(col / PRINT_ZONE) + 1) * PRINT_ZONE;
    this.out += ' '.repeat(next - col);
  }
  text(): string { return this.out; }
}

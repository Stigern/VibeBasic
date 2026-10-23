// Debug.Print formatting. Task 5 has the core rules the golden programs need;
// Task 6 completes it (dates by locale, etc.).
//
// - Numbers: a space before non-negative numbers, a space after every number,
//   no zero before the decimal point (" .5", "-.5").
// - `;` adds nothing; `,` moves to the next 14-character print zone.

import { VBRuntimeError } from './errors';
import { NullT, isObject, toStr, type VBValue } from './values';

export const PRINT_ZONE = 14;

/** `Str`/Print text of a number: leading space if not negative, no zero before the decimal point. */
export function printNumber(n: number): string {
  let s = toStr(n);
  if (s.startsWith('0.')) s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return n < 0 ? s : ' ' + s;
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

/**
 * One Debug.Print / Print # line being built. `startColumn` is where the line starts (after an earlier `;`). Columns are
 * 0-based and count from the last line break written (a string may hold one; `Tab` past the column starts a new line).
 */
export class PrintLine {
  private out = '';
  constructor(private startColumn = 0, private readonly newline = '\r\n') {}

  /** The column after the text so far. */
  column(): number {
    const nl = Math.max(this.out.lastIndexOf('\n'), this.out.lastIndexOf('\r'));
    return nl < 0 ? this.startColumn + this.out.length : this.out.length - nl - 1;
  }

  addItem(v: VBValue): void { this.out += printItemText(v); }
  addSemicolon(): void {}
  addComma(): void {
    const col = this.column();
    const next = (Math.floor(col / PRINT_ZONE) + 1) * PRINT_ZONE;
    this.out += ' '.repeat(next - col);
  }
  /** `Spc(n)`: n spaces. */
  addSpc(n: number): void { if (n > 0) this.out += ' '.repeat(n); }
  /** `Tab(n)`: to column n (1-based); past it, column n of the next line. `Tab` alone: the next print zone. */
  addTab(n?: number): void {
    if (n === undefined) { this.addComma(); return; }
    const target = Math.max(1, n) - 1;
    const col = this.column();
    if (col > target) this.out += this.newline + ' '.repeat(target);
    else this.out += ' '.repeat(target - col);
  }
  text(): string { return this.out; }
}

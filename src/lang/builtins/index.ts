// Built-in function and constant registry. The interpreter looks names up
// here after user code, enum members and constants (see interp/eval.ts).
// Task 5 only registers what the interpreter core needs (LBound/UBound);
// Task 6 fills in the rest of the library.

import type { Host } from '../host';
import { VBRuntimeError } from '../errors';
import { VBArray, toNumber, type VBValue } from '../values';

export interface BuiltinCtx {
  host: Host;
  /** BCP 47 locale for date/number text (ProgramOptions.locale). */
  locale: string;
}

/**
 * A built-in function. The interpreter checks `minArgs`/`maxArgs` (error 450)
 * before calling `fn`. Trailing omitted arguments are left out of `args`;
 * an omitted argument in the middle (`MsgBox "x", , "t"`) is `undefined`.
 */
export type Builtin = {
  minArgs: number;
  maxArgs: number;
  fn: (args: VBValue[], ctx: BuiltinCtx) => VBValue | Promise<VBValue>;
};

/** Built-in functions by lower-case name. */
export const BUILTINS = new Map<string, Builtin>();

/** Built-in constants (vbCrLf, vbYes, ...) by lower-case name. */
export const CONSTANTS = new Map<string, VBValue>();

function arrayBound(which: 0 | 1) {
  return (args: VBValue[]): VBValue => {
    if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
    const a = args[0];
    if (!(a instanceof VBArray)) throw new VBRuntimeError(13);
    const dim = args[1] === undefined ? 1 : toNumber(args[1]);
    if (!a.allocated || !Number.isInteger(dim) || dim < 1 || dim > a.bounds.length) throw new VBRuntimeError(9);
    return a.bounds[dim - 1][which];
  };
}

BUILTINS.set('lbound', { minArgs: 1, maxArgs: 2, fn: arrayBound(0) });
BUILTINS.set('ubound', { minArgs: 1, maxArgs: 2, fn: arrayBound(1) });

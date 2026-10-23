// Built-in function and constant registry. The interpreter looks names up
// here after user code, enum members and constants (see interp/eval.ts).
// The library is split over strings.ts, convert.ts, math.ts, datetime.ts,
// misc.ts (dialogs, colours, IIf ...), files.ts (file I/O, settings) and constants.ts; importing this file
// registers everything.

import { VBRuntimeError } from '../errors';
import { VBArray, toNumber, type VBValue } from '../values';
import { BUILTINS, def } from './util';

export { BUILTINS, CANONICAL_NAMES, CONSTANTS, def } from './util';
export type { Builtin, BuiltinCtx } from './util';
export { formatValue } from './format';
export { ErrObject } from './err';

function arrayBound(which: 0 | 1) {
  return (args: VBValue[]): VBValue => {
    const a = args[0];
    if (!(a instanceof VBArray)) throw new VBRuntimeError(13);
    const dim = args[1] === undefined ? 1 : toNumber(args[1]);
    if (!a.allocated || !Number.isInteger(dim) || dim < 1 || dim > a.bounds.length) throw new VBRuntimeError(9);
    return a.bounds[dim - 1][which];
  };
}

def('LBound', 1, 2, arrayBound(0));
def('UBound', 1, 2, arrayBound(1));

import './strings';
import './convert';
import './math';
import './datetime';
import './misc';
import './files';
import './constants';
import './err';

/**
 * Numeric built-ins get a Single argument as its exact value (Sqr(s), CDbl(s) as in VB6); the others (CStr, Left,
 * MsgBox, IIf ...) get its 7 shown digits (see interp/staticTypes.ts `shown`).
 */
for (const n of [
  'abs', 'sgn', 'int', 'fix', 'sqr', 'log', 'exp', 'sin', 'cos', 'tan', 'atn', 'round', 'hex', 'oct', 'rnd', 'randomize',
  'cint', 'clng', 'cdbl', 'csng', 'ccur', 'cbyte', 'cbool', 'cdate', 'cdec', 'cverr', 'year', 'month', 'day', 'hour', 'minute',
  'second', 'weekday', 'dateserial', 'timeserial', 'dateadd', 'datediff', 'datepart', 'monthname', 'weekdayname', 'rgb', 'qbcolor',
  'space', 'chr', 'chrw', 'lbound', 'ubound',
]) {
  const b = BUILTINS.get(n);
  if (b) b.num = true;
}

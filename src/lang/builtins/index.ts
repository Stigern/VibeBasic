// Built-in function and constant registry. The interpreter looks names up
// here after user code, enum members and constants (see interp/eval.ts).
// The library is split over strings.ts, convert.ts, math.ts, datetime.ts,
// misc.ts (dialogs, colours, IIf ...) and constants.ts; importing this file
// registers everything.

import { VBRuntimeError } from '../errors';
import { VBArray, toNumber, type VBValue } from '../values';
import { def } from './util';

export { BUILTINS, CONSTANTS, def } from './util';
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

def('lbound', 1, 2, arrayBound(0));
def('ubound', 1, 2, arrayBound(1));

import './strings';
import './convert';
import './math';
import './datetime';
import './misc';
import './constants';
import './err';

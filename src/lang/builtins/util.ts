// Shared pieces of the built-in library: the registry, argument helpers and
// the registration function used by strings.ts, convert.ts, math.ts, ...

import type { Host } from '../host';
import { VBRuntimeError } from '../errors';
import { NullT, bankers, toNumber, type VBValue } from '../values';

export interface BuiltinCtx {
  host: Host;
  /** BCP 47 locale for date/number text (ProgramOptions.locale). */
  locale: string;
  /** Default MsgBox/InputBox title (ProgramOptions.appTitle, default 'Project1'). */
  appTitle?: string;
  // Task 8 adds the `Err` object here.
}

/**
 * A built-in function. The interpreter checks `minArgs`/`maxArgs` (error 450)
 * before calling `fn`; `fn` itself checks again, so calling it directly is safe.
 * Trailing omitted arguments are left out of `args`; an omitted argument in the
 * middle (`MsgBox "x", , "t"`) is `undefined`.
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

/**
 * Registers a built-in under one or more names (`$` variants need no extra
 * name: `Left$` looks up `left`). Wrong argument counts, and an omitted
 * required argument, are error 450.
 */
export function def(
  names: string | string[], minArgs: number, maxArgs: number,
  fn: (args: VBValue[], ctx: BuiltinCtx) => VBValue | Promise<VBValue>,
): void {
  const impl: Builtin['fn'] = (args, ctx) => {
    if (args.length < minArgs || args.length > maxArgs) throw new VBRuntimeError(450);
    for (let i = 0; i < minArgs; i++) if (args[i] === undefined) throw new VBRuntimeError(450);
    return fn(args, ctx);
  };
  for (const n of Array.isArray(names) ? names : [names]) {
    BUILTINS.set(n.toLowerCase(), { minArgs, maxArgs, fn: impl });
  }
}

export const isNullV = (v: VBValue | undefined): v is NullT => v instanceof NullT;

/** CLng-style integer (banker's rounding) of an argument. */
export const intArg = (v: VBValue): number => {
  const n = toNumber(v);
  if (!Number.isFinite(n)) throw new VBRuntimeError(6);
  return bankers(n);
};

/** Optional integer argument (`undefined` when omitted). */
export const optInt = (v: VBValue | undefined, dflt: number): number => (v === undefined ? dflt : intArg(v));

/** vbTextCompare (1) selects case-insensitive comparison. */
export const isTextCompare = (v: VBValue | undefined): boolean => v !== undefined && !(v instanceof NullT) && toNumber(v) === 1;

/** `s` repeated `n` times; more than 2^26 characters is error 7. */
export function repeat(s: string, n: number): string {
  if (n < 0) throw new VBRuntimeError(5);
  if (s.length * n > 2 ** 26) throw new VBRuntimeError(7);
  return s.repeat(n);
}

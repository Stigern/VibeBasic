// The `Err` object and the `Error` / `Error$` function.
//
// One ErrObject per program (BuiltinCtx.err). The interpreter fills it when an
// error is caught by a handler (or reported as unhandled) and clears it on
// Resume, Resume Next, Exit Sub/Function, any On Error statement, and when a
// procedure with an active handler returns (see interp/exec.ts).

import type { VBObject } from '../host';
import { VBRuntimeError, vbErrorText } from '../errors';
import { toNumber, toStr, type VBValue } from '../values';
import { def, intArg, type BuiltinCtx } from './util';

/** Properties (Clear and Raise are methods: `callMethod`). */
const PROPERTIES = new Set(['number', 'description', 'source', 'helpfile', 'helpcontext', 'lastdllerror']);

/** VB's `Err`: Number (default member), Description, Source, Clear, Raise. */
export class ErrObject implements VBObject {
  readonly vbTypeName = 'ErrObject';
  readonly defaultMember = 'Number';
  number = 0;
  description = '';
  source = '';

  /** `appTitle` is the default Source (the project name, as in VB6). */
  constructor(readonly appTitle = 'Project1') {}

  /** Fills Err from a caught (or unhandled) error. */
  setFrom(err: VBRuntimeError): void {
    this.number = err.number;
    this.description = err.description;
    this.source = err.source ?? this.appTitle;
  }

  clear(): void {
    this.number = 0;
    this.description = '';
    this.source = '';
  }

  /**
   * `Err.Raise number[, source[, description]]`: throws the error. The
   * description defaults to VB's text for the number, the source to the app title.
   */
  raise(args: VBValue[]): never {
    if (args[0] === undefined) throw new VBRuntimeError(450);
    const n = intArg(args[0]);
    if (n === 0) throw new VBRuntimeError(5);
    const e = new VBRuntimeError(n, args[2] === undefined ? undefined : toStr(args[2]));
    e.source = args[1] === undefined ? this.appTitle : toStr(args[1]);
    throw e;
  }

  hasMember(name: string): boolean {
    return PROPERTIES.has(name.toLowerCase());
  }

  getMember(name: string, args: VBValue[]): VBValue {
    if (args.length > 0) throw new VBRuntimeError(450);
    switch (name.toLowerCase()) {
      case 'number': return this.number;
      case 'description': return this.description;
      case 'source': return this.source;
      case 'helpfile': return '';
      case 'helpcontext': case 'lastdllerror': return 0;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (args.length > 0) throw new VBRuntimeError(450);
    switch (name.toLowerCase()) {
      case 'number': this.number = intArg(toNumber(value)); return;
      case 'description': this.description = toStr(value); return;
      case 'source': this.source = toStr(value); return;
      case 'helpfile': case 'helpcontext': return;
    }
    throw new VBRuntimeError(438);
  }

  callMethod(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'clear':
        if (args.length > 0) throw new VBRuntimeError(450);
        this.clear();
        return 0;
      case 'raise':
        if (args.length > 3) throw new VBRuntimeError(450);
        return this.raise(args);
    }
    throw new VBRuntimeError(438);
  }
}

/** The program's Err object (created on first use for a context that has none). */
export function errOf(ctx: BuiltinCtx): ErrObject {
  return (ctx.err ??= new ErrObject(ctx.appTitle));
}

def('Err', 0, 0, (_a, ctx) => errOf(ctx));

/** `Error(n)`: VB's text for error n (`''` for 0); `Error` alone: the current Err.Description. */
def('Error', 0, 1, (a, ctx) => {
  if (a[0] === undefined) return errOf(ctx).description;
  const n = intArg(a[0]);
  return n === 0 ? '' : vbErrorText(n);
});

// Generator driver for the interpreter.
//
// All statement execution and expression evaluation are generators (`Gen<T>`).
// A generator talks to the driver by yielding:
//   - a Promise: the driver awaits it and resumes the generator with the
//     result (or throws the rejection into it). Host dialogs, DoEvents and
//     the periodic `setTimeout(0)` slice use this.
//   - a SubCall: the driver runs that generator to completion on its own
//     explicit stack and resumes the caller with its return value (or throws
//     its error into the caller). Every VB procedure call goes through a
//     SubCall, so VB recursion depth does not grow the JS stack.
//
// Nothing else is ever yielded. Between yields everything runs synchronously.

import type { VBValue } from '../values';

/** Thrown into running code to stop it (End statement, Program.end, unhandled error). Never caught by VB code. */
export class EndSignal {
  readonly kind = 'end';
}

/** Ask the driver to run `gen` as a nested call and resume with its result. */
export class SubCall {
  constructor(readonly gen: Gen<VBValue>) {}
}

export type Yielded = Promise<unknown> | SubCall;
export type Gen<T> = Generator<Yielded, T, unknown>;

type Resume = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Runs `root` to completion, awaiting yielded promises and running SubCalls
 * on an explicit stack. Resolves with the root's return value; rejects with
 * whatever the root throws.
 */
export async function runGenerator<T>(root: Gen<T>, scope?: ExecScope): Promise<T> {
  const stack: Gen<unknown>[] = [root];
  let input: Resume = { ok: true, value: undefined };
  // `scope` is current only while generator code runs, never across an await.
  // It must also be restored synchronously when the loop ends (not a microtask
  // later), or another run that resumes in between would save a stale state.
  let restore: (() => void) | undefined = scope?.activate();
  try {
    while (stack.length > 0) {
      const g = stack[stack.length - 1];
      let r: IteratorResult<Yielded, unknown>;
      try {
        r = input.ok ? g.next(input.value) : g.throw(input.error);
      } catch (e) {
        stack.pop();
        input = { ok: false, error: e };
        continue;
      }
      if (r.done) {
        stack.pop();
        input = { ok: true, value: r.value };
        continue;
      }
      const y: Yielded = r.value;
      if (y instanceof SubCall) {
        stack.push(y.gen);
        input = { ok: true, value: undefined };
        continue;
      }
      restore?.();
      restore = undefined;
      scope?.beforeAwait?.();
      // The end of the program (End, Program.end) cancels the wait: EndSignal is thrown in.
      const cancellable = scope?.cancellable;
      try {
        input = { ok: true, value: await (cancellable ? cancellable(y) : y) };
      } catch (e) {
        input = { ok: false, error: e };
      }
      // Event handlers that started while we waited run to completion first.
      for (let nested = scope?.afterAwait?.(); nested; nested = scope?.afterAwait?.()) {
        await (cancellable ? cancellable(nested).catch(() => {}) : nested);
      }
      restore = scope?.activate();
    }
  } finally {
    restore?.();
  }
  if (!input.ok) throw input.error;
  return input.value as T;
}

/** Per-program state that must be current while its code runs (e.g. the date-text locale), and the await hooks. */
export interface ExecScope {
  /** Makes the scope current and returns a function that restores the previous state. */
  activate(): () => void;
  /** Called just before the driver awaits a yielded promise. */
  beforeAwait?(): void;
  /**
   * Called after a yielded promise has settled, before the generator resumes:
   * a promise to wait for first (nested event handlers still running), or
   * undefined to resume now. Called again after each wait.
   */
  afterAwait?(): Promise<void> | undefined;
  /**
   * Wraps an awaited promise so that it also rejects with an EndSignal when
   * the program ends: a host promise that never settles (a dialog, onBreak)
   * cannot keep a run alive after End. The wrapper registers a cancel
   * listener only until `p` settles (no long-lived promise reactions).
   */
  readonly cancellable?: <T>(p: Promise<T>) => Promise<T>;
}

/**
 * Runs a generator that must not call procedures or wait (constant
 * expressions, array bounds in Type fields). If it yields anything it is
 * closed and `onYield()` is called, which must throw.
 */
export function runSync<T>(gen: Gen<T>, onYield: () => never): T {
  const r = gen.next();
  if (!r.done) {
    gen.return(undefined as T);
    onYield();
  }
  return r.value;
}

/** A promise that resolves on the next macrotask, letting the UI and timers run. */
export function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// The Immediate window: one command, run in the frame stopped in break mode
// or in a global context. See Program.immediate for the contract.

import type { ProcDecl, Stmt } from '../ast';
import { VBRuntimeError, VBSyntaxError, internalError } from '../errors';
import { parseModule } from '../parser';
import { PrintLine } from '../printFormat';
import { EndSignal, runGenerator, type Gen } from './driver';
import { printItems } from './fileStmts';
import { execBlock, isStackOverflow } from './exec';
import type { Runtime } from './program';
import { Frame, ModuleScope, Run } from './scope';

/** `?` or the word `Print` at the start of a command. */
const PRINT = /^(\?|print(?=\s|$))/i;

const INVALID = 'Compile error: Invalid in Immediate window';

/**
 * Statements the Immediate window does not allow, anywhere in the command:
 * declarations, and error handling / jumps (they would act on the paused
 * procedure's handler state and labels).
 */
const NOT_IMMEDIATE = new Set<Stmt['kind']>(['dim', 'const', 'onError', 'resume', 'goto', 'label']);

function hasInvalidStatement(body: Stmt[] | undefined): boolean {
  if (!body) return false;
  return body.some(s => {
    if (NOT_IMMEDIATE.has(s.kind)) return true;
    switch (s.kind) {
      case 'if': return s.branches.some(b => hasInvalidStatement(b.body)) || hasInvalidStatement(s.elseBody);
      case 'select': return s.cases.some(c => hasInvalidStatement(c.body)) || hasInvalidStatement(s.elseBody);
      case 'for': case 'forEach': case 'do': case 'while': case 'with': return hasInvalidStatement(s.body);
      default: return false;
    }
  });
}

/** An empty module: the global context's own scope (globals and host names only, no Private module variables). */
const globalContext = new WeakMap<Runtime, ModuleScope>();

function globalModule(rt: Runtime): ModuleScope {
  let m = globalContext.get(rt);
  if (!m) {
    m = new ModuleScope('', 'module', parseModule('', ''));
    globalContext.set(rt, m);
  }
  return m;
}

/** Parses a command as the body of a Sub; a syntax error is returned as text. */
function parseCommand(code: string): ProcDecl | string {
  try {
    const ast = parseModule(`Sub Immediate()\n${code}\nEnd Sub\n`, 'Immediate');
    if (ast.procedures.length !== 1 || ast.variables.length > 0 || ast.consts.length > 0) return INVALID;
    return ast.procedures[0];
  } catch (e) {
    if (e instanceof VBSyntaxError) return `Compile error: ${e.message}`;
    throw e;
  }
}

/** The frame a command runs in: a copy of the break frame (same variables), or a fresh global one. */
function commandFrame(rt: Runtime, run: Run, proc: ProcDecl): Frame {
  const bf = rt.breakFrame;
  if (!bf) return new Frame(run, globalModule(rt), proc, 0);
  // Shares the paused frame's Variables (so assignments reach it) but not its
  // error-handler state: an error here never runs the paused procedure's handler.
  const f = new Frame(run, bf.module, bf.proc, bf.line);
  for (const [k, v] of bf.locals) f.locals.set(k, v);
  f.returnVar = bf.returnVar;
  f.withStack.push(...bf.withStack);
  return f;
}

export async function runImmediate(rt: Runtime, text: string): Promise<string> {
  const src = text.trim();
  const print = PRINT.exec(src);
  const proc = parseCommand(print ? `Debug.Print ${src.slice(print[0].length)}` : src);
  if (typeof proc === 'string') return proc;
  if (hasInvalidStatement(proc.body)) return INVALID;

  const body = proc.body;
  const run = new Run(rt);
  run.immediate = true;
  const f = commandFrame(rt, run, proc);
  run.frames.push(f);

  function* command(): Gen<string> {
    yield* rt.ensureInit(run);
    let out = '';
    let rest = 0;
    const first = body[0];
    if (print && first?.kind === 'debugPrint') {
      // the `?` part is returned, not printed
      const line = new PrintLine(0, '\n');
      yield* printItems(f, first.items, line);
      out = line.text();
      rest = 1;
    }
    yield* execBlock(f, body, rest);
    return out;
  }

  rt.immediateRuns++;
  try {
    return await runGenerator(command(), rt.scope);
  } catch (e) {
    if (e instanceof EndSignal) return '';
    const err = e instanceof VBRuntimeError ? e : isStackOverflow(e) ? new VBRuntimeError(28) : internalError(e);
    return err.compile ? `Compile error: ${err.description}` : `Run-time error '${err.number}': ${err.description}`;
  } finally {
    rt.immediateRuns--;
    // events queued while the command was in a time slice
    if (rt.slicing === 0 && rt.eventsSuspended === 0 && rt.state !== 'break') rt.drainEvents();
  }
}

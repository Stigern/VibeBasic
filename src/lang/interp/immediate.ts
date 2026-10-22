// The Immediate window: one command, run in the frame stopped in break mode
// or in a global context. See Program.immediate for the contract.

import type { ProcDecl } from '../ast';
import { VBRuntimeError, VBSyntaxError } from '../errors';
import { parseModule } from '../parser';
import { PrintLine } from '../printFormat';
import { EndSignal, runGenerator, type Gen } from './driver';
import { evalExpr } from './eval';
import { execBlock, hasDeclarations, isStackOverflow } from './exec';
import type { Runtime } from './program';
import { Frame, ModuleScope, Run } from './scope';

/** `?` or the word `Print` at the start of a command. */
const PRINT = /^(\?|print(?=\s|$))/i;

const INVALID = 'Compile error: Invalid in Immediate window';

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
  if (hasDeclarations(proc)) return INVALID;

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
      const line = new PrintLine(0);
      for (const it of first.items) {
        if (it.expr) line.addItem(yield* evalExpr(f, it.expr));
        if (it.sep === ';') line.addSemicolon();
        else if (it.sep === ',') line.addComma();
      }
      out = line.text();
      rest = 1;
    }
    yield* execBlock(f, body, rest);
    return out;
  }

  try {
    return await runGenerator(command(), rt.scope);
  } catch (e) {
    if (e instanceof EndSignal) return '';
    const err = isStackOverflow(e) ? new VBRuntimeError(28) : e;
    if (err instanceof VBRuntimeError) {
      return err.compile ? `Compile error: ${err.description}` : `Run-time error '${err.number}': ${err.description}`;
    }
    throw e;
  } finally {
    // events queued while the command was in a time slice
    if (rt.slicing === 0 && rt.eventsSuspended === 0 && rt.state !== 'break') rt.drainEvents();
  }
}

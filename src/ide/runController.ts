// Run controller: F5 / Ctrl+F5 / Break / End / Restart and the design -> run <-> break state machine.
// Owns the RunSession of the IDE, makes the IDE read-only while it runs (IdeState.mode), highlights the break
// line in the code window and feeds Debug.Print and the Immediate window.
//
// Known limit: Break cannot interrupt a handler that waits for the host (for example `Form2.Show vbModal` or a
// MsgBox); it takes effect when that wait is over. End always works.
import { VBSyntaxError } from '../lang/errors';
import { winPaths } from '../platform';
import { winDirOf } from '../lang/fileio/winPath';
import type { BreakInfo, CodeLocation } from '../lang/host';
import type { StackEntry } from '../lang/interp/debugger';
import { findSyntaxErrors } from '../lang/parser';
import { parseCondConsts, type CondConsts } from '../lang/condComp';
import { listProcedures } from '../model/procedures';
import { moduleKind } from '../model/types';
import { RunSession } from '../run/session';
import type { FormHost } from '../run/formHost';
import { compileErrorBox, messageBox98 } from '../ui98/dialogs';
import { breakpointsOf, type CodeWindow } from './codeWindow';
import type { IdeState } from './ideState';

export interface RunOptions {
  /** Immediate window hooks: Debug.Print output and showing the window on break. */
  immediate?: { print(text: string, newline: boolean): void; show(): void; focus(): void };
  readFile?: (path: string) => Promise<Uint8Array>;
  doc?: Document;
  /** Ask AI on an error: the error dialog's button (the program is in break mode on the line, or in design for a compile error before the start). */
  onAskAi?: (fix: ErrorToFix) => void;
}

/** An error the AI should fix: the form or module, the error and (run-time errors) the variables of the stopped frame. */
export interface ErrorToFix {
  itemId: string;
  error: { number: number; description: string; compile: boolean; line: number; procName: string | null };
  vars: { name: string; value: string }[];
}

/** How a debug command starts or goes on: a step, or Run To Cursor (a one-shot breakpoint). */
export type DebugGo = { step: 'into' | 'over' | 'out' } | { runTo: { moduleName: string; line: number } };

export class RunController {
  session: RunSession | null = null;
  private pendingBreak: ((a: 'continue' | 'end') => void) | null = null;
  private breakWin: CodeWindow | null = null;
  /** Code windows showing a green Call Stack triangle (cleared when the break ends). */
  private callWins: CodeWindow[] = [];
  /** Where the program is stopped in break mode (Show Next Statement, Set Next Statement), else null. */
  breakAt: CodeLocation | null = null;
  private errorWins: CodeWindow[] = [];
  /** Set while in break mode on an unhandled error (Tools > Ask AI about this error). */
  breakError: Omit<ErrorToFix, 'vars'> | null = null;
  private starting = false;
  /** The previous run's host teardown: a new run waits for it (Shift+F5), so it cannot destroy the new run's windows. */
  private lastDispose: Promise<void> = Promise.resolve();

  constructor(private ide: IdeState, private hostFactory: () => FormHost, private openCode: (itemId: string) => CodeWindow, private opts: RunOptions = {}) {
    ide.on('breakpoints', () => this.syncBreakpoints());   // F9 in run or break mode reaches the running program
  }

  private get doc(): Document { return this.opts.doc ?? document; }

  private itemId(moduleName: string): string | undefined {
    const l = moduleName.toLowerCase();
    return [...this.ide.project.forms, ...this.ide.project.modules].find(x => x.name.toLowerCase() === l)?.id;
  }

  private appPath(): string {
    const p = this.ide.filePath;
    if (p && winPaths()) return winDirOf(p);   // "C:\Proj" ("C:\" for a project at the root, as VB6)
    const i = p ? Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) : -1;
    return p && i >= 0 ? p.slice(0, i) : '';
  }

  /** Compile error before the program starts: message box, code window at the line, line in red, stays in design. */
  private async showCompileError(e: VBSyntaxError): Promise<void> {
    const id = e.moduleName ? this.itemId(e.moduleName) : undefined;
    if (id) {
      const w = this.openCode(id);
      w.markErrorLines([e.line]);
      w.gotoLine(e.line);
      this.errorWins.push(w);
    }
    const askAi = !!id && !!this.opts.onAskAi;
    if (await compileErrorBox(this.doc, e.message, { askAi }) !== 'ai' || !id) return;
    const code = [...this.ide.project.forms, ...this.ide.project.modules].find(x => x.id === id)?.code ?? '';
    const procName = listProcedures(code).find(p => e.line >= p.line && e.line <= p.endLine)?.name ?? null;
    this.opts.onAskAi?.({ itemId: id, error: { number: 0, description: e.message, compile: true, line: e.line, procName }, vars: [] });
  }

  /** The error of the current break (with the stopped frame's variables), or null when not stopped on an error. */
  errorToFix(): ErrorToFix | null {
    const b = this.breakError;
    if (!b || this.ide.mode !== 'break') return null;
    return { ...b, vars: b.error.compile ? [] : this.session?.variables() ?? [] };
  }

  /** End, then wait until the program and its windows are gone (at most 3 s for the windows). */
  async endAndWait(): Promise<void> {
    this.end();
    await Promise.race([this.lastDispose, new Promise(r => setTimeout(r, 3000))]);
  }

  /** F5 / Ctrl+F5. In break mode F5 continues. With `go`, a step or Run To Cursor (Debug menu). */
  async start(fullCompile: boolean, go?: DebugGo): Promise<void> {
    if (this.ide.mode === 'break') {
      if (go && this.session) this.arm(this.session, go);
      this.pendingBreak?.('continue');
      return;
    }
    if (this.ide.mode === 'run' || this.starting || this.ide.busy) return;
    this.starting = true;
    let session: RunSession | null;
    try {
      session = await this.prepare(fullCompile);
    } finally {
      this.starting = false;
    }
    if (!session) return;
    if (go) this.arm(session, go);
    try {
      await session.start();
    } catch (e) {
      console.error(e);
      session.end();
      const msg = e instanceof Error ? e.message : String(e);
      await messageBox98(this.doc, { prompt: `Could not start the program:\n${msg}`, title: 'VibeBasic', buttons: 16 }).catch(() => {});
    }
  }

  /** Compile checks and session creation; null when the program did not start. */
  private async prepare(fullCompile: boolean): Promise<RunSession | null> {
    for (const w of this.errorWins.splice(0)) try { w.markErrorLines([]); } catch { /* window closed */ }
    const p = this.ide.project;
    const modules = [
      ...p.forms.map(f => ({ name: f.name, kind: 'form' as const, source: f.code })),
      ...p.modules.map(m => ({ name: m.name, kind: moduleKind(m), source: m.code })),
    ];
    if (fullCompile) {
      let consts: CondConsts | undefined;
      try { consts = p.condComp ? parseCondConsts(p.condComp) : undefined; } catch { /* reported when the program starts */ }
      for (const m of modules) {
        const errs = findSyntaxErrors(m.source, m.name, consts);
        if (errs.length) { await this.showCompileError(errs[0]); return null; }
      }
    }
    await Promise.race([this.lastDispose, new Promise(r => setTimeout(r, 3000))]);   // a hung teardown must not block F5 forever
    const host = this.hostFactory();
    let session!: RunSession;
    try {
      session = new RunSession(p, host, {
        debugPrint: (t, nl) => this.opts.immediate?.print(t, nl),
        onBreak: info => this.onBreak(info),
        onEnded: () => this.ended(session),
        readFile: this.opts.readFile ?? (async () => { throw new Error('ENOENT'); }),
        appPath: this.appPath(),
      }, 'ide');
    } catch (e) {
      this.disposeHost(host);
      if (e instanceof VBSyntaxError) { await this.showCompileError(e); return null; }
      throw e;
    }
    this.session = session;
    this.syncBreakpoints();
    void session.program.debug.setWatches(p.watches ?? []);   // Break When Value Is True / Changes
    this.ide.setMode('run');
    return session;
  }

  /** F8 / Shift+F8 / Ctrl+Shift+F8: in design mode it starts the program and breaks at the first statement. */
  step(mode: 'into' | 'over' | 'out'): void {
    if (this.ide.mode === 'run' || (this.ide.mode === 'design' && mode === 'out')) return;
    void this.start(false, { step: this.ide.mode === 'design' ? 'into' : mode });
  }

  /** Ctrl+F8: runs (or starts) until `line` of the module is reached. */
  runToCursor(moduleName: string, line: number): void {
    if (this.ide.mode === 'run') return;
    void this.start(false, { runTo: { moduleName, line } });
  }

  private arm(s: RunSession, go: DebugGo): void {
    if ('step' in go) s.step(go.step);
    else s.runToLine(go.runTo.moduleName, go.runTo.line);
  }

  /** Passes the IDE's breakpoints to the running program (every module, so removed ones go too). */
  syncBreakpoints(): void {
    const s = this.session;
    if (!s) return;
    const bps = breakpointsOf(this.ide);
    for (const it of [...this.ide.project.forms, ...this.ide.project.modules]) s.setBreakpoints(it.name, bps.get(it.id) ?? []);
  }

  /** Ctrl+Break / Cmd+. / Ctrl+Pause. */
  breakNow(): void {
    if (this.ide.mode === 'run') this.session?.pause();
  }

  end(): void {
    const s = this.session;
    if (!s) return;
    s.end();
    this.pendingBreak?.('end');
  }

  async restart(): Promise<void> {
    this.end();
    await this.start(false);
  }

  /**
   * Debug > Set Next Statement (Ctrl+F9) on `line` of a module's code window: the program goes on from that statement of
   * the stopped procedure (it breaks there again first). Returns null when done, else the message to show.
   */
  setNextStatement(moduleName: string, line: number): string | null {
    const s = this.session, at = this.breakAt;
    if (this.ide.mode !== 'break' || !s || !at || !this.pendingBreak) return null;
    if (at.moduleName.toLowerCase() !== moduleName.toLowerCase() || !at.procName) return 'Can\'t set the next statement outside the current procedure';
    const err = s.program.debug.setNextStatement(line);
    if (err === null) this.pendingBreak('continue');
    return err;
  }

  /** Debug > Show Next Statement: the code window of the stopped procedure at its yellow line. */
  showNextStatement(): void {
    const at = this.breakAt;
    const id = at && this.itemId(at.moduleName);
    if (at && id) this.openCode(id).gotoLine(at.line);
  }

  /** Call Stack > Show: the line of a procedure call; a caller's line (not the newest) gets the green triangle. */
  showStackFrame(e: StackEntry, newest: boolean): void {
    const id = this.itemId(e.moduleName);
    if (!id) return;
    this.clearCallLines();
    const w = this.openCode(id);
    w.gotoLine(e.line);
    if (!newest && w.setCallLine) { w.setCallLine(e.line); this.callWins.push(w); }
  }

  private clearCallLines(): void {
    for (const w of this.callWins.splice(0)) try { w.setCallLine?.(null); } catch { /* window closed */ }
  }

  private async onBreak(info: BreakInfo & { askAi?: boolean }): Promise<'continue' | 'end'> {
    this.breakAt = info.at;
    this.ide.setMode('break');
    const id = info.at.moduleName ? this.itemId(info.at.moduleName) : undefined;
    // VB6: the Immediate window is shown, but the keyboard focus goes to the code window with the caret on the yellow
    // line (so F8 / Shift+F8 / F9 keep working from there); only a break outside any code item focuses the Immediate window.
    this.opts.immediate?.show();
    if (id) {
      const w = this.openCode(id);
      this.breakWin = w;
      w.gotoLine(info.at.line);
      w.setBreakLine(info.at.line);
      if (info.error?.compile) { w.markErrorLines([info.at.line]); this.errorWins.push(w); }
    } else this.opts.immediate?.focus();
    const e = info.error;
    this.breakError = info.reason === 'error' && e && id
      ? { itemId: id, error: { number: e.number, description: e.description, compile: e.compile, line: info.at.line, procName: info.at.procName || null } }
      : null;
    try {
      const answer = new Promise<'continue' | 'end'>(resolve => { this.pendingBreak = resolve; });
      if (info.askAi) { const fix = this.errorToFix(); if (fix) this.opts.onAskAi?.(fix); }
      return await answer;
    } finally {
      this.breakError = null;
      this.breakAt = null;
      this.pendingBreak = null;
      this.clearBreakLine();
      this.clearCallLines();
      if (this.ide.mode === 'break') this.ide.setMode('run');
    }
  }

  private clearBreakLine(): void {
    try { this.breakWin?.setBreakLine(null); } catch { /* window closed */ }
    this.breakWin = null;
  }

  private disposeHost(host: FormHost): void {
    let p: Promise<void>;
    try {
      p = Promise.resolve((host as { dispose?: () => unknown }).dispose?.()).then(() => {}, () => {});
    } catch { p = Promise.resolve(); /* a failing dispose must not break the state machine */ }
    const prev = this.lastDispose;
    this.lastDispose = Promise.all([prev, p]).then(() => {});
  }

  private ended(s: RunSession): void {
    if (this.session !== s) return;
    this.session = null;
    this.clearBreakLine();
    this.pendingBreak?.('end');
    this.disposeHost(s.formHost);
    this.ide.setMode('design');
  }
}

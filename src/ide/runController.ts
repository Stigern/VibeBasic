// Run controller: F5 / Ctrl+F5 / Break / End / Restart and the design -> run <-> break state machine.
// Owns the RunSession of the IDE, makes the IDE read-only while it runs (IdeState.mode), highlights the break
// line in the code window and feeds Debug.Print and the Immediate window.
//
// Known limit: Break cannot interrupt a handler that waits for the host (for example `Form2.Show vbModal` or a
// MsgBox); it takes effect when that wait is over. End always works.
import { VBSyntaxError } from '../lang/errors';
import type { BreakInfo } from '../lang/host';
import { findSyntaxErrors } from '../lang/parser';
import { RunSession } from '../run/session';
import type { FormHost } from '../run/formHost';
import { compileErrorBox, messageBox98 } from '../ui98/dialogs';
import type { CodeWindow } from './codeWindow';
import type { IdeState } from './ideState';

export interface RunOptions {
  /** Immediate window hooks: Debug.Print output and showing the window on break. */
  immediate?: { print(text: string, newline: boolean): void; show(): void; focus(): void };
  readFile?: (path: string) => Promise<Uint8Array>;
  doc?: Document;
}

export class RunController {
  session: RunSession | null = null;
  private pendingBreak: ((a: 'continue' | 'end') => void) | null = null;
  private breakWin: CodeWindow | null = null;
  private errorWins: CodeWindow[] = [];
  private starting = false;
  /** The previous run's host teardown: a new run waits for it (Shift+F5), so it cannot destroy the new run's windows. */
  private lastDispose: Promise<void> = Promise.resolve();

  constructor(private ide: IdeState, private hostFactory: () => FormHost, private openCode: (itemId: string) => CodeWindow, private opts: RunOptions = {}) {}

  private get doc(): Document { return this.opts.doc ?? document; }

  private itemId(moduleName: string): string | undefined {
    const l = moduleName.toLowerCase();
    return [...this.ide.project.forms, ...this.ide.project.modules].find(x => x.name.toLowerCase() === l)?.id;
  }

  private appPath(): string {
    const p = this.ide.filePath;
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
    await compileErrorBox(this.doc, e.message);
  }

  /** F5 / Ctrl+F5. In break mode F5 continues. */
  async start(fullCompile: boolean): Promise<void> {
    if (this.ide.mode === 'break') { this.pendingBreak?.('continue'); return; }
    if (this.ide.mode === 'run' || this.starting || this.ide.busy) return;
    this.starting = true;
    let session: RunSession | null;
    try {
      session = await this.prepare(fullCompile);
    } finally {
      this.starting = false;
    }
    if (!session) return;
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
      ...p.modules.map(m => ({ name: m.name, kind: 'module' as const, source: m.code })),
    ];
    if (fullCompile) {
      for (const m of modules) {
        const errs = findSyntaxErrors(m.source, m.name);
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
    this.ide.setMode('run');
    return session;
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

  private async onBreak(info: BreakInfo): Promise<'continue' | 'end'> {
    this.ide.setMode('break');
    const id = info.at.moduleName ? this.itemId(info.at.moduleName) : undefined;
    if (id) {
      const w = this.openCode(id);
      this.breakWin = w;
      w.setBreakLine(info.at.line);
      if (info.error?.compile) { w.markErrorLines([info.at.line]); this.errorWins.push(w); }
    }
    this.opts.immediate?.show();
    this.opts.immediate?.focus();
    try {
      return await new Promise<'continue' | 'end'>(resolve => { this.pendingBreak = resolve; });
    } finally {
      this.pendingBreak = null;
      this.clearBreakLine();
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

// Runs a project the AI changed in RunSession with the inline host (jsdom), for the behaviour checks of the tasks.
// Files and SaveSetting live in a MemoryFs, databases in the tests' FakeDb (node:sqlite). MsgBox / InputBox / run-time
// error dialogs never block: they are recorded and answered at once.
import type { Backend } from '../src/backend/backend';
import { BrowserBackend } from '../src/backend/browserBackend';
import { MemoryFs } from '../src/lang/fileio/memoryFs';
import type { Project } from '../src/model/types';
import type { RuntimeErrorInfo } from '../src/run/errorDialog';
import { InlineFormHost } from '../src/run/inlineFormHost';
import { RunSession } from '../src/run/session';
import { FakeDb } from '../tests/run/fakeDb';

export const APP = '/app';

/** A backend for running programs: files, settings and databases in memory, the rest from the browser backend. */
export function runtimeBackend(fs = new MemoryFs(), db = new FakeDb()): { backend: Backend; fs: MemoryFs; db: FakeDb } {
  fs.mkdirs(APP);
  const base = new BrowserBackend();
  const backend = new Proxy(base, {
    get(t, k: string | symbol) {
      if (typeof k === 'string') {
        if (/^(fio|fs|setting)/.test(k) && typeof (fs as unknown as Record<string, unknown>)[k] === 'function') return ((fs as unknown as Record<string, (...a: unknown[]) => unknown>)[k]).bind(fs);
        if (k === 'listDir') return fs.listDir.bind(fs);
        if (/^db[A-Z]/.test(k) && typeof (db as unknown as Record<string, unknown>)[k] === 'function') return ((db as unknown as Record<string, (...a: unknown[]) => unknown>)[k]).bind(db);
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Backend;
  return { backend, fs, db };
}

/** An inline host whose dialogs answer at once (and are recorded). */
export class RecordingHost extends InlineFormHost {
  msgs: string[] = [];
  inputs: string[] = [];
  errors: RuntimeErrorInfo[] = [];
  errorAnswer: 'end' | 'debug' | 'ai' = 'end';
  inputAnswer = '';
  override messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number> { this.msgs.push(o.prompt); return Promise.resolve(1); }
  override inputBox(o: { prompt: string }): Promise<string> { this.inputs.push(o.prompt); return Promise.resolve(this.inputAnswer); }
  override runtimeErrorBox(o: RuntimeErrorInfo): Promise<'end' | 'debug' | 'ai'> {
    this.errors.push(o);
    const a = this.errorAnswer;
    if (a === 'ai') this.errorAnswer = 'end';
    return Promise.resolve(a);
  }
}

export const settle = async (ms = 40): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, ms));
};

/** One run of a project for a check: start, poke with Immediate commands and clicks, read back. */
export class Rt {
  session!: RunSession;
  host!: RecordingHost;
  out: string[] = [];
  breaks = 0;
  ended = false;
  readonly container: HTMLElement;
  constructor(readonly project: Project, readonly env = runtimeBackend()) {
    this.container = document.body.appendChild(document.createElement('div'));
  }

  async start(): Promise<void> {
    this.host = new RecordingHost(this.container, this.env.backend);
    this.session = new RunSession(this.project, this.host, {
      debugPrint: t => { this.out.push(t); }, onBreak: async () => { this.breaks++; return 'end'; }, onEnded: () => { this.ended = true; },
      readFile: async () => { throw new Error('ENOENT'); }, appPath: APP,
    }, 'ide');
    await this.session.start();
    await settle();
  }

  /** `? expr` in the Immediate window, trimmed. */
  async val(expr: string): Promise<string> { return (await this.session.immediate(`? ${expr}`)).trim(); }
  async exec(stmt: string): Promise<string> { const r = await this.session.immediate(stmt); await settle(); return r; }

  /** A mouse click on a control (its button, or the control itself), then a pause. Falls back to firing Name_Click. */
  async click(formName: string, ctl: string, index: number | null = null): Promise<void> {
    const f = this.project.forms.find(x => x.name.toLowerCase() === formName.toLowerCase());
    const c = f?.controls.find(d => d.name.toLowerCase() === ctl.toLowerCase() && d.index === index);
    const el = c && this.container.querySelector<HTMLElement>(`[data-control-id="${c.id}"]`);
    const target = el?.querySelector<HTMLElement>('button, input') ?? el;
    if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    else if (f) await this.session.fire(f.name, `${ctl}_Click`, []);
    await settle(80);
  }

  /** Runs `Name_Click` of a menu (or any event procedure) directly. */
  async fire(formName: string, proc: string): Promise<void> { await this.session.fire(formName, proc, []); await settle(80); }

  end(): void { try { if (this.session && this.session.state !== 'ended') this.session.end(); } catch { /* gone */ } this.container.remove(); }
}

// @vitest-environment jsdom
// Sub Main as the Startup Object, Command$, Environ and the App object's version information, PrevInstance and LogEvent.
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend, SysInfoData, SystemApi } from '../../src/backend/backend';
import { VBSyntaxError } from '../../src/lang/errors';
import { newForm, newProject } from '../../src/model/controls';
import type { Project } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { NO_STARTUP, RunSession } from '../../src/run/session';

class FakeSystem implements SystemApi {
  logged: string[] = [];
  async sysInfo(): Promise<SysInfoData> { throw new Error('not used'); }
  async environment(): Promise<[string, string][]> { return [['HOME', '/Users/me'], ['PATH', '/bin']]; }
  async commandLine(): Promise<string> { return '/Users/me/a.kalk'; }
  async prevInstance(): Promise<boolean> { return true; }
  async logEvent(line: string): Promise<void> { this.logged.push(line); }
}

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

function project(module: string, extra: Partial<Project> = {}): Project {
  const p = newProject();
  p.forms = [newForm('Form1', 'Private Sub Form_Load()\n    Debug.Print "form"\nEnd Sub\n')];
  p.startupForm = 'Form1';
  p.modules = [{ id: 'm1', name: 'Module1', code: module }];
  return Object.assign(p, extra);
}

async function run(p: Project, mode: 'ide' | 'app' = 'ide', sys = new FakeSystem()) {
  const out: string[] = [];
  let ended = 0;
  session = new RunSession(p, new InlineFormHost(container, sys as unknown as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => { ended++; },
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/tmp',
  }, mode);
  await session.start();
  await settle();
  return { out, ended: () => ended, sys };
}

test('Sub Main runs instead of the startup form, and the program ends when it returns', async () => {
  const r = await run(project('Sub Main()\n    Debug.Print "main"\nEnd Sub\n', { subMain: true }));
  expect(r.out).toEqual(['main']);
  expect(r.ended()).toBe(1);
  expect(container.querySelector('.vb-form')).toBeNull();
});

test('Startup Object Sub Main without a Sub Main: "Must have startup form or Sub Main()"', () => {
  const p = project('Sub Other()\nEnd Sub\n', { subMain: true });
  let e: unknown;
  try { new RunSession(p, new InlineFormHost(container), { debugPrint: () => {}, onBreak: async () => 'end', onEnded: () => {}, readFile: async () => new Uint8Array(), appPath: '' }, 'ide'); } catch (x) { e = x; }
  expect(e).toBeInstanceOf(VBSyntaxError);
  expect((e as Error).message).toBe(NO_STARTUP);
});

test('Command$ in the IDE is the project\'s Command Line Arguments; in a made app the file it opened', async () => {
  const code = 'Sub Main()\n    Debug.Print "[" & Command$ & "]"; Command()\nEnd Sub\n';
  expect((await run(project(code, { subMain: true, commandLine: '/x a.txt' }))).out).toEqual(['[/x a.txt]/x a.txt']);
  expect((await run(project(code, { subMain: true }), 'app')).out).toEqual(['[/Users/me/a.kalk]/Users/me/a.kalk']);
});

test('Environ(name) and Environ(n) read the process environment', async () => {
  const r = await run(project('Sub Main()\n    Debug.Print Environ("HOME"); "|"; Environ$("home"); "|"; Environ(2); "|"; Environ("NOPE"); "|"; Environ(3)\nEnd Sub\n', { subMain: true }));
  expect(r.out).toEqual(['/Users/me|/Users/me|PATH=/bin||']);
});

test('App version information, PrevInstance and LogEvent', async () => {
  const code = 'Sub Main()\n    Debug.Print App.Major & "." & App.Minor & "." & App.Revision; "|"; App.CompanyName; "|"; App.LegalCopyright; "|"; App.ProductName; "|"; App.PrevInstance\n'
    + '    App.LogEvent "disk full", vbLogEventTypeWarning\nEnd Sub\n';
  const p = project(code, { subMain: true, versionInfo: { major: 2, minor: 3, revision: 45, companyName: 'Acme', legalCopyright: '(c) 2026' } });
  const app = await run(p, 'app');
  expect(app.out).toEqual(['2.3.45|Acme|(c) 2026||True']);
  expect(app.sys.logged).toHaveLength(1);
  expect(app.sys.logged[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\tWarning\tdisk full$/);
  // the IDE: no PrevInstance and no log (as VB6); an old project is version 1.0.0
  const ide = await run(project(code, { subMain: true }));
  expect(ide.out).toEqual(['1.0.0||||False']);
  expect(ide.sys.logged).toEqual([]);
});

// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { resolveParent, type WindowCreateOptions } from '../../src/run/tauriFormHost';
import { boot } from '../../src/boot';
import { newForm, newProject } from '../../src/model/controls';
import type { Project } from '../../src/model/types';
import { serializeProject } from '../../src/model/serialize';
import type { TauriFormHost } from '../../src/run/tauriFormHost';
import { requestQuit, startRuntime } from '../../src/runtime/runtimeMain';

function fakeBackend(embedded: string | null | Error) {
  const log: string[] = [];
  let quitHandler: () => void = () => {};
  const b = {
    kind: 'browser',
    getEmbeddedProject: async () => { if (embedded instanceof Error) throw embedded; return embedded; },
    quitApp: async () => { log.push('quit'); },
    getAppDir: async () => '/Apps',
    showMainWindow: async () => { log.push('show'); },
    readBinaryFile: async () => new Uint8Array(),
    onQuitRequested: (h: () => void) => { quitHandler = h; },
  } as unknown as Backend;
  return { b, log, fireQuit: () => quitHandler() };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('no embedded project starts IDE', async () => {
  const { b, log } = fakeBackend(null);
  const deps = { startIde: vi.fn(), startRuntime: vi.fn(async () => {}), showError: vi.fn(async () => {}) };
  await boot(b, deps);
  expect(deps.startIde).toHaveBeenCalledWith(b);
  expect(deps.startRuntime).not.toHaveBeenCalled();
  expect(log).toEqual(['show']);
});

test('embedded project starts runtime', async () => {
  const p = newProject();
  p.name = 'Calc';
  const { b } = fakeBackend(serializeProject(p));
  const deps = { startIde: vi.fn(), startRuntime: vi.fn(async (_p: Project, _b: Backend) => {}), showError: vi.fn(async () => {}) };
  await boot(b, deps);
  expect(deps.startIde).not.toHaveBeenCalled();
  expect(deps.startRuntime.mock.calls[0]![0].name).toBe('Calc');
});

test('corrupt embedded project shows error and quits', async () => {
  const { b, log } = fakeBackend('hei');
  const deps = { startIde: vi.fn(), startRuntime: vi.fn(async () => {}), showError: vi.fn(async (t: string) => { log.push('error:' + t); }) };
  await boot(b, deps);
  expect(log).toEqual(['error:This is not a VibeBasic project file.', 'quit']);
  expect(deps.startRuntime).not.toHaveBeenCalled();
});

function fakeHost() {
  return { messageBox: vi.fn(async () => 1), dispose: vi.fn(async () => {}) } as unknown as TauriFormHost & { messageBox: ReturnType<typeof vi.fn> };
}

test('session end quits app', async () => {
  const p = newProject();
  p.forms = []; // nothing to show: the program ends at once
  const { b, log } = fakeBackend(null);
  const host = fakeHost();
  await startRuntime(p, b, host);
  await tick();
  expect(host.dispose).toHaveBeenCalled();
  expect(log).toEqual(['quit']);
});

test('syntax error shows a compile error and quits', async () => {
  const p = newProject();
  p.forms = [newForm('Form1', 'Sub Form_Load(\nEnd Sub')];
  p.startupForm = 'Form1';
  const { b, log } = fakeBackend(null);
  const host = fakeHost();
  await startRuntime(p, b, host);
  expect(host.messageBox.mock.calls[0][0].prompt).toMatch(/^Compile error:\n\n/);
  expect(log).toEqual(['quit']);
});

test('unreadable embedded project shows error and quits, never the IDE', async () => {
  const { b, log } = fakeBackend(new Error('x.vbb: Permission denied'));
  const deps = { startIde: vi.fn(), startRuntime: vi.fn(async () => {}), showError: vi.fn(async (t: string) => { log.push('error:' + t); }) };
  await boot(b, deps);
  expect(deps.startIde).not.toHaveBeenCalled();
  expect(log).toEqual(['error:x.vbb: Permission denied', 'quit']);
});

test('Cmd+Q before the session exists is applied once it does', async () => {
  const { b, log, fireQuit } = fakeBackend(null);
  const quitDeps = { startIde: vi.fn(), startRuntime: async (p: Project, bb: Backend) => { await startRuntime(p, bb, fakeHost()); }, showError: vi.fn(async () => {}), onQuit: requestQuit };
  (b as unknown as { getEmbeddedProject: () => Promise<string> }).getEmbeddedProject = async () => { fireQuit(); return serializeProject(Object.assign(newProject(), { forms: [] })); };
  await boot(b, quitDeps);
  await tick();
  expect(log.filter(l => l === 'quit').length).toBeGreaterThanOrEqual(1);
});

test('dialog parent only when the owner window is visible', async () => {
  const o = { parent: 'main', alwaysOnTop: false } as WindowCreateOptions;
  const win = (v: boolean) => async () => ({ isVisible: async () => v });
  expect((await resolveParent(o, win(true))).parent).toBe('main');
  const hidden = await resolveParent(o, win(false));
  expect(hidden.parent).toBeUndefined();
  expect(hidden.alwaysOnTop).toBe(true);
  expect((await resolveParent(o, async () => null)).parent).toBeUndefined();
  expect((await resolveParent(o, async () => { throw new Error('x'); })).alwaysOnTop).toBe(true);
  expect(await resolveParent({ alwaysOnTop: false } as WindowCreateOptions, win(false))).toEqual({ alwaysOnTop: false });
});

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
    getAppName: async () => 'App',
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

test('startRuntime asks the backend for the bundle name', async () => {
  const p = newProject();
  p.forms = [];
  const { b } = fakeBackend(null);
  const getAppName = vi.fn(async () => 'Mitt Program');
  (b as any).getAppName = getAppName;
  await startRuntime(p, b, fakeHost());
  expect(getAppName).toHaveBeenCalled();
});

// Review 08 final #8: the API key older versions left in the localStorage the form windows share is moved at start.
test('AI settings left in localStorage are moved to the Rust store at start, before a made app runs', async () => {
  const { LEGACY_AI_KEY, loadAiSettingsFrom } = await import('../../src/backend/aiSettingsStore');
  const old = { baseUrl: 'http://x/v1', model: 'm', apiKey: 'secret', thinking: 'low' };
  for (const embedded of [null, serializeProject(newProject())]) {
    localStorage.setItem(LEGACY_AI_KEY, JSON.stringify(old));
    let stored: unknown = null;
    const io = { get: async () => stored, set: async (v: unknown) => { stored = v; } };
    const { b } = fakeBackend(embedded);
    Object.assign(b, { kind: 'tauri', loadSettings: (key: string) => (key === 'ai' ? loadAiSettingsFrom(io, localStorage) : Promise.resolve(null)) });
    let atRuntimeStart: string | null | undefined;
    const deps = { startIde: vi.fn(), startRuntime: vi.fn(async () => { atRuntimeStart = localStorage.getItem(LEGACY_AI_KEY); }), showError: vi.fn(async () => {}) };
    await boot(b, deps);
    await vi.waitFor(() => expect(localStorage.getItem(LEGACY_AI_KEY)).toBeNull());
    expect(stored).toEqual(old);
    if (embedded !== null) expect(atRuntimeStart).toBeNull();
  }
  // the store cannot be written: the old copy stays for the next start
  localStorage.setItem(LEGACY_AI_KEY, JSON.stringify(old));
  const { b } = fakeBackend(null);
  Object.assign(b, { kind: 'tauri', loadSettings: () => loadAiSettingsFrom({ get: async () => null, set: async () => { throw new Error('no'); } }, localStorage) });
  await boot(b, { startIde: vi.fn(), startRuntime: vi.fn(async () => {}), showError: vi.fn(async () => {}) });
  await tick();
  expect(localStorage.getItem(LEGACY_AI_KEY)).not.toBeNull();
  localStorage.removeItem(LEGACY_AI_KEY);
});

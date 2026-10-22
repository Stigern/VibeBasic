// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { boot } from '../../src/boot';
import { newForm, newProject } from '../../src/model/controls';
import type { Project } from '../../src/model/types';
import { serializeProject } from '../../src/model/serialize';
import type { TauriFormHost } from '../../src/run/tauriFormHost';
import { startRuntime } from '../../src/runtime/runtimeMain';

function fakeBackend(embedded: string | null) {
  const log: string[] = [];
  let quitHandler: () => void = () => {};
  const b = {
    kind: 'browser',
    getEmbeddedProject: async () => embedded,
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

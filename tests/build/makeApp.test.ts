// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { makeAppFlow } from '../../src/build/makeApp';
import { IdeState } from '../../src/ide/ideState';
import { parseProject } from '../../src/model/serialize';

let ide: IdeState, backend: any;
beforeEach(() => {
  document.body.replaceChildren();
  ide = new IdeState();
  backend = { saveAppDialog: vi.fn(async (_n: string) => '/Apps/Min Kalk.app'), makeApp: vi.fn(async () => {}) };
});
const run = () => makeAppFlow(ide, backend as Backend, document);

test('default file name from title', async () => {
  ide.project.title = 'Min Kalk';
  await run();
  expect(backend.saveAppDialog).toHaveBeenCalledWith('Min Kalk.app');
  expect(backend.makeApp).toHaveBeenCalledWith(expect.objectContaining({ targetPath: '/Apps/Min Kalk.app', appName: 'Min Kalk', overwrite: true }));
});

test('falls back to project name', async () => {
  ide.project.title = '';
  await run();
  expect(backend.saveAppDialog).toHaveBeenCalledWith('Project1.app');
});

test('cancel does nothing', async () => {
  backend.saveAppDialog = vi.fn(async () => null);
  await run();
  expect(backend.makeApp).not.toHaveBeenCalled();
  expect(document.querySelector('.dlg98')).toBeNull();
});

test('passes project json and icon', async () => {
  ide.project.assets['a1'] = { mime: 'image/png', dataBase64: 'QUJD' };
  ide.project.iconAsset = 'a1';
  await run();
  const arg = backend.makeApp.mock.calls[0][0];
  expect(arg.iconPngBase64).toBe('QUJD');
  expect(parseProject(arg.projectJson).iconAsset).toBe('a1');
});

test('no icon gives null', async () => {
  await run();
  expect(backend.makeApp.mock.calls[0][0].iconPngBase64).toBeNull();
});

test('error shown', async () => {
  backend.makeApp = vi.fn(async () => { throw new Error('Could not make the app: x'); });
  const p = run();
  await new Promise(r => setTimeout(r, 0));
  expect(document.querySelector('.dlg98')?.textContent).toContain('Could not make the app: x');
  document.querySelector<HTMLButtonElement>('.dlg98 button')!.click();
  await p;
});

test('blocked while running', async () => {
  ide.mode = 'run';
  const p = run();
  await new Promise(r => setTimeout(r, 0));
  expect(document.querySelector('.dlg98')?.textContent).toContain("Can't make the app while the program is running.");
  expect(backend.saveAppDialog).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.dlg98 button')!.click();
  await p;
});

test('Make tab: Browse sets icon as one undo step, Clear removes it', async () => {
  const { showProjectProperties } = await import('../../src/ide/projectDialogs');
  localStorage.setItem('vibebasic.fs:/i.png', 'PNGDATA');
  vi.spyOn(window, 'prompt').mockReturnValue('/i.png');
  const btn = (l: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === l)!;
  const open = async () => { const p = showProjectProperties(ide, document); await new Promise(r => setTimeout(r, 0)); return p; };

  let p = open(); await new Promise(r => setTimeout(r, 0));
  document.querySelectorAll<HTMLElement>('.dlg98 [role="tab"]').forEach(t => { if (t.textContent === 'Make') t.click(); });
  btn('Browse...').click(); await new Promise(r => setTimeout(r, 0));
  btn('OK').click(); await p;
  const id = ide.project.iconAsset!;
  expect(ide.project.assets[id].mime).toBe('image/png');
  ide.stack.undo();
  expect(ide.project.iconAsset).toBeNull();
  expect(ide.project.assets[id]).toBeUndefined();
  ide.stack.redo();

  p = open(); await new Promise(r => setTimeout(r, 0));
  document.querySelectorAll<HTMLElement>('.dlg98 [role="tab"]').forEach(t => { if (t.textContent === 'Make') t.click(); });
  btn('Clear').click(); btn('OK').click(); await p;
  expect(ide.project.iconAsset).toBeNull();
});

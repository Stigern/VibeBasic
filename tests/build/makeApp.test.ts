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
  backend = { saveAppDialog: vi.fn(async (_n: string) => '/Apps/Min Kalk.app'), makeApp: vi.fn(async () => {}), canMakeApp: vi.fn(async () => {}) };
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

test('second call while busy is ignored; busy and wait cursor cleared afterwards', async () => {
  let release!: (v: string | null) => void;
  backend.saveAppDialog = vi.fn(() => new Promise<string | null>(r => { release = r; }));
  const first = run();
  await new Promise(r => setTimeout(r, 0));
  expect(ide.busy).toBe(true);
  expect(document.body.style.cursor).toBe('wait');
  await run();
  expect(backend.saveAppDialog).toHaveBeenCalledTimes(1);
  release('/Apps/X.app');
  await first;
  expect(backend.makeApp).toHaveBeenCalledTimes(1);
  expect(ide.busy).toBe(false);
  expect(document.body.style.cursor).toBe('');
});

test('busy is cleared after an error too', async () => {
  backend.makeApp = vi.fn(async () => { throw new Error('x'); });
  const p = run();
  await new Promise(r => setTimeout(r, 0));
  document.querySelector<HTMLButtonElement>('.dlg98 button')!.click();
  await p;
  expect(ide.busy).toBe(false);
});

test('busy disables Make and Run menu items', async () => {
  const { buildMenus } = await import('../../src/ide/menus');
  const noop = () => {};
  const menus = buildMenus({ makeApp: noop, start: noop, startFullCompile: noop, restart: noop } as any, ide);
  const items = menus.flatMap(m => m.items);
  const find = (l: string) => items.find(i => i.label.startsWith(l))!;
  expect(find('Make').enabled!()).toBe(true);
  expect(find('Start').enabled!()).toBe(true);
  ide.setBusy(true);
  expect(find('Make').enabled!()).toBe(false);
  expect(find('Start').enabled!()).toBe(false);
});

test('checks canMakeApp before the save dialog and shows its text', async () => {
  backend.canMakeApp = vi.fn(async () => { throw new Error('Make requires the desktop version of VibeBasic.'); });
  const p = run();
  await new Promise(r => setTimeout(r, 0));
  expect(document.querySelector('.dlg98')?.textContent).toContain('Make requires the desktop version of VibeBasic.');
  expect(backend.saveAppDialog).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.dlg98 button')!.click();
  await p;
});

test('BrowserBackend refuses Make with the desktop message', async () => {
  const { BrowserBackend } = await import('../../src/backend/browserBackend');
  await expect(new BrowserBackend().canMakeApp()).rejects.toThrow('Make requires the desktop version of VibeBasic.');
});

test('Make tab: replacing or clearing the icon drops the old asset (undoable); Browse error is shown', async () => {
  const { showProjectProperties } = await import('../../src/ide/projectDialogs');
  ide.project.assets['old'] = { mime: 'image/png', dataBase64: 'QQ==' };
  ide.project.iconAsset = 'old';
  const btn = (l: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === l)!;
  const open = async () => {
    const dlg = showProjectProperties(ide, document);
    await new Promise(r => setTimeout(r, 0));
    document.querySelectorAll<HTMLElement>('.dlg98 [role="tab"]').forEach(t => { if (t.textContent === 'Make') t.click(); });
    return dlg;
  };
  let p = open(); await new Promise(r => setTimeout(r, 5));
  btn('Clear').click(); btn('OK').click(); await p;
  expect(ide.project.iconAsset).toBeNull();
  expect(ide.project.assets['old']).toBeUndefined();
  ide.stack.undo();
  expect(ide.project.iconAsset).toBe('old');
  expect(ide.project.assets['old']).toBeDefined();

  // still referenced by a picture: kept
  ide.project.forms[0].props.Picture = { asset: 'old' } as any;
  p = open(); await new Promise(r => setTimeout(r, 5));
  btn('Clear').click(); btn('OK').click(); await p;
  expect(ide.project.assets['old']).toBeDefined();
  delete ide.project.forms[0].props.Picture;

  // Browse failure -> MsgBox, dialog stays usable
  vi.spyOn(window, 'prompt').mockReturnValue('/missing.png');
  p = open(); await new Promise(r => setTimeout(r, 5));
  btn('Browse...').click();
  await new Promise(r => setTimeout(r, 20));
  const boxes = [...document.querySelectorAll('.dlg98')];
  expect(boxes.some(b => /ENOENT|not found|missing/i.test(b.textContent ?? ''))).toBe(true);
  boxes.at(-1)!.querySelector<HTMLButtonElement>('button')!.click();
  await new Promise(r => setTimeout(r, 0));
  btn('Cancel').click(); await p;
});

test('the version, copyright and file types go to Make; Auto Increment adds 1 to the revision first', async () => {
  ide.project.versionInfo = { major: 2, minor: 1, revision: 9, autoIncrement: true, legalCopyright: '(c) Stig' };
  ide.project.fileTypes = ['kalk'];
  await run();
  const arg = backend.makeApp.mock.calls[0][0];
  expect(arg.version).toEqual({ major: 2, minor: 1, revision: 10, copyright: '(c) Stig' });
  expect(arg.fileTypes).toEqual(['kalk']);
  expect(ide.project.versionInfo?.revision).toBe(10);
  expect(parseProject(arg.projectJson).versionInfo?.revision).toBe(10);
});

// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Backend } from '../../src/backend/backend';
import { FileController } from '../../src/ide/fileController';
import { openCodeWindow } from '../../src/ide/codeWindow';
import { openDesigner } from '../../src/ide/designer';
import { IdeState } from '../../src/ide/ideState';
import { setProjectFieldCmd } from '../../src/model/commands';
import { newProject } from '../../src/model/controls';
import { serializeProject } from '../../src/model/serialize';

const flush = () => new Promise(r => setTimeout(r, 0));
const press = (label: string) => { [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click(); };
const dialogs = () => document.querySelectorAll('.dlg98').length;

let ide: IdeState, backend: any, fc: FileController, closeHandler: () => Promise<boolean>;

beforeEach(() => {
  document.body.replaceChildren();
  ide = new IdeState();
  backend = {
    kind: 'browser',
    openProjectDialog: vi.fn(async () => '/x/Saved.vbb'),
    saveProjectDialog: vi.fn(async (_n: string) => '/x/Project1.vbb'),
    readTextFile: vi.fn(async () => serializeProject({ ...newProject(), name: 'Saved' })),
    writeTextFile: vi.fn(async () => {}),
    setWindowTitle: vi.fn(async () => {}),
    closeMainWindow: vi.fn(async () => {}),
    onCloseRequested: vi.fn((h: () => Promise<boolean>) => { closeHandler = h; }),
  } as any;
  fc = new FileController(ide, backend as Backend, document);
});
const makeDirty = () => ide.stack.execute(setProjectFieldCmd('title', 'x'));

test('clean project opens without asking', async () => {
  await fc.newProject();
  expect(dialogs()).toBe(0);
  expect(ide.project.name).toBe('Project1');
});

test('dirty + cancel aborts new', async () => {
  makeDirty();
  const p = fc.newProject(); await flush();
  expect(document.querySelector('.dlg98')!.textContent).toContain('Save changes to the following files?');
  expect(document.querySelector('.dlg98')!.textContent).toContain('Project1.vbb');
  press('Cancel'); await p;
  expect(ide.project.title).toBe('x');
});

test('dirty + no discards', async () => {
  makeDirty();
  const p = fc.newProject(); await flush(); press('No'); await p;
  expect(ide.project.title).toBe('');
  expect(backend.writeTextFile).not.toHaveBeenCalled();
});

test('dirty + yes saves then continues', async () => {
  makeDirty();
  const p = fc.newProject(); await flush(); press('Yes'); await p;
  expect(backend.writeTextFile).toHaveBeenCalledOnce();
  expect(backend.writeTextFile.mock.calls[0][0]).toBe('/x/Project1.vbb');
  expect(ide.project.title).toBe('');
  expect(ide.stack.isDirty).toBe(false);
});

test('yes but save dialog cancelled aborts', async () => {
  makeDirty();
  backend.saveProjectDialog.mockResolvedValue(null);
  const p = fc.newProject(); await flush(); press('Yes'); await p;
  expect(backend.writeTextFile).not.toHaveBeenCalled();
  expect(ide.project.title).toBe('x');
});

test('close window asks', async () => {
  fc = new FileController(ide, backend as Backend, document);
  backend.onCloseRequested(() => fc.confirmDiscard());
  makeDirty();
  const r = closeHandler(); await flush(); press('Cancel');
  expect(await r).toBe(false);
});

test('bad file shows error and keeps project', async () => {
  backend.readTextFile.mockResolvedValue('hei');
  const p = fc.open(); await flush();
  expect(document.querySelector('.dlg98')!.textContent).toContain('This is not a VibeBasic project file.');
  press('OK'); await p;
  expect(ide.project.name).toBe('Project1');
  expect(ide.filePath).toBeNull();
});

test('open replaces project and file path', async () => {
  await fc.open();
  expect(ide.project.name).toBe('Saved');
  expect(ide.filePath).toBe('/x/Saved.vbb');
});

test('save without path uses Save As with default name; write error is reported', async () => {
  backend.writeTextFile.mockRejectedValueOnce(new Error('disk full'));
  const p = fc.save(); await flush();
  expect(backend.saveProjectDialog).toHaveBeenCalledWith('Project1.vbb');
  expect(document.querySelector('.dlg98')!.textContent).toContain('disk full');
  press('OK');
  expect(await p).toBe(false);
});

test('exit closes the window only after confirmation', async () => {
  makeDirty();
  const p = fc.exit(); await flush(); press('Cancel'); await p;
  expect(backend.closeMainWindow).not.toHaveBeenCalled();
  const q = fc.exit(); await flush(); press('No'); await q;
  expect(backend.closeMainWindow).toHaveBeenCalledOnce();
});

test('title', () => {
  fc.updateTitle();
  expect(backend.setWindowTitle).toHaveBeenCalledWith(`Project1 - VibeBasic ${__APP_VERSION__} [design]`);
});

test('New Project applies Require Variable Declaration to Form1', async () => {
  ide.setOptions({ requireVariableDeclaration: true });
  await fc.newProject();
  expect(ide.project.forms[0].code).toBe('Option Explicit\n');
});

test('reopening a project closes open designer and code windows', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const env = { mdiHost: host };
  openDesigner(ide, ide.project.forms[0].id, env);
  openCodeWindow(ide, ide.project.forms[0].id, env);
  expect(host.querySelectorAll('.mdi98').length).toBe(2);
  backend.readTextFile.mockResolvedValue(serializeProject({ ...newProject(), forms: ide.project.forms.map(f => ({ ...f, code: 'new text' })) }));
  await fc.open();
  expect(host.querySelectorAll('.mdi98').length).toBe(0);
  const w = openCodeWindow(ide, ide.project.forms[0].id, env);
  expect((w as unknown as { view: { state: { doc: { toString(): string } } } }).view.state.doc.toString()).toBe('new text');
});

const readFixture = async (p: string) => new Uint8Array(readFileSync(p));

test('a VB6 .vbp opens as an unsaved project, then the import report', async () => {
  backend.openProjectDialog.mockResolvedValue('tests/fixtures/vb6/Project1.vbp');
  backend.readBinaryFile = vi.fn(readFixture);
  const p = fc.open(); await vi.waitFor(() => expect(dialogs()).toBe(1));
  expect(document.querySelector('.dlg98')!.textContent).toContain('Gadget1 (Foo.Gadget) is not supported');
  press('OK'); await p;
  expect(ide.project.name).toBe('Demo');
  expect(ide.filePath).toBeNull();
  expect(ide.stack.isDirty).toBe(true);
});

test('Add File adds a .frm as one undoable step; a name the project has is changed, with a warning', async () => {
  backend.openFileDialog = vi.fn(async () => 'tests/fixtures/vb6/Form2.frm');
  backend.readBinaryFile = vi.fn(readFixture);
  const added = vi.fn();
  fc.onItemAdded = added;
  await fc.addFile();
  expect(ide.project.forms.map(f => f.name)).toEqual(['Form1', 'Form2']);
  expect(added).toHaveBeenCalledWith(ide.project.forms[1].id);
  const again = fc.addFile(); await vi.waitFor(() => expect(dialogs()).toBe(1));   // a second Form2
  expect(document.querySelector('.dlg98')!.textContent).toContain('The name Form2 is already used; the form was renamed Form2_2.');
  press('OK'); await again;
  expect(ide.project.forms.map(f => f.name)).toEqual(['Form1', 'Form2', 'Form2_2']);
  ide.stack.undo();
  ide.stack.undo();
  expect(ide.project.forms.map(f => f.name)).toEqual(['Form1']);
});

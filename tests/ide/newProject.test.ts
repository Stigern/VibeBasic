// @vitest-environment jsdom
// The New Project dialog, the project types it offers and the recent projects list.
import { beforeEach, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { FileController } from '../../src/ide/fileController';
import { IdeState } from '../../src/ide/ideState';
import { showNewProjectDialog } from '../../src/ide/newProjectDialog';
import { MAX_RECENT, projectFolder, projectLabel, RecentProjects, withRecent } from '../../src/ide/recentProjects';
import { newProject } from '../../src/model/controls';
import { serializeProject } from '../../src/model/serialize';
import { projectFromTemplate, TEMPLATES } from '../../src/model/templates';
import { findSyntaxErrors } from '../../src/lang/parser';

const flush = () => new Promise(r => setTimeout(r, 0));
const press = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click();
const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('.dlg98 .tabs98-tab')].find(t => t.textContent === label)!.click();
const mouse = (el: Element, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true }));

beforeEach(() => { document.body.replaceChildren(); });

test.each([
  ['textEditor', 'Text Editor'], ['drawing', 'Drawing App'], ['serial', 'Serial Terminal'],
])('New Project opens the %s preset', async (id, label) => {
  const result = showNewProjectDialog(document, { startup: false, recent: [] });
  const item = [...document.querySelectorAll('.np-item')].find(el => el.textContent === label)!;
  expect(item.querySelector('svg')).not.toBeNull();
  mouse(item, 'mousedown');
  mouse(item, 'dblclick');
  expect((await result).choice).toEqual({ kind: 'new', template: id });
});

test('every project type makes a project that is valid VB', () => {
  for (const t of TEMPLATES) {
    const p = projectFromTemplate(t.id, 'Option Explicit\n');
    expect(p.forms.length, t.id).toBeGreaterThan(0);
    for (const m of [...p.forms, ...p.modules]) expect(findSyntaxErrors(m.code, m.name), `${t.id} ${m.name}`).toEqual([]);
  }
  const mdi = projectFromTemplate('mdi');
  expect(mdi.forms.map(f => [f.name, !!f.mdi, f.props.MDIChild === true])).toEqual([['MDIForm1', true, false], ['Form1', false, true]]);
  expect(mdi.startupForm).toBe('MDIForm1');
  const main = projectFromTemplate('subMain');
  expect(main.subMain).toBe(true);
  expect(main.modules[0].code).toContain('Sub Main()');
  const data = projectFromTemplate('data');
  const [grid, ctl] = data.forms[0].controls;
  expect([grid.type, ctl.type, grid.props.DataSource]).toEqual(['DataGrid', 'Data', ctl.name]);
  expect(data.components).toEqual(['MSDATGRD.OCX']);
  expect(projectFromTemplate('standard').forms[0].code).toBe('');
});

test('the recent list: newest first, one entry per project (any case), at most MAX_RECENT; names and folders', () => {
  let l: string[] = [];
  for (let i = 0; i < 10; i++) l = withRecent(l, `C:\\P\\P${i}.vbb`);
  expect(l.length).toBe(MAX_RECENT);
  expect(l[0]).toBe('C:\\P\\P9.vbb');
  expect(withRecent(l, 'c:\\p\\p5.VBB')).toEqual(['c:\\p\\p5.VBB', ...l.filter(p => p !== 'C:\\P\\P5.vbb')]);
  expect(projectLabel('C:\\Kalk\\Kalk.vbb')).toBe('Kalk');
  expect(projectLabel('/Users/a/Old.VBP')).toBe('Old');
  expect(projectFolder('C:\\Kalk\\Kalk.vbb')).toBe('C:\\Kalk');
});

test('RecentProjects keeps the list in the settings; Open and Save add to it; a project that cannot be read leaves it', async () => {
  const saved: Record<string, unknown> = { recent: ['/x/Old.vbb', 42] };
  const store = { loadSettings: vi.fn(async (k: string) => saved[k] ?? null), saveSettings: vi.fn(async (k: string, v: unknown) => { saved[k] = v; }) };
  const recent = new RecentProjects(store as unknown as Backend);
  await recent.ready();
  expect(recent.list).toEqual(['/x/Old.vbb']);

  const ide = new IdeState();
  const backend = {
    openProjectDialog: vi.fn(async () => '/x/Saved.vbb'), saveProjectDialog: vi.fn(async () => '/x/New.vbb'),
    readTextFile: vi.fn(async (p: string) => { if (p.includes('Gone')) throw new Error('not found'); return serializeProject({ ...newProject(), name: 'Saved' }); }),
    writeTextFile: vi.fn(async () => {}), setWindowTitle: vi.fn(async () => {}),
  };
  const fc = new FileController(ide, backend as unknown as Backend, document, recent);
  await fc.open();
  expect(recent.list).toEqual(['/x/Saved.vbb', '/x/Old.vbb']);
  await fc.saveAs();
  expect(saved.recent).toEqual(['/x/New.vbb', '/x/Saved.vbb', '/x/Old.vbb']);
  await fc.open('/x/Old.vbb');   // the Recent list opens a path without the file dialog
  expect(backend.openProjectDialog).toHaveBeenCalledTimes(1);
  expect(recent.list[0]).toBe('/x/Old.vbb');

  recent.add('/x/Gone.vbb');
  const p = fc.open('/x/Gone.vbb'); await flush();
  expect(document.querySelector('.dlg98')!.textContent).toContain('not found');
  press('OK'); await p;
  expect(recent.list).not.toContain('/x/Gone.vbb');
});

test('FileController.newProject makes the chosen type (Option Explicit when the option is on)', async () => {
  const ide = new IdeState();
  ide.setOptions({ requireVariableDeclaration: true });
  const fc = new FileController(ide, { setWindowTitle: async () => {} } as unknown as Backend, document);
  expect(await fc.newProject('mdi')).toBe(true);
  expect(ide.project.forms.map(f => f.name)).toEqual(['MDIForm1', 'Form1']);
  expect(ide.project.forms[1].code.startsWith('Option Explicit')).toBe(true);
});

test('recent projects opened before settings load are merged without resurrecting removed entries', async () => {
  let resolve!: (value: unknown) => void;
  let persisted: unknown;
  const loading = new Promise<unknown>(r => { resolve = r; });
  const recent = new RecentProjects({
    loadSettings: async <T>() => await loading as T | null,
    saveSettings: async (_key, value) => { persisted = value; },
  } as Pick<Backend, 'loadSettings' | 'saveSettings'>);
  recent.add('/x/New.vbb');
  recent.remove('/x/Gone.vbb');
  resolve(['/x/Gone.vbb', '/x/Old.vbb']);
  await recent.ready();
  await flush();
  expect(recent.list).toEqual(['/x/New.vbb', '/x/Old.vbb']);
  expect(persisted).toEqual(['/x/New.vbb', '/x/Old.vbb']);
});

test('recent project writes finish in order even when the settings backend is slow', async () => {
  let finish!: () => void;
  let persisted: unknown;
  let writes = 0;
  const recent = new RecentProjects({
    loadSettings: async () => [],
    saveSettings: async (_key, value) => {
      if (++writes === 1) await new Promise<void>(r => { finish = r; });
      persisted = value;
    },
  } as Pick<Backend, 'loadSettings' | 'saveSettings'>);
  await recent.ready();
  recent.add('/x/First.vbb');
  await flush();
  recent.add('/x/Second.vbb');
  await flush();
  finish();
  await flush();
  expect(persisted).toEqual(['/x/Second.vbb', '/x/First.vbb']);
});

test('the dialog at start: New picks a type (click, arrows, double click opens), Existing, Recent, and "Don\'t show"', async () => {
  let r = showNewProjectDialog(document, { startup: true, recent: ['C:\\Kalk\\Kalk.vbb', 'D:\\Old\\Old.vbp'] });
  expect([...document.querySelectorAll('.dlg98 .tabs98-tab')].map(t => t.textContent)).toEqual(['New', 'Existing', 'Recent']);
  expect([...document.querySelectorAll('.np-item span')].map(s => s.textContent)).toEqual(TEMPLATES.map(t => t.label));
  expect(document.querySelector('.np-item.sel')!.textContent).toBe('Standard EXE');
  mouse(document.querySelectorAll('.np-item')[3], 'mousedown');
  expect(document.querySelector('.np-desc')!.textContent).toContain('Data control');
  document.querySelector('.np-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(document.querySelector('.np-item.sel')!.textContent).toBe('AI Wizard');
  mouse(document.querySelectorAll('.np-item')[1], 'mousedown');
  mouse(document.querySelectorAll('.np-item')[1], 'dblclick');
  expect(await r).toEqual({ choice: { kind: 'new', template: 'mdi' }, dontShow: false });

  r = showNewProjectDialog(document, { startup: true, recent: ['C:\\Kalk\\Kalk.vbb', 'D:\\Old\\Old.vbp'] });
  tab('Recent');
  expect([...document.querySelectorAll('.np-row .np-name')].map(e => e.textContent)).toEqual(['Kalk', 'Old']);
  mouse(document.querySelectorAll('.np-row')[1], 'mousedown');
  const dont = document.querySelector<HTMLInputElement>('.np-dont input')!;
  dont.checked = true; dont.dispatchEvent(new Event('change'));
  press('Open');
  expect(await r).toEqual({ choice: { kind: 'recent', path: 'D:\\Old\\Old.vbp' }, dontShow: true });

  r = showNewProjectDialog(document, { startup: true, recent: [] });
  tab('Existing');
  press('Browse...');
  expect(await r).toEqual({ choice: { kind: 'existing' }, dontShow: false });

  r = showNewProjectDialog(document, { startup: true, recent: [] });
  tab('Recent');
  expect(document.querySelector('.np-empty')).not.toBeNull();
  press('Cancel');
  expect((await r).choice).toBeNull();
});

test('File > New Project: the New tab only, no "Don\'t show"; Help explains and comes back to the dialog as it was', async () => {
  const r = showNewProjectDialog(document, { startup: false, recent: ['C:\\Kalk\\Kalk.vbb'] });
  expect([...document.querySelectorAll('.dlg98 .tabs98-tab')].map(t => t.textContent)).toEqual(['New']);
  expect(document.querySelector('.np-dont')).toBeNull();
  mouse(document.querySelectorAll('.np-item')[2], 'mousedown');
  press('Help'); await flush();
  expect(document.querySelector('.dlg98')!.textContent).toContain('Tools > Options > General');
  press('OK'); await flush(); await flush();
  expect(document.querySelector('.np-item.sel')!.textContent).toBe('Sub Main');
  press('Open');
  expect((await r).choice).toEqual({ kind: 'new', template: 'subMain' });
});

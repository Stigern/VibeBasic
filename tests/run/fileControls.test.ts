// @vitest-environment jsdom
import { afterEach, beforeEach, expect, onTestFinished, test } from 'vitest';
import type { Backend, DirListing, Volume } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { dirListItem, filterFiles, findVolume, normalizePath, patternMatcher, resolvePath } from '../../src/run/objects/fileControls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

// --- helpers ---

const f = (name: string): { name: string; hidden: boolean } => ({ name, hidden: name.startsWith('.') });
const TREE: Record<string, DirListing> = {
  '/': { dirs: ['Users', 'Volumes'], files: [] },
  '/Users': { dirs: ['alice'], files: [f('readme.md')] },
  '/Users/alice': { dirs: ['.cache', 'docs'], files: ['a.txt', 'b.bas', 'c.txt', '.hidden.txt', 'notes.doc'].map(f) },
  '/Users/alice/docs': { dirs: [], files: [f('plan.txt')] },
  '/Volumes': { dirs: ['Data'], files: [] },
  '/Volumes/Data': { dirs: [], files: [f('d.txt')] },
};
const VOLUMES: Volume[] = [{ name: 'Macintosh HD', path: '/' }, { name: 'Data', path: '/Volumes/Data' }];
const backend = (): Pick<Backend, 'listVolumes' | 'listDir'> => ({
  listVolumes: async () => VOLUMES,
  listDir: async p => { const l = TREE[p]; if (!l) throw new Error(`${p}: No such file or directory`); return l; },
});

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));
/** The run session sends patches at the latest 16 ms after they were queued. */
const flush = async () => { for (let i = 0; i < 10; i++) await tick(); await new Promise(r => setTimeout(r, 40)); };

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][]) {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container, backend() as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/Users/alice',
  }, 'ide');
  await session.start();
  await flush();
  const el = (name: string) => container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls.find(c => c.name === name)!.id}"]`)!;
  return { out, el };
}
const ALL: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][] = [['DriveListBox', 'Drive1'], ['DirListBox', 'Dir1'], ['FileListBox', 'File1']];

// --- helpers without a window ---

test('patterns: several separated by ";", not case sensitive, "*.*" is every file', () => {
  const m = patternMatcher('*.txt;*.BAS');
  expect(['a.txt', 'b.bas', 'c.doc', 'd.txt.bak', 'E.TXT'].filter(m)).toEqual(['a.txt', 'b.bas', 'E.TXT']);
  expect(['a', 'b.c'].filter(patternMatcher('*.*'))).toEqual(['a', 'b.c']);
  expect(['a1.x', 'ab.x', 'a12.x'].filter(patternMatcher('a?.x'))).toEqual(['a1.x', 'ab.x']);
  expect(['x'].filter(patternMatcher(''))).toEqual(['x']);
});

test('Hidden shows the hidden files, Normal and Archive the ordinary ones', () => {
  const files = ['a.txt', '.b.txt'].map(f);
  const o = { pattern: '*.*', hidden: false, normal: true, archive: true };
  expect(filterFiles(files, o)).toEqual(['a.txt']);
  expect(filterFiles(files, { ...o, hidden: true })).toEqual(['a.txt', '.b.txt']);
  expect(filterFiles(files, { ...o, normal: false })).toEqual(['a.txt']);   // Archive alone is the same as Normal
  expect(filterFiles(files, { ...o, normal: false, archive: false })).toEqual([]);
  expect(filterFiles(files, { ...o, normal: false, archive: false, hidden: true })).toEqual(['.b.txt']);
});

test('paths: resolving, volumes, the folder list', () => {
  expect(normalizePath('/a//b/')).toBe('/a/b');
  expect(resolvePath('/a/b', '..')).toBe('/a');
  expect(resolvePath('/a/b', 'c/./d')).toBe('/a/b/c/d');
  expect(resolvePath('/a/b', '/x/')).toBe('/x');
  expect(findVolume(VOLUMES, '/Volumes/Data')?.path).toBe('/Volumes/Data');
  expect(findVolume(VOLUMES, 'data')?.path).toBe('/Volumes/Data');
  expect(findVolume(VOLUMES, '/Volumes/Data/x/y')?.path).toBe('/Volumes/Data');
  expect(findVolume(VOLUMES, '/Users')?.path).toBe('/');
  expect(findVolume(VOLUMES, 'nope')).toBeUndefined();
  const subs = ['/a/b/x', '/a/b/y'];
  expect([dirListItem('/a/b', subs, 1), dirListItem('/a/b', subs, -1), dirListItem('/a/b', subs, -2), dirListItem('/a/b', subs, -3), dirListItem('/a/b', subs, -4)])
    .toEqual(['/a/b/y', '/a/b', '/a', '/', undefined]);
});

// --- a whole program ---

test('the typical VB6 coupling: Drive1_Change -> Dir1.Path = Drive1.Drive, Dir1_Change -> File1.Path = Dir1.Path', async () => {
  const r = await run([
    'Private Sub Drive1_Change()', '  Debug.Print "drive;"', '  Dir1.Path = Drive1.Drive', 'End Sub', '',
    'Private Sub Dir1_Change()', '  Debug.Print "dir;"', '  File1.Path = Dir1.Path', 'End Sub', '',
    'Private Sub File1_PathChange()', '  Debug.Print "file;"', 'End Sub', '',
    'Private Sub Form_Load()',
    '  Debug.Print Drive1.Drive; ","; Dir1.Path; ","; File1.Path; ","; Dir1.ListCount; ","; File1.ListCount',
    '  Drive1.Drive = "/Volumes/Data"',
    '  Debug.Print Dir1.Path; ","; File1.Path; ","; File1.ListCount; ","; File1.List(0); ","; Dir1.ListCount',
    '  Debug.Print "["; File1.FileName; "]"',
    'End Sub',
  ].join('\n'), ALL);
  expect(r.out).toEqual(['/,/Users/alice,/Users/alice, 1 , 4 ', 'drive;', 'dir;', 'file;', '/Volumes/Data,/Volumes/Data, 1 ,d.txt, 0 ', '[]']);
});

test('Pattern with several patterns, Hidden, PatternChange; FileName, List(i) and ListCount', async () => {
  const r = await run([
    'Private Sub File1_PatternChange()', '  Debug.Print "pc;"', 'End Sub', '',
    'Private Sub Form_Load()',
    '  Dim i As Integer, s As String',
    '  File1.Pattern = "*.txt;*.bas"',
    '  For i = 0 To File1.ListCount - 1: s = s & File1.List(i) & " ": Next',
    '  Debug.Print s',
    '  File1.Hidden = True',
    '  Debug.Print File1.ListCount; File1.List(0)',
    '  File1.FileName = "b.bas"',
    '  Debug.Print File1.ListIndex; File1.FileName; File1.Pattern',
    '  On Error Resume Next',
    '  Debug.Print File1.List(9)',
    '  Debug.Print Err.Number',
    'End Sub',
  ].join('\n'), ALL);
  expect(r.out).toEqual(['pc;', 'a.txt b.bas c.txt ', ' 4 a.txt', ' 1 b.bas*.txt;*.bas', ' 381 ']);
});

test('DirListBox: List(i) of the sub-folders, -1 the current folder, -2 its parent; hidden folders are left out', async () => {
  const r = await run([
    'Private Sub Form_Load()',
    '  Dir1.Path = "/Users/alice"',
    '  Debug.Print Dir1.ListCount; Dir1.List(0); Dir1.List(-1); Dir1.List(-2); Dir1.List(-3)',
    '  Dir1.Path = ".."',
    '  Debug.Print Dir1.Path; Dir1.ListCount; Dir1.List(0)',
    'End Sub',
  ].join('\n'), ALL);
  expect(r.out).toEqual([' 1 /Users/alice/docs/Users/alice/Users/', '/Users 1 /Users/alice']);
});

test('an unknown drive gives 68 once the volumes are known; a drive name works', async () => {
  const r = await run([
    'Private Sub Form_Load()',
    '  DoEvents: DoEvents',
    '  On Error Resume Next',
    '  Drive1.Drive = "nope"',
    '  Debug.Print Err.Number; Drive1.Drive',
    '  Drive1.Drive = "data"',
    '  Debug.Print Drive1.Drive',
    'End Sub',
  ].join('\n'), ALL);
  expect(r.out).toEqual([' 68 /', '/Volumes/Data']);
});

// --- the window ---

const click = async (el: Element) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); };
const dblclick = async (el: Element) => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await flush(); };

test('the user: pick a drive, double-click a folder, click a file raise Change, Change and Click and fill the lists', async () => {
  const r = await run([
    'Private Sub Drive1_Change()', '  Debug.Print "drive:" & Drive1.Drive', '  Dir1.Path = Drive1.Drive', 'End Sub', '',
    'Private Sub Dir1_Change()', '  Debug.Print "dir:" & Dir1.Path', '  File1.Path = Dir1.Path', 'End Sub', '',
    'Private Sub Dir1_Click()', '  Debug.Print "dirclick:" & Dir1.ListIndex', 'End Sub', '',
    'Private Sub File1_Click()', '  Debug.Print "file:" & File1.FileName', 'End Sub',
  ].join('\n'), ALL);
  const texts = (name: string, sel: string) => [...r.el(name).querySelectorAll(sel)].map(e => e.textContent);
  expect(texts('Dir1', '.dir-text')).toEqual(['/', 'Users', 'alice', 'docs']);
  expect(texts('File1', 'option')).toEqual(['a.txt', 'b.bas', 'c.txt', 'notes.doc']);
  expect(texts('Drive1', '.vb-item')).toEqual(['/ [Macintosh HD]', '/Volumes/Data']);

  const row = (i: number) => r.el('Dir1').querySelectorAll('.dir-row')[i];
  await click(row(3));   // docs: a click first (the list is painted again), then the double click on the new row
  await dblclick(row(3));
  expect(r.out).toEqual(['dirclick:0', 'dir:/Users/alice/docs']);
  expect(texts('Dir1', '.dir-text')).toEqual(['/', 'Users', 'alice', 'docs']);
  expect(texts('File1', 'option')).toEqual(['plan.txt']);

  const file = r.el('File1').querySelector('select')!;
  file.selectedIndex = 0;
  file.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(r.out.at(-1)).toBe('file:plan.txt');

  r.el('Drive1').querySelectorAll('.vb-item')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await flush();
  expect(r.out.slice(-2)).toEqual(['drive:/Volumes/Data', 'dir:/Volumes/Data']);
  expect(texts('File1', 'option')).toEqual(['d.txt']);
  expect(texts('Dir1', '.dir-text')).toEqual(['/', 'Volumes', 'Data']);

  await click(row(1));   // the folder above: ListIndex -2
  expect(r.out.at(-1)).toBe('dirclick:-2');
});

test('a double click opens a folder although the webview fires no dblclick (Chromium, when the click repainted the rows)', async () => {
  const r = await run(['Private Sub Dir1_Change()', '  Debug.Print "dir:" & Dir1.Path', 'End Sub'].join('\n'), ALL);
  const row = (i: number) => r.el('Dir1').querySelectorAll('.dir-row')[i];
  const press = (el: Element, detail: number) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  // jsdom has no layout: the row under the pointer is the one at the index pressed last (each click repaints the rows)
  let under = 3;
  const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
  doc.elementFromPoint = () => row(under);
  onTestFinished(() => { delete doc.elementFromPoint; });
  press(row(3), 1);
  await flush();
  press(row(3), 2);   // WebView2: the second click (detail 2) on the new row, and no dblclick
  await flush();
  expect(r.out).toEqual(['dir:/Users/alice/docs']);

  under = 0;
  press(row(0), 1);
  await flush();
  press(row(0), 2);
  row(0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));   // WebKit: the dblclick comes too, and counts once
  await flush();
  expect(r.out).toEqual(['dir:/Users/alice/docs', 'dir:/']);
});

test('Path of a folder that does not exist is error 76; Path and the list stay as they were', async () => {
  const r = await run([
    'Private Sub Form_Load()',
    '  On Error Resume Next',
    '  Dir1.Path = "/Users/nobody"',
    '  Debug.Print Err.Number; Dir1.Path; Dir1.ListCount',
    '  Err.Clear',
    '  File1.Path = "/nope"',
    '  Debug.Print Err.Number; File1.Path',
    'End Sub',
  ].join('\n'), ALL);
  expect(r.out).toEqual([' 76 /Users/alice 1 ', ' 76 /Users/alice']);
});

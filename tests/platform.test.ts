// @vitest-environment jsdom
// Windows and Linux: the platform value, the Ctrl key, Windows paths, the DriveListBox's drives and what Make makes.
import { afterEach, describe, expect, test } from 'vitest';
import type { Backend, DirListing, Volume } from '../src/backend/backend';
import { dialogFilters } from '../src/backend/dialogFilters';
import { applyPlatform } from '../src/boot';
import { appNameOf, appTarget } from '../src/build/appTarget';
import { sanitizeAppFileName } from '../src/build/makeApp';
import type { TypeSource } from '../src/lang/fileio/binary';
import { FileIO } from '../src/lang/fileio/fileIO';
import type { FileSystemApi } from '../src/lang/fileio/fsApi';
import { winChain, winDirOf, winIsRoot, winNormalize, winParent, winResolve } from '../src/lang/fileio/winPath';
import { newControl, newForm, newProject } from '../src/model/controls';
import { shortcutMatches as vbShortcutMatches, shortcutValue } from '../src/model/menuShortcuts';
import type { ControlType, PropValue } from '../src/model/types';
import { ctrlLike, guessPlatform, platform, setPlatform, winPaths, type Platform } from '../src/platform';
import { multiFileName } from '../src/run/commonDialog';
import { InlineFormHost } from '../src/run/inlineFormHost';
import { findVolume, normalizePath, resolvePath, winDriveText } from '../src/run/objects/fileControls';
import { RunSession } from '../src/run/session';
import { parseShortcut, shortcutMatches } from '../src/ui98/menubar';

const on = (p: Platform) => setPlatform(p);
afterEach(() => setPlatform('mac', false));

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => new KeyboardEvent('keydown', { key: k, ...mods });

test('the platform a user agent names', () => {
  expect(guessPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120')).toBe('windows');
  expect(guessPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).toBe('linux');
  expect(guessPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('mac');
  expect(guessPlatform('Mozilla/5.0 (Linux; Android 14)')).toBe('mac');
  on('windows');
  expect(winPaths()).toBe(true);
  setPlatform('windows', false);   // the browser version: its files stay POSIX paths
  expect(winPaths()).toBe(false);
});

test('the main window takes the platform from the backend; the guess stays when it fails', async () => {
  await applyPlatform({ kind: 'tauri', platform: async () => 'windows' } as unknown as Backend);
  expect([platform(), winPaths()]).toEqual(['windows', true]);
  await applyPlatform({ kind: 'browser', platform: async () => 'windows' } as unknown as Backend);
  expect([platform(), winPaths()]).toEqual(['windows', false]);
  setPlatform('linux');
  await applyPlatform({ kind: 'tauri', platform: () => Promise.reject(new Error('no')) } as unknown as Backend);
  expect(platform()).toBe('linux');
});

describe('Ctrl: Cmd on a Mac, only Ctrl on Windows and Linux', () => {
  test('IDE menus', () => {
    const cut = parseShortcut('Ctrl+X'), brk = parseShortcut('Ctrl+Break'), del = parseShortcut('Del');
    expect(shortcutMatches(cut, key('x', { metaKey: true }))).toBe(true);
    expect(shortcutMatches(cut, key('x', { ctrlKey: true }))).toBe(true);
    expect(shortcutMatches(brk, key('.', { metaKey: true }))).toBe(true);
    expect(shortcutMatches(del, key('Backspace'), true)).toBe(true);
    for (const p of ['windows', 'linux'] as const) {
      on(p);
      expect(shortcutMatches(cut, key('x', { ctrlKey: true }))).toBe(true);
      expect(shortcutMatches(cut, key('x', { metaKey: true }))).toBe(false);   // the Windows key is not Ctrl
      expect(shortcutMatches(brk, key('Pause', { ctrlKey: true }))).toBe(true);
      expect(shortcutMatches(brk, key('.', { ctrlKey: true }))).toBe(false);
      expect(shortcutMatches(del, key('Backspace'), true)).toBe(false);
      expect(shortcutMatches(del, key('Delete'), true)).toBe(true);
    }
  });

  test('a running form\'s menu Shortcut and ctrlLike', () => {
    const ctrlS = shortcutValue('Ctrl+S')!;
    const e = (m: Partial<KeyboardEventInit>) => ({ key: 's', code: 'KeyS', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
    expect(vbShortcutMatches(ctrlS, e({ metaKey: true }))).toBe(true);
    expect(ctrlLike({ ctrlKey: false, metaKey: true })).toBe(true);
    on('windows');
    expect(vbShortcutMatches(ctrlS, e({ metaKey: true }))).toBe(false);
    expect(vbShortcutMatches(ctrlS, e({ ctrlKey: true }))).toBe(true);
    expect(ctrlLike({ ctrlKey: false, metaKey: true })).toBe(false);
  });
});

describe('Windows paths', () => {
  test('resolving, roots, parents', () => {
    expect(winNormalize('c:/a//b\\.\\..\\c\\')).toBe('C:\\a\\c');
    expect(winResolve('C:\\Proj', 'data\\x.txt')).toBe('C:\\Proj\\data\\x.txt');
    expect(winResolve('C:\\Proj\\sub', '..\\..\\..\\x')).toBe('C:\\x');
    expect(winResolve('C:\\Proj', '\\Temp')).toBe('C:\\Temp');
    expect(winResolve('C:\\Proj', 'D:\\Data/y.dat')).toBe('D:\\Data\\y.dat');
    expect(winResolve('C:\\Proj', 'd:y.dat')).toBe('D:\\y.dat');
    expect(winResolve('C:\\Proj', 'D:y.dat', () => 'D:\\Work')).toBe('D:\\Work\\y.dat');
    expect(winResolve('C:\\Proj', 'c:y.dat')).toBe('C:\\Proj\\y.dat');
    expect(winResolve('C:\\Proj', '\\\\srv\\share\\a\\..\\b')).toBe('\\\\srv\\share\\b');
    expect(winIsRoot('c:')).toBe(true);
    expect(winIsRoot('\\\\srv\\share')).toBe(true);
    expect(winParent('C:\\a')).toBe('C:\\');
    expect(winParent('C:\\')).toBe('C:\\');
    expect(winChain('C:\\a\\b')).toEqual(['C:\\', 'C:\\a', 'C:\\a\\b']);
    expect(winDirOf('C:\\Proj\\Kalk.vbb')).toBe('C:\\Proj');
    expect(winDirOf('C:\\Kalk.vbb')).toBe('C:\\');
  });

  const types = {} as TypeSource;
  const DIRS = new Set(['C:\\', 'C:\\Proj', 'C:\\Proj\\sub', 'D:\\', 'D:\\Work']);
  const fs = { fsStat: async (p: string) => (DIRS.has(p) ? { isDir: true, size: 0, mtime: 0, readOnly: false, hidden: false } : null) } as unknown as FileSystemApi;

  test('FileIO: CurDir, ChDir and ChDrive on Windows', async () => {
    on('windows');
    const io = new FileIO(() => fs, 'C:\\Proj', types);
    expect(io.curDir).toBe('C:\\Proj');
    expect(io.resolve('a.txt')).toBe('C:\\Proj\\a.txt');
    expect(io.resolve('/x/y.txt')).toBe('C:\\x\\y.txt');
    await io.chDir('sub');
    expect(io.curDir).toBe('C:\\Proj\\sub');
    expect(io.curDirOf('D')).toBe('D:\\');         // CurDir("D"): a drive not visited yet is at its root
    await io.chDir('D:\\Work');                   // another drive: its folder changes, the current drive stays
    expect(io.curDir).toBe('C:\\Proj\\sub');
    expect(io.curDirOf('d')).toBe('D:\\Work');
    expect(io.curDirOf('c:')).toBe('C:\\Proj\\sub');
    expect(() => io.curDirOf('1')).toThrow(expect.objectContaining({ number: 68 }));
    expect(io.resolve('D:z.txt')).toBe('D:\\Work\\z.txt');
    await io.chDrive('d: [Data]');
    expect(io.curDir).toBe('D:\\Work');
    await io.chDrive('C');
    expect(io.curDir).toBe('C:\\Proj\\sub');
    await expect(io.chDrive('Q')).rejects.toMatchObject({ number: 68 });
    await expect(io.chDrive('')).rejects.toMatchObject({ number: 5 });
  });

  test('FileIO on a Mac: "\\" is "/" and the drive letter is dropped, ChDrive does nothing', async () => {
    const io = new FileIO(() => fs, '/Users/alice', types);
    expect(io.resolve('C:\\Temp\\a.txt')).toBe('/Temp/a.txt');
    expect(io.resolve('sub\\b.txt')).toBe('/Users/alice/sub/b.txt');
    await io.chDrive('D');
    expect(io.curDir).toBe('/Users/alice');
  });

  test('file controls and CommonDialog', () => {
    on('windows');
    expect(normalizePath('/')).toBe('C:\\');
    expect(resolvePath('C:\\Proj', '..')).toBe('C:\\');
    expect(resolvePath('C:\\Proj', 'd: [Data]')).toBe('D:\\');
    expect(multiFileName(['C:\\Docs\\a.txt', 'C:\\Docs\\b.txt'], true)).toBe('C:\\Docs\0a.txt\0b.txt');
    expect(multiFileName(['C:\\a.txt', 'C:\\b.txt'], false)).toBe('C:\\ a.txt b.txt');
  });
});

describe('DriveListBox on Windows', () => {
  test('a drive as VB6 shows it: "c: [label]"', () => {
    expect(winDriveText({ name: 'System', path: 'C:\\' })).toBe('c: [System]');
    expect(winDriveText({ name: 'C: [System]', path: 'C:\\' })).toBe('c: [System]');
    expect(winDriveText({ name: 'D:\\', path: 'D:\\' })).toBe('d:');
    expect(winDriveText({ name: '', path: 'E:\\' })).toBe('e:');
    expect(winDriveText({ name: '\\\\srv\\share', path: 'Z:\\' })).toBe('z: [\\\\srv\\share]');
    on('windows');
    const vols: Volume[] = [{ name: 'System', path: 'C:\\' }, { name: 'Data', path: 'D:\\' }];
    expect(findVolume(vols, 'd')?.path).toBe('D:\\');
    expect(findVolume(vols, 'D:\\Temp')?.path).toBe('D:\\');
    expect(findVolume(vols, 'c: [System]')?.path).toBe('C:\\');
    expect(findVolume(vols, 'x:')).toBeUndefined();
  });

  test('a running DriveListBox / DirListBox pair', async () => {
    on('windows');
    const TREE: Record<string, DirListing> = {
      'C:\\': { dirs: ['Users'], files: [] }, 'C:\\Users': { dirs: ['alice'], files: [] },
      'C:\\Users\\alice': { dirs: ['docs'], files: [] }, 'D:\\': { dirs: ['Work'], files: [] },
    };
    const backend = {
      listVolumes: async (): Promise<Volume[]> => [{ name: 'System', path: 'C:\\' }, { name: 'Data', path: 'D:\\' }],
      listDir: async (p: string) => { const l = TREE[p]; if (!l) throw new Error(`${p}: not found`); return l; },
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const p = newProject();
    p.forms = [newForm('Form1', [
      'Private Sub Form_Click()',
      '  Debug.Print Drive1.Drive; "|"; Dir1.Path; "|"; Dir1.List(0); "|"; Dir1.List(-2)',
      '  Drive1.Drive = "D:\\Work"',
      'End Sub',
      'Private Sub Drive1_Change()', '  Dir1.Path = Drive1.Drive', '  Debug.Print "->"; Drive1.Drive; "|"; Dir1.Path', 'End Sub',
    ].join('\n'))];
    p.startupForm = 'Form1';
    for (const [type, name] of [['DriveListBox', 'Drive1'], ['DirListBox', 'Dir1']] as [Exclude<ControlType, 'Form'>, string][]) {
      const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
      c.name = name;
      p.forms[0].controls.push(c);
    }
    const out: string[] = [];
    const session = new RunSession(p, new InlineFormHost(container, backend as unknown as Backend), {
      debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
      readFile: async () => { throw new Error('ENOENT'); }, appPath: 'C:\\Users\\alice',
    }, 'ide');
    const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 40)); };
    try {
      await session.start();
      await flush();
      const drive = container.querySelector<HTMLElement>(`[data-control-id="${p.forms[0].controls[0].id}"]`)!;
      expect([...drive.querySelectorAll('.vb-item')].map(e => e.textContent)).toEqual(['c: [System]', 'd: [Data]']);
      container.querySelector<HTMLElement>('.vb-form-client')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      expect(out.join('')).toContain('c: [System]|C:\\Users\\alice|C:\\Users\\alice\\docs|C:\\Users');
      expect(out.join('')).toContain('->d: [Data]|D:\\');
    } finally {
      session.end();
      container.remove();
    }
  });

  test('Form_Load reads Drive, List, ListCount and ListIndex before the drives have come (it waits for them); ListIndex picks one', async () => {
    on('windows');
    const backend = {
      listVolumes: () => new Promise<Volume[]>(r => setTimeout(() => r([{ name: 'System', path: 'C:\\' }, { name: 'Data', path: 'D:\\' }]), 30)),
      listDir: async () => ({ dirs: [], files: [] }),
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const p = newProject();
    p.forms = [newForm('Form1', [
      'Private Sub Form_Load()',
      '  Debug.Print Drive1.Drive; "|"; Drive1.ListCount; "|"; Drive1.List(1); "|"; Drive1.ListIndex',
      '  Drive1.ListIndex = 1',
      '  Debug.Print Drive1.Drive; "|"; Drive1.ListIndex',
      '  On Error Resume Next',
      '  Drive1.ListIndex = 2',
      '  Debug.Print "err"; Err.Number',
      'End Sub',
      'Private Sub Drive1_Change()', '  Debug.Print "change:"; Drive1.Drive', 'End Sub',
    ].join('\n'))];
    p.startupForm = 'Form1';
    const c = newControl(p.forms[0], 'DriveListBox', { left: 120, top: 120 }, null);
    c.name = 'Drive1';
    p.forms[0].controls.push(c);
    const out: string[] = [];
    const session = new RunSession(p, new InlineFormHost(container, backend as unknown as Backend), {
      debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
      readFile: async () => { throw new Error('ENOENT'); }, appPath: 'C:\\Users\\alice',
    }, 'ide');
    try {
      await session.start();
      for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 20));
      expect(out.map(s => s.trim()))
        .toEqual(['c: [System]| 2 |d: [Data]| 0', 'change:d: [Data]', 'd: [Data]| 1', 'err 380']);
    } finally {
      session.end();
      container.remove();
    }
  });
});

describe('Make', () => {
  test('the target per platform', () => {
    expect(appTarget('mac')).toEqual({ ext: '.app', filters: [{ name: 'Application', extensions: ['app'] }] });
    expect(appTarget('windows')).toEqual({ ext: '.exe', filters: [{ name: 'Application', extensions: ['exe'] }] });
    expect(appTarget('linux')).toEqual({ ext: '', filters: [] });
    expect(appNameOf('Kalk.app', 'mac')).toBe('Kalk');
    expect(appNameOf('Kalk.EXE', 'windows')).toBe('Kalk');
    expect(appNameOf('Kalk.app', 'windows')).toBe('Kalk.app');
    expect(appNameOf('kalk', 'linux')).toBe('kalk');
  });

  test('the file name: Windows also drops \\ * ? " < > | and trailing dots', () => {
    expect(sanitizeAppFileName('A*B?.', 'mac')).toBe('A*B?.');
    expect(sanitizeAppFileName('A*B?<x>|"\\y. ', 'windows')).toBe('ABxy');
    // device names (also before a dot), as make_app.rs
    expect(sanitizeAppFileName('CON', 'windows')).toBe('CON_');
    expect(sanitizeAppFileName('con.backup', 'windows')).toBe('con_.backup');
    expect(sanitizeAppFileName('Com3 ', 'windows')).toBe('Com3_');
    expect(sanitizeAppFileName('lpt9.x', 'windows')).toBe('lpt9_.x');
    expect(sanitizeAppFileName('Console', 'windows')).toBe('Console');
    expect(sanitizeAppFileName('COM0', 'windows')).toBe('COM0');
    expect(sanitizeAppFileName('CON', 'mac')).toBe('CON');
  });

  test('dialog filters: Windows and Linux keep "All files" as a choice of its own', () => {
    const f = [{ name: 'Text', extensions: ['txt'] }, { name: 'All', extensions: ['*'] }];
    expect(dialogFilters(f, 'mac')).toEqual([]);
    expect(dialogFilters(f, 'windows')).toEqual(f);
  });
});

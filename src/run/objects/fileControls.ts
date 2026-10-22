// DriveListBox, DirListBox and FileListBox: the path and pattern helpers (plain functions, no I/O).
// The listing itself comes from the backend (list_volumes / list_dir) through the form host.

import type { DirListing, Volume } from '../../backend/backend';

/** What a run-time control needs for the file controls. */
export interface FileContext {
  listVolumes(): Promise<Volume[]>;
  listDir(path: string): Promise<DirListing>;
  /** The folder a DirListBox / FileListBox starts in (VB6: the current folder). */
  defaultPath: string;
}

/** "/a//b/" -> "/a/b", "" -> "/". */
export function normalizePath(p: string): string {
  const parts = p.split('/').filter(s => s !== '');
  return '/' + parts.join('/');
}

/** An absolute path is kept; a relative one ("..", "sub") is taken from `cur`. "." and ".." are resolved. */
export function resolvePath(cur: string, p: string): string {
  const out: string[] = [];
  for (const s of (p.startsWith('/') ? p : `${cur}/${p}`).split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return '/' + out.join('/');
}

export const joinPath = (dir: string, name: string): string => (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
export const parentPath = (p: string): string => resolvePath(p, '..');

/** The volume a Drive value stands for: its path or its name, else the volume that holds the path. Undefined when there is none. */
export function findVolume(volumes: Volume[], value: string): Volume | undefined {
  const v = value.trim(), n = v.length > 1 ? v.replace(/\/+$/, '') : v;
  const lower = n.toLowerCase();
  const exact = volumes.find(x => x.path.toLowerCase() === lower || x.name.toLowerCase() === lower);
  if (exact) return exact;
  if (!n.startsWith('/')) return undefined;
  return volumes.filter(x => n === x.path || n.startsWith(x.path.replace(/\/+$/, '') + '/')).sort((a, b) => b.path.length - a.path.length)[0];
}

/** "*.txt;*.bas" -> a test on a file name; the patterns are not case sensitive, "*.*" and an empty pattern match every file. */
export function patternMatcher(pattern: string): (name: string) => boolean {
  const tests = pattern.split(';').map(s => s.trim()).filter(s => s !== '').map(pat => {
    if (pat === '*.*' || pat === '*') return () => true;
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return (name: string) => re.test(name);
  });
  return tests.length === 0 ? () => true : name => tests.some(t => t(name));
}

/** The file names FileListBox shows. Archive is the same as Normal (an ordinary file); hidden files (names starting with ".") only with Hidden. */
export function filterFiles(files: DirListing['files'], o: { pattern: string; hidden: boolean; normal: boolean; archive: boolean }): string[] {
  const match = patternMatcher(o.pattern);
  return files.filter(f => match(f.name) && (f.hidden ? o.hidden : o.normal || o.archive)).map(f => f.name);
}

/** The full paths DirListBox lists under the current folder; hidden folders are left out. */
export function subDirs(path: string, dirs: string[]): string[] {
  return dirs.filter(d => !d.startsWith('.')).map(d => joinPath(path, d));
}

/** DirListBox.List(i): i >= 0 the sub-folders, -1 the current folder, -2 its parent, and so on up to "/". Undefined when out of range. */
export function dirListItem(path: string, subs: string[], i: number): string | undefined {
  if (i >= 0) return subs[i];
  let p = path;
  for (let k = -1; k > i; k--) { if (p === '/') return undefined; p = parentPath(p); }
  return p;
}

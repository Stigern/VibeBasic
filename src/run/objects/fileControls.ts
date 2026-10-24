// DriveListBox, DirListBox and FileListBox: the path and pattern helpers (plain functions, no I/O).
// The listing itself comes from the backend (list_volumes / list_dir) through the form host.

import type { DirListing, Volume } from '../../backend/backend';
import { winChain, winIsRoot, winJoin, winNormalize, winParent, winResolve } from '../../lang/fileio/winPath';
import { winPaths } from '../../platform';

/** What a run-time control needs for the file controls. */
export interface FileContext {
  listVolumes(): Promise<Volume[]>;
  listDir(path: string): Promise<DirListing>;
  /** The folder a DirListBox / FileListBox starts in (VB6: the current folder). */
  defaultPath: string;
}

/** "/a//b/" -> "/a/b", "" -> "/" (Windows: "c:/a\b\" -> "C:\a\b", "" and "/" -> "C:\"). */
export function normalizePath(p: string): string {
  if (winPaths()) return winNormalize(p === '/' ? '' : driveText(p));
  const parts = p.split('/').filter(s => s !== '');
  return '/' + parts.join('/');
}

/** An absolute path is kept; a relative one ("..", "sub") is taken from `cur`. "." and ".." are resolved. */
export function resolvePath(cur: string, p: string): string {
  if (winPaths()) return winResolve(cur, driveText(p));
  const out: string[] = [];
  for (const s of (p.startsWith('/') ? p : `${cur}/${p}`).split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return '/' + out.join('/');
}

export const joinPath = (dir: string, name: string): string =>
  (winPaths() ? winJoin(dir, name) : (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name);
export const parentPath = (p: string): string => (winPaths() ? winParent(p) : resolvePath(p, '..'));
const isRoot = (p: string): boolean => (winPaths() ? winIsRoot(p) : p === '/');

/** Windows: a DriveListBox's Drive ("c: [System]") as a path, "c:" (the drive's current folder, which a DirListBox takes as its root). */
const driveText = (p: string): string => /^([A-Za-z]):\s*\[.*\]\s*$/.exec(p)?.[1].concat(':') ?? p;

/** Windows: a drive as VB6's DriveListBox shows it and Drive gives it: the letter in lower case and the volume label,
 *  "c: [System]" (a network drive's label is its share, "\\server\share"); "c:" without a label. The backend's name may be the
 *  label, or already "C: [label]" / "C:\". */
export function winDriveText(v: Volume): string {
  const letter = (/^([A-Za-z]):/.exec(v.path)?.[1] ?? v.path.charAt(0)).toLowerCase();
  const n = v.name.trim();
  const label = /^[A-Za-z]:\s*\[(.*)\]$/.exec(n)?.[1] ?? (/^[A-Za-z]:\\?$/.test(n) ? '' : n);
  return label ? `${letter}: [${label}]` : `${letter}:`;
}

/** The volume a Drive value stands for: its path or its name, else the volume that holds the path. Undefined when there is none. */
export function findVolume(volumes: Volume[], value: string): Volume | undefined {
  if (winPaths()) {   // VB6: the first letter names the drive ("d", "D:\Temp", "d: [Data]")
    const letter = /^([A-Za-z])(:|$)/.exec(value.trim())?.[1].toUpperCase();
    return letter ? volumes.find(x => x.path.charAt(0).toUpperCase() === letter) : undefined;
  }
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

/** The full paths DirListBox lists under the current folder; hidden folders (names starting with ".") are left out. */
export function subDirs(path: string, dirs: string[]): string[] {
  return dirs.filter(d => !d.startsWith('.')).map(d => joinPath(path, d));
}

/** DirListBox.List(i): i >= 0 the sub-folders, -1 the current folder, -2 its parent, and so on up to "/" ("C:\"). Undefined when out of range. */
export function dirListItem(path: string, subs: string[], i: number): string | undefined {
  if (i >= 0) return subs[i];
  let p = path;
  for (let k = -1; k > i; k--) { if (isRoot(p)) return undefined; p = parentPath(p); }
  return p;
}

/** The folders a DirListBox shows above and at `path`, from the root down: ["/", "/a", "/a/b"] (["C:\", "C:\a", ...] on Windows). */
export function pathChain(path: string): string[] {
  if (winPaths()) return winChain(path);
  const segs = path.split('/').filter(Boolean);
  return ['/', ...segs.map((_, i) => '/' + segs.slice(0, i + 1).join('/'))];
}

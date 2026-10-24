// Windows paths, the VB6 native way: "C:\Folder\File.txt", "\\server\share\x". Plain functions on strings; "/" is read as "\".
// A full path starts with its root: "C:\" (a drive, the letter in upper case) or "\\server\share\". A root keeps its trailing
// backslash, any other folder has none. Used instead of the POSIX helpers when winPaths() (the desktop app on Windows).

/** The root of a path and the rest after it. `drive` without `absolute` is "D:file" (relative to D's current folder);
 *  `absolute` without `drive` and `unc` is "\file" (the root of the current drive). */
interface WinParts { drive: string; unc: string; absolute: boolean; rest: string }

function parts(path: string): WinParts {
  const p = path.replace(/\//g, '\\');
  const unc = /^\\\\([^\\]+)\\([^\\]+)\\?/.exec(p);
  if (unc) return { drive: '', unc: `\\\\${unc[1]}\\${unc[2]}\\`, absolute: true, rest: p.slice(unc[0].length) };
  const d = /^([A-Za-z]):/.exec(p);
  if (d) {
    const rest = p.slice(2);
    return { drive: d[1].toUpperCase(), unc: '', absolute: rest.startsWith('\\'), rest };
  }
  return { drive: '', unc: '', absolute: p.startsWith('\\'), rest: p };
}

/** `root` + the segments of `rest`, with "." and ".." resolved ("..": never above the root) and empty segments dropped. */
function join(root: string, rest: string): string {
  const out: string[] = [];
  for (const s of rest.split('\\')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return root + out.join('\\');
}

/** The root of a full path ("C:\", "\\srv\share\"); "C:\" when it has none. */
export function winRoot(path: string): string {
  const p = parts(path);
  return p.unc || `${p.drive || 'C'}:\\`;
}

/** The drive letter of a full path (upper case), '' for a UNC path. */
export const winDrive = (path: string): string => parts(path).drive;

/** A path as a clean full path: "c:/a//b\.\..\c\" -> "C:\a\c". A path without a root is taken from "C:\". */
export function winNormalize(path: string): string {
  const p = parts(path);
  return join(p.unc || `${p.drive || 'C'}:\\`, p.rest);
}

/**
 * The full path of `path` seen from the folder `cur` (a full path): "x.txt" and "..\x" from `cur`, "\x" from the root of `cur`'s
 * drive, "D:x" from D's current folder (`driveDir`, else D's root; `cur` when it is on D), "D:\x" and "\\srv\share\x" as they are.
 */
export function winResolve(cur: string, path: string, driveDir?: (drive: string) => string | undefined): string {
  const p = parts(path), c = parts(cur);
  if (p.unc) return join(p.unc, p.rest);
  if (p.drive && p.absolute) return join(`${p.drive}:\\`, p.rest);
  if (p.drive) {
    const base = c.drive === p.drive ? winNormalize(cur) : driveDir?.(p.drive) ?? `${p.drive}:\\`;
    return join(winRoot(base), `${parts(base).rest}\\${p.rest}`);
  }
  if (p.absolute) return join(winRoot(cur), p.rest);
  return join(winRoot(cur), `${c.rest}\\${p.rest}`);
}

/** Whether a full path is a root ("C:\", "\\srv\share\"). */
export const winIsRoot = (path: string): boolean => winNormalize(path) === winRoot(path);

/** The folder a full path is in; a root is its own parent. */
export function winParent(path: string): string {
  const n = winNormalize(path), root = winRoot(n);
  if (n === root) return root;
  const i = n.lastIndexOf('\\');
  return i < root.length ? root : n.slice(0, i);
}

/** The last part of a path (both separators), '' for a root. */
export function winName(path: string): string {
  const n = winNormalize(path);
  return n === winRoot(n) ? '' : n.slice(n.lastIndexOf('\\') + 1);
}

/** `name` in the folder `dir` (a full path). */
export const winJoin = (dir: string, name: string): string => winNormalize(`${winNormalize(dir)}\\${name}`);

/** The folders from the root down to `path` itself: "C:\a\b" -> ["C:\", "C:\a", "C:\a\b"]. */
export function winChain(path: string): string[] {
  const n = winNormalize(path), root = winRoot(n);
  const segs = n.slice(root.length).split('\\').filter(Boolean);
  return [root, ...segs.map((_, i) => root + segs.slice(0, i + 1).join('\\'))];
}

/** The folder of a file path as VB6's App.Path gives it ("C:\" for a file at the root); '' when it has no folder. */
export function winDirOf(path: string): string {
  const p = path.replace(/\//g, '\\'), i = p.lastIndexOf('\\');
  if (i < 0) return '';
  return winParent(p);
}

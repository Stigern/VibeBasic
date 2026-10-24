// What File > Make makes on each platform: a .app bundle on a Mac, an .exe on Windows, a plain executable on Linux.

import type { FileFilter } from '../backend/backend';
import { platform, type Platform } from '../platform';

export interface AppTarget {
  /** The file extension with its dot ('' on Linux). */
  ext: string;
  /** The save dialog's filters (none on Linux: an executable has no extension). */
  filters: FileFilter[];
}

export function appTarget(p: Platform = platform()): AppTarget {
  if (p === 'windows') return { ext: '.exe', filters: [{ name: 'Application', extensions: ['exe'] }] };
  if (p === 'linux') return { ext: '', filters: [] };
  return { ext: '.app', filters: [{ name: 'Application', extensions: ['app'] }] };
}

/** "Hello.exe" -> "Hello" (the target's extension, any case; other names are kept). */
export function appNameOf(fileName: string, p: Platform = platform()): string {
  const { ext } = appTarget(p);
  return ext && fileName.toLowerCase().endsWith(ext) ? fileName.slice(0, -ext.length) : fileName;
}

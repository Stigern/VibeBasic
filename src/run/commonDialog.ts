// CommonDialog helpers shared by the form hosts: the VB filter string as dialog filters, and the file dialog through the backend.

import type { Backend, FileFilter } from '../backend/backend';
import { patternMatcher } from './objects/fileControls';

export interface FileDialogRequest {
  kind: 'open' | 'save';
  /** The VB filter, "Text (*.txt)|*.txt|All (*.*)|*.*". */
  filter: string;
  /** 1-based index of the filter that is selected first. */
  filterIndex: number;
  title: string;
  initDir: string;
  /** The file name in the dialog before the call (CommonDialog.FileName). */
  fileName: string;
}

/** "Text (*.txt)|*.txt|All (*.*)|*.*" -> [{ name: 'Text (*.txt)', extensions: ['txt'] }, { name: 'All (*.*)', extensions: ['*'] }]. Several patterns: "*.htm;*.html". */
export function parseVbFilter(filter: string): FileFilter[] {
  const parts = filter.split('|');
  const out: FileFilter[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const exts: string[] = [];
    for (const pat of parts[i + 1].split(';')) {
      const t = pat.trim();
      if (t === '') continue;
      const dot = t.lastIndexOf('.');
      const ext = dot < 0 ? t : t.slice(dot + 1);
      exts.push(ext === '*' || ext === '' || t === '*' ? '*' : ext);
    }
    if (exts.length) out.push({ name: parts[i].trim() || parts[i + 1].trim(), extensions: [...new Set(exts)] });
  }
  return out;
}

/** The last part of a path (both separators). */
export const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
const dirName = (path: string): string => { const m = /^(.*)[\\/][^\\/]*$/.exec(path); return m ? m[1] || '/' : ''; };

/**
 * FilterIndex after the dialog: the Mac dialog has no filter menu, so it is the filter that matches the chosen file —
 * the one selected before when it does, else the first that does ("All files" matches every file); unchanged when
 * none matches. 1-based, counting the pairs of the VB filter.
 */
export function filterIndexFor(filter: string, current: number, path: string): number {
  const parts = filter.split('|');
  const matches: boolean[] = [];
  const name = baseName(path);
  for (let i = 0; i + 1 < parts.length; i += 2) matches.push(parts[i + 1].trim() !== '' && patternMatcher(parts[i + 1])(name));
  if (matches[current - 1]) return current;
  const first = matches.indexOf(true);
  return first < 0 ? current : first + 1;
}

/** Opens the file dialog of the backend; the chosen filter comes first, "All files" (`*`) filters last. Null when cancelled. */
export function runFileDialog(backend: Backend, r: FileDialogRequest): Promise<string | null> {
  const all = parseVbFilter(r.filter);
  const sel = Math.min(Math.max(1, Math.floor(r.filterIndex) || 1), all.length) - 1;
  const isAll = (f: FileFilter) => f.extensions.includes('*');
  const rest = all.filter((_, i) => i !== sel);
  const filters = all.length ? [all[sel], ...rest.filter(f => !isAll(f)), ...rest.filter(isAll)] : [];
  const initDir = r.initDir || dirName(r.fileName);
  return r.kind === 'open'
    ? backend.showOpenDialog(filters, r.title, initDir)
    : backend.showSaveDialog(filters, r.title, initDir, baseName(r.fileName));
}

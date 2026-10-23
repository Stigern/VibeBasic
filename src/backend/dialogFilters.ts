// The CommonDialog filters as the Tauri dialog plugin gets them.

import type { FileFilter } from './backend';

/**
 * On macOS the plugin (rfd) shows no filter menu: the extensions of every filter are merged into one list of allowed
 * file types. A filter with `*` (VB's "All files (*.*)|*.*") therefore means no restriction at all, which is no
 * filters; otherwise the plain extensions (empty filters dropped). The order is kept: `*` filters come last
 * (runFileDialog), so a platform with a filter menu would show "All files" as a choice of its own.
 */
export function dialogFilters(filters: FileFilter[]): FileFilter[] {
  if (filters.some(f => f.extensions.includes('*'))) return [];
  return filters.map(f => ({ name: f.name, extensions: f.extensions.filter(x => x !== '') })).filter(f => f.extensions.length > 0);
}

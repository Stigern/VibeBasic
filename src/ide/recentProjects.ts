// The projects opened or saved last (newest first): the New Project dialog's Recent tab and the list at the end of the File menu.
// Kept in the app's settings ('recent'), as VB6 kept its list in the registry.
import type { Backend } from '../backend/backend';

export const MAX_RECENT = 8;

type Store = Pick<Backend, 'loadSettings' | 'saveSettings'>;

/** `path` first, without another spelling of it (a path's case does not matter on Windows and macOS), at most MAX_RECENT. */
export function withRecent(list: readonly string[], path: string): string[] {
  const l = path.toLowerCase();
  return [path, ...list.filter(p => p.toLowerCase() !== l)].slice(0, MAX_RECENT);
}

/** The file name without its folder and extension: "C:\Kalk\Kalk.vbb" -> "Kalk". */
export const projectLabel = (path: string): string => (path.split(/[\\/]/).pop() ?? path).replace(/\.(vbb|vbp)$/i, '');

/** The folder of a path, for the Recent tab. */
export const projectFolder = (path: string): string => { const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return i > 0 ? path.slice(0, i) : path; };

export class RecentProjects {
  list: string[] = [];
  private loaded: Promise<void>;
  private pending: ((list: string[]) => string[])[] = [];
  private isLoaded = false;
  private saving = Promise.resolve();

  constructor(private store: Store) {
    this.loaded = store.loadSettings<unknown>('recent')
      .catch(() => null)
      .then(v => {
        const saved = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
        this.list = this.pending.reduce((list, change) => change(list), saved);
        this.isLoaded = true;
        if (this.pending.length) this.persist();
        this.pending = [];
      });
  }

  /** Resolves once the saved list is in (the Recent tab waits for it). */
  ready(): Promise<void> { return this.loaded; }

  add(path: string): void { this.change(list => withRecent(list, path)); }

  /** A project that could not be opened leaves the list. */
  remove(path: string): void { this.change(list => list.filter(p => p.toLowerCase() !== path.toLowerCase())); }

  private change(change: (list: string[]) => string[]): void {
    this.list = change(this.list);
    if (this.isLoaded) this.persist(); else this.pending.push(change);
  }

  private persist(): void {
    const list = this.list;
    this.saving = this.saving.then(() => this.store.saveSettings('recent', list)).catch(() => {});
  }
}

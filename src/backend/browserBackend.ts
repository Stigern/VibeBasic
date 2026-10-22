import type { Backend, FileFilter } from './backend';

const FS_PREFIX = 'vibebasic.fs:';

/** Development only: files live in localStorage under `vibebasic.fs:<path>`, dialogs are window.prompt. */
export class BrowserBackend implements Backend {
  readonly kind = 'browser' as const;

  async showMainWindow(): Promise<void> {
    // Ingenting å gjøre i nettleseren.
  }

  private ask(message: string, def: string): string | null {
    const r = window.prompt(message, def);
    const name = r?.trim();
    return name ? name : null;
  }

  async openProjectDialog(): Promise<string | null> {
    return this.ask('Open project (file name, *.vbb):', 'Project1.vbb');
  }

  async saveProjectDialog(defaultFileName: string): Promise<string | null> {
    const name = this.ask('Save project as (file name, *.vbb):', defaultFileName);
    if (name === null) return null;
    return /\.vbb$/i.test(name) ? name : name + '.vbb';
  }

  async openFileDialog(filters: FileFilter[]): Promise<string | null> {
    const ext = filters.flatMap((f) => f.extensions).map((x) => '*.' + x).join(', ');
    return this.ask(`Open file (file name${ext ? ', ' + ext : ''}):`, '');
  }

  async readTextFile(path: string): Promise<string> {
    const text = localStorage.getItem(FS_PREFIX + path);
    if (text === null) throw new Error(`${path}: No such file`);
    return text;
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    localStorage.setItem(FS_PREFIX + path, text);
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readTextFile(path));
  }

  async loadSettings<T>(key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem('vibebasic.settings:' + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch { return null; }
  }

  async saveSettings(key: string, v: unknown): Promise<void> {
    try { localStorage.setItem('vibebasic.settings:' + key, JSON.stringify(v)); } catch { /* storage unavailable */ }
  }

  async setWindowTitle(title: string): Promise<void> {
    document.title = title;
  }

  async closeMainWindow(): Promise<void> {
    window.close(); // best effort: browsers only close windows opened by script
  }

  async getEmbeddedProject(): Promise<string | null> {
    return null;
  }

  async quitApp(): Promise<void> {
    // Nothing to quit in the browser.
  }

  async getAppDir(): Promise<string> {
    return '';
  }

  onQuitRequested(_handler: () => void): void {
    // No runtime menu in the browser.
  }

  onCloseRequested(_handler: () => Promise<boolean>): void {
    // Best effort: beforeunload cannot await an async handler, so the browser's own
    // confirmation prompt stands in for the IDE's "Save changes?" dialog (development only).
    window.addEventListener('beforeunload', (e) => {
      e.preventDefault();
      e.returnValue = '';
    });
  }
}

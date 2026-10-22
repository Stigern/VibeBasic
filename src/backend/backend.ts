import { BrowserBackend } from './browserBackend';
import { TauriBackend } from './tauriBackend';

export interface FileFilter { name: string; extensions: string[] }

export interface Backend {
  readonly kind: 'tauri' | 'browser';
  showMainWindow(): Promise<void>;
  /** Open dialog filtered to *.vbb. Null when cancelled. */
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(defaultFileName: string): Promise<string | null>;
  openFileDialog(filters: FileFilter[]): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  setWindowTitle(title: string): Promise<void>;
  /** The handler returns false to cancel closing. */
  onCloseRequested(handler: () => Promise<boolean>): void;
}

let cached: Backend | undefined;

/** Velger TauriBackend når appen kjører i Tauri, ellers BrowserBackend. */
export function getBackend(): Backend {
  if (!cached) {
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    cached = inTauri ? new TauriBackend() : new BrowserBackend();
  }
  return cached;
}

import { BrowserBackend } from './browserBackend';
import { TauriBackend } from './tauriBackend';
import type { ChatMessage } from '../ai/types';

export interface FileFilter { name: string; extensions: string[] }

export interface Backend {
  readonly kind: 'tauri' | 'browser';
  showMainWindow(): Promise<void>;
  /** Open dialog filtered to *.vbb. Null when cancelled. */
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(defaultFileName: string): Promise<string | null>;
  /** Save dialog for a made app (filter .app). Null when cancelled. */
  saveAppDialog(defaultName: string): Promise<string | null>;
  /** Builds a standalone .app from the project (desktop only). Rejects with the error text. */
  makeApp(o: { targetPath: string; appName: string; projectJson: string; iconPngBase64: string | null; overwrite: boolean }): Promise<void>;
  openFileDialog(filters: FileFilter[]): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  /** Small JSON settings (IDE options ...) kept in localStorage under `vibebasic.settings:<key>`. Null when absent. */
  loadSettings<T>(key: string): Promise<T | null>;
  saveSettings(key: string, v: unknown): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  /** The handler returns false to cancel closing. */
  onCloseRequested(handler: () => Promise<boolean>): void;
  /** Closes the main window without asking again (the caller already confirmed). */
  closeMainWindow(): Promise<void>;
  /** Made apps: the embedded project text (Contents/Resources/vibebasic-project.vbb), or null in the IDE. */
  getEmbeddedProject(): Promise<string | null>;
  /** Exits the whole app. */
  quitApp(): Promise<void>;
  /** The folder that contains the .app ('' when unknown). */
  getAppDir(): Promise<string>;
  /** The made app's name (CFBundleName; App.EXEName); '' when unknown. */
  getAppName(): Promise<string>;
  /** Rejects with the reason text when Make can't work here (browser, or desktop not run as a built .app). */
  canMakeApp(): Promise<void>;
  /** Model ids from `GET {baseUrl}/models`. Rejects with a readable error text. */
  aiListModels(baseUrl: string, apiKey: string): Promise<string[]>;
  /** `POST {baseUrl}/chat/completions`; resolves to choices[0].message.content. Rejects with a readable error text. */
  aiChat(baseUrl: string, apiKey: string, model: string, messages: ChatMessage[]): Promise<string>;
  /** Made apps: the runtime menu's Quit (Cmd+Q) was chosen. */
  onQuitRequested(handler: () => void): void;
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

import { BrowserBackend } from './browserBackend';
import { TauriBackend } from './tauriBackend';
import type { ChatMessage } from '../ai/types';
import type { AiChatOptions } from '../ai/sse';

export interface FileFilter { name: string; extensions: string[] }
/** A drive of DriveListBox: `path` is what `Drive1.Drive` returns ("/" is the startup disk). */
export interface Volume { name: string; path: string }
/** One folder: sub-folder names (symlinked folders too, as plain names) and files, sorted. */
export interface DirListing { dirs: string[]; files: { name: string; hidden: boolean }[] }

/** Inet (OpenURL / Execute): one HTTP(S) request; `headers` are "Name: value" lines, `timeoutSecs` 0 = none. */
export interface InetRequest { id: string; url: string; method: string; headers: string; body: Uint8Array; timeoutSecs: number; userName: string; password: string }
/** Any HTTP status is an answer. A failed request rejects with "number|description" (35761|Request timed out ...). */
export interface InetResponse { status: number; statusText: string; version: string; headers: [string, string][]; body: Uint8Array }
/** The addresses of a Winsock socket once it is connected, listening or bound. */
export interface SocketInfo { localIp: string; localPort: number; remoteIp: string; remotePort: number }
/** What a socket reports on its own (the "vb:socket" events of the Rust side). */
export type SocketEvent =
  | { kind: 'connectionRequest'; id: number; requestId: number; remoteIp: string; remotePort: number }
  | { kind: 'data'; id: number; data: Uint8Array; remoteIp: string; remotePort: number }
  | { kind: 'close'; id: number }
  | { kind: 'error'; id: number; number: number; description: string };

/**
 * Inet and Winsock: the network calls the main window makes for a running program. Socket ids are chosen by the caller.
 * The socket calls reject with "number|description" (10061|Connection is forcefully rejected ...).
 */
export interface NetApi {
  inetRequest(r: InetRequest): Promise<InetResponse>;
  inetCancel(id: string): Promise<void>;
  sockConnect(id: number, host: string, port: number): Promise<SocketInfo>;
  sockListen(id: number, port: number, ip: string): Promise<SocketInfo>;
  sockAccept(id: number, requestId: number): Promise<SocketInfo>;
  /** UDP: bind the local port (0 = any). */
  sockBind(id: number, port: number, ip: string): Promise<SocketInfo>;
  /** TCP: on the connection; UDP: one datagram to host:port. */
  sockSend(id: number, data: Uint8Array, host: string, port: number): Promise<void>;
  sockClose(id: number): Promise<void>;
  /** Closes every socket and aborts every Inet request (the end of a run). */
  netReset(): Promise<void>;
  netLocalIp(): Promise<string>;
  /** Resolves with the function that stops listening. */
  onSocketEvent(handler: (e: SocketEvent) => void): Promise<() => void>;
}

export interface Backend extends NetApi {
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
  /** Generic open dialog (CommonDialog.ShowOpen): `filters` in the order shown (the first is selected), `initDir` '' for the default folder. Null when cancelled. An extension `*` means every file. */
  showOpenDialog(filters: FileFilter[], title: string, initDir: string): Promise<string | null>;
  /** Generic save dialog (CommonDialog.ShowSave). `defaultName` is the file name suggested ('' for none). Null when cancelled. */
  showSaveDialog(filters: FileFilter[], title: string, initDir: string, defaultName?: string): Promise<string | null>;
  /** DriveListBox: the startup disk "/" first, then /Volumes/*. */
  listVolumes(): Promise<Volume[]>;
  /** DirListBox / FileListBox: the contents of one folder. Rejects with the error text when it can't be read. */
  listDir(path: string): Promise<DirListing>;
  /** Clipboard object of a running program: the system clipboard as text. Rejects when it cannot be reached. */
  clipboardGetText(): Promise<string>;
  clipboardSetText(text: string): Promise<void>;
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
  /** `POST {baseUrl}/chat/completions`; resolves to choices[0].message.content. With `opts.onDelta` the reply streams (thinking, then answer); `opts.signal` aborts it (rejects with "cancelled"). Rejects with a readable error text. */
  aiChat(baseUrl: string, apiKey: string, model: string, messages: ChatMessage[], reasoningEffort?: string, opts?: AiChatOptions): Promise<string>;
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

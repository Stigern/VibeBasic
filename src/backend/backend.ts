import { BrowserBackend } from './browserBackend';
import type { PrinterInfo } from '../run/printing';
import { TauriBackend } from './tauriBackend';
import type { AiModel, ChatMessage } from '../ai/types';
import type { AiChatOptions } from '../ai/sse';
import type { FileSystemApi } from '../lang/fileio/fsApi';

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

/** MSComm: the modem status lines (CTSHolding, DSRHolding, CDHolding; RI raises comEvRing). */
export interface CommLines { cts: boolean; dsr: boolean; cd: boolean; ring: boolean }
/** What an open serial port reports on its own (the "vb:comm" events of the Rust side). `error`: reading failed (unplugged), the port is closed. */
export type CommEvent =
  | { kind: 'data'; id: number; data: Uint8Array }
  | ({ kind: 'lines'; id: number } & CommLines)
  | { kind: 'error'; id: number; number: number; description: string };

/**
 * MSComm: the serial ports (src-tauri/src/comm.rs), used by the main window for a running program. Port ids are chosen by the
 * caller. The calls reject with "number|description" (8002|Invalid port number, 8005|Port already open, 8018 ...).
 */
export interface SerialApi {
  /** The /dev/cu.* devices, sorted (CommPort n is the n-th). */
  commList(): Promise<string[]>;
  /** `settings` "9600,n,8,1"; `handshaking` 0-3. Resolves with the modem lines. */
  commOpen(id: number, path: string, settings: string, handshaking: number, dtr: boolean, rts: boolean): Promise<CommLines>;
  commConfigure(id: number, settings: string, handshaking: number): Promise<void>;
  commWrite(id: number, data: Uint8Array): Promise<void>;
  /** DTREnable, RTSEnable, Break; null leaves a line as it is. */
  commSetLines(id: number, dtr: boolean | null, rts: boolean | null, brk: boolean | null): Promise<void>;
  commClose(id: number): Promise<void>;
  /** Closes every port (the end of a run). */
  commReset(): Promise<void>;
  /** Resolves with the function that stops listening. */
  onCommEvent(handler: (e: CommEvent) => void): Promise<() => void>;
}

/** SysInfo: the macOS version, the main screen's visible frame (points) and the power state with VB6's values (255 / -1 unknown). */
export interface SysInfoData {
  osVersion: string; osBuild: string;
  workLeft: number; workTop: number; workWidth: number; workHeight: number;
  acStatus: number; batteryLifePercent: number; batteryLifeTime: number; batteryFullTime: number; batteryStatus: number;
}
export interface SystemApi { sysInfo(): Promise<SysInfoData> }

/** A database value as the Rust side sends it: SQLite NULL, a number, a string, or the bytes of a BLOB. */
export type DbValue = null | number | string | { blob: string };
/** The rows of a query; `types` are the declared column types ('' for an expression). */
export interface DbQueryResult { columns: string[]; types: string[]; rows: DbValue[][] }
export interface DbExecResult { rowsAffected: number; lastInsertRowid: number }

/**
 * Data control, ADO Data Control, Recordset: SQLite databases (src-tauri/src/db.rs), used by the main window for a running
 * program. A missing database file is created. Every call rejects with "number|description" (DAO error numbers:
 * 3078|no such table ..., 3022 duplicate key, 3044 invalid path).
 */
export interface DatabaseApi {
  dbOpen(path: string): Promise<number>;
  dbQuery(id: number, sql: string, params: DbValue[]): Promise<DbQueryResult>;
  /** Without params the SQL may hold several statements. */
  dbExecute(id: number, sql: string, params: DbValue[]): Promise<DbExecResult>;
  dbClose(id: number): Promise<void>;
  /** Closes every connection (the end of a run). */
  dbReset(): Promise<void>;
}

/** FileSystemApi: the files of a running program (Open, Kill, Dir ...) and SaveSetting, made by the main window. */
export interface Backend extends NetApi, FileSystemApi, DatabaseApi, SerialApi, SystemApi {
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
  /** MMControl / MediaPlayer (Tauri only): opens a file for a form window to read by the token; rejects "53|..." (missing) or
   *  "296|..." (too big). */
  mediaOpen?(path: string): Promise<string>;
  /** The bytes of an opened media file. */
  mediaRead?(token: string): Promise<Uint8Array>;
  mediaClose?(token: string): Promise<void>;
  /** Printers (desktop only): the printers of the system. */
  printerList?(): Promise<PrinterInfo[]>;
  /** The macOS print dialog for a print window (label vbdialog-print-<n>), as a sheet on it. */
  printWindow?(label: string): Promise<void>;
  /** Small JSON settings (IDE options ...) kept in localStorage under `vibebasic.settings:<key>`. Null when absent. In the
   *  desktop app the 'ai' settings (with the API key) are kept by the Rust side instead, out of reach of the form windows,
   *  which share the localStorage (src/backend/aiSettingsStore.ts). */
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
  /** Models from `GET {baseUrl}/models` (id, and the context size when the server reports one). Rejects with a readable error text. */
  aiListModels(baseUrl: string, apiKey: string): Promise<AiModel[]>;
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

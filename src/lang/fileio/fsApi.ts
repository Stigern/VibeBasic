// What the language needs from the file system for Open/Get/Put/Close, Kill, Name, MkDir, Dir ... and SaveSetting:
// small async primitives. The run session hands the backend's implementation (Rust commands, src-tauri/src/fileio.rs)
// to the interpreter through Host.fileSystem(); tests and the browser use MemoryFs. Every call rejects with
// "number|description" (VB6 error numbers: 53|File not found, 76|Path not found ...).

import { VBRuntimeError } from '../errors';

export type FileMode = 'input' | 'output' | 'append' | 'binary' | 'random';
/** `Access Read | Write | Read Write`; '' when not given. */
export type FileAccess = '' | 'read' | 'write' | 'readwrite';

export interface FileStat {
  isDir: boolean;
  size: number;
  /** Modification time, ms since 1970 (UTC). */
  mtime: number;
  readOnly: boolean;
  hidden: boolean;
}

/** One folder: sub-folder names and files, each sorted (the shape of Backend.listDir). */
export interface FsListing { dirs: string[]; files: { name: string; hidden: boolean }[] }

export interface FileSystemApi {
  /** Opens a file (full path) and keeps the handle; `len` is its size. Output truncates; Output, Append and Binary/Random create it. */
  fioOpen(path: string, mode: FileMode, access: FileAccess): Promise<{ id: number; len: number }>;
  /** Up to `len` bytes from byte `pos` (0-based); fewer at the end of the file. */
  fioRead(id: number, pos: number, len: number): Promise<Uint8Array>;
  fioWrite(id: number, pos: number, data: Uint8Array): Promise<void>;
  fioClose(id: number): Promise<void>;
  fsKill(path: string): Promise<void>;
  fsRename(from: string, to: string): Promise<void>;
  fsMkDir(path: string): Promise<void>;
  fsRmDir(path: string): Promise<void>;
  fsCopy(from: string, to: string): Promise<void>;
  /** vbReadOnly is the only attribute with a Mac counterpart. */
  fsSetAttr(path: string, attr: number): Promise<void>;
  /** Null when nothing is there. */
  fsStat(path: string): Promise<FileStat | null>;
  listDir(path: string): Promise<FsListing>;
  settingGet(appName: string, section: string, key: string): Promise<string | null>;
  settingSave(appName: string, section: string, key: string, value: string): Promise<void>;
  /** `key` null deletes the section. Rejects 5 when it does not exist. */
  settingDelete(appName: string, section: string, key: string | null): Promise<void>;
  settingAll(appName: string, section: string): Promise<[string, string][]>;
}

/** A rejection of the file system ("53|File not found") as a VB run-time error; anything else is `fallback`. */
export function fsError(e: unknown, fallback = 75): VBRuntimeError {
  if (e instanceof VBRuntimeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^(\d+)\|([\s\S]*)$/.exec(msg);
  return m ? new VBRuntimeError(Number(m[1])) : new VBRuntimeError(fallback);
}

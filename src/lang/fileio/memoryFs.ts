// An in-memory FileSystemApi with the same error numbers as the Rust commands (src-tauri/src/fileio.rs): the tests'
// file system, and the browser development build's (files live as long as the page).

import type { FileAccess, FileMode, FileStat, FileSystemApi, FsListing } from './fsApi';

interface MemFile { data: Uint8Array; mtime: number; readOnly: boolean }

const err = (n: number, text: string): Error => new Error(`${n}|${text}`);
const E52 = () => err(52, 'Bad file name or number');
const E53 = () => err(53, 'File not found');
const E58 = () => err(58, 'File already exists');
const E75 = () => err(75, 'Path/File access error');
const E76 = () => err(76, 'Path not found');

const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const sortNames = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

export class MemoryFs implements FileSystemApi {
  readonly files = new Map<string, MemFile>();
  readonly dirs = new Set<string>(['/']);
  /** SaveSetting store: app / section / key (lower case) -> [written key, value]. */
  readonly settings = new Map<string, Map<string, Map<string, [string, string]>>>();
  private handles = new Map<number, MemFile>();
  private nextId = 0;

  /** Creates the folder and its parents. */
  mkdirs(path: string): void {
    for (let p = path; p !== '/' && !this.dirs.has(p); p = parentOf(p)) this.dirs.add(p);
  }

  /** A file with this text (Latin-1 bytes), creating its folders. */
  writeFile(path: string, data: Uint8Array | string): void {
    this.mkdirs(parentOf(path));
    const bytes = typeof data === 'string' ? Uint8Array.from(data, c => c.charCodeAt(0) & 0xff) : data;
    this.files.set(path, { data: bytes, mtime: Date.now(), readOnly: false });
  }

  /** A file's bytes as a Latin-1 string (undefined when missing). */
  readFile(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? String.fromCharCode(...f.data) : undefined;
  }

  get openCount(): number { return this.handles.size; }

  private missing(path: string): Error { return this.dirs.has(parentOf(path)) ? E53() : E76(); }

  async fioOpen(path: string, mode: FileMode, access: FileAccess): Promise<{ id: number; len: number }> {
    if (this.dirs.has(path)) throw E75();
    let f = this.files.get(path);
    if (!f) {
      if (mode === 'input' || access === 'read') throw this.missing(path);
      if (!this.dirs.has(parentOf(path))) throw E76();
      f = { data: new Uint8Array(0), mtime: Date.now(), readOnly: false };
      this.files.set(path, f);
    } else if (f.readOnly && (mode === 'output' || mode === 'append' || access === 'write' || access === 'readwrite')) {
      throw err(70, 'Permission denied');
    }
    if (mode === 'output') { f.data = new Uint8Array(0); f.mtime = Date.now(); }
    const id = ++this.nextId;
    this.handles.set(id, f);
    return { id, len: f.data.length };
  }

  async fioRead(id: number, pos: number, len: number): Promise<Uint8Array> {
    const f = this.handles.get(id);
    if (!f) throw E52();
    return f.data.slice(pos, pos + len);
  }

  async fioWrite(id: number, pos: number, data: Uint8Array): Promise<void> {
    const f = this.handles.get(id);
    if (!f) throw E52();
    const end = pos + data.length;
    if (end > f.data.length) {
      const grown = new Uint8Array(end);
      grown.set(f.data);
      f.data = grown;
    }
    f.data.set(data, pos);
    f.mtime = Date.now();
  }

  async fioClose(id: number): Promise<void> { this.handles.delete(id); }

  async fsKill(path: string): Promise<void> {
    if (!this.files.has(path)) throw this.missing(path);
    this.files.delete(path);
  }

  async fsRename(from: string, to: string): Promise<void> {
    if (!this.files.has(from) && !this.dirs.has(from)) throw this.missing(from);
    if (this.files.has(to) || this.dirs.has(to)) throw E58();
    if (!this.dirs.has(parentOf(to))) throw E76();
    const f = this.files.get(from);
    if (f) { this.files.delete(from); this.files.set(to, f); return; }
    for (const d of [...this.dirs]) if (d === from || d.startsWith(from + '/')) { this.dirs.delete(d); this.dirs.add(to + d.slice(from.length)); }
    for (const [p, v] of [...this.files]) if (p.startsWith(from + '/')) { this.files.delete(p); this.files.set(to + p.slice(from.length), v); }
  }

  async fsMkDir(path: string): Promise<void> {
    if (this.dirs.has(path) || this.files.has(path)) throw E75();
    if (!this.dirs.has(parentOf(path))) throw E76();
    this.dirs.add(path);
  }

  async fsRmDir(path: string): Promise<void> {
    if (!this.dirs.has(path)) throw this.files.has(path) ? E75() : E76();
    const prefix = path + '/';
    if ([...this.files.keys(), ...this.dirs].some(p => p.startsWith(prefix))) throw E75();
    this.dirs.delete(path);
  }

  async fsCopy(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw this.missing(from);
    if (!this.dirs.has(parentOf(to))) throw E76();
    if (this.dirs.has(to)) throw E75();
    this.files.set(to, { data: f.data.slice(), mtime: Date.now(), readOnly: false });
  }

  async fsSetAttr(path: string, attr: number): Promise<void> {
    const f = this.files.get(path);
    if (!f) { if (this.dirs.has(path)) return; throw this.missing(path); }
    f.readOnly = (attr & 1) !== 0;
  }

  async fsStat(path: string): Promise<FileStat | null> {
    const hidden = nameOf(path).startsWith('.');
    if (this.dirs.has(path)) return { isDir: true, size: 0, mtime: 0, readOnly: false, hidden };
    const f = this.files.get(path);
    return f ? { isDir: false, size: f.data.length, mtime: f.mtime, readOnly: f.readOnly, hidden } : null;
  }

  async listDir(path: string): Promise<FsListing> {
    if (!this.dirs.has(path)) throw new Error(`${path}: No such file or directory`);
    const prefix = path === '/' ? '/' : path + '/';
    const direct = (p: string) => p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes('/');
    const dirs = [...this.dirs].filter(direct).map(nameOf).sort(sortNames);
    const files = [...this.files.keys()].filter(direct).map(nameOf).sort(sortNames).map(name => ({ name, hidden: name.startsWith('.') }));
    return { dirs, files };
  }

  private section(app: string, sec: string, create: boolean): Map<string, [string, string]> | undefined {
    let a = this.settings.get(app.toLowerCase());
    if (!a) { if (!create) return undefined; a = new Map(); this.settings.set(app.toLowerCase(), a); }
    let s = a.get(sec.toLowerCase());
    if (!s) { if (!create) return undefined; s = new Map(); a.set(sec.toLowerCase(), s); }
    return s;
  }

  async settingGet(app: string, sec: string, key: string): Promise<string | null> {
    return this.section(app, sec, false)?.get(key.toLowerCase())?.[1] ?? null;
  }

  async settingSave(app: string, sec: string, key: string, value: string): Promise<void> {
    const s = this.section(app, sec, true)!;
    s.set(key.toLowerCase(), [s.get(key.toLowerCase())?.[0] ?? key, value]);
  }

  async settingDelete(app: string, sec: string, key: string | null): Promise<void> {
    const s = this.section(app, sec, false);
    if (!s) throw err(5, 'Invalid procedure call or argument');
    if (key === null) { this.settings.get(app.toLowerCase())!.delete(sec.toLowerCase()); return; }
    if (!s.delete(key.toLowerCase())) throw err(5, 'Invalid procedure call or argument');
  }

  async settingAll(app: string, sec: string): Promise<[string, string][]> {
    return [...this.section(app, sec, false)?.values() ?? []].map(([k, v]) => [k, v]);
  }
}

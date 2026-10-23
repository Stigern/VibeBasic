// The open files of a running program (file numbers 1-511) and the current folder (CurDir), on top of a FileSystemApi.
//
// - Input files are read whole when opened (Line Input, Input # and EOF then need no waiting), in chunks of READ_CHUNK and
//   at most MAX_READ_BYTES (error 7 beyond: the text must fit in memory); Output and Append files
//   are buffered and written on Close, at End, before Seek/LOF and every 64K characters. Binary and Random files are
//   read and written by position on every Get / Put.
// - Text is Windows-1252 like VB6 (UTF-8 is read when the file is UTF-8, see decodeText); lines end in CRLF.
// - Paths: "\" and "/" both separate folders, a drive letter ("C:") is dropped, and relative paths are from CurDir,
//   which starts as App.Path.

import type { VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import { dateFrom, type VBDate, type VBRecord, type VBValue } from '../values';
import { ByteReader, NeedMore, decodeRecord, encodeRecord, type TypeSource } from './binary';
import { fsError, type FileAccess, type FileMode, type FileSystemApi } from './fsApi';
import { TextReader, decode1252, decodeText, encode1252, type InputField } from './textFormat';

const MAX_FILE = 511;
const FLUSH_CHARS = 65536;
/** One fioRead asks for at most this much (the backend refuses more than 64 MB a call). */
export const READ_CHUNK = 8 * 1024 * 1024;
/** An Input file, or one Input(n) / Get, bigger than this is error 7 (Out of memory). */
export const MAX_READ_BYTES = 256 * 1024 * 1024;

/** The closeAll of the program before this one (one program runs at a time in a page). A new program's first Open waits for
 *  it, then has the backend close whatever an earlier run (or a page that was reloaded) left open (fioReset). */
let lastClose: Promise<void> = Promise.resolve();

export const vbDirectory = 16;

interface OpenFile {
  num: number;
  path: string;
  mode: FileMode;
  id: number;
  recLen: number;
  /** Bytes in the file (as far as this program wrote it). */
  len: number;
  /** Input: the text. */
  reader?: TextReader;
  /** Output/Append: text not yet written, and the byte position it goes to. */
  pending: string;
  wpos: number;
  /** Writes in progress, in order; a failure is raised at the next Close / flush. */
  writing: Promise<void>;
  failure?: VBRuntimeError;
  /** Print #: the column after the last `;` or `,` (0 at the start of a line). */
  column: number;
  /** Binary/Random: the next byte; the last record read or written; the last Get came up short. */
  pos: number;
  lastRec: number;
  eof: boolean;
}

/** `*` and `?` in the last part of a path; `*.*` is every name (Windows). */
export function wildcardMatcher(mask: string): (name: string) => boolean {
  if (mask === '*.*' || mask === '*') return () => true;
  const re = new RegExp('^' + mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return name => re.test(name);
}

const hasWildcard = (s: string) => /[*?]/.test(s);
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const byName = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

export class FileIO {
  private readonly files = new Map<number, OpenFile>();
  /** CurDir: a full path. */
  curDir: string;
  /** What `Dir()` without arguments returns next; null before the first Dir(path) and after the last name. */
  private dirNames: string[] | null = null;
  /** closeAll ran: the program has ended. */
  private ended = false;
  /** Files left open by an earlier run are closed (once, before this program's first Open). */
  private reset: Promise<void> | null = null;

  constructor(private readonly getApi: () => FileSystemApi | undefined, appPath: string, private readonly types: TypeSource) {
    this.curDir = this.normalize(appPath.replace(/\\/g, '/') || '/');
  }

  private api(): FileSystemApi {
    const a = this.getApi();
    if (!a) throw new VBRuntimeError(68);
    return a;
  }

  /** Runs a file-system call; its rejection becomes the VB error (`fallback` when it has no number). */
  private async call<T>(fn: (a: FileSystemApi) => Promise<T>, fallback = 75): Promise<T> {
    const a = this.api();
    try {
      return await fn(a);
    } catch (e) {
      throw fsError(e, fallback);
    }
  }

  private normalize(p: string): string {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  }

  /** Up to `n` bytes from `pos` in chunks (fewer only at the end of the file); 7 when `n` is more than MAX_READ_BYTES. */
  private async readBytes(id: number, pos: number, n: number): Promise<Uint8Array> {
    if (n > MAX_READ_BYTES) throw new VBRuntimeError(7);
    if (n <= READ_CHUNK) return this.call(a => a.fioRead(id, pos, n), 57);
    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < n) {
      const want = Math.min(READ_CHUNK, n - got);
      const c = await this.call(a => a.fioRead(id, pos + got, want), 57);
      parts.push(c);
      got += c.length;
      if (c.length < want) break;
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const c of parts) { out.set(c, at); at += c.length; }
    return out;
  }

  /** The full Mac path of a VB path. */
  resolve(path: string): string {
    let s = path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/|$)/, '');
    if (!s.startsWith('/')) s = `${this.curDir}/${s}`;
    return this.normalize(s);
  }

  // ---- file numbers ----

  /** The open file `num`: 52 when the number is out of range or not open. */
  private file(num: number): OpenFile {
    const f = Number.isInteger(num) ? this.files.get(num) : undefined;
    if (!f) throw new VBRuntimeError(52);
    return f;
  }

  /** FreeFile: the lowest unused number in 1-255 (range 0) or 256-511 (range 1); 67 when none is free. */
  freeFile(range: number): number {
    if (range !== 0 && range !== 1) throw new VBRuntimeError(5);
    for (let n = range === 0 ? 1 : 256, end = range === 0 ? 255 : 511; n <= end; n++) if (!this.files.has(n)) return n;
    throw new VBRuntimeError(67);
  }

  private isOpen(path: string): boolean {
    const l = path.toLowerCase();
    for (const f of this.files.values()) if (f.path.toLowerCase() === l) return true;
    return false;
  }

  // ---- Open / Close ----

  async open(path: string, mode: FileMode, access: FileAccess, num: number, recLen?: number): Promise<void> {
    if (!Number.isInteger(num) || num < 1 || num > MAX_FILE) throw new VBRuntimeError(52);
    if (this.files.has(num)) throw new VBRuntimeError(55);
    if (recLen !== undefined && (!Number.isInteger(recLen) || recLen < 1 || recLen > 32767)) throw new VBRuntimeError(5);
    const full = this.resolve(path);
    // a file open for writing may not be opened again; nor may an open file be opened for writing
    const l = full.toLowerCase();
    for (const f of this.files.values()) {
      if (f.path.toLowerCase() === l && (f.mode === 'output' || f.mode === 'append' || mode === 'output' || mode === 'append')) throw new VBRuntimeError(55);
    }
    if (this.ended) throw new VBRuntimeError(52);
    const api = this.api();
    await (this.reset ??= lastClose.then(() => api.fioReset?.()).catch(() => {}));
    const { id, len } = await this.call(a => a.fioOpen(full, mode, access));
    // the program ended while the file was opening (closeAll has run): nobody would close it
    if (this.ended) { void api.fioClose(id).catch(() => {}); throw new VBRuntimeError(52); }
    if (this.files.has(num)) { void api.fioClose(id).catch(() => {}); throw new VBRuntimeError(55); }
    const f: OpenFile = {
      num, path: full, mode, id, recLen: recLen ?? 128, len, pending: '', wpos: mode === 'append' ? len : 0,
      writing: Promise.resolve(), column: 0, pos: 0, lastRec: 0, eof: false,
    };
    if (mode === 'input') {
      try {
        f.reader = new TextReader(decodeText(len > 0 ? await this.readBytes(id, 0, len) : new Uint8Array(0)));
      } catch (e) {
        void api.fioClose(id).catch(() => {});
        throw e;
      }
      if (this.ended) { void api.fioClose(id).catch(() => {}); throw new VBRuntimeError(52); }
    }
    this.files.set(num, f);
  }

  /** Starts writing the buffered text (in order after earlier writes). */
  private enqueue(f: OpenFile): void {
    if (f.pending !== '') {
      const bytes = encode1252(f.pending);
      const at = f.wpos;
      f.pending = '';
      f.wpos += bytes.length;
      f.len = Math.max(f.len, f.wpos);
      const api = this.api();
      f.writing = f.writing.then(() => api.fioWrite(f.id, at, bytes)).catch(e => { f.failure ??= fsError(e, 57); });
    }
  }

  /** Writes the buffered text and waits for every write; raises the first failure. */
  private flush(f: OpenFile): Promise<void> {
    this.enqueue(f);
    return f.writing.then(() => {
      const e = f.failure;
      f.failure = undefined;
      if (e) throw e;
    });
  }

  private async closeFile(f: OpenFile): Promise<void> {
    this.files.delete(f.num);
    try {
      await this.flush(f);
    } finally {
      await this.api().fioClose(f.id).catch(() => {});
    }
  }

  /** Close #1, #2 (an unopened number is ignored, as in VB6); `null` closes every file. */
  async close(nums: number[] | null): Promise<void> {
    const list = nums === null ? [...this.files.values()] : nums.map(n => {
      if (!Number.isInteger(n) || n < 1 || n > MAX_FILE) throw new VBRuntimeError(52);
      return this.files.get(n);
    });
    let first: unknown;
    for (const f of list) {
      if (!f) continue;
      try { await this.closeFile(f); } catch (e) { first ??= e; }
    }
    if (first) throw first;
  }

  /** The end of the program: every file is written and closed. */
  closeAll(): Promise<void> {
    const list = [...this.files.values()];
    this.ended = true;
    this.files.clear();
    this.dirNames = null;
    const done = Promise.all(list.map(f => this.flush(f).catch(() => {}).then(() => this.getApi()?.fioClose(f.id)).catch(() => {}))).then(() => {});
    lastClose = lastClose.then(() => done);
    return done;
  }

  // ---- sequential files ----

  private writable(num: number): OpenFile {
    const f = this.file(num);
    if (f.mode !== 'output' && f.mode !== 'append') throw new VBRuntimeError(54);
    return f;
  }

  private readable(num: number): TextReader {
    const f = this.file(num);
    if (!f.reader) throw new VBRuntimeError(54);
    return f.reader;
  }

  /** Print # / Write #: the column the next text starts at. */
  column(num: number): number { return this.writable(num).column; }

  /** Appends text to an Output/Append file; `column` is where the line stands afterwards. A promise when a flush is due. */
  writeText(num: number, text: string, column: number): void | Promise<void> {
    const f = this.writable(num);
    f.pending += text;
    f.column = column;
    if (f.pending.length >= FLUSH_CHARS || f.failure) return this.flush(f);
  }

  lineInput(num: number): string { return this.readable(num).line(); }
  inputField(num: number): InputField { return this.readable(num).field(); }

  /** Input(n, #f) / InputB: characters of an Input file, bytes of a Binary file (62 when fewer are left). */
  async inputChars(num: number, n: number): Promise<string> {
    if (!Number.isInteger(n) || n < 0) throw new VBRuntimeError(5);
    const f = this.file(num);
    if (f.reader) return f.reader.chars(n);
    if (f.mode !== 'binary') throw new VBRuntimeError(54);
    const data = n > 0 ? await this.readBytes(f.id, f.pos, n) : new Uint8Array(0);
    if (data.length < n) throw new VBRuntimeError(62);
    f.pos += n;
    return decode1252(data);
  }

  eof(num: number): boolean {
    const f = this.file(num);
    if (f.reader) return f.reader.eof;
    if (f.mode === 'binary' || f.mode === 'random') return f.eof;
    return true;
  }

  async lof(num: number): Promise<number> {
    const f = this.file(num);
    if (f.mode === 'output' || f.mode === 'append') await this.flush(f);
    return f.len;
  }

  /** Seek(n): the next byte (1-based), the next record in a Random file. */
  seekPos(num: number): number {
    const f = this.file(num);
    if (f.reader) return f.reader.pos + 1;
    if (f.mode === 'random') return Math.floor(f.pos / f.recLen) + 1;
    if (f.mode === 'binary') return f.pos + 1;
    return f.wpos + f.pending.length + 1;
  }

  /** Loc(n): the last record read or written (Random), the last byte (Binary), the position / 128 (sequential). */
  loc(num: number): number {
    const f = this.file(num);
    if (f.mode === 'random') return f.lastRec;
    if (f.mode === 'binary') return f.pos;
    return Math.floor((this.seekPos(num) - 1) / 128);
  }

  /** Seek #n, pos. */
  seek(num: number, pos: number): void {
    const f = this.file(num);
    if (!Number.isInteger(pos) || pos < 1) throw new VBRuntimeError(63);
    if (f.reader) { f.reader.pos = Math.min(pos - 1, f.reader.text.length); return; }
    if (f.mode === 'random') { f.pos = (pos - 1) * f.recLen; return; }
    if (f.mode === 'binary') { f.pos = pos - 1; return; }
    this.enqueue(f);
    f.wpos = pos - 1;
  }

  // ---- Get / Put ----

  private recordFile(num: number, rec: number | undefined): { f: OpenFile; at: number } {
    const f = this.file(num);
    if (f.mode !== 'binary' && f.mode !== 'random') throw new VBRuntimeError(54);
    if (rec === undefined) return { f, at: f.mode === 'random' ? Math.floor(f.pos / f.recLen) * f.recLen : f.pos };
    if (!Number.isInteger(rec) || rec < 1) throw new VBRuntimeError(63);
    return { f, at: f.mode === 'random' ? (rec - 1) * f.recLen : rec - 1 };
  }

  /** Get: the value read for a target declared as `t` whose value is `cur` (arrays and records are filled in place). */
  async get(num: number, rec: number | undefined, cur: VBValue, t: VBTypeName, fixedLength: number | undefined): Promise<VBValue> {
    const { f, at } = this.recordFile(num, rec);
    if (f.mode === 'random') {
      const data = await this.readBytes(f.id, at, f.recLen);
      const r = new ByteReader(data, f.recLen, false);
      const v = decodeRecord(r, cur, t, fixedLength, true, this.types);
      f.eof = r.short;
      f.lastRec = at / f.recLen + 1;
      f.pos = at + f.recLen;
      return v;
    }
    for (let want = 256; ; ) {
      const data = await this.readBytes(f.id, at, want);
      const r = new ByteReader(data, Infinity, data.length === want);
      try {
        const v = decodeRecord(r, cur, t, fixedLength, false, this.types);
        f.eof = r.short;
        f.pos = at + r.pos;
        return v;
      } catch (e) {
        if (!(e instanceof NeedMore)) throw e;
        want = Math.max(e.upTo, want * 4);
      }
    }
  }

  async put(num: number, rec: number | undefined, v: VBValue, t: VBTypeName, fixedLength: number | undefined): Promise<void> {
    const { f, at } = this.recordFile(num, rec);
    let bytes = encodeRecord(v, t, fixedLength, f.mode === 'random', this.types);
    if (f.mode === 'random') {
      if (bytes.length > f.recLen) throw new VBRuntimeError(59);
      // the rest of the record is zeros, so LOF / Len(record) counts the records
      const padded = new Uint8Array(f.recLen);
      padded.set(bytes);
      bytes = padded;
    }
    await this.call(a => a.fioWrite(f.id, at, bytes), 57);
    f.len = Math.max(f.len, at + bytes.length);
    f.pos = at + bytes.length;
    if (f.mode === 'random') f.lastRec = at / f.recLen + 1;
  }

  /** The bytes a record takes in a Random file: Len(rec). */
  recordLength(rec: VBRecord): number {
    return encodeRecord(rec, { userType: rec.typeName }, undefined, true, this.types).length;
  }

  // ---- the file system ----

  /** The files (and with vbDirectory the folders) of `dir` that match `mask`. */
  private async matches(dir: string, mask: string, attr: number): Promise<string[]> {
    let listing;
    try {
      listing = await this.api().listDir(dir);
    } catch {
      return [];
    }
    const match = wildcardMatcher(mask);
    const hidden = (attr & 2) !== 0;
    const names = listing.files.filter(x => hidden || !x.hidden).map(x => x.name);
    if (attr & vbDirectory) names.push(...listing.dirs.filter(d => hidden || !d.startsWith('.')));
    const out = names.filter(match).sort(byName);
    if (attr & vbDirectory && dir !== '/') out.unshift(...['.', '..'].filter(match));
    return out;
  }

  /** Dir(path, attr) starts a listing and returns its first name; Dir() the next one ('' after the last). */
  async dir(path: string | undefined, attr: number): Promise<string> {
    if (path === undefined) {
      if (this.dirNames === null) throw new VBRuntimeError(5);
      const next = this.dirNames.shift();
      if (next === undefined) { this.dirNames = null; return ''; }
      return next;
    }
    if (attr & 8) { this.dirNames = []; return ''; }   // vbVolume: a Mac volume has no label
    const raw = path === '' ? '*' : path;
    const full = this.resolve(raw);
    let names: string[];
    if (/[\\/]$/.test(raw)) names = await this.matches(full, '*', attr);
    else if (hasWildcard(nameOf(full))) names = await this.matches(parentOf(full), nameOf(full), attr);
    else {
      const st = await this.api().fsStat(full).catch(() => null);
      const shown = st && (!st.hidden || attr & 2) && (!st.isDir || attr & vbDirectory);
      names = shown ? [nameOf(full)] : [];
    }
    this.dirNames = names;
    return this.dir(undefined, 0);
  }

  async kill(path: string): Promise<void> {
    const full = this.resolve(path);
    const targets = hasWildcard(nameOf(full))
      ? (await this.matches(parentOf(full), nameOf(full), 0)).map(n => `${parentOf(full).replace(/\/$/, '')}/${n}`)
      : [full];
    if (targets.length === 0) throw new VBRuntimeError(53);
    for (const t of targets) {
      if (this.isOpen(t)) throw new VBRuntimeError(75);
      await this.call(a => a.fsKill(t));
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.resolve(from);
    if (this.isOpen(f)) throw new VBRuntimeError(75);
    await this.call(a => a.fsRename(f, this.resolve(to)));
  }

  async fileCopy(from: string, to: string): Promise<void> {
    const f = this.resolve(from);
    if (this.isOpen(f)) throw new VBRuntimeError(70);
    await this.call(a => a.fsCopy(f, this.resolve(to)));
  }

  async mkDir(path: string): Promise<void> { const p = this.resolve(path); await this.call(a => a.fsMkDir(p)); }
  async rmDir(path: string): Promise<void> { const p = this.resolve(path); await this.call(a => a.fsRmDir(p)); }

  async chDir(path: string): Promise<void> {
    const p = this.resolve(path);
    const st = await this.call(a => a.fsStat(p));
    if (!st?.isDir) throw new VBRuntimeError(76);
    this.curDir = p;
  }

  async setAttr(path: string, attr: number): Promise<void> {
    const p = this.resolve(path);
    await this.call(a => a.fsSetAttr(p, attr));
  }

  private async stat(path: string) {
    const p = this.resolve(path);
    const st = await this.call(a => a.fsStat(p));
    if (!st) throw new VBRuntimeError(53);
    return st;
  }

  /** GetAttr: vbReadOnly 1, vbHidden 2 (a name starting with "."), vbDirectory 16. */
  async getAttr(path: string): Promise<number> {
    const st = await this.stat(path);
    return (st.readOnly ? 1 : 0) | (st.hidden ? 2 : 0) | (st.isDir ? vbDirectory : 0);
  }

  async fileLen(path: string): Promise<number> {
    const st = await this.stat(path);
    if (st.isDir) throw new VBRuntimeError(53);
    return st.size;
  }

  /** FileDateTime: the modification time, local time. */
  async fileDateTime(path: string): Promise<VBDate> {
    const d = new Date((await this.stat(path)).mtime);
    return dateFrom(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }

  // ---- SaveSetting / GetSetting ----

  getSetting(app: string, section: string, key: string): Promise<string | null> {
    return this.call(a => a.settingGet(app, section, key));
  }
  saveSetting(app: string, section: string, key: string, value: string): Promise<void> {
    return this.call(a => a.settingSave(app, section, key, value));
  }
  deleteSetting(app: string, section: string, key: string | null): Promise<void> {
    return this.call(a => a.settingDelete(app, section, key), 5);
  }
  allSettings(app: string, section: string): Promise<[string, string][]> {
    return this.call(a => a.settingAll(app, section));
  }
}

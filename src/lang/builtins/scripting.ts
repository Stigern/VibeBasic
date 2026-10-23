// The Microsoft Scripting Runtime (scrrun.dll) objects VB6 programs make with CreateObject or New: Dictionary and
// FileSystemObject (with TextStream, File, Folder and the Files / SubFolders collections), and CreateObject itself.
//
// - Dictionary: keys are compared as VB6 does (CompareMode vbBinaryCompare by default: "a" and "A" are two keys; 1 and 1#
//   are one key); reading Item of a missing key adds it with Empty. Add of a used key is 457, Remove of a missing one 32811.
// - FileSystemObject works on the program's files (FileIO: "\" or "/", relative to CurDir); Path is the Mac path. A
//   TextStream is Windows-1252 text like Open ... For Input / Output (Unicode streams are not made).
// - CreateObject knows the ProgIDs registered with defClass(..., true) (ADODB.*, Scripting.*); anything else is 429.

import { VBRuntimeError } from '../errors';
import type { VBObject } from '../host';
import { wildcardMatcher, type FileIO } from '../fileio/fileIO';
import type { FileStat } from '../fileio/fsApi';
import { Empty, EmptyT, NullT, RefContainer, VBArray, VBRecord, dateFrom, isDate, isObject, toBool, toNumber, toStr, type VBValue } from '../values';
import { PROG_IDS, defClass } from './collection';
import { BUILTINS, def, type BuiltinCtx } from './util';

const given = (v: VBValue | undefined): v is VBValue => v !== undefined && !(v instanceof EmptyT);
const plain = (v: VBValue): VBValue => (isObject(v) && v.defaultMember !== undefined ? v.getMember(v.defaultMember, []) : v);
const argc = (args: VBValue[], min: number, max: number): void => { if (args.length < min || args.length > max) throw new VBRuntimeError(450); };

// ---------------------------------------------------------------------------------------------------------------
// Dictionary

const DICT_PARAMS: Record<string, readonly string[]> = { add: ['Key', 'Item'], exists: ['Key'], remove: ['Key'], item: ['Key'], key: ['Key'] };

/** A Dictionary: its items and object keys are counted references (they leave with Remove, RemoveAll, or the Dictionary). */
export class VBDictionary extends RefContainer implements VBObject {
  readonly vbTypeName = 'Dictionary';
  readonly defaultMember = 'Item';
  readonly rawArgs = true;
  private map = new Map<unknown, { key: VBValue; item: VBValue }>();
  private mode = 0;

  protected heldValues(): VBValue[] { return [...this.map.values()].flatMap(e => [e.key, e.item]); }

  paramNames(name: string): readonly string[] | undefined { return DICT_PARAMS[name.toLowerCase()]; }

  /** Adds an entry, holding its key and item. */
  private put(k: unknown, key: VBValue, item: VBValue): void {
    this.keep(key);
    this.keep(item);
    this.map.set(k, { key, item });
  }

  /** The key as stored: an object stays itself (keys compare by identity), anything else is its plain value. */
  private static keyValue(k: VBValue): VBValue { return isObject(k) ? k : plain(k); }

  /** The map key of a VB key: text by CompareMode, numbers by value, an object by reference. */
  private keyOf(k: VBValue): unknown {
    if (isObject(k)) return k.identity ?? k;
    k = plain(k);
    if (typeof k === 'string') return 's' + (this.mode ? k.toLowerCase() : k);
    if (typeof k === 'number') return 'n' + k;
    if (typeof k === 'boolean') return 'b' + k;
    if (isDate(k)) return 'd' + k.serial;
    if (k instanceof EmptyT) return 'e';
    if (k instanceof NullT) return 'z';
    throw new VBRuntimeError(13);
  }

  private static stored(v: VBValue): VBValue { return v instanceof VBArray || v instanceof VBRecord ? v.clone() : v; }

  /** For Each: the keys. */
  items(): VBObject[] { return [...this.map.values()].map(e => e.key) as VBObject[]; }

  hasMember(name: string): boolean { return ['item', 'count', 'comparemode', 'key'].includes(name.toLowerCase()); }

  getMember(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'count': argc(args, 0, 0); return this.map.size;
      case 'comparemode': argc(args, 0, 0); return this.mode;
      case 'item': {
        argc(args, 1, 1);
        const k = this.keyOf(args[0]);
        const e = this.map.get(k);
        if (e) return e.item;
        this.put(k, VBDictionary.keyValue(args[0]), Empty);   // reading a missing key adds it
        return Empty;
      }
      case 'key': throw new VBRuntimeError(450);
    }
    return this.callMethod(name, args);
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    switch (name.toLowerCase()) {
      case 'item': {
        argc(args, 1, 1);
        const k = this.keyOf(args[0]);
        const e = this.map.get(k);
        const item = VBDictionary.stored(value);
        if (e) { const old = e.item; this.keep(item); e.item = item; this.letGo(old); }
        else this.put(k, VBDictionary.keyValue(args[0]), item);
        return;
      }
      case 'key': {   // d.Key(old) = new
        argc(args, 1, 1);
        const old = this.keyOf(args[0]), nk = this.keyOf(value);
        const e = this.map.get(old);
        if (!e) throw new VBRuntimeError(32811);
        if (nk !== old && this.map.has(nk)) throw new VBRuntimeError(457);
        const key = VBDictionary.keyValue(value);
        this.keep(key);
        this.letGo(e.key);
        const entries = [...this.map.entries()].map(([k, v]): [unknown, typeof v] => (k === old ? [nk, { key, item: v.item }] : [k, v]));
        this.map = new Map(entries);
        return;
      }
      case 'comparemode': {
        argc(args, 0, 0);
        if (this.map.size) throw new VBRuntimeError(5);
        const m = toNumber(value);
        if (!(m >= 0)) throw new VBRuntimeError(5);
        this.mode = Math.trunc(m);
        return;
      }
    }
    throw new VBRuntimeError(this.hasMember(name) ? 383 : 438);
  }

  callMethod(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'add': {
        argc(args, 2, 2);
        const k = this.keyOf(args[0]);
        if (this.map.has(k)) throw new VBRuntimeError(457);
        this.put(k, VBDictionary.keyValue(args[0]), VBDictionary.stored(args[1]));
        return Empty;
      }
      case 'exists': argc(args, 1, 1); return this.map.has(this.keyOf(args[0]));
      case 'remove': {
        argc(args, 1, 1);
        const k = this.keyOf(args[0]);
        const e = this.map.get(k);
        if (!e) throw new VBRuntimeError(32811);
        this.map.delete(k);
        this.letGo(e.key);
        this.letGo(e.item);
        return Empty;
      }
      case 'removeall': {
        argc(args, 0, 0);
        const all = this.heldValues();
        this.map.clear();
        for (const v of all) this.letGo(v);
        return Empty;
      }
      case 'keys': case 'items': {
        argc(args, 0, 0);
        const vals = [...this.map.values()].map(e => (name.toLowerCase() === 'keys' ? e.key : e.item));
        const a = new VBArray('Variant', [[0, vals.length - 1]]);
        vals.forEach((v, i) => a.set([i], v));
        return a;
      }
      case 'item': case 'count': case 'comparemode': return this.getMember(name, args);
    }
    throw new VBRuntimeError(438);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// FileSystemObject

const SEP = /[\\/]/;
const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
const lastSep = (p: string): number => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
export const fileNameOf = (p: string): string => { const t = trimSep(p); return t.slice(lastSep(t) + 1).replace(/^[A-Za-z]:$/, ''); };
export const parentOf = (p: string): string => {
  const t = trimSep(p), i = lastSep(t);
  return i < 0 ? '' : i === 0 ? t[0] : t.slice(0, i).replace(/^([A-Za-z]:)$/, '$1\\');
};
const extensionOf = (p: string): string => { const n = fileNameOf(p), i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1); };
const baseNameOf = (p: string): string => { const n = fileNameOf(p), i = n.lastIndexOf('.'); return i < 0 ? n : n.slice(0, i); };
/** BuildPath: the path's own separator ("\" when it has one), else "/". */
const buildPath = (path: string, name: string): string => {
  if (path === '') return name;
  if (SEP.test(path[path.length - 1]) || SEP.test(name[0] ?? '')) return path + name;
  return path + (path.includes('\\') ? '\\' : '/') + name;
};

const mtimeDate = (st: FileStat): VBValue => {
  const d = new Date(st.mtime);
  return dateFrom(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
};

function io(ctx: BuiltinCtx): FileIO {
  if (!ctx.files) throw new VBRuntimeError(68);
  return ctx.files;
}

/** A Files or SubFolders collection: Count, Item(name), For Each. */
class FsItems implements VBObject {
  readonly defaultMember = 'Item';
  constructor(readonly vbTypeName: string, private list: VBObject[]) {}
  items(): VBObject[] { return this.list; }
  hasMember(name: string): boolean { return ['count', 'item'].includes(name.toLowerCase()); }
  getMember(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'count': argc(args, 0, 0); return this.list.length;
      case 'item': {
        argc(args, 1, 1);
        const n = toStr(args[0]).toLowerCase();
        const f = this.list.find(x => toStr(x.getMember('Name', [])).toLowerCase() === n);
        if (!f) throw new VBRuntimeError(5);
        return f;
      }
    }
    throw new VBRuntimeError(438);
  }
  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }
  callMethod(name: string, args: VBValue[]): VBValue { return this.getMember(name, args); }
}

abstract class FsEntry implements VBObject {
  abstract readonly vbTypeName: string;
  readonly defaultMember = 'Path';
  constructor(protected ctx: BuiltinCtx, readonly path: string) {}
  protected stat(): Promise<FileStat> {
    return io(this.ctx).statOf(this.path).then(st => { if (!st) throw new VBRuntimeError(this.vbTypeName === 'File' ? 53 : 76); return st; });
  }
  protected abstract more(l: string): VBValue | Promise<VBValue> | undefined;
  hasMember(name: string): boolean {
    return ['name', 'path', 'parentfolder', 'datelastmodified', 'datecreated', 'datelastaccessed', 'attributes', 'size',
      'shortname', 'shortpath', 'files', 'subfolders', 'isrootfolder', 'type'].includes(name.toLowerCase());
  }
  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) return this.callMethod(name, args) as VBValue;
    argc(args, 0, 0);
    switch (l) {
      case 'name': case 'shortname': return fileNameOf(this.path);
      case 'path': case 'shortpath': return this.path;
      case 'parentfolder': return this.path === '/' ? Empty : new FsFolder(this.ctx, parentOf(this.path));
      case 'datelastmodified': case 'datecreated': case 'datelastaccessed': return this.stat().then(mtimeDate) as unknown as VBValue;
      case 'attributes':
        return this.stat().then(st => (st.readOnly ? 1 : 0) | (st.hidden ? 2 : 0) | (st.isDir ? 16 : 32)) as unknown as VBValue;
    }
    const v = this.more(l);
    if (v === undefined) throw new VBRuntimeError(438);
    return v as VBValue;
  }
  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }
  abstract callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue>;
}

class FsFile extends FsEntry {
  readonly vbTypeName = 'File';
  protected more(l: string): VBValue | Promise<VBValue> | undefined {
    if (l === 'size') return this.stat().then(st => st.size);
    if (l === 'type') return extensionOf(this.path) ? `${extensionOf(this.path).toUpperCase()} File` : 'File';
    return undefined;
  }
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const f = io(this.ctx);
    switch (name.toLowerCase()) {
      case 'delete': argc(args, 0, 1); return f.kill(this.path).then(() => Empty);
      case 'copy': argc(args, 1, 2); return copyFile(this.ctx, this.path, toStr(args[0]), args[1]);
      case 'move': argc(args, 1, 1); return moveFile(this.ctx, this.path, toStr(args[0]));
      case 'openastextstream': argc(args, 0, 2); return openText(this.ctx, this.path, args[0], true);
    }
    if (this.hasMember(name)) return this.getMember(name, args);
    throw new VBRuntimeError(438);
  }
}

class FsFolder extends FsEntry {
  readonly vbTypeName = 'Folder';
  protected more(l: string): VBValue | Promise<VBValue> | undefined {
    switch (l) {
      case 'isrootfolder': return this.path === '/';
      case 'type': return 'File Folder';
      case 'files': case 'subfolders':
        return io(this.ctx).listing(this.path).then(ls => (l === 'files'
          ? new FsItems('Files', ls.files.map(x => new FsFile(this.ctx, buildPath(this.path, x.name))))
          : new FsItems('Folders', ls.dirs.map(d => new FsFolder(this.ctx, buildPath(this.path, d))))));
      case 'size': return folderSize(this.ctx, this.path);
    }
    return undefined;
  }
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    switch (name.toLowerCase()) {
      case 'delete': argc(args, 0, 1); return deleteFolder(this.ctx, this.path, args[0]);
      case 'createtextfile': argc(args, 1, 3); return createText(this.ctx, buildPath(this.path, toStr(args[0])), args[1]);
    }
    if (this.hasMember(name)) return this.getMember(name, args);
    throw new VBRuntimeError(438);
  }
}

/** A text file opened by OpenTextFile / CreateTextFile: read or written in one direction. */
class TextStream implements VBObject {
  readonly vbTypeName = 'TextStream';
  private col = 1;
  private lines = 1;
  constructor(private f: FileIO, private num: number, private reading: boolean) {}

  private reader() { if (!this.reading) throw new VBRuntimeError(54); return this.f.reader(this.num); }
  private write(text: string): VBValue | Promise<VBValue> {
    if (this.reading) throw new VBRuntimeError(54);
    const i = Math.max(text.lastIndexOf('\n'), -1);
    this.lines += text.split('\n').length - 1;
    this.col = i < 0 ? this.col + text.length : text.length - i;
    const r = this.f.writeText(this.num, text, 0);
    return r instanceof Promise ? r.then(() => Empty) : Empty;
  }

  hasMember(name: string): boolean { return ['atendofstream', 'atendofline', 'line', 'column'].includes(name.toLowerCase()); }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!this.hasMember(l)) return this.callMethod(name, args) as VBValue;
    argc(args, 0, 0);
    if (!this.reading) {
      if (l === 'line') return this.lines;
      if (l === 'column') return this.col;
      throw new VBRuntimeError(54);
    }
    const r = this.reader(), t = r.text;
    switch (l) {
      case 'atendofstream': return r.eof;
      case 'atendofline': return r.eof || t[r.pos] === '\r' || t[r.pos] === '\n';
      case 'line': return (t.slice(0, r.pos).match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
      default: return r.pos - Math.max(t.lastIndexOf('\n', r.pos - 1), t.lastIndexOf('\r', r.pos - 1));
    }
  }

  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    switch (name.toLowerCase()) {
      case 'readline': argc(args, 0, 0); return this.reader().line();
      case 'skipline': argc(args, 0, 0); this.reader().line(); return Empty;
      case 'readall': {
        argc(args, 0, 0);
        const r = this.reader();
        if (r.eof) throw new VBRuntimeError(62);
        const s = r.text.slice(r.pos);
        r.pos = r.text.length;
        return s;
      }
      case 'read': case 'skip': {
        argc(args, 1, 1);
        const r = this.reader(), n = Math.max(0, Math.trunc(toNumber(args[0])));
        if (r.eof) throw new VBRuntimeError(62);
        const s = r.chars(Math.min(n, r.text.length - r.pos));
        return name.toLowerCase() === 'read' ? s : Empty;
      }
      case 'write': argc(args, 1, 1); return this.write(toStr(args[0]));
      case 'writeline': argc(args, 0, 1); return this.write((args.length ? toStr(args[0]) : '') + '\r\n');
      case 'writeblanklines': argc(args, 1, 1); return this.write('\r\n'.repeat(Math.max(0, Math.trunc(toNumber(args[0])))));
      case 'close': argc(args, 0, 0); return this.f.closeStream(this.num).then(() => Empty);
    }
    if (this.hasMember(name)) return this.getMember(name, args);
    throw new VBRuntimeError(438);
  }
}

async function exists(ctx: BuiltinCtx, path: string): Promise<FileStat | null> {
  return io(ctx).statOf(path);
}

/** OpenTextFile path, [IOMode ForReading 1 | ForWriting 2 | ForAppending 8], [Create]. */
async function openText(ctx: BuiltinCtx, path: string, ioMode: VBValue | undefined, create: VBValue | boolean | undefined): Promise<VBValue> {
  const f = io(ctx);
  const m = given(ioMode) ? toNumber(ioMode) : 1;
  if (m !== 1 && m !== 2 && m !== 8) throw new VBRuntimeError(5);
  const st = await exists(ctx, path);
  if (st?.isDir) throw new VBRuntimeError(70);
  if (!st && (m === 1 || !(given(create) && toBool(create)))) throw new VBRuntimeError(53);
  const num = await f.openStream(path, m === 1 ? 'input' : m === 2 ? 'output' : 'append');
  return new TextStream(f, num, m === 1);
}

/** CreateTextFile path, [Overwrite = True]: 58 when the file is there and Overwrite is False. */
async function createText(ctx: BuiltinCtx, path: string, overwrite: VBValue | undefined): Promise<VBValue> {
  const f = io(ctx);
  const st = await exists(ctx, path);
  if (st && (st.isDir || (given(overwrite) && !toBool(overwrite)))) throw new VBRuntimeError(58);
  return new TextStream(f, await f.openStream(path, 'output'), false);
}

/** A destination that ends in "\" or "/" (or any destination of a wildcard source) is a folder: the file keeps its name there. */
const target = (from: string, to: string, folder: boolean): string =>
  (SEP.test(to[to.length - 1] ?? '') ? to + fileNameOf(from) : folder ? buildPath(to, fileNameOf(from)) : to);

/**
 * The files a CopyFile / MoveFile source names: a wildcard (`*`, `?`) in its last part matches the files of that folder
 * (none: 53); `folder` is then true (the destination must be a folder that exists, else 76).
 */
async function sourceFiles(ctx: BuiltinCtx, from: string, to: string): Promise<{ files: string[]; folder: boolean }> {
  const name = fileNameOf(from);
  if (!/[*?]/.test(name)) return { files: [from], folder: false };
  const dir = parentOf(from);
  const ls = await io(ctx).listing(dir || '.');
  const match = wildcardMatcher(name);
  const files = ls.files.map(x => x.name).filter(match).map(n => buildPath(dir, n));
  if (files.length === 0) throw new VBRuntimeError(53);
  if (!(await exists(ctx, to))?.isDir) throw new VBRuntimeError(76);
  return { files, folder: true };
}

async function copyFile(ctx: BuiltinCtx, from: string, to: string, overwrite: VBValue | undefined): Promise<VBValue> {
  const { files, folder } = await sourceFiles(ctx, from, to);
  for (const file of files) {
    const dest = target(file, to, folder);
    if (given(overwrite) && !toBool(overwrite) && await exists(ctx, dest)) throw new VBRuntimeError(58);
    await io(ctx).fileCopy(file, dest);
  }
  return Empty;
}

async function moveFile(ctx: BuiltinCtx, from: string, to: string): Promise<VBValue> {
  const { files, folder } = await sourceFiles(ctx, from, to);
  for (const file of files) {
    const dest = target(file, to, folder);
    if (await exists(ctx, dest)) throw new VBRuntimeError(58);
    await io(ctx).rename(file, dest);
  }
  return Empty;
}

/** DeleteFolder / Folder.Delete: the folder with everything in it (Force: read-only files too). */
async function deleteFolder(ctx: BuiltinCtx, path: string, force: VBValue | undefined): Promise<VBValue> {
  const f = io(ctx);
  const ls = await f.listing(path);
  for (const file of ls.files) {
    const p = buildPath(path, file.name);
    if (given(force) && toBool(force)) await f.setAttr(p, 0).catch(() => {});
    await f.kill(p);
  }
  for (const d of ls.dirs) await deleteFolder(ctx, buildPath(path, d), force);
  await f.rmDir(path);
  return Empty;
}

/** Folder.Size: the bytes of every file in the folder and its subfolders. */
async function folderSize(ctx: BuiltinCtx, path: string): Promise<number> {
  const f = io(ctx);
  const ls = await f.listing(path);
  let n = 0;
  for (const file of ls.files) n += (await f.statOf(buildPath(path, file.name)))?.size ?? 0;
  for (const d of ls.dirs) n += await folderSize(ctx, buildPath(path, d));
  return n;
}

export class FileSystemObject implements VBObject {
  readonly vbTypeName = 'FileSystemObject';
  constructor(private ctx: BuiltinCtx) {}
  hasMember(): boolean { return false; }
  getMember(name: string, args: VBValue[]): VBValue { return this.callMethod(name, args) as VBValue; }
  setMember(): void { throw new VBRuntimeError(438); }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const s = (i: number): string => toStr(args[i]);
    const f = io(this.ctx), ctx = this.ctx;
    switch (name.toLowerCase()) {
      case 'fileexists': argc(args, 1, 1); return exists(ctx, s(0)).then(st => st !== null && !st.isDir);
      case 'folderexists': argc(args, 1, 1); return exists(ctx, s(0)).then(st => st !== null && st.isDir);
      case 'getfile': argc(args, 1, 1); return exists(ctx, s(0)).then(st => {
        if (!st || st.isDir) throw new VBRuntimeError(53);
        return new FsFile(ctx, f.resolve(s(0)));
      });
      case 'getfolder': argc(args, 1, 1); return exists(ctx, s(0)).then(st => {
        if (!st?.isDir) throw new VBRuntimeError(76);
        return new FsFolder(ctx, f.resolve(s(0)));
      });
      case 'createtextfile': argc(args, 1, 3); return createText(ctx, s(0), args[1]);
      case 'opentextfile': argc(args, 1, 4); return openText(ctx, s(0), args[1], args[2]);
      case 'deletefile': argc(args, 1, 2); return f.kill(s(0)).then(() => Empty);
      case 'deletefolder': argc(args, 1, 2); return exists(ctx, s(0)).then(st => {
        if (!st?.isDir) throw new VBRuntimeError(76);
        return deleteFolder(ctx, s(0), args[1]);
      });
      case 'createfolder': argc(args, 1, 1); return exists(ctx, s(0)).then(async st => {
        if (st) throw new VBRuntimeError(58);
        await f.mkDir(s(0));
        return new FsFolder(ctx, f.resolve(s(0)));
      });
      case 'copyfile': argc(args, 2, 3); return copyFile(ctx, s(0), s(1), args[2]);
      case 'movefile': argc(args, 2, 2); return moveFile(ctx, s(0), s(1));
      case 'getparentfoldername': argc(args, 1, 1); return parentOf(s(0));
      case 'getfilename': argc(args, 1, 1); return fileNameOf(s(0));
      case 'getbasename': argc(args, 1, 1); return baseNameOf(s(0));
      case 'getextensionname': argc(args, 1, 1); return extensionOf(s(0));
      case 'buildpath': argc(args, 2, 2); return buildPath(s(0), s(1));
      case 'getabsolutepathname': argc(args, 1, 1); return f.resolve(s(0));
      case 'gettempname': argc(args, 0, 0); return `rad${Math.floor(Math.random() * 0xfffff).toString(16).toUpperCase().padStart(5, '0')}.tmp`;
    }
    throw new VBRuntimeError(438);
  }
}

defClass(['Scripting.Dictionary', 'Dictionary'], () => new VBDictionary(), true);
defClass(['Scripting.FileSystemObject', 'FileSystemObject'], ctx => new FileSystemObject(ctx), true);

/** CreateObject(Class, [ServerName]): an object of a known ProgID; 429 for any other. */
def('CreateObject', 1, 2, (args, ctx) => {
  if (given(args[1]) && toStr(args[1]) !== '') throw new VBRuntimeError(462);
  const c = PROG_IDS.get(toStr(args[0]).trim().toLowerCase());
  if (!c) throw new VBRuntimeError(429);
  return c.create(ctx);
});
BUILTINS.get('createobject')!.params = ['Class', 'ServerName'];

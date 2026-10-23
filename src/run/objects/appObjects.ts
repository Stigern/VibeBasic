// Host globals of a running program: App, Screen and the Picture objects LoadPicture returns (Forms and Clipboard: globalObjects.ts).

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { optInt } from '../../lang/builtins/util';
import { Empty, Nothing, toStr, type VBValue } from '../../lang/values';
import { DEFAULT_VERSION, type PictureRef, type VersionInfo } from '../../model/types';

/** Any picture value carries its asset reference; `null` is an empty picture (`LoadPicture("")`). */
export interface HasPictureRef { pictureRef: PictureRef | null }

/**
 * A Picture: what `Picture1.Picture` reads and LoadPicture returns. `pictureRef.asset` is a project asset key,
 * or a data URL for a picture loaded at run time (the form window shows that URL directly).
 */
export class PictureObject implements VBObject, HasPictureRef {
  readonly vbTypeName = 'Picture';
  constructor(readonly pictureRef: PictureRef | null) {}
  hasMember(name: string): boolean { return name.toLowerCase() === 'handle'; }
  getMember(name: string): VBValue {
    if (name.toLowerCase() === 'handle') return this.pictureRef ? 1 : 0;
    throw new VBRuntimeError(438);
  }
  setMember(): void { throw new VBRuntimeError(438); }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

/** A tiny read/write property bag; names are case-insensitive, `readOnly` ones give 383. */
abstract class PropObject implements VBObject {
  abstract readonly vbTypeName: string;
  protected abstract props(): Record<string, () => VBValue>;
  protected setters: Record<string, (v: VBValue) => void> = {};
  hasMember(name: string): boolean { return name.toLowerCase() in this.props(); }
  getMember(name: string, args: VBValue[]): VBValue {
    const g = this.props()[name.toLowerCase()];
    if (!g) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    return g();
  }
  setMember(name: string, _args: VBValue[], value: VBValue): void {
    const l = name.toLowerCase();
    if (!(l in this.props())) throw new VBRuntimeError(438);
    const s = this.setters[l];
    if (!s) throw new VBRuntimeError(383);
    s(value);
  }
  callMethod(_name: string, _args: VBValue[]): VBValue | Promise<VBValue> { throw new VBRuntimeError(438); }
}

/** App.LogEvent's event types (vbLogEventTypeError 1, Warning 2, Information 4) as the log file names them. */
const LOG_TYPES: Record<number, string> = { 1: 'Error', 2: 'Warning', 4: 'Information' };

/** A log line: local time, the event type and the text (line ends in it become spaces). */
export function logLine(text: string, type: number, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const t = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  return `${t}\t${LOG_TYPES[type] ?? 'Information'}\t${text.replace(/\r\n|[\r\n]/g, ' ')}`;
}

export interface AppInfo {
  title: string; path: string; exeName: string;
  version?: VersionInfo;
  /** App.LogEvent: writes one line to the log (absent: LogEvent does nothing, as in VB6's IDE). */
  log?: (line: string) => Promise<void>;
}

export class AppObject extends PropObject {
  readonly vbTypeName = 'App';
  title: string;
  /** App.PrevInstance; the session sets it before the program starts. */
  prevInstance = false;
  constructor(private info: AppInfo) {
    super();
    this.title = info.title;
    this.setters = { title: v => { this.title = toStr(v); } };
  }
  protected props(): Record<string, () => VBValue> {
    const v = this.info.version ?? DEFAULT_VERSION;
    return {
      title: () => this.title, path: () => this.info.path, exename: () => this.info.exeName, previnstance: () => this.prevInstance,
      major: () => v.major, minor: () => v.minor, revision: () => v.revision,
      comments: () => v.comments ?? '', companyname: () => v.companyName ?? '', filedescription: () => v.fileDescription ?? '',
      legalcopyright: () => v.legalCopyright ?? '', legaltrademarks: () => v.legalTrademarks ?? '', productname: () => v.productName ?? '',
    };
  }
  override hasMember(name: string): boolean { return name.toLowerCase() === 'logevent' || super.hasMember(name); }
  override callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    if (name.toLowerCase() !== 'logevent') throw new VBRuntimeError(438);
    if (args.length < 1 || args.length > 2 || args[0] === undefined) throw new VBRuntimeError(450);
    const line = logLine(toStr(args[0]), optInt(args[1], 4));
    return this.info.log ? this.info.log(line).then(() => Empty, () => { throw new VBRuntimeError(75); }) : Empty;
  }
}

export class ScreenObject extends PropObject {
  readonly vbTypeName = 'Screen';
  private mousePointer: VBValue = 0;
  /** `active` gives the form that was activated last and its control with the focus (Nothing when there is none). */
  constructor(private active: { form(): VBValue; control(): VBValue } = { form: () => Nothing, control: () => Nothing }) {
    super();
    this.setters = { mousepointer: v => { this.mousePointer = v; } };   // accepted and ignored
  }
  protected props(): Record<string, () => VBValue> {
    const scr = typeof screen !== 'undefined' ? screen : { width: 1024, height: 768 };
    return {
      width: () => (scr.width || 1024) * 15, height: () => (scr.height || 768) * 15, mousepointer: () => this.mousePointer,
      activeform: () => this.active.form(), activecontrol: () => this.active.control(),
    };
  }
}

// Host interface for the VibeBasic language core: the object protocol that
// `VBValue` needs (VBObject) and the services the interpreter asks its host
// for (dialogs, Debug.Print, error and break reporting).

import type { VBValue } from './values';
import type { VBRuntimeError } from './errors';
import type { FileSystemApi } from './fileio/fsApi';

/**
 * A host object (form, control, App …). Contract the interpreter relies on:
 * - `hasMember` and `getMember` are cheap and free of side effects (they
 *   may be asked while resolving names; a Let to `obj.name` reads first);
 * - `callMethod` throws VBRuntimeError(438) for a method it does not have
 *   (in a form's code an undeclared `Foo args` is tried as `Me.Foo args`
 *   and 438 there becomes "Sub or Function not defined");
 * - a plain JS error thrown (or rejected) by any of these becomes VB error 51.
 */
export interface VBObject {
  readonly vbTypeName: string;            // "TextBox", "Form" …
  readonly defaultMember?: string;        // "Text" for TextBox, "Caption" for Label
  /** Method arguments are passed as they are: an object argument is not turned into its default member (Collection.Add). */
  readonly rawArgs?: boolean;
  hasMember(name: string): boolean;
  getMember(name: string, args: VBValue[]): VBValue;              // also indexed: List1.List(2)
  /** A Promise: the write finishes later and the statement waits for it. */
  setMember(name: string, args: VBValue[], value: VBValue): void | Promise<void>;
  /** `refs[i]` is the by-reference slot of argument i when `byRefArgs(name)` lists i and the caller passed a variable (else undefined). */
  callMethod(name: string, args: VBValue[], refs?: (OutSlot | undefined)[]): VBValue | Promise<VBValue>;
  /** The 0-based positions of a method's ByRef parameters (`Winsock1.GetData data`); the method writes to them through `refs`. */
  byRefArgs?(name: string): readonly number[] | undefined;
  /** `Load Name(i)` / `Unload Name(i)` of a control array element (a control array object only). */
  loadElement?(index: number): void | Promise<void>;
  unloadElement?(index: number): void | Promise<void>;
  item?(index: number): VBObject;         // control arrays: Command1(2)
  /** The elements for `For Each` (a control array's controls in index order, a collection's items). */
  items?(): VBObject[];
  /** Print, PSet, Line, Circle and Scale on this object (Form, PictureBox, Printer); absent: error 438. */
  graphics?(call: GraphicsCall): void | Promise<void>;
}

/** One piece of a Print statement on an object: text (numbers already formatted), `Spc(n)`, `Tab(n)` or the next print zone (`,`). */
export type PrintPiece = string | { spc: number } | { tab: number } | { zone: true };
export interface GfxCallPoint { step: boolean; x: number; y: number }
/** A drawing statement with its arguments evaluated (see GfxStmt). Absent colour: ForeColor. */
export type GraphicsCall =
  | { method: 'print'; pieces: PrintPiece[]; newline: boolean }
  | { method: 'pset'; at: GfxCallPoint; color?: number }
  | { method: 'line'; from?: GfxCallPoint; to: GfxCallPoint; color?: number; box: '' | 'b' | 'bf' }
  | { method: 'circle'; at: GfxCallPoint; radius: number; color?: number; start?: number; end?: number; aspect?: number }
  | { method: 'scale'; from?: GfxCallPoint; to?: GfxCallPoint };

/** A by-reference argument of a host method: assigning `value` stores into the caller's variable (converted to its type). */
export interface OutSlot { value: VBValue }

/** Where code is running: module, procedure (`''` when none) and 1-based source line. */
export interface CodeLocation { moduleName: string; procName: string; line: number }

export interface BreakInfo { reason: 'error' | 'pause'; at: CodeLocation; error?: VBRuntimeError }

export interface Host {
  /**
   * "Me", "Command1" in Form1, "Form2", "App"; `undefined` if the host does
   * not know the name. Must be cheap and free of side effects. In a form's
   * procedures it is asked (with `'Me'` too, for `hasMember`) before global
   * Public names and built-ins: the form's controls and properties win there
   * (`Caption = "x"`, `Width`, `Hide`).
   */
  resolveName(moduleName: string, name: string): VBObject | undefined;
  msgBox(prompt: string, buttons: number, title: string): Promise<number>;
  inputBox(prompt: string, title: string, defaultText: string): Promise<string>;
  /** One Debug.Print statement; `newline` is false after a trailing `;` or `,`. */
  debugPrint(text: string, newline: boolean): void;
  doEvents(): Promise<void>;
  /** Beep: the system beep (a short tone); a host without sound may leave it out. */
  beep?(): void;
  loadPicture(path: string): Promise<VBValue>;
  /** SavePicture: the file bytes of a picture (`ext` the file's extension, lower case: an Image is BMP for 'bmp', else PNG);
   *  throws 481 when the value is not a picture. Absent: error 481. */
  pictureBytes?(picture: VBValue, ext: string): Uint8Array;
  /** An unhandled run-time (or compile) error; `'end'` ends the program, `'debug'` enters break mode. */
  onRuntimeError(err: VBRuntimeError, at: CodeLocation): Promise<'end' | 'debug'>;
  onBreak(info: BreakInfo): Promise<'continue' | 'end'>;
  /** The program has ended (called once). */
  onEnd(): void;
  /** File I/O and SaveSetting (Open, Kill, Dir ...). Absent: those statements raise error 68, Device unavailable. */
  fileSystem?(): FileSystemApi | undefined;
}

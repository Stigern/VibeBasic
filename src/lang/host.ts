// Host interface for the VibeBasic language core: the object protocol that
// `VBValue` needs (VBObject) and the services the interpreter asks its host
// for (dialogs, Debug.Print, error and break reporting).

import type { VBValue } from './values';
import type { VBRuntimeError } from './errors';

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
  hasMember(name: string): boolean;
  getMember(name: string, args: VBValue[]): VBValue;              // also indexed: List1.List(2)
  setMember(name: string, args: VBValue[], value: VBValue): void;
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue>;
  item?(index: number): VBObject;         // control arrays: Command1(2)
  /** The elements for `For Each` (a control array's controls in index order, a collection's items). */
  items?(): VBObject[];
}

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
  loadPicture(path: string): Promise<VBValue>;
  /** An unhandled run-time (or compile) error; `'end'` ends the program, `'debug'` enters break mode. */
  onRuntimeError(err: VBRuntimeError, at: CodeLocation): Promise<'end' | 'debug'>;
  onBreak(info: BreakInfo): Promise<'continue' | 'end'>;
  /** The program has ended (called once). */
  onEnd(): void;
}

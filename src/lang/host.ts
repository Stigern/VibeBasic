// Host interface for the VibeBasic language core: the object protocol that
// `VBValue` needs (VBObject) and the services the interpreter asks its host
// for (dialogs, Debug.Print, error and break reporting).

import type { VBValue } from './values';
import type { VBRuntimeError } from './errors';

export interface VBObject {
  readonly vbTypeName: string;            // "TextBox", "Form" …
  readonly defaultMember?: string;        // "Text" for TextBox, "Caption" for Label
  hasMember(name: string): boolean;
  getMember(name: string, args: VBValue[]): VBValue;              // also indexed: List1.List(2)
  setMember(name: string, args: VBValue[], value: VBValue): void;
  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue>;
  item?(index: number): VBObject;         // control arrays: Command1(2)
}

/** Where code is running: module, procedure (`''` when none) and 1-based source line. */
export interface CodeLocation { moduleName: string; procName: string; line: number }

export interface BreakInfo { reason: 'error' | 'pause'; at: CodeLocation; error?: VBRuntimeError }

export interface Host {
  /** "Me", "Command1" in Form1, "Form2", "App"; `undefined` if the host does not know the name. */
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

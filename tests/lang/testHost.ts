/// <reference types="vite/client" />
// Test host for the interpreter: records Debug.Print output, MsgBox prompts
// and unhandled errors as text lines, and runs golden programs.

import type { BreakInfo, CodeLocation, Host, VBObject } from '../../src/lang/host';
import type { VBRuntimeError } from '../../src/lang/errors';
import { Nothing, type VBValue } from '../../src/lang/values';
import { Program, type ProgramOptions } from '../../src/lang/interp/program';

export class TestHost implements Host {
  /** Debug.Print lines, `[MsgBox] <prompt>` and `[Error <n> at <Module>:<line>] <text>`. */
  output: string[] = [];
  /** Answers for MsgBox, used in order (default vbOK = 1). */
  msgBoxAnswers: number[] = [];
  /** Answers for InputBox, used in order (default: the default text). */
  inputBoxAnswers: string[] = [];
  /** What to answer when an unhandled run-time error happens. */
  errorChoice: 'end' | 'debug' = 'end';
  /** Objects returned by `resolveName`, keyed by lower-case name. */
  objects = new Map<string, VBObject>();
  /** Every `onBreak` call. */
  breaks: BreakInfo[] = [];
  /** What `onBreak` answers; 'wait' leaves it pending until `answerBreak` (or forever). */
  breakChoice: 'continue' | 'end' | 'wait' = 'end';
  /** When set, answers every `onBreak` instead of `breakChoice` (e.g. to use the Immediate window first). */
  breakHook?: (info: BreakInfo) => Promise<string> | string;
  endCalls = 0;
  private breaksTaken = 0;
  private readonly breakWaiters = new Map<number, (info: BreakInfo) => void>();
  private pendingBreak?: (answer: 'continue' | 'end') => void;
  /** Text of a Debug.Print line that ended with `;` or `,`. */
  private partial = '';

  resolveName(_moduleName: string, name: string): VBObject | undefined {
    return this.objects.get(name.toLowerCase());
  }

  async msgBox(prompt: string, _buttons: number, _title: string): Promise<number> {
    this.flush();
    this.output.push(`[MsgBox] ${prompt}`);
    return this.msgBoxAnswers.shift() ?? 1;
  }

  async inputBox(_prompt: string, _title: string, defaultText: string): Promise<string> {
    return this.inputBoxAnswers.shift() ?? defaultText;
  }

  debugPrint(text: string, newline: boolean): void {
    this.partial += text;
    if (newline) {
      this.output.push(this.partial);
      this.partial = '';
    }
  }

  async doEvents(): Promise<void> {}

  async loadPicture(_path: string): Promise<VBValue> {
    return Nothing;
  }

  async onRuntimeError(err: VBRuntimeError, at: CodeLocation): Promise<'end' | 'debug'> {
    this.flush();
    const text = err.compile ? `Compile error: ${err.description}` : err.description;
    this.output.push(`[Error ${err.number} at ${at.moduleName}:${at.line}] ${text}`);
    return this.errorChoice;
  }

  async onBreak(info: BreakInfo): Promise<'continue' | 'end'> {
    this.breaks.push(info);
    this.breakWaiters.get(this.breaks.length - 1)?.(info);
    if (this.breakHook) return (await this.breakHook(info)) as 'continue' | 'end';
    if (this.breakChoice === 'wait') return new Promise(resolve => { this.pendingBreak = resolve; });
    return this.breakChoice;
  }

  /** The next `onBreak` call not yet taken by an earlier `nextBreak()` (resolves at once if it already happened). */
  nextBreak(): Promise<BreakInfo> {
    const i = this.breaksTaken++;
    if (i < this.breaks.length) return Promise.resolve(this.breaks[i]);
    return new Promise(resolve => this.breakWaiters.set(i, resolve));
  }

  /** Answers an `onBreak` left pending by `breakChoice = 'wait'`. */
  answerBreak(answer: 'continue' | 'end'): void {
    const p = this.pendingBreak;
    this.pendingBreak = undefined;
    p?.(answer);
  }

  onEnd(): void {
    this.endCalls++;
  }

  /** Output lines, including an unfinished Debug.Print line. */
  lines(): string[] {
    return this.partial ? [...this.output, this.partial] : [...this.output];
  }

  private flush(): void {
    if (this.partial) {
      this.output.push(this.partial);
      this.partial = '';
    }
  }
}

const SOURCES = import.meta.glob('./programs/*.bas', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Source of a golden program by file name (`05-procs.bas`) or path ending in it. */
export function goldenSource(basFile: string): string {
  const base = basFile.split(/[\\/]/).pop()!;
  const src = SOURCES[`./programs/${base}`];
  if (src === undefined) throw new Error(`No golden program ${base}`);
  return src;
}

/** Names of all golden programs (`01-arith.bas`, ...). */
export function goldenFiles(): string[] {
  return Object.keys(SOURCES).map(k => k.slice('./programs/'.length)).sort();
}

export const TEST_OPTIONS: ProgramOptions = { locale: 'en-US' };

/** Makes `Module1` from the file, runs `Main` and returns the output lines joined with `\n`. */
export async function runGolden(basFile: string): Promise<string> {
  const host = new TestHost();
  const prog = new Program([{ name: 'Module1', kind: 'module', source: goldenSource(basFile) }], host, TEST_OPTIONS);
  await prog.runEvent('Module1', 'Main');
  return host.lines().join('\n');
}

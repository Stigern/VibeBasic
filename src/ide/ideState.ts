// Shared IDE state. Designer, Properties, Project Explorer, code windows and the run controller (plan 03)
// read it and listen for changes; they change the project only through `stack` (commands).
import { CommandStack } from '../model/commands';
import { newProject } from '../model/controls';
import type { ControlType, Project } from '../model/types';

export type ActiveView = { kind: 'designer'; formId: string } | { kind: 'code'; itemId: string } | { kind: 'none' };
export type IdeEvent = 'project' | 'selection' | 'activeView' | 'mode' | 'options' | 'tool' | 'closeWindows' | 'codeSelection' | 'breakpoints';
export interface IdeOptions {
  autoSyntaxCheck: boolean; requireVariableDeclaration: boolean;
  showGrid: boolean; gridWidth: number; gridHeight: number; alignToGrid: boolean;
}
/** Code a new form/module starts with when "Require Variable Declaration" is on. */
export const OPTION_EXPLICIT = 'Option Explicit\n';
export const DEFAULT_OPTIONS: IdeOptions = {
  autoSyntaxCheck: true, requireVariableDeclaration: false, showGrid: true, gridWidth: 120, gridHeight: 120, alignToGrid: true,
};

export class IdeState {
  project: Project;
  filePath: string | null = null;
  stack: CommandStack;
  /** Empty `ids` means the form itself. */
  selection: { formId: string; ids: string[] } | null = null;
  activeView: ActiveView = { kind: 'none' };
  /** True while the active code window has a non-empty text selection (Edit > Cut / Copy / Delete). */
  codeHasSelection = false;
  currentTool: ControlType | 'Pointer' = 'Pointer';
  /** Plan 03 sets run / break. */
  mode: 'design' | 'run' | 'break' = 'design';
  /** True while Make runs: Make and Run are disabled. */
  busy = false;
  options: IdeOptions = { ...DEFAULT_OPTIONS };
  controlsLocked = false;
  /** True while any code window (open or closed) has a breakpoint (Debug > Clear All Breakpoints). */
  hasBreakpoints = false;
  /** Form/module selected in the Project Explorer (target of Project > Remove). */
  explorerItemId: string | null = null;
  private listeners: Record<string, (() => void)[]> = {};

  constructor(project: Project = newProject()) {
    this.project = project;
    this.stack = this.makeStack();
  }

  private makeStack(): CommandStack { return new CommandStack(() => this.project, () => this.emit('project')); }

  /** Returns a function that removes the listener again. */
  on(event: IdeEvent, cb: () => void): () => void {
    (this.listeners[event] ??= []).push(cb);
    return () => { this.listeners[event] = (this.listeners[event] ?? []).filter(x => x !== cb); };
  }
  emit(event: IdeEvent): void { for (const cb of [...(this.listeners[event] ?? [])]) cb(); }

  /** Replaces the project (New / Open) with a fresh undo stack and clears selection and view. */
  setProject(project: Project, filePath: string | null = null): void {
    this.emit('closeWindows');   // designer and code windows of the old project close before it is replaced
    this.project = project;
    this.filePath = filePath;
    this.stack = this.makeStack();
    this.selection = null;
    this.explorerItemId = null;
    this.activeView = { kind: 'none' };
    this.emit('project');
    this.emit('selection');
    this.emit('activeView');
  }
  /** Explorer selection if it still exists, else the item of the active view, else the first form. */
  currentItemId(): string | null {
    const exists = (id: string | null) => !!id && (this.project.forms.some(f => f.id === id) || this.project.modules.some(m => m.id === id));
    if (exists(this.explorerItemId)) return this.explorerItemId;
    const v = this.activeView;
    const id = v.kind === 'designer' ? v.formId : v.kind === 'code' ? v.itemId : null;
    return exists(id) ? id : this.project.forms[0]?.id ?? null;
  }
  setSelection(sel: { formId: string; ids: string[] } | null): void { this.selection = sel; this.emit('selection'); }
  setActiveView(v: ActiveView): void { this.activeView = v; this.emit('activeView'); }
  setCodeSelection(has: boolean): void { if (this.codeHasSelection === has) return; this.codeHasSelection = has; this.emit('codeSelection'); }
  /** A breakpoint was set or cleared somewhere (the run controller passes them to a running program). */
  breakpointsChanged(any: boolean): void { this.hasBreakpoints = any; this.emit('breakpoints'); }
  setMode(m: 'design' | 'run' | 'break'): void { this.mode = m; this.emit('mode'); }
  setBusy(b: boolean): void { this.busy = b; this.emit('mode'); }
  /** Selecting a tool; `Pointer` resets. */
  setTool(t: ControlType | 'Pointer'): void { this.currentTool = t; this.emit('tool'); }
  setOptions(o: Partial<IdeOptions>): void { this.options = { ...this.options, ...o }; this.emit('options'); }
}

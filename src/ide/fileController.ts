// File operations (New / Open / Save / Save As / Exit), the "Save changes?" prompt, and the VB6 import: Open Project with a .vbp
// and Project > Add File with a .frm / .bas / .cls (model/vb6Import.ts), each followed by the import report when there were problems.
import type { Backend } from '../backend/backend';
import { addAssetCmd, addFormCmd, addModuleCmd, compositeCmd, type Command } from '../model/commands';
import { normalizeComponents, setComponentsCmd } from '../model/components';
import { newProject } from '../model/controls';
import { parseProject, serializeProject } from '../model/serialize';
import { importVb6File, importVbp } from '../model/vb6Import';
import { h } from '../ui98/dom';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { OPTION_EXPLICIT, type IdeState } from './ideState';

const VB_CRITICAL = 16;
const VB_EXCLAMATION = 48;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isVbp = (path: string) => /\.vbp$/i.test(path);
const VB6_FILES = { name: 'Visual Basic Files', extensions: ['frm', 'bas', 'cls'] };

export class FileController {
  /** Called after a project was replaced; main.ts hooks this to open the startup form's designer. */
  onProjectReplaced: (() => void) | null = null;
  /** Called after Project > Add File added a form or module; main.ts opens its designer / code window. */
  onItemAdded: ((id: string) => void) | null = null;

  constructor(private ide: IdeState, private backend: Backend, private doc: Document = document) {}

  private fileName(): string {
    const p = this.ide.filePath;
    return (p ? p.split(/[\\/]/).pop() : '') || `${this.ide.project.name}.vbb`;
  }

  private error(message: string): Promise<number> {
    return messageBox98(this.doc, { prompt: message, title: 'VibeBasic', buttons: VB_CRITICAL });
  }

  /** Replaces the project; setProject first closes all open designer and code windows (no stale editors/snapshots). */
  private replace(project: ReturnType<typeof newProject>, filePath: string | null): void {
    this.ide.setProject(project, filePath);
    this.updateTitle();
  }

  async newProject(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const p = newProject();
    if (this.ide.options.requireVariableDeclaration) p.forms[0].code = OPTION_EXPLICIT;
    this.replace(p, null);
    this.onProjectReplaced?.();
  }

  async open(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const path = await this.backend.openProjectDialog();
    if (!path) return;
    let project, warnings: string[] = [];
    try {
      if (isVbp(path)) ({ project, warnings } = await importVbp(path, p => this.backend.readBinaryFile(p)));
      else project = parseProject(await this.backend.readTextFile(path));
    } catch (e) {
      await this.error(errText(e));
      return;
    }
    // an imported VB6 project opens as a new, unsaved .vbb (Save asks for its name)
    this.replace(project, isVbp(path) ? null : path);
    if (isVbp(path)) this.ide.stack.markDirtyExternal();
    this.onProjectReplaced?.();
    if (warnings.length) await this.importReport(warnings);
  }

  /** Project > Add File: a VB6 .frm (with its .frx), .bas or .cls into the current project, as one undoable step. */
  async addFile(): Promise<void> {
    if (this.ide.mode !== 'design') return;
    const path = await this.backend.openFileDialog([VB6_FILES]);
    if (!path) return;
    const p = this.ide.project;
    let r;
    try {
      // an invalid name, or one the project has already, is changed (the import report says so)
      r = await importVb6File(path, f => this.backend.readBinaryFile(f), [p.name, ...p.forms.map(f => f.name), ...p.modules.map(m => m.name)]);
    } catch (e) {
      await this.error(errText(e));
      return;
    }
    const item = r.forms[0] ?? r.modules[0];
    if (r.forms[0]?.mdi && p.forms.some(f => f.mdi)) {
      await messageBox98(this.doc, { prompt: 'Only one MDI Form allowed', title: 'VibeBasic', buttons: VB_EXCLAMATION });
      return;
    }
    const cmds: Command[] = Object.entries(r.assets).map(([id, a]) => addAssetCmd(id, a));
    const comps = normalizeComponents(p.components, r.components);
    if (comps.length !== p.components.length) cmds.push(setComponentsCmd(comps));
    cmds.push(r.forms[0] ? addFormCmd(r.forms[0]) : addModuleCmd(r.modules[0]));
    this.ide.stack.execute(compositeCmd(`Add ${item.name}`, cmds));
    this.ide.explorerItemId = item.id;
    if (r.forms[0]) this.ide.setSelection({ formId: item.id, ids: [] }); else this.ide.setSelection(null);
    this.onItemAdded?.(item.id);
    if (r.warnings.length) await this.importReport(r.warnings);
  }

  /** The import report: what was left out or will not run. */
  private async importReport(warnings: string[]): Promise<void> {
    const list = h('div', { class: 'dlg98-filelist dlg98-report' }, ...warnings.map(w => h('div', {}, w)));
    await showDialog98(this.doc, {
      title: 'Import Report',
      content: h('div', {}, h('div', { class: 'dlg98-text' }, 'The project was imported. These parts were left out or are not supported:'), list),
      buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }],
    });
  }

  async save(): Promise<boolean> {
    return this.ide.filePath ? this.writeTo(this.ide.filePath) : this.saveAs();
  }

  async saveAs(): Promise<boolean> {
    const path = await this.backend.saveProjectDialog(`${this.ide.project.name}.vbb`);
    if (!path) return false;
    return this.writeTo(path);
  }

  private async writeTo(path: string): Promise<boolean> {
    try {
      await this.backend.writeTextFile(path, serializeProject(this.ide.project));
    } catch (e) {
      await this.error(errText(e));
      return false;
    }
    this.ide.filePath = path;
    this.ide.stack.markSaved();
    this.updateTitle();
    return true;
  }

  /** True = continue (clean, saved or discarded); false = the user cancelled. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.ide.stack.isDirty) return true;
    const list = h('div', { class: 'dlg98-filelist' }, h('div', {}, this.fileName()));
    const v = await showDialog98(this.doc, {
      title: 'VibeBasic',
      content: h('div', {}, h('div', { class: 'dlg98-text' }, 'Save changes to the following files?'), list),
      buttons: [
        { label: 'Yes', value: 'yes', default: true },
        { label: 'No', value: 'no' },
        { label: 'Cancel', value: 'cancel', cancel: true },
      ],
    });
    if (v === 'yes') return this.save();
    return v === 'no';
  }

  async exit(): Promise<void> {
    if (await this.confirmDiscard()) await this.backend.closeMainWindow();
  }

  updateTitle(): void {
    void this.backend.setWindowTitle(`${this.ide.project.name} - VibeBasic ${__APP_VERSION__} [${this.ide.mode}]`);
  }
}
